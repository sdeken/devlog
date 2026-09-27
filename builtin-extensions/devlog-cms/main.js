/**
 * devlog-cms: a finished timesheet → hours in the Technology Partners
 * consultant timesheet system ("CMS").
 *
 * CMS has no API, so this does what the browser does:
 *
 *  - log in with the form (j_security_check), keeping the session cookie;
 *  - read the week page (TPIServlet?screen=TimesheetScreen&action=retrieve
 *    &ref=MM/DD/YY, ref = the Sunday): a row per assignment (client, project,
 *    the assignment id in its "Week" link) and a cell per day linking to that
 *    day's timesheet_id and showing its hours ("07.50"). A day only gets its
 *    link on the day itself, and not at all outside the assignment's dates;
 *  - to change a day, open its form (…&timesheet_id=N) for the current
 *    description and revision, then submit Update with hrs_worked (decimal
 *    hours) and work_desc.
 *
 * CMS weeks run Sunday to Saturday, so a Devlog week (Monday to Sunday) needs
 * two CMS weeks. Hours per assignment per day are the sum of the timesheet's
 * entries whose canvas (or a canvas above it) names the assignment. The
 * preview compares with what CMS shows, so only days that differ are sent.
 * Days this extension filled before (sent/<week>.json) and that no longer
 * have time are set back to 0; days you typed into CMS yourself are left
 * alone.
 */
