/**
 * Hour targets: weekly or monthly, on any canvas (canvas fields
 * `target_week` and `target_month`). Each is measured on its own, against
 * the timesheet hours under its canvas (the canvas and everything inside
 * it) in its own period; a target is not taken on by the canvases inside.
 * So 168 h for a client in September and 20 h a week for a task under that
 * client are two separate measures. See docs/TIME-EXTENSION.md.
 */
import { isWithin, localDate, type CanvasMeta, type TimesheetEntry } from '@devlog/core'

export interface TargetRow {
  canvasId: string
  period: 'week' | 'month'
  /** The week's Monday, or the month ("2026-09"). */
  key: string
  /** Target, in minutes. */
  target: number
  /** Timesheet minutes under the canvas in the period. */
  actual: number
}

/** A target in hours from a field, or null (unset, not a number, not positive). */
export function targetHours(raw: string | undefined): number | null {
  const n = Number(String(raw ?? '').trim().replace(',', '.'))
  return raw && Number.isFinite(n) && n > 0 ? n : null
}

/** The months ("YYYY-MM") a week (by its Monday) touches. */
export function monthsOfWeek(week: string): string[] {
  const [y, m, d] = week.split('-').map(Number)
  const out = new Set<string>()
  for (let i = 0; i < 7; i++) out.add(localDate(new Date(y, m - 1, d + i)).slice(0, 7))
  return [...out]
}

/** Every week (by its Monday) that has a day in a month. */
export function weeksOfMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0)
  const out: string[] = []
  for (let d = new Date(y, m - 1, 1 - ((new Date(y, m - 1, 1).getDay() + 6) % 7)); d <= last; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7)) out.push(localDate(d))
  return out
}

function minutesUnder(canvases: CanvasMeta[], canvasId: string, entries: TimesheetEntry[]): number {
  return entries.reduce((n, e) => (e.canvasId === canvasId || isWithin(canvases, e.canvasId, canvasId) ? n + e.minutes : n), 0)
}

/**
 * The targets that apply to a week on screen: each canvas's weekly target
 * for that week, and its monthly target for every month the week touches.
 * `weekEntries` is the week's timesheet; `monthEntries` has every
 * timesheet entry of those months (other weeks' saved or drafted sheets,
 * and this one's), by month.
 */
export function targetsFor(canvases: CanvasMeta[], week: string, weekEntries: TimesheetEntry[], monthEntries: Map<string, TimesheetEntry[]>): TargetRow[] {
  const rows: TargetRow[] = []
  for (const c of canvases) {
    if (c.archived) continue
    const perWeek = targetHours(c.fields?.target_week)
    if (perWeek !== null) rows.push({ canvasId: c.id, period: 'week', key: week, target: Math.round(perWeek * 60), actual: minutesUnder(canvases, c.id, weekEntries) })
    const perMonth = targetHours(c.fields?.target_month)
    if (perMonth === null) continue
    for (const month of monthsOfWeek(week)) {
      const inMonth = (monthEntries.get(month) ?? []).filter((e) => e.date.startsWith(month))
      rows.push({ canvasId: c.id, period: 'month', key: month, target: Math.round(perMonth * 60), actual: minutesUnder(canvases, c.id, inMonth) })
    }
  }
  return rows
}
