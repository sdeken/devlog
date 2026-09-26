/**
 * devlog-focus: window tracking as an extension.
 *
 * The app tells it which window is in front (only while the machine is
 * unlocked and awake, and only if you allowed it). It appends each change
 * to a JSON-lines file per machine and day in its own folder in the devlog:
 *
 *   extensions/builtin.devlog-focus/<machine>/YYYY/MM/YYYY-MM-DD.jsonl
 *   {"t":"2026-09-26T09:14:03.120Z","app":"Code","title":"store.ts — devlog"}
 *
 * and hands those back to the app's timeline, review and summary.
 */
const FILE_RE = /^([^/]+)\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.jsonl$/

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function fileFor(machine, iso) {
  const date = localDate(new Date(iso))
  return `${machine}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jsonl`
}

exports.activate = (ctx) => {
  let last = null
  let writes = Promise.resolve()

  const record = (t, app, title) => {
    const line = JSON.stringify({ t, app, title }) + '\n'
    // Keep lines in order even if the app delivers two changes at once.
    writes = writes.then(() => ctx.files.repo.append(fileFor(ctx.machine, t), line)).catch((err) => console.error('devlog-focus: write failed', err))
  }

  ctx.system.onForegroundWindow((w) => {
    last = { app: w.app, title: w.title }
    record(w.t, w.app, w.title)
  })

  // Back from a lock, sleep or idle spell: the window in front may not have
  // changed, so say again what it is, or its time would not resume.
  ctx.activity.on((n) => {
    if (n.type === 'resume' && last) record(n.t, last.app, last.title)
  })

  ctx.provide.focus(async (fromDate, toDate) => {
    await writes
    const events = []
    for (const f of await ctx.files.repo.list()) {
      const m = FILE_RE.exec(f.path)
      if (!m || m[4] < fromDate || m[4] > toDate) continue
      const text = (await ctx.files.repo.readText(f.path)) || ''
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line)
          if (typeof o.t === 'string') events.push({ t: o.t, app: String(o.app || ''), title: String(o.title || ''), machine: m[1] })
        } catch {
          // A torn last line (a crash mid-write): skip it.
        }
      }
    }
    return events
  })
}
