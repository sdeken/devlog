/**
 * The targets that apply to the week on screen: each measured on its own,
 * against the timesheet hours under its canvas in its own period (this
 * week, or the months the week touches). Other weeks of those months count
 * as saved, or as drafted from tracked time when not saved yet.
 */
import { useEffect, useMemo, useState } from 'react'
import { canvasLabel, localDate, type Timesheet as Sheet, type TimesheetEntry } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import { monthsOfWeek, targetHours, targetsFor, weeksOfMonth } from '../targets'

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const hm = (minutes: number): string => {
  const m = Math.round(minutes)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

interface Props {
  canvases: CanvasMeta[]
  week: string
  sheet: Sheet
  /** Another week's timesheet: saved, or a draft from tracked time. */
  loadWeek: (week: string) => Promise<Sheet>
}

export function Targets({ canvases, week, sheet, loadWeek }: Props): React.JSX.Element | null {
  const anyMonthly = canvases.some((c) => targetHours(c.fields?.target_month) !== null)
  const anyWeekly = canvases.some((c) => targetHours(c.fields?.target_week) !== null)
  // The other weeks of the months this week touches (not future ones).
  const [others, setOthers] = useState<Map<string, TimesheetEntry[]>>(new Map())
  useEffect(() => {
    if (!anyMonthly) return
    let alive = true
    const today = localDate(new Date())
    const weeks = [...new Set(monthsOfWeek(week).flatMap(weeksOfMonth))].filter((w) => w !== week && w <= today)
    void Promise.all(weeks.map(async (w) => [w, (await loadWeek(w).catch(() => null))?.entries ?? []] as const)).then((list) => {
      if (alive) setOthers(new Map(list))
    })
    return () => {
      alive = false
    }
  }, [week, anyMonthly, loadWeek])

  const rows = useMemo(() => {
    const byMonth = new Map<string, TimesheetEntry[]>()
    for (const month of monthsOfWeek(week)) byMonth.set(month, [...sheet.entries, ...[...others.values()].flat()])
    return targetsFor(canvases, week, sheet.entries, byMonth)
  }, [canvases, week, sheet, others])

  if (!anyMonthly && !anyWeekly) return null
  return (
    <section className="ts-targets" aria-label="Targets">
      <h3>Targets</h3>
      {rows.length === 0 && <p className="hint">No target applies to this week.</p>}
      <ul>
        {rows.map((r) => {
          const pct = r.target > 0 ? Math.round((r.actual / r.target) * 100) : 0
          const [y, m] = r.key.split('-').map(Number)
          return (
            <li key={`${r.canvasId}/${r.period}/${r.key}`} className={`ts-target${r.actual > r.target ? ' is-over' : ''}`} data-canvas={r.canvasId} data-period={r.period}>
              <span className="ts-target-label" title={canvasLabel(canvases, r.canvasId)}>
                {canvasLabel(canvases, r.canvasId)}
              </span>
              <span className="ts-target-period">{r.period === 'week' ? 'this week' : monthFmt.format(new Date(y, m - 1, 1))}</span>
              <span className="ts-target-bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, pct)}%` }} />
              </span>
              <span className="ts-target-hours">
                {hm(r.actual)} of {hm(r.target)}
              </span>
              <span className="ts-target-pct">{pct}%</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
