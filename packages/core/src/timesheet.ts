/**
 * Timesheets: turning tracked time into the entries reported to outside
 * systems (see docs/TIMESHEETS.md). Pure functions, no I/O.
 *
 *  1. `buildSessions`: tracked segments → sessions (same task, gaps up to
 *     30 minutes count as work, split at midnight and at a task switch).
 *  2. `draftEntries`: sessions → entries, each rounded once with the firm
 *     rounding rule and laid out on quarter hours without overlaps.
 *  3. `balanceDays`: per group (client) per day, compare what the rounded
 *     entries report with the rounded total actually worked, and suggest
 *     which entries to trim (or extend) to even it out.
 */
import { localDate } from './format/blocks'

export const QUARTER_MINUTES = 15
const QUARTER_MS = QUARTER_MINUTES * 60_000
const MINUTE_MS = 60_000

/**
 * The firm rounding rule: 0 stays 0; anything above 0 is at least 15
 * minutes; beyond that, the nearest multiple of 15 with exact halves
 * rounding up (22.5 → 30, 37.5 → 45).
 */
export function roundWorkMinutes(minutes: number): number {
  if (!(minutes > 0)) return 0
  return roundWorkMs(Math.round(minutes * MINUTE_MS)) / MINUTE_MS
}

/** The rounding rule on milliseconds (exact integer arithmetic), returning milliseconds. */
export function roundWorkMs(ms: number): number {
  if (!(ms > 0)) return 0
  const quarters = Math.floor((2 * ms + QUARTER_MS) / (2 * QUARTER_MS)) // nearest, halves up
  return Math.max(1, quarters) * QUARTER_MS
}

