import { useEffect, useMemo, useState } from 'react'
import { localDate, previewText } from '@shared/entries'
import { JOURNAL_PAGE_ID, categoryPath } from '@shared/pages'
import { APP_KIND_LABEL, bucketizeDay, buildFocusSegments, buildTaskSegments, cleanFocusSegments, type TimelineBucket } from '@shared/activity'
import { addDays, formatMinutes } from '@shared/review'
import type { ActivityEvent, Entry, PageMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  pages: PageMeta[]
  today: string
  date: string
  /** Focus flips shorter than this are folded into their neighbours (alt-tab noise). */
  focusMinSeconds: number
  onChangeDate: (date: string) => void
  onJumpTo: (pageId: string, date: string) => void
}

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

function gitLabel(e: ActivityEvent): string {
  const repo = e.repo ? `${e.repo}: ` : ''
  switch (e.action) {
    case 'checkout':
      return `${repo}switched to ${e.branch ?? '?'}${e.from ? ` (from ${e.from})` : ''}`
    case 'branch':
      return `${repo}created branch ${e.branch ?? '?'}`
    case 'push':
      return `${repo}pushed ${e.branch ?? ''}`.trim()
    case 'merge':
      return `${repo}merged ${e.detail ?? e.branch ?? ''}`.trim()
    case 'rebase':
      return `${repo}rebased ${e.detail ?? ''}`.trim()
    case 'pull':
      return `${repo}pulled ${e.detail ?? ''}`.trim()
    case 'stash':
      return `${repo}stashed changes`
    case 'reset':
      return `${repo}reset ${e.detail ?? ''}`.trim()
    case 'commit':
      return `${repo}committed ${e.detail ?? ''}`.trim()
    default:
      return `${repo}${e.action ?? 'git'}`
  }
}

const INTERVALS = [5, 15, 30, 60]
const INTERVAL_KEY = 'devlog:timeline:interval'

