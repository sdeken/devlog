import { useEffect, useMemo, useState } from 'react'
import { localDate, previewText } from '@shared/entries'
import { JOURNAL_PAGE_ID, categoryPath } from '@shared/pages'
import {
  DEFAULT_ESTIMATE,
  addDays,
  buildReviewRows,
  estimateMinutes,
  formatMinutes,
  noteKey,
  weekDates,
  weekStart,
  type ReviewNote,
  type ReviewRow
} from '@shared/review'
import type { PageMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  pages: PageMeta[]
  today: string
  onJumpTo: (pageId: string, date: string) => void
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

const CAP_KEY = 'devlog:review:cap'

export function Review({ pages, today, onJumpTo }: Props): React.JSX.Element {
  const [start, setStart] = useState(() => weekStart(today))
  const [notes, setNotes] = useState<ReviewNote[] | null>(null)
  const [cap, setCap] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(CAP_KEY)) || DEFAULT_ESTIMATE.capMinutes
    } catch {
      return DEFAULT_ESTIMATE.capMinutes
    }
  })
  const dates = useMemo(() => weekDates(start), [start])
  const end = dates[6]

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    void api.entries.range(start, end).then((chunks) => {
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
    })
    return () => {
      cancelled = true
    }
  }, [start, end])

  const minutes = useMemo(() => estimateMinutes(notes ?? [], { ...DEFAULT_ESTIMATE, capMinutes: cap }), [notes, cap])
  const rows = useMemo(() => buildReviewRows(pages, notes ?? [], minutes), [pages, notes, minutes])
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages])

  const dayTotals = useMemo(() => {
    const t = new Map<string, { notes: number; minutes: number }>()
    for (const n of notes ?? []) {
      const cell = t.get(n.date) ?? { notes: 0, minutes: 0 }
      cell.notes += 1
      cell.minutes += minutes.get(noteKey(n)) ?? 0
      t.set(n.date, cell)
    }
    return t
  }, [notes, minutes])
  const weekMinutes = [...dayTotals.values()].reduce((n, c) => n + c.minutes, 0)
  const weekNotes = notes?.length ?? 0

  const changeCap = (v: number): void => {
    setCap(v)
    try {
      localStorage.setItem(CAP_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

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
                  <span className="cell-minutes">{formatMinutes(cell.minutes)}</span>
                  <span className="cell-notes">{cell.notes}</span>
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

  // Per-day detail: top-level category → sub-path → page → notes.
  const detail = useMemo(() => {
    const byDate = new Map<string, ReviewNote[]>()
    for (const n of notes ?? []) {
      if (!byDate.has(n.date)) byDate.set(n.date, [])
      byDate.get(n.date)!.push(n)
    }
    return dates
      .filter((d) => byDate.has(d))
      .map((d) => {
        const groups = new Map<string, { label: string; sub: Map<string, { label: string; notes: ReviewNote[] }> }>()
        for (const n of byDate.get(d)!) {
          const page = pageById.get(n.pageId)
          const path = n.pageId === JOURNAL_PAGE_ID ? [] : categoryPath(page?.category ?? '')
          const title = n.pageId === JOURNAL_PAGE_ID ? 'Journal' : (page?.title ?? n.pageId)
          const topKey = path[0] ?? `page:${n.pageId}`
          const topLabel = path[0] ?? title
          const subLabel = [...path.slice(1), path.length > 0 ? title : ''].filter(Boolean).join(' / ')
          const subKey = `${n.pageId}`
          if (!groups.has(topKey)) groups.set(topKey, { label: topLabel, sub: new Map() })
          const g = groups.get(topKey)!
          if (!g.sub.has(subKey)) g.sub.set(subKey, { label: subLabel, notes: [] })
          g.sub.get(subKey)!.notes.push(n)
        }
        const sum = (list: ReviewNote[]): number => list.reduce((s, n) => s + (minutes.get(noteKey(n)) ?? 0), 0)
        return {
          date: d,
          groups: [...groups.values()]
            .map((g) => {
              const subs = [...g.sub.values()].map((s) => ({
                ...s,
                notes: [...s.notes].sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt)),
                minutes: sum(s.notes)
              }))
              return { label: g.label, subs: subs.sort((a, b) => b.minutes - a.minutes), minutes: subs.reduce((s, x) => s + x.minutes, 0) }
            })
            .sort((a, b) => b.minutes - a.minutes)
        }
      })
  }, [notes, dates, pageById, minutes])

  return (
    <div className="feed review">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Weekly review</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(start))} – {rangeFmt.format(parseLocal(end))}
            {notes ? ` · ${weekNotes} note${weekNotes === 1 ? '' : 's'} · ~${formatMinutes(weekMinutes)}` : ''}
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
      {notes && notes.length === 0 && <p className="feed-empty">No notes this week.</p>}

      {notes && notes.length > 0 && (
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
                      <span className="review-day-name">{dayHead.format(parseLocal(d))}</span>
                      <span className="review-day-num">{dayNum.format(parseLocal(d))}</span>
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
                        {cell && (
                          <>
                            <span className="cell-minutes">{formatMinutes(cell.minutes)}</span>
                            <span className="cell-notes">{cell.notes}</span>
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
            Time is estimated from note timestamps: each note counts until the next note that day (any page), capped at{' '}
            <select className="move-select" value={cap} onChange={(ev) => changeCap(Number(ev.target.value))}>
              {[15, 30, 45, 60, 90, 120].map((v) => (
                <option key={v} value={v}>
                  {formatMinutes(v)}
                </option>
              ))}
            </select>
            ; the last note of a day counts {formatMinutes(DEFAULT_ESTIMATE.lastNoteMinutes)}. Log a note when you switch tasks and the
            estimate gets better.
          </p>

          {detail.map((d) => (
            <section key={d.date} className="review-day-section">
              <h3>
                {longDay.format(parseLocal(d.date))}
                <span className="feed-sub"> · ~{formatMinutes(dayTotals.get(d.date)?.minutes ?? 0)}</span>
              </h3>
              {d.groups.map((g) => (
                <div key={g.label} className="review-group">
                  <div className="review-group-head">
                    <span className="review-group-label">{g.label}</span>
                    <span className="review-group-minutes">~{formatMinutes(g.minutes)}</span>
                  </div>
                  {g.subs.map((s) => (
                    <div key={s.label || g.label} className="review-sub">
                      {s.label && (
                        <div className="review-sub-head">
                          <span>{s.label}</span>
                          <span className="review-group-minutes">~{formatMinutes(s.minutes)}</span>
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
                              <span className="review-note-minutes">{formatMinutes(minutes.get(noteKey(n)) ?? 0)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}