/** An instant rounded to the nearest quarter hour of local time (halves up). */
export function roundToQuarterHour(date: Date): Date {
  const local = new Date(date)
  const msIntoHour = local.getMinutes() * MINUTE_MS + local.getSeconds() * 1000 + local.getMilliseconds()
  const quarters = Math.floor((2 * msIntoHour + QUARTER_MS) / (2 * QUARTER_MS))
  local.setMinutes(0, 0, 0)
  return new Date(local.getTime() + quarters * QUARTER_MS)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A stretch of tracked time on one canvas (what the tracker replays into). */
export interface WorkSegment {
  canvasId: string
  start: string
  end: string
}

export interface Session {
  canvasId: string
  /** Local date the session is on. */
  date: string
  start: string
  end: string
  /** From first start to last end, short gaps included. */
  workedMinutes: number
}

export interface SessionOptions {
  /** Gaps up to this long on the same task still count as work. Default 30. */
  maxGapMinutes?: number
}

/**
 * Merge segments into sessions: consecutive segments on the same canvas,
 * with no other canvas in between, are one session unless a gap between
 * them is longer than `maxGapMinutes`. Sessions never cross local midnight.
 */
export function buildSessions(segments: WorkSegment[], opts: SessionOptions = {}): Session[] {
  const maxGap = (opts.maxGapMinutes ?? 30) * MINUTE_MS
  const pieces: Array<{ canvasId: string; start: number; end: number }> = []
  for (const seg of segments) {
    let s = Date.parse(seg.start)
    const e = Date.parse(seg.end)
    if (!(e > s)) continue
    // Split at local midnight.
    while (s < e) {
      const d = new Date(s)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const pieceEnd = Math.min(e, midnight)
      pieces.push({ canvasId: seg.canvasId, start: s, end: pieceEnd })
      s = pieceEnd
    }
  }
  pieces.sort((a, b) => a.start - b.start || a.end - b.end)

  const out: Session[] = []
  let cur: { canvasId: string; start: number; end: number } | null = null
  const close = (): void => {
    if (!cur) return
    out.push({
      canvasId: cur.canvasId,
      date: localDate(new Date(cur.start)),
      start: new Date(cur.start).toISOString(),
      end: new Date(cur.end).toISOString(),
      workedMinutes: (cur.end - cur.start) / MINUTE_MS
    })
    cur = null
  }
  for (const p of pieces) {
    if (
      cur &&
      p.canvasId === cur.canvasId &&
      p.start - cur.end <= maxGap &&
      localDate(new Date(p.start)) === localDate(new Date(cur.start))
    ) {
      cur.end = Math.max(cur.end, p.end)
      continue
    }
    close()
    cur = { ...p }
  }
  close()
  return out
}

// ---------------------------------------------------------------------------
// Draft entries
// ---------------------------------------------------------------------------

export type EntrySource = 'tracked' | 'manual'

export interface TimesheetEntry {
  id: string
  date: string
  /** Rounded start (ISO), on a local quarter hour. */
  start: string
  /** Reported minutes: a multiple of 15, at least 15. */
  minutes: number
  canvasId: string
  /** Unrounded minutes actually worked, kept for the record. */
  worked: number
  source: EntrySource
  note?: string
}

/**
 * Round sessions into entries. Each duration is rounded once with the firm
 * rule; starts go to the nearest quarter hour, then move later where needed
 * so that entries on the same day never overlap (in the order they happened).
 */
export function draftEntries(sessions: Session[]): TimesheetEntry[] {
  const sorted = [...sessions].sort((a, b) => a.start.localeCompare(b.start))
  const out: TimesheetEntry[] = []
  const dayEnd = new Map<string, number>()
  sorted.forEach((s, i) => {
    const minutes = roundWorkMinutes(s.workedMinutes)
    if (minutes === 0) return
    let start = roundToQuarterHour(new Date(s.start)).getTime()
    const busyUntil = dayEnd.get(s.date)
    if (busyUntil !== undefined && start < busyUntil) start = busyUntil
    dayEnd.set(s.date, start + minutes * MINUTE_MS)
    out.push({ id: `e${i + 1}`, date: s.date, start: new Date(start).toISOString(), minutes, canvasId: s.canvasId, worked: s.workedMinutes, source: 'tracked' })
  })
  return out
}

// ---------------------------------------------------------------------------
// Balancing rounding inflation
// ---------------------------------------------------------------------------

export interface Adjustment {
  entryId: string
  from: number
  to: number
}

export interface DayBalance {
  date: string
  /** The grouping key, normally the client (top-level canvas). */
  group: string
  /** Σ unrounded minutes worked. */
  worked: number
  /** The rounded total actually worked: what the day should report. */
  target: number
  /** Σ entry minutes as they stand. */
  reported: number
  /** Suggested changes that bring `reported` to `target` (never below 15 per entry). */
  suggestions: Adjustment[]
  /** What the suggestions could not even out (positive: still over-reported). */
  residual: number
}

/**
 * For each group and day, suggest how to even out rounding: take the
 * difference between what the entries report and the rounded total worked
 * out of (or add it to) the longest entries, 15 minutes at a time, never
 * taking an entry below 15 minutes. Suggestions only; nothing is changed.
 */
export function balanceDays(entries: TimesheetEntry[], groupOf: (canvasId: string) => string): DayBalance[] {
  const groups = new Map<string, TimesheetEntry[]>()
  for (const e of entries) {
    const key = `${e.date}\u0000${groupOf(e.canvasId)}`
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const out: DayBalance[] = []
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [date, group] = key.split('\u0000')
    const worked = list.reduce((n, e) => n + e.worked, 0)
    const target = roundWorkMinutes(worked)
    const reported = list.reduce((n, e) => n + e.minutes, 0)
    const proposed = new Map(list.map((e) => [e.id, e.minutes]))
    // Longest first; ties by more time worked, then by id, so suggestions are stable.
    const pick = (canShrink: boolean): TimesheetEntry | undefined =>
      list
        .filter((e) => !canShrink || proposed.get(e.id)! > QUARTER_MINUTES)
        .sort((a, b) => proposed.get(b.id)! - proposed.get(a.id)! || b.worked - a.worked || a.id.localeCompare(b.id))[0]
    let diff = reported - target
    while (diff > 0) {
      const e = pick(true)
      if (!e) break
      proposed.set(e.id, proposed.get(e.id)! - QUARTER_MINUTES)
      diff -= QUARTER_MINUTES
    }
    while (diff < 0) {
      const e = pick(false)!
      proposed.set(e.id, proposed.get(e.id)! + QUARTER_MINUTES)
      diff += QUARTER_MINUTES
    }
    const suggestions = list.filter((e) => proposed.get(e.id) !== e.minutes).map((e) => ({ entryId: e.id, from: e.minutes, to: proposed.get(e.id)! }))
    out.push({ date, group, worked, target, reported, suggestions, residual: diff })
  }
  return out
}
