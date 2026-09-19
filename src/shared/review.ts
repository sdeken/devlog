/**
 * Weekly review: roll notes and tracked time up by day and category.
 *
 * Time comes from the activity log (task segments, explicit duration
 * markers). When a day has no tracking data at all, it falls back to a
 * timestamp heuristic so an untracked day still shows something.
 */
import { localDate, parseDurationMarker } from './entries'
import { JOURNAL_PAGE_ID, categoryPath } from './pages'
import {
  applyExplicitDurations,
  buildFocusSegments,
  buildTaskSegments,
  focusSummaryByDay,
  taskMinutesByDay,
  type AppSummary,
  type AppKind,
  type ExplicitDuration,
  type FocusSegment,
  type TaskSegment
} from './activity'
import type { ActivityEvent, Entry, PageMeta } from './types'

export interface ReviewNote {
  pageId: string
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

export const noteKey = (n: ReviewNote): string => `${n.pageId}/${n.date}/${n.entry.id}`

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
  /** date → pageId → minutes */
  byPageDay: Map<string, Map<string, number>>
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
}

/** Turn a week's notes and activity events into minutes per page per day. */
export function computeWeekTime(notes: ReviewNote[], events: ActivityEvent[], opts: WeekTimeOptions): WeekTime {
  const explicit: ExplicitDuration[] = []
  const explicitByNote = new Map<string, number>()
  for (const n of notes) {
    if (n.entry.kind && n.entry.kind !== 'note') continue
    const minutes = parseDurationMarker(n.entry.markdown)
    if (minutes) {
      explicit.push({ pageId: n.pageId, end: n.entry.createdAt, minutes, entryId: n.entry.id })
      explicitByNote.set(noteKey(n), minutes)
    }
  }
  const segOpts = { now: opts.now, heartbeatMs: opts.heartbeatMs }
  const tracked = applyExplicitDurations(buildTaskSegments(events, segOpts), explicit)
  const focusSegments = buildFocusSegments(events, segOpts)
  const byPageDay = taskMinutesByDay(tracked)
  const method = new Map<string, DayMethod>()
  const datesWithEvents = new Set(events.map((e) => localDate(new Date(e.t))))

  // Fallback per day: no tracking data and no explicit markers → heuristic.
  const fallback = estimateMinutes(notes, opts.estimate)
  for (const date of opts.dates) {
    const hasTracked = (byPageDay.get(date)?.size ?? 0) > 0 || datesWithEvents.has(date)
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
    for (const n of dayNotes) m.set(n.pageId, (m.get(n.pageId) ?? 0) + (fallback.get(noteKey(n)) ?? 0))
    byPageDay.set(date, m)
  }

  return { byPageDay, method, taskSegments: tracked, focusSegments, focus: focusSummaryByDay(focusSegments), explicitByNote }
}

// ---------------------------------------------------------------------------
// Matrix rows
// ---------------------------------------------------------------------------

export interface ReviewRow {
  /** "category" rows group pages; "page" rows are leaves. */
  kind: 'category' | 'page'
  key: string
  label: string
  depth: number
  pageId?: string
  path: string[]
  /** Per-date totals. */
  cells: Map<string, { notes: number; minutes: number }>
  totalNotes: number
  totalMinutes: number
  children: ReviewRow[]
}

/**
 * Build the review matrix: a tree of category rows (top level first, then
 * nested categories) with page rows as leaves. Pages appear when they have
 * notes or time in the range. The journal is a top-level row of its own.
 */
export function buildReviewRows(pages: PageMeta[], notes: ReviewNote[], byPageDay: Map<string, Map<string, number>>): ReviewRow[] {
  const pageById = new Map(pages.map((p) => [p.id, p]))
  const roots: ReviewRow[] = []
  const rowsByKey = new Map<string, ReviewRow>()

  const rowFor = (kind: ReviewRow['kind'], path: string[], label: string, pageId?: string): ReviewRow => {
    const key = `${kind}:${path.join('/')}${pageId ? `#${pageId}` : ''}`
    let row = rowsByKey.get(key)
    if (row) return row
    row = { kind, key, label, depth: path.length - (kind === 'page' ? 0 : 1), pageId, path, cells: new Map(), totalNotes: 0, totalMinutes: 0, children: [] }
    rowsByKey.set(key, row)
    const parentPath = kind === 'page' ? path : path.slice(0, -1)
    if (parentPath.length === 0) roots.push(row)
    else {
      const parentKey = `category:${parentPath.join('/')}`
      const parent = rowsByKey.get(parentKey) ?? rowFor('category', parentPath, parentPath[parentPath.length - 1])
      parent.children.push(row)
    }
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

  const pathOf = (pageId: string): { path: string[]; label: string } => {
    const page = pageById.get(pageId)
    if (pageId === JOURNAL_PAGE_ID) return { path: [], label: 'Journal' }
    return { path: categoryPath(page?.category ?? ''), label: page?.title ?? pageId }
  }

  const add = (pageId: string, date: string, notesCount: number, minutes: number): void => {
    const { path, label } = pathOf(pageId)
    for (let i = 1; i <= path.length; i++) rowFor('category', path.slice(0, i), path[i - 1])
    bump(rowFor('page', path, label, pageId), date, notesCount, minutes)
    for (let i = 1; i <= path.length; i++) bump(rowFor('category', path.slice(0, i), path[i - 1]), date, notesCount, minutes)
  }

  for (const n of notes) add(n.pageId, n.date, 1, 0)
  for (const [date, perPage] of byPageDay) for (const [pageId, minutes] of perPage) add(pageId, date, 0, minutes)

  const sortRows = (rows: ReviewRow[]): ReviewRow[] =>
    rows
      .map((r) => ({ ...r, children: sortRows(r.children) }))
      .sort((a, b) => {
        if (a.pageId === JOURNAL_PAGE_ID) return 1
        if (b.pageId === JOURNAL_PAGE_ID) return -1
        return b.totalMinutes - a.totalMinutes || a.label.localeCompare(b.label)
      })
  return sortRows(roots)
}
