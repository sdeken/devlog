import { useEffect, useMemo, useState } from 'react'
import { localDate, previewText } from '@shared/entries'
import { JOURNAL_PAGE_ID, categoryPath } from '@shared/pages'
import { classifyApp } from '@shared/activity'
import { addDays, formatMinutes } from '@shared/review'
import type { ActivityEvent, Entry, PageMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  pages: PageMeta[]
  today: string
  date: string
  onChangeDate: (date: string) => void
  onJumpTo: (pageId: string, date: string) => void
}

type Row =
  | { t: string; kind: 'note'; pageId: string; entry: Entry }
  | { t: string; kind: 'system'; type: ActivityEvent['type']; pageId?: string | null }
  | { t: string; kind: 'focus'; app: string; end: string; items: Array<{ t: string; title: string; end: string }> }

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const SYSTEM_LABEL: Record<string, string> = {
  start: 'Devlog started',
  stop: 'Devlog stopped',
  lock: 'Screen locked',
  unlock: 'Screen unlocked',
  idle: 'Went idle',
  active: 'Back from idle',
  suspend: 'Machine went to sleep',
  resume: 'Machine woke up'
}

export function Timeline({ pages, today, date, onChangeDate, onJumpTo }: Props): React.JSX.Element {
  const [notes, setNotes] = useState<Array<{ pageId: string; entry: Entry }> | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [showFocus, setShowFocus] = useState(true)
  const [showSystem, setShowSystem] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const pageLabel = (id: string | null | undefined): string => {
    if (!id) return 'no task'
    if (id === JOURNAL_PAGE_ID) return 'Journal'
    const p = pageById.get(id)
    return p ? [...categoryPath(p.category), p.title].join(' / ') : id
  }

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    void Promise.all([api.entries.range(addDays(date, -1), date), api.activity.range(date, date)]).then(([chunks, evs]) => {
      if (cancelled) return
      const flat: Array<{ pageId: string; entry: Entry }> = []
      for (const { pageId, day } of chunks) {
        for (const entry of day.entries) if (localDate(new Date(entry.createdAt)) === date) flat.push({ pageId, entry })
      }
      setNotes(flat)
      setEvents(evs)
    })
    return () => {
      cancelled = true
    }
  }, [date])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const n of notes ?? []) out.push({ t: n.entry.createdAt, kind: 'note', pageId: n.pageId, entry: n.entry })
    const sorted = [...events].sort((a, b) => a.t.localeCompare(b.t))
    let run: Extract<Row, { kind: 'focus' }> | null = null
    const endRun = (t: string): void => {
      if (!run) return
      run.end = t
      if (run.items.length > 0) run.items[run.items.length - 1].end = t
      out.push(run)
      run = null
    }
    for (let i = 0; i < sorted.length; i++) {
      const ev = sorted[i]
      const next = sorted[i + 1]
      switch (ev.type) {
        case 'focus': {
          const app = (ev.app ?? '').replace(/\.exe$/i, '') || '(unknown)'
          if (run && run.app === app) {
            run.items[run.items.length - 1].end = ev.t
            run.items.push({ t: ev.t, title: ev.title ?? '', end: next?.t ?? ev.t })
          } else {
            endRun(ev.t)
            run = { t: ev.t, kind: 'focus', app, end: next?.t ?? ev.t, items: [{ t: ev.t, title: ev.title ?? '', end: next?.t ?? ev.t }] }
          }
          break
        }
        case 'heartbeat':
          break
        default:
          endRun(ev.t)
          out.push({ t: ev.t, kind: 'system', type: ev.type, pageId: ev.pageId })
      }
    }
    endRun(sorted[sorted.length - 1]?.t ?? new Date().toISOString())
    return out.sort((a, b) => a.t.localeCompare(b.t))
  }, [notes, events])

  const visible = rows.filter((r) => (r.kind === 'focus' ? showFocus : r.kind === 'system' ? showSystem : true))
  const minutes = (a: string, b: string): number => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60_000)

  return (
    <div className="feed timeline">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Timeline</h2>
          <span className="feed-sub">{date === today ? 'Today · ' : ''}{longDay.format(parseLocal(date))}</span>
          <span className="spacer" />
          <label className="check check-inline">
            <input type="checkbox" checked={showSystem} onChange={(ev) => setShowSystem(ev.target.checked)} /> System
          </label>
          <label className="check check-inline">
            <input type="checkbox" checked={showFocus} onChange={(ev) => setShowFocus(ev.target.checked)} /> Apps
          </label>
          <div className="week-nav">
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => onChangeDate(addDays(date, -1))} title="Previous day">
              ‹
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => onChangeDate(today)} disabled={date === today}>
              Today
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => onChangeDate(addDays(date, 1))} disabled={date >= today} title="Next day">
              ›
            </button>
          </div>
        </div>
      </header>

      {notes === null && <p className="feed-empty">Loading…</p>}
      {notes && visible.length === 0 && <p className="feed-empty">Nothing recorded on this day.</p>}

      <ol className="tl">
        {visible.map((r, i) => {
          if (r.kind === 'note') {
            const commit = r.entry.kind === 'commit'
            return (
              <li key={`n-${r.entry.id}`} className={`tl-row tl-note${commit ? ' tl-commit' : ''}`}>
                <time>{timeFmt.format(new Date(r.t))}</time>
                <span className="tl-dot" />
                <button type="button" className="tl-body tl-link" onClick={() => onJumpTo(r.pageId, date)}>
                  <span className="tl-page">{pageLabel(r.pageId)}</span>
                  <span className="tl-text">
                    {r.entry.parentId ? '↳ ' : ''}
                    {previewText(r.entry.markdown, 160)}
                  </span>
                </button>
              </li>
            )
          }
          if (r.kind === 'system') {
            const label = r.type === 'task' ? (r.pageId ? `Task → ${pageLabel(r.pageId)}` : 'Task stopped') : r.type === 'start' && r.pageId ? `Devlog started · task ${pageLabel(r.pageId)}` : (SYSTEM_LABEL[r.type] ?? r.type)
            return (
              <li key={`s-${i}`} className={`tl-row tl-system tl-${r.type}`}>
                <time>{timeFmt.format(new Date(r.t))}</time>
                <span className="tl-dot" />
                <span className="tl-body">
                  <span className="tl-text">{label}</span>
                </span>
              </li>
            )
          }
          const key = `f-${r.t}`
          const open = expanded.has(key)
          const kind = classifyApp(r.app, r.items[0]?.title ?? '')
          return (
            <li key={key} className={`tl-row tl-focus kind-${kind}`}>
              <time>{timeFmt.format(new Date(r.t))}</time>
              <span className={`tl-dot kind-dot kind-${kind}`} />
              <div className="tl-body">
                <button
                  type="button"
                  className="tl-link tl-focus-head"
                  onClick={() =>
                    setExpanded((s) => {
                      const n = new Set(s)
                      if (n.has(key)) n.delete(key)
                      else n.add(key)
                      return n
                    })
                  }
                >
                  <span className="tl-app">{r.app}</span>
                  <span className="tl-text">{open ? '' : r.items[r.items.length - 1].title || '(no title)'}</span>
                  <span className="tl-minutes">
                    {formatMinutes(minutes(r.t, r.end))}
                    {r.items.length > 1 ? ` · ${r.items.length} windows` : ''}
                  </span>
                </button>
                {open && (
                  <ul className="tl-titles">
                    {r.items.map((it, j) => (
                      <li key={j}>
                        <time>{timeFmt.format(new Date(it.t))}</time>
                        <span className="tl-text">{it.title || '(no title)'}</span>
                        <span className="tl-minutes">{formatMinutes(minutes(it.t, it.end))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
