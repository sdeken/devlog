/**
 * devlog-jira: a finished timesheet → Jira worklogs.
 *
 * Each timesheet entry whose task (or a canvas above it) has a Jira issue
 * becomes one worklog on that issue: its start time, its duration, and its
 * note as the comment. What was sent is kept per week in this extension's
 * synced folder (sent/<week>.json: entry id → issue, worklog id, and what
 * was sent), so sending again, from any machine, only creates, updates or
 * deletes what changed.
 *
 * Talks to the REST API v2 (Jira Cloud and Data Center): Basic auth with an
 * account email and API token (Cloud), or a personal access token (Data
 * Center, email left empty).
 */
const ISSUE_RE = /^[A-Z][A-Z0-9_]*-\d+$/

const pad = (n, w = 2) => String(n).padStart(w, '0')

/** Jira's timestamp: local time with its UTC offset, e.g. 2026-09-22T09:00:00.000+0200. */
function jiraTime(iso) {
  const d = new Date(iso)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

const hm = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`

async function config(ctx) {
  const base = String(ctx.settings.get('baseurl') || '').trim().replace(/\/+$/, '')
  if (!base) throw new Error('Set the Jira URL in the extension settings')
  if (!/^https:\/\/[^/]+/.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('The Jira URL must start with https://')
  const token = await ctx.secrets.get('token')
  if (!token) throw new Error('Set the Jira token in the extension settings')
  const email = String(ctx.settings.get('email') || '').trim()
  const auth = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`
  return { base, auth }
}

