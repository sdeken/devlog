import { useEffect, useMemo, useState } from 'react'
import { localDate, previewText } from '@shared/entries'
import { JOURNAL_PAGE_ID, categoryPath } from '@shared/pages'
import { APP_KIND_LABEL, splitByLocalDay, type AppKind } from '@shared/activity'
import {
  DEFAULT_ESTIMATE,
  addDays,
  buildReviewRows,
  computeWeekTime,
  formatMinutes,
  noteKey,
  weekDates,
  weekStart,
  type ReviewNote,
  type ReviewRow
} from '@shared/review'
import type { ActivityEvent, PageMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  pages: PageMeta[]
  today: string
  onJumpTo: (pageId: string, date: string) => void
  onOpenTimeline: (date: string) => void
}

const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dayNum = new Intl.DateTimeFormat(undefined, { day: 'numeric' })
const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const rangeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const KIND_ORDER: AppKind[] = ['coding', 'terminal', 'meeting', 'comms', 'browser', 'devlog', 'other']

export function Review({ pages, today, onJumpTo, onOpenTimeline }: Props): React.JSX.Element {
  const [start, setStart] = useState(() => weekStart(today))
  const [notes, setNotes] = useState<ReviewNote[] | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const dates = useMemo(() => weekDates(start), [start])
  const end = dates[6]

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    void Promise.all([api.entries.range(start, end), api.activity.range(start, end)]).then(([chunks, evs]) => {
      if (cancelled) return
      const flat: ReviewNote[] = []
      for (const { pageId, day } of chunks) {
        for (const entry of day.entries) {
          // Attribute by when it was written; replies can live in an older day file.
          const date = localDate(new Date(entry.createdAt))
          if (date >= start && date <= end) flat.push({ pageId, date, entry })
        }
      }
      setNotes(flat)
      setEvents(evs)
    })
    return () => {
      cancelled = true
    }
  }, [start, end])

  const time = useMemo(() => computeWeekTime(notes ?? [], events, { dates, estimate: DEFAULT_ESTIMATE }), [notes, events, dates])
  const rows = useMemo(() => buildReviewRows(pages, notes ?? [], time.byPageDay), [pages, notes, time])
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])
  const pageLabel = (id: string): string => {
    if (id === JOURNAL_PAGE_ID) return 'Journal'
    const p = pageById.get(id)
    if (!p) return id
    return [...categoryPath(p.category), p.title].join(' / ')
  }

  const dayTotals = useMemo(() => {
    const t = new Map<string, { notes: number; minutes: number }>()
    for (const d of dates) t.set(d, { notes: 0, minutes: 0 })
    for (const n of notes ?? []) t.get(n.date)!.notes += 1
    for (const [date, perPage] of time.byPageDay) {
      const cell = t.get(date)
      if (cell) for (const m of perPage.values()) cell.minutes += m
    }
    return t
  }, [notes, time, dates])
  const weekMinutes = [...dayTotals.values()].reduce((n, c) => n + c.minutes, 0)
  const weekNotes = notes?.length ?? 0
  const anyEstimated = [...time.method.values()].includes('estimated')
  const anyTracked = [...time.method.values()].includes('tracked')

  const segmentsByDay = useMemo(() => {
    const m = new Map<string, Array<{ pageId: string; start: string; end: string; minutes: number; source: string }>>()
    for (const piece of splitByLocalDay(time.taskSegments)) {
      if (!m.has(piece.date)) m.set(piece.date, [])
      m.get(piece.date)!.push({ ...piece.segment, minutes: piece.minutes })
    }
    return m
  }, [time])

  const renderRow = (row: ReviewRow): React.JSX.Element => (
    <>
      <tr key={row.key} className={`review-row review-${row.kind} depth-${Math.min(row.depth, 3)}`}>
        <th scope="row" style={{ paddingLeft: 10 + row.depth * 16 }}>
          {row.kind === 'page' && row.pageId ? (
            <button type="button" className="link" onClick={() => onJumpTo(row.pageId!, dates.find((d) => row.cells.has(d)) ?? today)}>
              {row.label}
            </button>
          ) : (
            row.label
          )}
        </th>
        {dates.map((d) => {
          const cell = row.cells.get(d)
          return (
            <td key={d} className={`review-cell${d === today ? ' is-today' : ''}${cell ? ' has-notes' : ''}`}>
              {cell && (
                <>
                  <span className="cell-minutes">{cell.minutes > 0 ? formatMinutes(cell.minutes) : '·'}</span>
                  <span className="cell-notes">{cell.notes > 0 ? cell.notes : ''}</span>
                </>
              )}
            </td>
          )
        })}
        <td className="review-cell review-total">
          <span className="cell-minutes">{formatMinutes(row.totalMinutes)}</span>
          <span className="cell-notes">{row.totalNotes}</span>
        </td>
      </tr>
      {row.children.map(renderRow)}
    </>
  )

  // Per-day detail: top-level category → page → notes, plus time and activity.
  const detail = useMemo(() => {
    const byDate = new Map<string, ReviewNote[]>()
    for (const n of notes ?? []) {
      if (!byDate.has(n.date)) byDate.set(n.date, [])
      byDate.get(n.date)!.push(n)
    }
    return dates
      .filter((d) => byDate.has(d) || (time.byPageDay.get(d)?.size ?? 0) > 0)
      .map((d) => {
        const perPage = time.byPageDay.get(d) ?? new Map<string, number>()
        const groups = new Map<string, { label: string; minutes: number; sub: Map<string, { label: string; minutes: number; notes: ReviewNote[] }> }>()
        const touch = (pageId: string): { label: string; minutes: number; notes: ReviewNote[] } => {
          const page = pageById.get(pageId)
          const path = pageId === JOURNAL_PAGE_ID ? [] : categoryPath(page?.category ?? '')
          const title = pageId === JOURNAL_PAGE_ID ? 'Journal' : (page?.title ?? pageId)
          const topKey = path[0] ?? `page:${pageId}`
          if (!groups.has(topKey)) groups.set(topKey, { label: path[0] ?? title, minutes: 0, sub: new Map() })
          const g = groups.get(topKey)!
          if (!g.sub.has(pageId)) {
            g.sub.set(pageId, { label: [...path.slice(1), path.length > 0 ? title : ''].filter(Boolean).join(' / '), minutes: 0, notes: [] })
          }
          return g.sub.get(pageId)!
        }
        for (const n of byDate.get(d) ?? []) touch(n.pageId).notes.push(n)
        for (const [pageId, minutes] of perPage) {
          const s = touch(pageId)
          s.minutes += minutes
        }
        for (const g of groups.values()) g.minutes = [...g.sub.values()].reduce((s, x) => s + x.minutes, 0)
        return {
          date: d,
          groups: [...groups.values()]
            .map((g) => ({
              ...g,
              subs: [...g.sub.values()]
                .map((s) => ({ ...s, notes: [...s.notes].sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt)) }))
                .sort((a, b) => b.minutes - a.minutes)
            }))
            .sort((a, b) => b.minutes - a.minutes)
        }
      })
  }, [notes, dates, pageById, time])

  return (
    <div className="feed review">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Weekly review</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(start))} – {rangeFmt.format(parseLocal(end))}
            {notes ? ` · ${weekNotes} note${weekNotes === 1 ? '' : 's'} · ${anyEstimated && !anyTracked ? '~' : ''}${formatMinutes(weekMinutes)}` : ''}
          </span>
          <span className="spacer" />
          <div className="week-nav">
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(addDays(start, -7))} title="Previous week">
              ‹
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(weekStart(today))} disabled={start === weekStart(today)}>
              This week
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(addDays(start, 7))} disabled={start >= weekStart(today)} title="Next week">
              ›
            </button>
          </div>
        </div>
      </header>

      {notes === null && <p className="feed-empty">Loading…</p>}
      {notes && notes.length === 0 && weekMinutes === 0 && <p className="feed-empty">Nothing this week.</p>}

      {notes && (notes.length > 0 || weekMinutes > 0) && (
        <>
          <div className="review-table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th scope="col" className="review-corner">
                    Client / project / page
                  </th>
                  {dates.map((d) => (
                    <th key={d} scope="col" className={`review-day${d === today ? ' is-today' : ''}`}>
                      <button type="button" className="review-day-btn" onClick={() => onOpenTimeline(d)} title="Open day timeline">
                        <span className="review-day-name">{dayHead.format(parseLocal(d))}</span>
                        <span className="review-day-num">{dayNum.format(parseLocal(d))}</span>
                      </button>
                      {time.method.get(d) === 'estimated' && (
                        <span className="review-method" title="No tracking data for this day; estimated from note timestamps">
                          ~
                        </span>
                      )}
                    </th>
                  ))}
                  <th scope="col" className="review-day review-total">
                    Week
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(renderRow)}
                <tr className="review-row review-sum">
                  <th scope="row">Total</th>
                  {dates.map((d) => {
                    const cell = dayTotals.get(d)
                    return (
                      <td key={d} className={`review-cell${d === today ? ' is-today' : ''}`}>
                        {cell && (cell.notes > 0 || cell.minutes > 0) && (
                          <>
                            <span className="cell-minutes">{formatMinutes(cell.minutes)}</span>
                            <span className="cell-notes">{cell.notes || ''}</span>
                          </>
                        )}
                      </td>
                    )
                  })}
                  <td className="review-cell review-total">
                    <span className="cell-minutes">{formatMinutes(weekMinutes)}</span>
                    <span className="cell-notes">{weekNotes}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="review-note">
            Time is tracked live: a page becomes the active task when you post on it and stays active until you post elsewhere, stop it, lock the
            machine, go idle or sleep. A note with a duration like <code>[2h]</code> or <code>[45m]</code> overrides tracking for that window.
            {anyEstimated && ' Days marked ~ have no tracking data and are estimated from note timing.'}
          </p>

          {detail.map((d) => {
            const focus = time.focus.get(d.date)
            const segs = segmentsByDay.get(d.date) ?? []
            return (
              <section key={d.date} className="review-day-section">
                <h3>
                  <button type="button" className="link" onClick={() => onOpenTimeline(d.date)} title="Open day timeline">
                    {longDay.format(parseLocal(d.date))}
                  </button>
                  <span className="feed-sub"> · {formatMinutes(dayTotals.get(d.date)?.minutes ?? 0)}</span>
                </h3>
                {d.groups.map((g) => (
                  <div key={g.label} className="review-group">
                    <div className="review-group-head">
                      <span className="review-group-label">{g.label}</span>
                      <span className="review-group-minutes">{formatMinutes(g.minutes)}</span>
                    </div>
                    {g.subs.map((s) => (
                      <div key={s.label || g.label} className="review-sub">
                        {s.label && (
                          <div className="review-sub-head">
                            <span>{s.label}</span>
                            <span className="review-group-minutes">{formatMinutes(s.minutes)}</span>
                          </div>
                        )}
                        <ul className="review-notes">
                          {s.notes.map((n) => (
                            <li key={noteKey(n)}>
                              <button type="button" className="review-note-link" onClick={() => onJumpTo(n.pageId, n.date)} title="Open on its page">
                                <time>{timeFmt.format(new Date(n.entry.createdAt))}</time>
                                <span className="review-note-text">
                                  {n.entry.parentId ? '↳ ' : ''}
                                  {previewText(n.entry.markdown, 140)}
                                </span>
                                {time.explicitByNote.has(noteKey(n)) && (
                                  <span className="duration-chip" title="Explicit duration">
                                    {formatMinutes(time.explicitByNote.get(noteKey(n))!)}
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ))}
                {(segs.length > 0 || (focus && focus.total > 0)) && (
                  <div className="review-activity">
                    {segs.length > 0 && (
                      <div className="review-activity-col">
                        <div className="review-sub-head">
                          <span>Task time</span>
                        </div>
                        <ul className="review-segments">
                          {segs.map((sg, i) => (
                            <li key={i}>
                              <time>
                                {timeFmt.format(new Date(sg.start))}–{timeFmt.format(new Date(sg.end))}
                              </time>
                              <span className="review-note-text">{pageLabel(sg.pageId)}</span>
                              <span className="review-note-minutes">
                                {formatMinutes(sg.minutes)}
                                {sg.source === 'explicit' ? ' ✎' : ''}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {focus && focus.total > 0 && (
                      <div className="review-activity-col">
                        <div className="review-sub-head">
                          <span>Screen time</span>
                          <span className="review-group-minutes">{formatMinutes(focus.total)}</span>
                        </div>
                        <ul className="review-kinds">
                          {KIND_ORDER.filter((k) => focus.kinds.has(k)).map((k) => (
                            <li key={k}>
                              <span className={`kind-dot kind-${k}`} />
                              <span className="review-note-text">{APP_KIND_LABEL[k]}</span>
                              <span className="review-note-minutes">{formatMinutes(focus.kinds.get(k)!)}</span>
                            </li>
                          ))}
                        </ul>
                        <ul className="review-apps">
                          {focus.apps.slice(0, 6).map((a) => (
                            <li key={a.app} title={a.titles.slice(0, 5).map((t) => `${t.title} (${formatMinutes(t.minutes)})`).join('\n')}>
                              <span className={`kind-dot kind-${a.kind}`} />
                              <span className="review-note-text">{a.app}</span>
                              <span className="review-note-minutes">{formatMinutes(a.minutes)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
