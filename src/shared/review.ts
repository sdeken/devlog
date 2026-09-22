/**
 * Weekly review: roll notes and tracked time up by day and category.
 *
 * Time comes from the activity log (task segments, explicit duration
 * markers). When a day has no tracking data at all, it falls back to a
 * timestamp heuristic so an untracked day still shows something.
 */
import { localDate, parseDurationMarker } from './entries'
import { JOURNAL_ID, ancestorIds } from './canvases'
import {
  applyExplicitDurations,
  buildFocusSegments,
  buildTaskSegments,
  cleanFocusSegments,
  focusSummaryByDay,
  taskMinutesByDay,
  type AppSummary,
  type AppKind,
  type ExplicitDuration,
  type FocusSegment,
  type TaskSegment
} from './activity'
import type { ActivityEvent, CanvasMeta, Entry } from './types'

export interface ReviewNote {
  canvasId: string
  /** Local date the note was written (from its timestamp). */
  date: string
  entry: Entry
}

export interface EstimateOptions {
  /** A note counts until the next note that day, but never more than this. */
  capMinutes: number
  /** The last note of a day has nothing after it; give it this much. */
  lastNoteMinutes: number
}

export const DEFAULT_ESTIMATE: EstimateOptions = { capMinutes: 60, lastNoteMinutes: 15 }

export const noteKey = (n: ReviewNote): string => `${n.canvasId}/${n.date}/${n.entry.id}`

/** Monday of the week containing `date` (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7))
  return localDate(dt)
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y, m - 1, d + n))
}

/** The seven dates of the week starting on `start`. */
export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}

/**
 * Fallback estimate for untracked days: each note owns the gap until the
 * next note that day (capped); the last note gets a fixed allowance.
 */
export function estimateMinutes(notes: ReviewNote[], opts: EstimateOptions = DEFAULT_ESTIMATE): Map<string, number> {
  const out = new Map<string, number>()
  const byDate = new Map<string, ReviewNote[]>()
  for (const n of notes) {
    if (!byDate.has(n.date)) byDate.set(n.date, [])
    byDate.get(n.date)!.push(n)
  }
  for (const list of byDate.values()) {
    const sorted = [...list].sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt))
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]
      const next = sorted[i + 1]
      let minutes = opts.lastNoteMinutes
      if (next) {
        const gap = (new Date(next.entry.createdAt).getTime() - new Date(cur.entry.createdAt).getTime()) / 60_000
        minutes = Math.max(0, Math.min(opts.capMinutes, gap))
      }
      out.set(noteKey(cur), minutes)
    }
  }
  return out
}

/** Round minutes to the nearest multiple of `granularity` (e.g. 15 for quarter hours). */
export function roundMinutes(minutes: number, granularity: number): number {
  const g = Math.max(1, granularity)
  return Math.round(minutes / g) * g
}

/** "7.25 h" style, for billing-like summaries. */
export function formatHours(minutes: number): string {
  const h = minutes / 60
  return `${(Math.round(h * 100) / 100).toFixed(2).replace(/\.?0+$/, '')} h`
}

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes)
  if (m <= 0) return '0m'
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

// ---------------------------------------------------------------------------
// Time computation
// ---------------------------------------------------------------------------

export type DayMethod = 'tracked' | 'estimated' | 'none'

export interface WeekTime {
  /** date → canvasId → minutes */
  byCanvasDay: Map<string, Map<string, number>>
  /** How each date's minutes were obtained. */
  method: Map<string, DayMethod>
  taskSegments: TaskSegment[]
  focusSegments: FocusSegment[]
  focus: Map<string, { apps: AppSummary[]; kinds: Map<AppKind, number>; total: number }>
  /** Explicit durations found in notes, by note key. */
  explicitByNote: Map<string, number>
}

export interface WeekTimeOptions {
  dates: string[]
  estimate?: EstimateOptions
  now?: string
  /** Liveness window for segment building; defaults to the tracker's heartbeat. */
  heartbeatMs?: number
  /** Focus flips shorter than this are folded away in screen-time figures. */
  focusMinSeconds?: number
}

