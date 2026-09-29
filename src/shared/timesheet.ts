/**
 * The draft timesheet for a week: tracked task time (explicit `[2h]`
 * markers applied, removed time excluded) merged into sessions and rounded
 * once with the firm rule; days with no tracking at all fall back to the
 * same estimate the review uses. See docs/TIMESHEETS.md.
 */
import { buildSessions, draftEntries, roundToQuarterHour, roundWorkMinutes, type Timesheet, type TimesheetEntry } from '@devlog/core'
import { computeWeekTime, weekDates, type ReviewNote } from './review'
import type { ActivityEvent } from './types'

export interface DraftOptions {
  now?: string
  heartbeatMs?: number
}

export function draftTimesheet(week: string, notes: ReviewNote[], events: ActivityEvent[], opts: DraftOptions = {}): Timesheet {
  const dates = weekDates(week)
  const inWeek = new Set(dates)
  const time = computeWeekTime(notes, events, { dates, now: opts.now, heartbeatMs: opts.heartbeatMs })

  const sessions = buildSessions(time.taskSegments.map((s) => ({ canvasId: s.canvasId, start: s.start, end: s.end }))).filter((s) => inWeek.has(s.date))
  const entries: TimesheetEntry[] = draftEntries(sessions)

  // Untracked days: one entry per canvas, starting at its first note.
  for (const date of dates) {
    if (time.method.get(date) !== 'estimated') continue
    let busyUntil = 0
    const firstNote = (canvasId: string): number =>
      Math.min(...notes.filter((n) => n.date === date && n.canvasId === canvasId).map((n) => Date.parse(n.entry.createdAt)))
    const rows = [...(time.byCanvasDay.get(date) ?? new Map<string, number>())].sort(([a], [b]) => firstNote(a) - firstNote(b))
    for (const [canvasId, worked] of rows) {
      const minutes = roundWorkMinutes(worked)
      if (minutes === 0) continue
      const first = firstNote(canvasId)
      let start = roundToQuarterHour(new Date(Number.isFinite(first) ? first : Date.parse(`${date}T09:00:00`))).getTime()
      if (start < busyUntil) start = busyUntil
      busyUntil = start + minutes * 60_000
      entries.push({ id: '', date, start: new Date(start).toISOString(), minutes, canvasId, worked, source: 'estimated' })
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
  entries.forEach((e, i) => (e.id = `e${i + 1}`))
  return { week, status: 'draft', entries, updatedAt: '' }
}

/** A fresh id for an entry added by hand. */
export function newEntryId(existing: TimesheetEntry[]): string {
  let n = existing.length + 1
  while (existing.some((e) => e.id === `m${n}`)) n++
  return `m${n}`
}
