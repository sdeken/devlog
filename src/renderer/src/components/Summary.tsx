import { useEffect, useMemo, useState } from 'react'
import { localDate } from '@devlog/core'
import { addDays, buildReviewRows, computeWeekTime, formatHours, formatMinutes, roundMinutes, weekStart, type ReviewNote, type ReviewRow } from '@shared/review'
import type { ActivityEvent, CanvasMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  canvases: CanvasMeta[]
  today: string
  focusMinSeconds: number
  onOpenCanvas: (id: string, date?: string) => void
}

type RangeKind = 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'custom'

const rangeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
const GRAN_KEY = 'devlog:summary:granularity'

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`
}

function monthEnd(date: string): string {
  const [y, m] = date.split('-').map(Number)
  return localDate(new Date(y, m, 0))
}

function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  let d = from
  while (d <= to && out.length < 400) {
    out.push(d)
    d = addDays(d, 1)
  }
  return out
}

export function Summary({ canvases, today, focusMinSeconds, onOpenCanvas }: Props): React.JSX.Element {
  const [kind, setKind] = useState<RangeKind>('week')
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: weekStart(today), to: today })
  const [granularity, setGranularity] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(GRAN_KEY)) || 15
    } catch {
      return 15
    }
  })
  const [notes, setNotes] = useState<ReviewNote[] | null>(null)
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const range = useMemo(() => {
    switch (kind) {
      case 'week':
        return { from: weekStart(today), to: addDays(weekStart(today), 6) }
      case 'lastWeek':
        return { from: addDays(weekStart(today), -7), to: addDays(weekStart(today), -1) }
      case 'month':
        return { from: monthStart(today), to: monthEnd(today) }
      case 'lastMonth': {
        const prev = addDays(monthStart(today), -1)
        return { from: monthStart(prev), to: prev }
      }
      default:
        return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from }
    }
  }, [kind, custom, today])
  const dates = useMemo(() => datesBetween(range.from, range.to), [range])

  useEffect(() => {
    let cancelled = false
    setNotes(null)
    void Promise.all([api.blocks.range(range.from, range.to), api.activity.range(range.from, range.to)]).then(([chunks, evs]) => {
      if (cancelled) return
      const flat: ReviewNote[] = []
      for (const { canvasId, day } of chunks) {
        for (const entry of day.entries) {
          const date = localDate(new Date(entry.createdAt))
          if (date >= range.from && date <= range.to) flat.push({ canvasId, date, entry })
        }
      }
      setNotes(flat)
      setEvents(evs)
    })
    return () => {
      cancelled = true
    }
  }, [range])

  const time = useMemo(() => computeWeekTime(notes ?? [], events, { dates, focusMinSeconds }), [notes, events, dates, focusMinSeconds])
  const rows = useMemo(() => buildReviewRows(canvases, notes ?? [], time.byCanvasDay), [canvases, notes, time])
  const total = rows.reduce((n, r) => n + r.totalMinutes, 0)
  const roundedSum = rows.reduce((n, r) => n + roundMinutes(r.totalMinutes, granularity), 0)

  const changeGranularity = (v: number): void => {
    const g = Math.max(1, Math.min(120, Math.round(v) || 15))
    setGranularity(g)
    try {
      localStorage.setItem(GRAN_KEY, String(g))
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

  const rowLabel = (row: ReviewRow): React.JSX.Element => (
    <button type="button" className="link" onClick={() => onOpenCanvas(row.canvasId, dates.find((d) => row.cells.has(d)) ?? today)}>
      {row.task ? '◉ ' : ''}
      {row.label}
    </button>
  )

  const renderChild = (row: ReviewRow, depth: number): React.JSX.Element => (
    <li key={row.canvasId} className={`sum-child depth-${depth}`}>
      <span className="sum-label" style={{ paddingLeft: depth * 16 }}>
        {rowLabel(row)}
      </span>
      <span className="sum-notes">{row.totalNotes ? `${row.totalNotes} blocks` : ''}</span>
      <span className="sum-exact">{formatMinutes(row.totalMinutes)}</span>
      <span className="sum-hours">{formatHours(roundMinutes(row.totalMinutes, granularity))}</span>
      {row.children.length > 0 && <ul className="sum-children">{row.children.map((c) => renderChild(c, depth + 1))}</ul>}
    </li>
  )

  return (
    <div className="feed summary">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Summary</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(range.from))} – {rangeFmt.format(parseLocal(range.to))}
            {notes ? ` · ${formatHours(roundMinutes(total, granularity))}` : ''}
          </span>
          <span className="spacer" />
          <select className="move-select" value={kind} onChange={(ev) => setKind(ev.target.value as RangeKind)}>
            <option value="week">This week</option>
            <option value="lastWeek">Last week</option>
            <option value="month">This month</option>
            <option value="lastMonth">Last month</option>
            <option value="custom">Custom…</option>
          </select>
          {kind === 'custom' && (
            <span className="sum-custom">
              <input type="date" value={custom.from} max={today} onChange={(ev) => setCustom({ ...custom, from: ev.target.value })} />
              <span>–</span>
              <input type="date" value={custom.to} max={today} onChange={(ev) => setCustom({ ...custom, to: ev.target.value })} />
            </span>
          )}
          <label className="check check-inline" title="Round each item to the nearest N minutes">
            nearest
            <input type="number" className="sum-gran" min={1} max={120} value={granularity} onChange={(ev) => changeGranularity(Number(ev.target.value))} />
            min
          </label>
        </div>
      </header>

      {notes === null && <p className="feed-empty">Loading…</p>}
      {notes && rows.length === 0 && <p className="feed-empty">No tracked time in this range.</p>}

      {notes && rows.length > 0 && (
        <>
          <ul className="sum-list">
            {rows.map((row) => {
              const open = expanded.has(row.canvasId)
              return (
                <li key={row.canvasId} className="sum-row">
                  <div className="sum-top">
                    <button type="button" className="sum-toggle" onClick={() => toggle(row.canvasId)} disabled={row.children.length === 0} title={row.children.length ? (open ? 'Collapse' : 'Expand') : ''}>
                      {row.children.length ? (open ? '▾' : '▸') : '·'}
                    </button>
                    <span className="sum-label">{rowLabel(row)}</span>
                    <span className="sum-bar" aria-hidden="true">
                      <span style={{ width: `${total > 0 ? Math.round((row.totalMinutes / total) * 100) : 0}%` }} />
                    </span>
                    <span className="sum-notes">{row.totalNotes ? `${row.totalNotes} blocks` : ''}</span>
                    <span className="sum-exact" title="Tracked time before rounding">
                      {formatMinutes(row.totalMinutes)}
                    </span>
                    <span className="sum-hours">{formatHours(roundMinutes(row.totalMinutes, granularity))}</span>
                  </div>
                  {open && row.children.length > 0 && <ul className="sum-children">{row.children.map((c) => renderChild(c, 1))}</ul>}
                </li>
              )
            })}
            <li className="sum-row sum-total">
              <div className="sum-top">
                <span className="sum-toggle" />
                <span className="sum-label">Total</span>
                <span className="sum-bar" />
                <span className="sum-notes">{notes.length} blocks</span>
                <span className="sum-exact">{formatMinutes(total)}</span>
                <span className="sum-hours">{formatHours(roundMinutes(total, granularity))}</span>
              </div>
            </li>
          </ul>
          <p className="review-note">
            Hours are each item's tracked time rounded to the nearest {granularity} minutes; the exact figure sits beside it.
            {Math.abs(roundedSum - roundMinutes(total, granularity)) >= 1 && ` Rounded items add up to ${formatHours(roundedSum)}; the total is rounded separately.`}
          </p>
        </>
      )}
    </div>
  )
}