async function jira(cfg, method, path, body) {
  const res = await fetch(cfg.base + path, {
    method,
    headers: { Authorization: cfg.auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    let detail = ''
    try {
      const j = await res.json()
      detail = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join('; ')
    } catch {
      // not JSON
    }
    const err = new Error(`Jira ${method} ${path}: HTTP ${res.status}${detail ? ` (${detail})` : ''}`)
    err.status = res.status
    throw err
  }
  return res.status === 204 ? null : res.json().catch(() => null)
}

async function readLedger(ctx, week) {
  const text = await ctx.files.repo.readText(`sent/${week}.json`)
  if (!text) return {}
  try {
    return JSON.parse(text) || {}
  } catch {
    return {}
  }
}

const writeLedger = (ctx, week, ledger) => ctx.files.repo.write(`sent/${week}.json`, JSON.stringify(ledger, null, 2) + '\n')

/** What each entry should be in Jira, or why it is not sent there. */
function wanted(entry) {
  const raw = String(entry.fields.issue || '').trim().toUpperCase()
  if (!raw) return { skip: 'No Jira issue on this task or the canvases above it' }
  if (!ISSUE_RE.test(raw)) return { skip: `"${raw}" is not a Jira issue key` }
  return { issue: raw, started: jiraTime(entry.start), seconds: entry.minutes * 60, comment: entry.note || '' }
}

/** Plan: one line per thing to do (or not do), against what was sent before. */
function plan(sheet, ledger) {
  const lines = []
  const ids = new Set()
  for (const e of sheet.entries) {
    ids.add(e.id)
    const w = wanted(e)
    const prev = ledger[e.id]
    const base = { entryIds: [e.id], date: e.date, start: e.start, minutes: e.minutes, description: e.note ? `${e.task} · ${e.note}` : e.task }
    if (w.skip) {
      if (prev) lines.push({ ...base, id: `${e.id}:old`, target: prev.issue, action: 'delete', reason: 'no longer mapped to an issue', prev })
      lines.push({ ...base, id: e.id, target: '', action: 'skip', reason: w.skip })
      continue
    }
    if (prev && prev.issue !== w.issue) {
      lines.push({ ...base, id: `${e.id}:old`, target: prev.issue, action: 'delete', reason: `moved to ${w.issue}`, prev })
      lines.push({ ...base, id: e.id, target: w.issue, action: 'create', want: w })
    } else if (!prev) lines.push({ ...base, id: e.id, target: w.issue, action: 'create', want: w })
    else if (prev.started === w.started && prev.seconds === w.seconds && prev.comment === w.comment) lines.push({ ...base, id: e.id, target: w.issue, action: 'unchanged' })
    else lines.push({ ...base, id: e.id, target: w.issue, action: 'update', want: w, prev })
  }
  for (const [id, prev] of Object.entries(ledger)) {
    if (!ids.has(id)) lines.push({ id: `gone:${id}`, entryIds: [id], date: prev.started.slice(0, 10), minutes: prev.seconds / 60, target: prev.issue, description: 'removed from the timesheet', action: 'delete', prev })
  }
  return lines
}

const publicLine = ({ want: _w, prev: _p, ...line }) => line

exports.activate = (ctx) => {
  ctx.commands.register('check', async () => {
    const me = await jira(await config(ctx), 'GET', '/rest/api/2/myself')
    ctx.ui.notify(`Connected to Jira as ${(me && (me.displayName || me.name || me.emailAddress)) || 'you'}`)
  })

  ctx.destinations.register('worklogs', {
    async preview(sheet) {
      return plan(sheet, await readLedger(ctx, sheet.week)).map(publicLine)
    },

    async send(sheet) {
      const cfg = await config(ctx)
      const ledger = await readLedger(ctx, sheet.week)
      const lines = plan(sheet, ledger)
      const done = []
      const failed = []
      const count = { create: 0, update: 0, delete: 0, unchanged: 0 }
      let minutes = 0
      const issues = new Set()
      for (const line of lines) {
        try {
          if (line.action === 'create') {
            const w = line.want
            const res = await jira(cfg, 'POST', `/rest/api/2/issue/${encodeURIComponent(w.issue)}/worklog`, { started: w.started, timeSpentSeconds: w.seconds, comment: w.comment })
            ledger[line.entryIds[0]] = { ...w, worklogId: String(res && res.id) }
          } else if (line.action === 'update') {
            const w = line.want
            await jira(cfg, 'PUT', `/rest/api/2/issue/${encodeURIComponent(w.issue)}/worklog/${encodeURIComponent(line.prev.worklogId)}`, { started: w.started, timeSpentSeconds: w.seconds, comment: w.comment })
            ledger[line.entryIds[0]] = { ...w, worklogId: line.prev.worklogId }
          } else if (line.action === 'delete') {
            try {
              await jira(cfg, 'DELETE', `/rest/api/2/issue/${encodeURIComponent(line.prev.issue)}/worklog/${encodeURIComponent(line.prev.worklogId)}`)
            } catch (err) {
              if (err.status !== 404) throw err // already gone in Jira: fine
            }
            if (ledger[line.entryIds[0]] && ledger[line.entryIds[0]].worklogId === line.prev.worklogId) delete ledger[line.entryIds[0]]
          } else continue
          // Record progress as it happens, so a failure halfway is not sent twice.
          await writeLedger(ctx, sheet.week, ledger)
          count[line.action]++
          done.push(line.id)
        } catch (err) {
          failed.push({ lineId: line.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      for (const l of lines) {
        if (l.action === 'unchanged') count.unchanged++
        if ((l.action === 'create' || l.action === 'update' || l.action === 'unchanged') && !failed.some((f) => f.lineId === l.id)) {
          minutes += l.minutes
          issues.add(l.target)
        }
      }
      const parts = []
      if (count.create) parts.push(`${count.create} worklog${count.create === 1 ? '' : 's'} created`)
      if (count.update) parts.push(`${count.update} updated`)
      if (count.delete) parts.push(`${count.delete} deleted`)
      if (count.unchanged) parts.push(`${count.unchanged} unchanged`)
      if (!parts.length) parts.push('nothing to send')
      return { done, failed, summary: `${parts.join(', ')} (${hm(minutes)} on ${issues.size} issue${issues.size === 1 ? '' : 's'})` }
    }
  })
}

exports._internal = { jiraTime, plan }
