/**
 * Weekly review: roll notes up by day and category, with a rough estimate of
 * time spent derived from note timestamps.
 */
import { localDate } from './entries'
import { JOURNAL_PAGE_ID, categoryPath } from './pages'
import type { Entry, PageMeta } from './types'

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
 * Estimate minutes per note: sort a day's notes across every page by time;
 * each note owns the gap until the next one (capped), the last one gets a
 * fixed allowance. Crude, but it turns a stream of timestamps into "roughly
 * how long" without asking the user to track anything.
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
 * nested categories) with page rows as leaves. Only pages that have notes in
 * the range appear. The journal is a top-level row of its own.
 */
export function buildReviewRows(
  pages: PageMeta[],
  notes: ReviewNote[],
  minutesByNote: Map<string, number>
): ReviewRow[] {
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

  const bump = (row: ReviewRow, date: string, minutes: number): void => {
    const cell = row.cells.get(date) ?? { notes: 0, minutes: 0 }
    cell.notes += 1
    cell.minutes += minutes
    row.cells.set(date, cell)
    row.totalNotes += 1
    row.totalMinutes += minutes
  }

  for (const n of notes) {
    const page = pageById.get(n.pageId)
    const minutes = minutesByNote.get(noteKey(n)) ?? 0
    const path = n.pageId === JOURNAL_PAGE_ID ? [] : categoryPath(page?.category ?? '')
    const label = n.pageId === JOURNAL_PAGE_ID ? 'Journal' : (page?.title ?? n.pageId)
    // Ensure category ancestors exist so they are ordered by first appearance.
    for (let i = 1; i <= path.length; i++) rowFor('category', path.slice(0, i), path[i - 1])
    const leaf = rowFor('page', path, label, n.pageId)
    bump(leaf, n.date, minutes)
    for (let i = 1; i <= path.length; i++) bump(rowFor('category', path.slice(0, i), path[i - 1]), n.date, minutes)
  }

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