const DEFAULT_BASE = 'https://consultant.technologypartners.net/consultant'
const pad = (n) => String(n).padStart(2, '0')

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (s, n) => {
  const d = parseDate(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}
/** The Sunday a date's CMS week starts on. */
const cmsSunday = (s) => addDays(s, -parseDate(s).getDay())
/** CMS's ref=MM/DD/YY. */
const ref = (sunday) => {
  const d = parseDate(sunday)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(2)}`
}

/** Decimal hours as CMS takes them: 90 → "1.5", 15 → "0.25". */
const hoursText = (minutes) => String(Math.round((minutes / 60) * 100) / 100)
const hm = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`

// ---------------------------------------------------------------------------
// Parsing CMS pages
// ---------------------------------------------------------------------------

const decode = (s) =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()

const isLoginPage = (html) => /j_security_check/i.test(html)

/**
 * The week page → { weekEnding: 'YYYY-MM-DD' | null, rows: [{ assignmentId,
 * client, project, cells: [{ date, timesheetId, minutes }] }] }, dates from
 * the Sunday it was asked for. A row's cells are its 3rd to 9th columns; a
 * day CMS won't take hours for (before the assignment starts, after it ends,
 * or not yet here) has no link, so its timesheetId is null.
 */
function parseWeek(html, sunday) {
  const ending = /Week Ending:\s*(\d{2})\/(\d{2})\/(\d{2})/i.exec(html)
  const weekEnding = ending ? `20${ending[3]}-${ending[1]}-${ending[2]}` : null
  const rows = []
  const parts = html.split(/<TR\s+class="textdefault"/i).slice(1)
  for (const part of parts) {
    const row = part.split(/<\/TR>/i)[0]
    const tds = [...row.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((m) => m[1])
    if (tds.length < 9) continue
    const cells = tds.slice(2, 9).map((td, i) => {
      const link = /timesheet_id=(\d+)/i.exec(td)
      const hours = /\d+(?:\.\d+)?/.exec(decode(td))
      return { date: addDays(sunday, i), timesheetId: link ? link[1] : null, minutes: hours ? Math.round(parseFloat(hours[0]) * 60) : 0 }
    })
    const assignment = /assignment_id=(\d+)/i.exec(row)
    rows.push({ assignmentId: assignment ? assignment[1] : '', client: decode(tds[0]), project: decode(tds[1]), cells })
  }
  return { weekEnding, rows }
}

/** A day's form → its current description and revision. */
function parseForm(html) {
  const desc = /<textarea[^>]*name=["']?work_desc["']?[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)
  const rev = /name=["']?revision_ts["']?\s+value=["']([^"']*)["']/i.exec(html) || /value=["']([^"']*)["']\s+name=["']?revision_ts/i.exec(html)
  const hours = /name=["']?hrs_worked["']?[^>]*value=["']([\d.]*)["']/i.exec(html)
  return {
    description: desc ? decode(desc[1].replace(/<br\s*\/?>/gi, '\n')).trim() : '',
    revision: rev ? rev[1] : '',
    minutes: hours ? Math.round(parseFloat(hours[1] || '0') * 60) : null
  }
}

// ---------------------------------------------------------------------------
// The session: cookies, redirects, login
// ---------------------------------------------------------------------------

class Session {
  constructor(base, username, password) {
    this.base = base
    this.origin = new URL(base).origin
    this.username = username
    this.password = password
    this.cookies = new Map()
  }

  keep(res) {
    const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean)
    for (const c of set) {
      const [pair] = c.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  /** Fetch, following redirects by hand so every hop's cookies are kept. Returns { url, html }. */
  async request(url, init = {}) {
    let target = new URL(url, this.base + '/').toString()
    let options = init
    for (let hop = 0; hop < 8; hop++) {
      if (new URL(target).origin !== this.origin) throw new Error(`CMS redirected somewhere else: ${target}`)
      const headers = { 'User-Agent': 'Devlog', ...(options.headers || {}) }
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
      const res = await fetch(target, { ...options, headers, redirect: 'manual' })
      this.keep(res)
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        target = new URL(res.headers.get('location'), target).toString()
        options = {} // a redirect after a POST is a GET
        continue
      }
      if (!res.ok) throw new Error(`CMS: HTTP ${res.status} for ${new URL(target).pathname}`)
      return { url: target, html: await res.text() }
    }
    throw new Error('CMS: too many redirects')
  }

  servlet(params) {
    return `${this.base}/servlet/TPIServlet?${new URLSearchParams(params).toString().replace(/%2F/g, '/')}`
  }

  /** Get a page, logging in first if CMS asks for it. */
  async page(params) {
    const url = this.servlet(params)
    let res = await this.request(url)
    if (!isLoginPage(res.html)) return res.html
    // One login per session, even if two pages asked at once.
    if (!this.login) {
      const body = new URLSearchParams({ from: '', j_username: this.username, j_password: this.password }).toString()
      this.login = this.request(`${this.base}/j_security_check`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
    }
    await this.login
    res = await this.request(url)
    if (isLoginPage(res.html)) throw new Error('CMS did not accept the username and password')
    return res.html
  }

  async week(sunday) {
    const html = await this.page({ screen: 'TimesheetScreen', action: 'retrieve', ref: ref(sunday) })
    const week = parseWeek(html, sunday)
    if (week.weekEnding && week.weekEnding !== addDays(sunday, 6)) throw new Error(`CMS showed the week ending ${week.weekEnding}, not ${addDays(sunday, 6)}`)
    return week
  }

  async update(timesheetId, minutes, description) {
    const form = parseForm(await this.page({ screen: 'TimesheetScreen', action: 'retrieve', timesheet_id: timesheetId }))
    const html = await this.page({
      screen: 'TimesheetScreen',
      revision_ts: form.revision,
      hrs_worked: hoursText(minutes),
      work_desc: description === null ? form.description : description,
      timesheet_id: timesheetId,
      action: 'Update'
    })
    // CMS answers with the week again: check the day now shows what was sent.
    const shown = [...html.matchAll(/timesheet_id=(\d+)"?[^>]*>\s*([\d.]+)\s*<\/A>/gi)].find((m) => m[1] === String(timesheetId))
    if (shown && Math.round(parseFloat(shown[2]) * 60) !== minutes) throw new Error(`CMS shows ${shown[2]} hours after the update, not ${hoursText(minutes)}`)
  }
}

async function session(ctx) {
  const username = String(ctx.settings.get('username') || '').trim()
  if (!username) throw new Error('Set the CMS username in the extension settings')
  const password = await ctx.secrets.get('password')
  if (!password) throw new Error('Set the CMS password in the extension settings')
  const base = String(ctx.settings.get('baseurl') || DEFAULT_BASE).trim().replace(/\/+$/, '')
  return new Session(base, username, password)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

/** The CMS row a canvas's field names: an assignment number, a project name, or "Client / Project". */
function findRow(rows, value) {
  const v = norm(value)
  if (/^\d+$/.test(v)) return rows.find((r) => r.assignmentId === v) || null
  return rows.find((r) => norm(r.project) === v) || rows.find((r) => norm(`${r.client} / ${r.project}`) === v) || null
}

async function readLedger(ctx, week) {
  try {
    return JSON.parse((await ctx.files.repo.readText(`sent/${week}.json`)) || '{}') || {}
  } catch {
    return {}
  }
}

/** Everything sending would do: { lines, cms (by assignment|date → cell) }. */
async function plan(ctx, sheet, s) {
  // CMS opens a day only on that day, so a week that hasn't started yet
  // (usually the second one: the Devlog week's Sunday) isn't asked for.
  const today = ymd(new Date())
  const sundays = [...new Set([cmsSunday(sheet.week), cmsSunday(addDays(sheet.week, 6))])].filter((sun) => sun <= today)
  const weeks = []
  for (const sun of sundays) weeks.push(await s.week(sun))
  const rows = new Map() // assignmentId → { client, project }
  const cells = new Map() // `${assignmentId}|${date}` → cell
  for (const w of weeks) {
    for (const r of w.rows) {
      rows.set(r.assignmentId, { ...r, cells: undefined })
      for (const c of r.cells) cells.set(`${r.assignmentId}|${c.date}`, c)
    }
  }
  const allRows = weeks.flatMap((w) => w.rows)
  const ledger = await readLedger(ctx, sheet.week)

  const lines = []
  const want = new Map() // key → { minutes, entryIds, notes }
  for (const e of sheet.entries) {
    const field = e.fields.assignment
    const row = field ? findRow(allRows, field) : null
    if (!row) {
      lines.push({
        id: `skip:${e.id}`,
        entryIds: [e.id],
        date: e.date,
        start: e.start,
        minutes: e.minutes,
        target: '',
        description: e.task,
        action: 'skip',
        reason: field ? `"${field}" is not one of your CMS assignments` : 'No CMS assignment on this task or the canvases above it'
      })
      continue
    }
    const key = `${row.assignmentId}|${e.date}`
    const w = want.get(key) || { minutes: 0, entryIds: [], notes: [] }
    w.minutes += e.minutes
    w.entryIds.push(e.id)
    if (e.note) w.notes.push(e.note)
    want.set(key, w)
  }
  // Days sent before that no longer have time go back to 0.
  for (const key of Object.keys(ledger)) if (!want.has(key)) want.set(key, { minutes: 0, entryIds: [], notes: [], clearing: true })

  for (const [key, w] of [...want].sort(([a], [b]) => a.localeCompare(b))) {
    const [assignmentId, date] = key.split('|')
    const cell = cells.get(key)
    const row = rows.get(assignmentId)
    const label = row ? `${row.client} / ${row.project}` : `assignment ${assignmentId}`
    const base = { id: key, entryIds: w.entryIds, date, minutes: w.minutes, target: label }
    if (cell && cell.minutes === w.minutes) lines.push({ ...base, action: 'unchanged', description: `${hoursText(w.minutes)} h` })
    else if (date > today) lines.push({ ...base, action: 'skip', reason: `CMS takes hours for ${date} on the day; send again then` })
    else if (!cell || !cell.timesheetId) lines.push({ ...base, action: 'skip', reason: 'CMS has no hours for this assignment on this day (outside its dates?)' })
    else
      lines.push({
        ...base,
        action: w.minutes === 0 ? 'delete' : cell.minutes === 0 ? 'create' : 'update',
        description: `${hoursText(cell.minutes)} → ${hoursText(w.minutes)} h${w.notes.length ? ` · ${w.notes.join('; ')}` : ''}`,
        timesheetId: cell.timesheetId,
        notes: w.notes
      })
  }
  return lines
}

const publicLine = ({ timesheetId: _t, notes: _n, ...line }) => line

exports.activate = (ctx) => {
  // Also the settings page's Test button.
  ctx.commands.register('check', async () => {
    const s = await session(ctx)
    const week = await s.week(cmsSunday(ymd(new Date())))
    return `Logged in to CMS as ${s.username}: ${week.rows.length} assignment${week.rows.length === 1 ? '' : 's'} this week`
  })

  ctx.commands.register('assignments', async () => {
    const s = await session(ctx)
    const week = await s.week(cmsSunday(ymd(new Date())))
    return week.rows.length ? week.rows.map((r) => `${r.assignmentId}: ${r.client} / ${r.project}`).join(' · ') : 'No assignments this week'
  })

  ctx.destinations.register('hours', {
    async preview(sheet) {
      return (await plan(ctx, sheet, await session(ctx))).map(publicLine)
    },

    async send(sheet) {
      const s = await session(ctx)
      const lines = await plan(ctx, sheet, s)
      const ledger = await readLedger(ctx, sheet.week)
      const done = []
      const failed = []
      const count = { create: 0, update: 0, delete: 0 }
      let minutes = 0
      for (const line of lines) {
        if (line.action === 'unchanged') minutes += line.minutes
        if (!(line.action in count)) continue
        try {
          await s.update(line.timesheetId, line.minutes, line.notes.length ? line.notes.join('; ') : null)
          if (line.minutes) ledger[line.id] = { minutes: line.minutes, timesheetId: line.timesheetId }
          else delete ledger[line.id]
          await ctx.files.repo.write(`sent/${sheet.week}.json`, JSON.stringify(ledger, null, 2) + '\n')
          count[line.action]++
          minutes += line.minutes
          done.push(line.id)
        } catch (err) {
          failed.push({ lineId: line.id, error: err instanceof Error ? err.message : String(err) })
        }
      }
      // Days already right count as sent (for the ledger), so clearing them later works.
      for (const line of lines) if (line.action === 'unchanged' && line.minutes && !ledger[line.id]) ledger[line.id] = { minutes: line.minutes }
      await ctx.files.repo.write(`sent/${sheet.week}.json`, JSON.stringify(ledger, null, 2) + '\n')
      const parts = []
      if (count.create) parts.push(`${count.create} day${count.create === 1 ? '' : 's'} filled in`)
      if (count.update) parts.push(`${count.update} changed`)
      if (count.delete) parts.push(`${count.delete} cleared`)
      if (!parts.length) parts.push('nothing to change')
      return { done, failed, summary: `${parts.join(', ')} (${hm(minutes)} in CMS this week)` }
    }
  })
}

exports._internal = { parseWeek, parseForm, findRow, cmsSunday, ref, hoursText }