export function Timeline({ pages, today, date, focusMinSeconds, onChangeDate, onJumpTo }: Props): React.JSX.Element {
  const [notes, setNotes] = useState<Array<{ pageId: string; entry: Entry }> | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [showApps, setShowApps] = useState(true)
  const [showSystem, setShowSystem] = useState(true)
  const [interval, setIntervalMinutes] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(INTERVAL_KEY))
      return INTERVALS.includes(v) ? v : 15
    } catch {
      return 15
    }
  })
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

  const buckets = useMemo<TimelineBucket[]>(() => {
    if (!notes) return []
    return bucketizeDay({
      date,
      intervalMinutes: interval,
      taskSegments: buildTaskSegments(events),
      focusSegments: cleanFocusSegments(buildFocusSegments(events), { minSeconds: focusMinSeconds }),
      notes,
      events
    })
  }, [notes, events, date, interval, focusMinSeconds])

  const changeInterval = (v: number): void => {
    setIntervalMinutes(v)
    try {
      localStorage.setItem(INTERVAL_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

  const toggle = (key: string): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const totals = useMemo(() => {
    let screen = 0
    const tasks = new Map<string, number>()
    for (const b of buckets) {
      screen += b.screenMinutes
      for (const t of b.tasks) tasks.set(t.pageId, (tasks.get(t.pageId) ?? 0) + t.minutes)
    }
    return { screen, tasked: [...tasks.values()].reduce((a, b) => a + b, 0) }
  }, [buckets])

  const rows: React.JSX.Element[] = []
  let prevEnd: string | null = null
  for (const b of buckets) {
    if (prevEnd && b.start !== prevEnd) {
      const gap = (new Date(b.start).getTime() - new Date(prevEnd).getTime()) / 60_000
      rows.push(
        <li key={`gap-${b.start}`} className="tlb-gap">
          <span>{formatMinutes(gap)} with nothing recorded</span>
        </li>
      )
    }
    prevEnd = b.end
    const key = b.start
    const open = expanded.has(key)
    const taskLabel =
      b.tasks.length === 0
        ? null
        : b.tasks.map((t) => `${pageLabel(t.pageId)}${b.tasks.length > 1 && Math.round(t.minutes) >= 1 ? ` (${formatMinutes(t.minutes)})` : ''}`).join(' → ')
    const visibleSystem = showSystem ? b.system : []
    rows.push(
      <li key={key} className={`tlb${b.tasks.length === 0 ? ' tlb-idle' : ''}`}>
        <div className="tlb-head">
          <time>
            {timeFmt.format(new Date(b.start))}
            <span className="tlb-dash">–</span>
            {timeFmt.format(new Date(b.end))}
          </time>
          <span className="tlb-task" title={b.tasks.map((t) => `${pageLabel(t.pageId)}: ${formatMinutes(t.minutes)}${t.source === 'explicit' ? ' (explicit)' : ''}`).join('\n')}>
            {taskLabel ?? <span className="tlb-notask">no task</span>}
          </span>
          {showApps && b.apps.length > 0 && (
            <span className="tlb-kinds" title={b.apps.map((a) => `${a.app} ${formatMinutes(a.minutes)}`).join(', ')}>
              {b.apps.slice(0, 4).map((a) => (
                <span key={a.app} className={`kind-dot kind-${a.kind}`} title={`${a.app} · ${APP_KIND_LABEL[a.kind]} · ${formatMinutes(a.minutes)}`} />
              ))}
              <span className="tlb-screen">{formatMinutes(b.screenMinutes)}</span>
            </span>
          )}
        </div>
        {b.notes.length > 0 && (
          <ul className="tlb-notes">
            {b.notes.map((n) => (
              <li key={n.entry.id}>
                <button type="button" className={`tl-link${n.entry.kind === 'commit' ? ' tlb-commit' : ''}`} onClick={() => onJumpTo(n.pageId, date)}>
                  <time>{timeFmt.format(new Date(n.entry.createdAt))}</time>
                  <span className="tl-page">{pageLabel(n.pageId)}</span>
                  <span className="tl-text">
                    {n.entry.parentId ? '↳ ' : ''}
                    {previewText(n.entry.markdown, 160)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {b.git.length > 0 && (
          <ul className="tlb-git">
            {b.git.map((e, i) => (
              <li key={`${e.t}-${i}`} title={e.repo}>
                <time>{timeFmt.format(new Date(e.t))}</time>
                <span className="tlb-git-icon">⎇</span>
                <span>{gitLabel(e)}</span>
              </li>
            ))}
          </ul>
        )}
        {visibleSystem.length > 0 && (
          <ul className="tlb-system">
            {visibleSystem.map((e, i) => (
              <li key={i}>
                <time>{timeFmt.format(new Date(e.t))}</time>
                <span>{e.type === 'start' && e.pageId ? `Devlog started · task ${pageLabel(e.pageId)}` : (SYSTEM_LABEL[e.type] ?? e.type)}</span>
              </li>
            ))}
          </ul>
        )}
        {showApps && b.apps.length > 0 && (
          <div className="tlb-apps">
            <button type="button" className="tlb-apps-toggle" onClick={() => toggle(key)} title={open ? 'Hide window titles' : 'Show window titles'}>
              {b.apps.map((a) => (
                <span key={a.app} className="app-chip">
                  <span className={`kind-dot kind-${a.kind}`} />
                  {a.app} <span className="app-chip-min">{formatMinutes(a.minutes)}</span>
                </span>
              ))}
              <span className="tlb-apps-caret">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <ul className="tl-titles">
                {b.apps.flatMap((a) =>
                  a.titles.slice(0, 8).map((t) => (
                    <li key={`${a.app}|${t.title}`}>
                      <span className={`kind-dot kind-${a.kind}`} />
                      <span className="tl-app">{a.app}</span>
                      <span className="tl-text">{t.title || '(no title)'}</span>
                      <span className="tl-minutes">{formatMinutes(t.minutes)}</span>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        )}
      </li>
    )
  }

  return (
    <div className="feed timeline">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Timeline</h2>
          <span className="feed-sub">
            {date === today ? 'Today · ' : ''}
            {longDay.format(parseLocal(date))}
            {notes && buckets.length > 0 ? ` · ${formatMinutes(totals.tasked)} on tasks · ${formatMinutes(totals.screen)} screen` : ''}
          </span>
          <span className="spacer" />
          <select className="move-select" value={interval} onChange={(ev) => changeInterval(Number(ev.target.value))} title="Interval">
            {INTERVALS.map((v) => (
              <option key={v} value={v}>
                {v} min
              </option>
            ))}
          </select>
          <label className="check check-inline">
            <input type="checkbox" checked={showSystem} onChange={(ev) => setShowSystem(ev.target.checked)} /> System
          </label>
          <label className="check check-inline">
            <input type="checkbox" checked={showApps} onChange={(ev) => setShowApps(ev.target.checked)} /> Apps
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
      {notes && buckets.length === 0 && <p className="feed-empty">Nothing recorded on this day.</p>}
      <ol className="tlb-list">{rows}</ol>
    </div>
  )
}
