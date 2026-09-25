import { useEffect, useMemo, useState } from 'react'
import { localDate, previewText } from '@devlog/core'
import { JOURNAL_ID, ancestorIds, canvasLabel } from '@devlog/core'
import { APP_KIND_LABEL, activeExclusions, splitByLocalDay, type AppKind } from '@shared/activity'
import { reported } from '@renderer/toasts'
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
import type { ActivityEvent, CanvasMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  canvases: CanvasMeta[]
  today: string
  focusMinSeconds: number
  onJumpTo: (canvasId: string, date: string) => void
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

const hhmm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `iso`'s local day at the given HH:MM, as an ISO instant. */
const atTime = (iso: string, value: string): string => {
  const d = new Date(iso)
  const [h, m] = value.split(':').map(Number)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

/**
 * One tracked stretch in the day detail, with Trim (narrow it to the hours
 * that were real) and Remove. Both record exclusions; the raw log is untouched.
 */
function SegmentRow({
  seg,
  label,
  onExclude
}: {
  seg: { canvasId: string; start: string; end: string; minutes: number; source: string }
  label: string
  onExclude: (windows: Array<{ start: string; end: string }>) => Promise<void>
}): React.JSX.Element {
  const [trimming, setTrimming] = useState(false)
  const [from, setFrom] = useState(hhmm(seg.start))
  const [to, setTo] = useState(hhmm(seg.end))
  const [error, setError] = useState<string | null>(null)
  const editable = seg.source === 'tracked'

  const saveTrim = async (): Promise<void> => {
    const newStart = atTime(seg.start, from)
    const newEnd = atTime(seg.start, to)
    if (newEnd <= newStart) return setError('End must be after start')
    if (newStart < seg.start || newEnd > seg.end) return setError(`Stay within ${hhmm(seg.start)}–${hhmm(seg.end)}`)
    const windows: Array<{ start: string; end: string }> = []
    if (newStart > seg.start) windows.push({ start: seg.start, end: newStart })
    if (newEnd < seg.end) windows.push({ start: newEnd, end: seg.end })
    if (windows.length) await onExclude(windows)
    setTrimming(false)
    setError(null)
  }

  if (trimming) {
    return (
      <li className="seg-trim">
        <input type="time" value={from} onChange={(ev) => setFrom(ev.target.value)} aria-label="Start" />
        <span>–</span>
        <input type="time" value={to} onChange={(ev) => setTo(ev.target.value)} aria-label="End" />
        <span className="review-note-text">{label}</span>
        <button type="button" className="btn btn-primary btn-xs" onClick={() => void saveTrim()}>
          Save
        </button>
        <button type="button" className="btn btn-quiet btn-xs" onClick={() => setTrimming(false)}>
          Cancel
        </button>
        {error && <span className="form-error">{error}</span>}
      </li>
    )
  }
  return (
    <li className="seg-row">
      <time>
        {timeFmt.format(new Date(seg.start))}–{timeFmt.format(new Date(seg.end))}
      </time>
      <span className="review-note-text">{label}</span>
      <span className="review-note-minutes">
        {formatMinutes(seg.minutes)}
        {seg.source === 'explicit' ? ' ✎' : ''}
      </span>
      {editable && (
        <span className="seg-actions">
          <button type="button" className="btn btn-quiet btn-xs" onClick={() => setTrimming(true)} title="Keep only the part of this stretch you actually worked">
            Trim
          </button>
          <button type="button" className="btn btn-quiet btn-xs" onClick={() => void onExclude([{ start: seg.start, end: seg.end }])} title="Remove this stretch from the task (the raw activity log is kept)">
            Remove
          </button>
        </span>
      )}
    </li>
  )
}

export function Review({ canvases, today, focusMinSeconds, onJumpTo, onOpenTimeline }: Props): React.JSX.Element {
  const [reload, setReload] = useState(0)
  const [start, setStart] = useState(() => weekStart(today))
  const [notes, setNotes] = useState<ReviewNote[] | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const dates = useMemo(() => weekDates(start), [start])
  const end = dates[6]

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    void Promise.all([api.blocks.range(start, end), api.activity.range(start, end)]).then(([chunks, evs]) => {
      if (cancelled) return
      const flat: ReviewNote[] = []
      for (const { canvasId, day } of chunks) {
        for (const entry of day.entries) {
          // Attribute by when it was written; replies can live in an older day file.
          const date = localDate(new Date(entry.createdAt))
          if (date >= start && date <= end) flat.push({ canvasId, date, entry })
        }
      }
      setNotes(flat)
      setEvents(evs)
    })
    return () => {
      cancelled = true
    }
  }, [start, end, reload])

  const exclude = async (windows: Array<{ start: string; end: string }>): Promise<void> => {
    for (const w of windows) await api.activity.exclude(w.start, w.end)
    setReload((n) => n + 1)
  }
  const removedByDay = useMemo(() => {
    const m = new Map<string, Array<{ id: string; start: string; end: string }>>()
    for (const w of activeExclusions(events)) {
      const d = localDate(new Date(w.start))
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(w)
    }
    return m
  }, [events])

  const time = useMemo(() => computeWeekTime(notes ?? [], events, { dates, estimate: DEFAULT_ESTIMATE, focusMinSeconds }), [notes, events, dates, focusMinSeconds])
  const rows = useMemo(() => buildReviewRows(canvases, notes ?? [], time.byCanvasDay), [canvases, notes, time])
  const byId = useMemo(() => new Map(canvases.map((c) => [c.id, c])), [canvases])
  const pageLabel = (id: string): string => canvasLabel(canvases, id)

  const dayTotals = useMemo(() => {
    const t = new Map<string, { notes: number; minutes: number }>()
    for (const d of dates) t.set(d, { notes: 0, minutes: 0 })
    for (const n of notes ?? []) t.get(n.date)!.notes += 1
    for (const [date, perPage] of time.byCanvasDay) {
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
    const m = new Map<string, Array<{ canvasId: string; start: string; end: string; minutes: number; source: string }>>()
    for (const piece of splitByLocalDay(time.taskSegments)) {
      if (!m.has(piece.date)) m.set(piece.date, [])
      m.get(piece.date)!.push({ ...piece.segment, minutes: piece.minutes })
    }
    return m
  }, [time])

  const renderRow = (row: ReviewRow): React.JSX.Element => (
    <>
      <tr key={row.canvasId} className={`review-row review-${row.task ? 'task' : row.children.length ? 'category' : 'page'} depth-${Math.min(row.depth, 3)}`}>
        <th scope="row" style={{ paddingLeft: 10 + row.depth * 16 }}>
          <button type="button" className="link" onClick={() => onJumpTo(row.canvasId, dates.find((d) => row.cells.has(d)) ?? today)}>
            {row.task ? '◉ ' : ''}
            {row.label}
          </button>
        </th>
        {dates.map((d) => {
          const cell = row.cells.get(d)
          return (
            <td key={d} className={`review-cell${d === today ? ' is-today' : ''}${cell ? ' has-notes' : ''}`}>
              {cell && (
                <>
                  <span className="cell-minutes">{Math.round(cell.minutes) >= 1 ? formatMinutes(cell.minutes) : '·'}</span>
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
      .filter((d) => byDate.has(d) || (time.byCanvasDay.get(d)?.size ?? 0) > 0 || removedByDay.has(d))
      .map((d) => {
        const perPage = time.byCanvasDay.get(d) ?? new Map<string, number>()
        const groups = new Map<string, { label: string; minutes: number; sub: Map<string, { label: string; minutes: number; notes: ReviewNote[] }> }>()
        const touch = (canvasId: string): { label: string; minutes: number; notes: ReviewNote[] } => {
          const chain = [...ancestorIds(canvases, canvasId).reverse(), canvasId]
          const topId = chain[0]
          const top = byId.get(topId)
          const topLabel = topId === JOURNAL_ID ? 'Journal' : (top?.title ?? topId)
          if (!groups.has(topId)) groups.set(topId, { label: topLabel, minutes: 0, sub: new Map() })
          const g = groups.get(topId)!
          if (!g.sub.has(canvasId)) {
            const rest = chain.slice(1).map((id) => byId.get(id)?.title ?? id)
            g.sub.set(canvasId, { label: rest.join(' / '), minutes: 0, notes: [] })
          }
          return g.sub.get(canvasId)!
        }
        for (const n of byDate.get(d) ?? []) touch(n.canvasId).notes.push(n)
        for (const [canvasId, minutes] of perPage) {
          const s = touch(canvasId)
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
  }, [notes, dates, byId, canvases, time, removedByDay])

  return (
    <div className="feed review">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Weekly review</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(start))} – {rangeFmt.format(parseLocal(end))}
            {notes ? ` · ${weekNotes} block${weekNotes === 1 ? '' : 's'} · ${anyEstimated && !anyTracked ? '~' : ''}${formatMinutes(weekMinutes)}` : ''}
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
                              <button type="button" className="review-note-link" onClick={() => onJumpTo(n.canvasId, n.date)} title="Open on its canvas">
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
                {(segs.length > 0 || removedByDay.has(d.date) || (focus && focus.total > 0)) && (
                  <div className="review-activity">
                    {(segs.length > 0 || removedByDay.has(d.date)) && (
                      <div className="review-activity-col">
                        <div className="review-sub-head">
                          <span>Task time</span>
                        </div>
                        <ul className="review-segments">
                          {segs.map((sg) => (
                            <SegmentRow key={`${sg.canvasId}-${sg.start}`} seg={sg} label={pageLabel(sg.canvasId)} onExclude={(w) => reported(exclude(w))} />
                          ))}
                        </ul>
                        {removedByDay.has(d.date) && (
                          <ul className="review-removed">
                            {removedByDay.get(d.date)!.map((w) => (
                              <li key={w.id}>
                                <span>
                                  Removed {timeFmt.format(new Date(w.start))}–{timeFmt.format(new Date(w.end))}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn-quiet btn-xs"
                                  onClick={() =>
                                    void reported(
                                      api.activity.restore(w.id, w.start).then(() => {
                                        setReload((n) => n + 1)
                                      })
                                    )
                                  }
                                >
                                  Restore
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
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
