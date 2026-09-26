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

/** Where an entry came from: tracked time, a note's estimate (untracked day), or typed in. */
export type EntrySource = 'tracked' | 'estimated' | 'manual'

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

// ---------------------------------------------------------------------------
// The stored timesheet
// ---------------------------------------------------------------------------

export interface Timesheet {
  /** Monday of the week (local date). */
  week: string
  /** `final` once you have approved it (what destinations send). */
  status: 'draft' | 'final'
  entries: TimesheetEntry[]
  updatedAt: string
}

/** The fenced block that holds a timesheet's exact data under its readable table. */
export const TIMESHEET_FENCE = 'devlog-timesheet'
/** Canvas field that marks the canvas Devlog keeps timesheets in. */
export const MANAGED_FIELD = 'devlog.managed'
export const TIMESHEETS_MANAGED = 'timesheets'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SOURCES: EntrySource[] = ['tracked', 'estimated', 'manual']

/** Keep a timesheet well-formed (it comes from a file, or from the UI). Throws on what cannot be repaired. */
export function sanitizeTimesheet(raw: unknown): Timesheet {
  const o = (raw ?? {}) as Record<string, unknown>
  const week = String(o.week ?? '')
  if (!DATE_RE.test(week)) throw new Error('A timesheet needs its week (YYYY-MM-DD)')
  const [y, m, d] = week.split('-').map(Number)
  const monday = new Date(y, m - 1, d)
  if (monday.getDay() !== 1) throw new Error('A timesheet week starts on a Monday')
  const dates = new Set(Array.from({ length: 7 }, (_, i) => localDate(new Date(y, m - 1, d + i))))
  const seen = new Set<string>()
  const entries: TimesheetEntry[] = []
  for (const e of (Array.isArray(o.entries) ? o.entries : []) as Array<Record<string, unknown>>) {
    const id = String(e?.id ?? '')
    const date = String(e?.date ?? '')
    const start = String(e?.start ?? '')
    const minutes = Number(e?.minutes)
    const canvasId = String(e?.canvasId ?? '')
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || seen.has(id)) throw new Error(`Bad or repeated entry id: ${id}`)
    if (!dates.has(date)) throw new Error(`Entry ${id}: ${date} is not in the week of ${week}`)
    if (Number.isNaN(Date.parse(start))) throw new Error(`Entry ${id}: bad start time`)
    if (!Number.isInteger(minutes) || minutes < QUARTER_MINUTES || minutes > 24 * 60 || minutes % QUARTER_MINUTES !== 0) throw new Error(`Entry ${id}: minutes must be a multiple of 15, at least 15`)
    if (!canvasId || !/^[a-z0-9-]{1,64}$/.test(canvasId)) throw new Error(`Entry ${id}: bad canvas`)
    seen.add(id)
    const worked = Number(e?.worked)
    const source = SOURCES.includes(e?.source as EntrySource) ? (e.source as EntrySource) : 'manual'
    const note = typeof e?.note === 'string' ? e.note.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) : ''
    entries.push({ id, date, start: new Date(start).toISOString(), minutes, canvasId, worked: Number.isFinite(worked) && worked >= 0 ? Math.round(worked * 100) / 100 : 0, source, ...(note ? { note } : {}) })
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id))
  return { week, status: o.status === 'final' ? 'final' : 'draft', entries, updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '' }
}

const hm = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

/**
 * The block body for a timesheet: a readable table (so git and any editor
 * show what was worked and reported) followed by the exact data, which is
 * what the app reads back.
 */
export function serializeTimesheet(sheet: Timesheet, labelOf: (canvasId: string) => string, clientOf: (canvasId: string) => string): string {
  const total = sheet.entries.reduce((n, e) => n + e.minutes, 0)
  const worked = sheet.entries.reduce((n, e) => n + e.worked, 0)
  const lines = [
    `**Timesheet, week of ${sheet.week}** (${sheet.status}): ${hm(total)} reported, ${hm(Math.round(worked))} worked`,
    '',
    '| Date | Start | Hours | Task | Client | Note |',
    '|---|---|---|---|---|---|'
  ]
  for (const e of sheet.entries) {
    const d = new Date(e.start)
    const start = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    lines.push(`| ${e.date} | ${start} | ${hm(e.minutes)} | ${cell(labelOf(e.canvasId))} | ${cell(labelOf(clientOf(e.canvasId)))} | ${cell(e.note ?? '')} |`)
  }
  if (sheet.entries.length === 0) lines.push('| | | | (no entries) | | |')
  lines.push('', '```' + TIMESHEET_FENCE, JSON.stringify({ week: sheet.week, status: sheet.status, updatedAt: sheet.updatedAt, entries: sheet.entries }), '```')
  return lines.join('\n')
}

/** Read a timesheet back from its block body (the fenced data), or null. */
export function parseTimesheet(markdown: string): Timesheet | null {
  const m = new RegExp('```' + TIMESHEET_FENCE + '\\n([\\s\\S]*?)\\n```').exec(markdown)
  if (!m) return null
  try {
    return sanitizeTimesheet(JSON.parse(m[1]))
  } catch {
    return null
  }
}
