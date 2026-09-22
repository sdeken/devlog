import { describe, expect, it } from 'vitest'
import { buildReviewRows, computeWeekTime, estimateMinutes, formatHours, formatMinutes, noteKey, roundMinutes, weekDates, weekStart, type ReviewNote } from '../src/shared/review'
import type { ActivityEvent } from '../src/shared/types'
import type { CanvasMeta } from '../src/shared/types'

const canvas = (id: string, title: string, parentId: string | null, task = false): CanvasMeta => ({ id, title, parentId, task, createdAt: '', updatedAt: '', repos: [], archived: false, hasSurface: false })
const note = (canvasId: string, date: string, time: string, id = `${canvasId}-${time}`): ReviewNote => ({
  canvasId,
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

  it('rounds to a granularity and formats hours', () => {
    expect(roundMinutes(37, 15)).toBe(30)
    expect(roundMinutes(38, 15)).toBe(45)
    expect(roundMinutes(100, 16)).toBe(96)
    expect(formatHours(450)).toBe('7.5 h')
    expect(formatHours(45)).toBe('0.75 h')
    expect(formatHours(0)).toBe('0 h')
  })

  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('0m')
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(60)).toBe('1h')
    expect(formatMinutes(135)).toBe('2h 15m')
  })
})

describe('review rows', () => {
  const canvases = [
    canvas('journal', 'Journal', null),
    canvas('acme', 'Acme Corp', null),
    canvas('acme-web', 'Web', 'acme'),
    canvas('acme-web-site', 'Website', 'acme-web', true),
    canvas('acme-general', 'General', 'acme', true),
    canvas('globex', 'Globex', null),
    canvas('globex-web', 'Website', 'globex', true)
  ]

  it('nests client → project → task and sums upwards, journal last', () => {
    const notes = [
      note('acme-web-site', '2026-09-14', '09:00'),
      note('acme-web-site', '2026-09-14', '09:30'),
      note('acme-general', '2026-09-15', '09:00'),
      note('globex-web', '2026-09-14', '10:00'),
      note('journal', '2026-09-16', '09:00')
    ]
    const byCanvasDay = new Map<string, Map<string, number>>([
      ['2026-09-14', new Map([['acme-web-site', 60], ['globex-web', 30]])],
      ['2026-09-15', new Map([['acme-general', 30]])]
    ])
    const rows = buildReviewRows(canvases, notes, byCanvasDay)
    expect(rows.map((r) => r.label)).toEqual(['Acme Corp', 'Globex', 'Journal'])
    const acme = rows[0]
    expect(acme.task).toBe(false)
    expect(acme.totalNotes).toBe(3)
    expect(acme.totalMinutes).toBe(90)
    expect(acme.cells.get('2026-09-14')).toEqual({ notes: 2, minutes: 60 })
    expect(acme.children.map((r) => `${r.label}@${r.depth}`)).toEqual(['Web@1', 'General@1'])
    expect(acme.children[0].children.map((r) => `${r.label}@${r.depth}:${r.task}`)).toEqual(['Website@2:true'])
    // Same task name under another client is a separate branch.
    expect(rows[1].children[0].canvasId).toBe('globex-web')
    expect(rows[2]).toMatchObject({ canvasId: 'journal', depth: 0, totalNotes: 1, totalMinutes: 0 })
    // A canvas whose parent is unknown sits at the top level.
    const orphan = buildReviewRows([canvas('x', 'X', 'gone')], [note('x', '2026-09-14', '09:00')], new Map())
    expect(orphan.map((r) => `${r.canvasId}@${r.depth}`)).toEqual(['x@0'])
  })
})

describe('computeWeekTime', () => {
  const dates = weekDates('2026-09-14')
  const T = (day: number, h: number, m = 0): string => new Date(2026, 8, day, h, m).toISOString()

  it('uses tracked segments when there is activity data and explicit markers when present', () => {
    const events: ActivityEvent[] = [
      { t: T(14, 9), type: 'task', canvasId: 'acme-web' },
      { t: T(14, 11), type: 'lock' },
      { t: T(14, 12), type: 'unlock' },
      { t: T(14, 13), type: 'stop' }
    ]
    const notes: ReviewNote[] = [
      { canvasId: 'acme-web', date: '2026-09-14', entry: { id: 'a', createdAt: T(14, 9), markdown: 'start' } },
      { canvasId: 'globex-web', date: '2026-09-14', entry: { id: 'b', createdAt: T(14, 12, 30), markdown: '[30m] Globex call' } },
      { canvasId: 'journal', date: '2026-09-16', entry: { id: 'c', createdAt: T(16, 9), markdown: 'untracked day' } }
    ]
    const time = computeWeekTime(notes, events, { dates, now: T(20, 0), heartbeatMs: 24 * 60 * 60_000 })
    expect(time.method.get('2026-09-14')).toBe('tracked')
    expect(time.method.get('2026-09-15')).toBe('none')
    expect(time.method.get('2026-09-16')).toBe('estimated')
    const mon = time.byCanvasDay.get('2026-09-14')!
    expect(mon.get('acme-web')).toBe(120 + 30) // 9–11, then 12–12:30 (12:30–13 overridden)
    expect(mon.get('globex-web')).toBe(30)
    expect(time.explicitByNote.get('globex-web/2026-09-14/b')).toBe(30)
    expect(time.byCanvasDay.get('2026-09-16')?.get('journal')).toBe(15) // fallback: last note allowance
  })
})