/** Turn a week's notes and activity events into minutes per page per day. */
export function computeWeekTime(notes: ReviewNote[], events: ActivityEvent[], opts: WeekTimeOptions): WeekTime {
  const explicit: ExplicitDuration[] = []
  const explicitByNote = new Map<string, number>()
  for (const n of notes) {
    if (n.entry.kind && n.entry.kind !== 'note') continue
    const minutes = parseDurationMarker(n.entry.markdown)
    if (minutes) {
      explicit.push({ canvasId: n.canvasId, end: n.entry.createdAt, minutes, entryId: n.entry.id })
      explicitByNote.set(noteKey(n), minutes)
    }
  }
  const segOpts = { now: opts.now, heartbeatMs: opts.heartbeatMs }
  const tracked = applyExplicitDurations(buildTaskSegments(events, segOpts), explicit)
  const focusSegments = cleanFocusSegments(buildFocusSegments(events, segOpts), { minSeconds: opts.focusMinSeconds ?? 5 })
  const byCanvasDay = taskMinutesByDay(tracked)
  const method = new Map<string, DayMethod>()
  const datesWithEvents = new Set(events.map((e) => localDate(new Date(e.t))))

  // Fallback per day: no tracking data and no explicit markers → heuristic.
  const fallback = estimateMinutes(notes, opts.estimate)
  for (const date of opts.dates) {
    const hasTracked = (byCanvasDay.get(date)?.size ?? 0) > 0 || datesWithEvents.has(date)
    if (hasTracked) {
      method.set(date, 'tracked')
      continue
    }
    const dayNotes = notes.filter((n) => n.date === date)
    if (dayNotes.length === 0) {
      method.set(date, 'none')
      continue
    }
    method.set(date, 'estimated')
    const m = new Map<string, number>()
    for (const n of dayNotes) m.set(n.canvasId, (m.get(n.canvasId) ?? 0) + (fallback.get(noteKey(n)) ?? 0))
    byCanvasDay.set(date, m)
  }

  return { byCanvasDay, method, taskSegments: tracked, focusSegments, focus: focusSummaryByDay(focusSegments), explicitByNote }
}

// ---------------------------------------------------------------------------
// Matrix rows
// ---------------------------------------------------------------------------

export interface ReviewRow {
  canvasId: string
  label: string
  depth: number
  /** Task canvases are what the tracker times; others are groupings (clients, projects). */
  task: boolean
  /** Per-date totals, rolled up from descendants. */
  cells: Map<string, { notes: number; minutes: number }>
  totalNotes: number
  totalMinutes: number
  children: ReviewRow[]
}

/**
 * Build the review tree: one row per canvas that has blocks or time in the
 * range, plus every ancestor so totals roll up client → project → task.
 * The journal is a top-level row of its own, listed last.
 */
export function buildReviewRows(canvases: CanvasMeta[], notes: ReviewNote[], byCanvasDay: Map<string, Map<string, number>>): ReviewRow[] {
  const byId = new Map(canvases.map((c) => [c.id, c]))
  const rows = new Map<string, ReviewRow>()
  const roots: ReviewRow[] = []

  const rowFor = (id: string): ReviewRow => {
    let row = rows.get(id)
    if (row) return row
    const c = byId.get(id)
    const parentId = c?.parentId && byId.has(c.parentId) ? c.parentId : null
    const parent = parentId ? rowFor(parentId) : null
    row = {
      canvasId: id,
      label: id === JOURNAL_ID ? 'Journal' : (c?.title ?? id),
      depth: parent ? parent.depth + 1 : 0,
      task: c?.task ?? false,
      cells: new Map(),
      totalNotes: 0,
      totalMinutes: 0,
      children: []
    }
    rows.set(id, row)
    if (parent) parent.children.push(row)
    else roots.push(row)
    return row
  }

  const bump = (row: ReviewRow, date: string, notesCount: number, minutes: number): void => {
    const cell = row.cells.get(date) ?? { notes: 0, minutes: 0 }
    cell.notes += notesCount
    cell.minutes += minutes
    row.cells.set(date, cell)
    row.totalNotes += notesCount
    row.totalMinutes += minutes
  }

  const add = (id: string, date: string, notesCount: number, minutes: number): void => {
    bump(rowFor(id), date, notesCount, minutes)
    for (const a of ancestorIds(canvases, id)) if (byId.has(a)) bump(rowFor(a), date, notesCount, minutes)
  }

  for (const n of notes) add(n.canvasId, n.date, 1, 0)
  for (const [date, perCanvas] of byCanvasDay) for (const [id, minutes] of perCanvas) add(id, date, 0, minutes)

  const sortRows = (list: ReviewRow[]): ReviewRow[] =>
    list
      .map((r) => ({ ...r, children: sortRows(r.children) }))
      .sort((a, b) => {
        if (a.canvasId === JOURNAL_ID) return 1
        if (b.canvasId === JOURNAL_ID) return -1
        return b.totalMinutes - a.totalMinutes || b.totalNotes - a.totalNotes || a.label.localeCompare(b.label)
      })
  return sortRows(roots)
}
