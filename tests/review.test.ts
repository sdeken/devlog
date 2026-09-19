import { describe, expect, it } from 'vitest'
import { buildReviewRows, estimateMinutes, formatMinutes, noteKey, weekDates, weekStart, type ReviewNote } from '../src/shared/review'
import type { PageMeta } from '../src/shared/types'

const page = (id: string, title: string, category: string): PageMeta => ({ id, title, category, description: '', createdAt: '' })
const note = (pageId: string, date: string, time: string, id = `${pageId}-${time}`): ReviewNote => ({
  pageId,
  date,
  entry: { id, createdAt: `${date}T${time}:00.000Z`, markdown: `note ${id}` }
})

describe('weeks', () => {
  it('starts weeks on Monday', () => {
    expect(weekStart('2026-09-19')).toBe('2026-09-14') // Saturday → Monday
    expect(weekStart('2026-09-14')).toBe('2026-09-14')
    expect(weekStart('2026-09-20')).toBe('2026-09-14') // Sunday belongs to the week before
    expect(weekDates('2026-09-14')).toEqual(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20'])
  })
})

describe('time estimate', () => {
  it('gives each note the gap to the next note, capped, and the last note a fixed allowance', () => {
    const notes = [note('a', '2026-09-14', '09:00'), note('b', '2026-09-14', '09:20'), note('a', '2026-09-14', '12:00'), note('a', '2026-09-15', '10:00')]
    const m = estimateMinutes(notes, { capMinutes: 60, lastNoteMinutes: 15 })
    expect(m.get(noteKey(notes[0]))).toBe(20)
    expect(m.get(noteKey(notes[1]))).toBe(60) // 2h40 gap capped
    expect(m.get(noteKey(notes[2]))).toBe(15) // last of the day
    expect(m.get(noteKey(notes[3]))).toBe(15) // only note of its day
  })

  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(60)).toBe('1h')
    expect(formatMinutes(135)).toBe('2h 15m')
  })
})

describe('review rows', () => {
  const pages = [page('journal', 'Journal', ''), page('acme-web', 'Website', 'Acme Corp / Web'), page('acme-general', 'General', 'Acme Corp'), page('globex-web', 'Website', 'Globex / Web')]

  it('nests client → project → page and sums upwards, journal last', () => {
    const notes = [
      note('acme-web', '2026-09-14', '09:00'),
      note('acme-web', '2026-09-14', '09:30'),
      note('acme-general', '2026-09-15', '09:00'),
      note('globex-web', '2026-09-14', '10:00'),
      note('journal', '2026-09-16', '09:00')
    ]
    const minutes = new Map(notes.map((n) => [noteKey(n), 30]))
    const rows = buildReviewRows(pages, notes, minutes)
    expect(rows.map((r) => r.label)).toEqual(['Acme Corp', 'Globex', 'Journal'])
    const acme = rows[0]
    expect(acme.kind).toBe('category')
    expect(acme.totalNotes).toBe(3)
    expect(acme.totalMinutes).toBe(90)
    expect(acme.cells.get('2026-09-14')).toEqual({ notes: 2, minutes: 60 })
    expect(acme.children.map((r) => `${r.kind}:${r.label}`)).toEqual(['category:Web', 'page:General'])
    const web = acme.children[0]
    expect(web.depth).toBe(1)
    expect(web.children.map((r) => `${r.kind}:${r.label}@${r.depth}`)).toEqual(['page:Website@2'])
    // Same project name under another client is a separate branch.
    expect(rows[1].children[0].children[0].pageId).toBe('globex-web')
    expect(rows[2]).toMatchObject({ kind: 'page', pageId: 'journal', depth: 0, totalNotes: 1 })
  })
})
