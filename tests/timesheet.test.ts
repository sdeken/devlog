import { describe, expect, it } from 'vitest'
import { adoptTimesheet, estimatedEntryId, parseTimesheet, resolveTimesheet, sanitizeTimesheet, serializeTimesheet, trackedEntryId, type Timesheet } from '@devlog/core'
import { draftTimesheet, newEntryId } from '../src/shared/timesheet'
import { computeWeekTime, type ReviewNote } from '../src/shared/review'
import type { ActivityEvent } from '../src/shared/types'

const at = (day: number, h: number, m = 0): string => new Date(2026, 8, day, h, m).toISOString()
const ev = (t: string, type: ActivityEvent['type'], canvasId?: string): ActivityEvent => ({ t, type, ...(canvasId ? { canvasId } : {}) })
const hm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** "This window was that canvas" (null: not worked), made at `made`. */
const assign = (id: string, start: string, end: string, canvasId: string | null, made: string): ActivityEvent => ({ t: start, type: 'assign', id, start, end, canvasId, at: made })
/** Heartbeats every five minutes over a stretch, so the app reads as alive. */
const beats = (day: number, fromH: number, toH: number): ActivityEvent[] => {
  const out: ActivityEvent[] = []
  for (let m = fromH * 60 + 5; m < toH * 60; m += 5) out.push(ev(at(day, Math.floor(m / 60), m % 60), 'heartbeat'))
  return out
}
const rows = (sheet: Timesheet): Array<[string, string, string, number, string]> => sheet.entries.map((e) => [e.date, e.canvasId, hm(e.start), e.minutes, e.source])

describe('the draft timesheet', () => {
  it('turns tracked time into rounded entries and estimates untracked days', () => {
    const events: ActivityEvent[] = [
      ev(at(22, 9, 2), 'start', 'acme'),
      ev(at(22, 10, 7), 'task', 'globex'), // acme 09:02–10:07 (65 min → 60)
      ev(at(22, 10, 11), 'task', 'acme'), // globex 4 min → 15
      ev(at(22, 10, 20), 'lock'), // acme 9 min, joins the 09:02 session (gap 4 min)
      ev(at(22, 10, 21), 'stop')
    ]
    for (let m = 5; m <= 80; m += 5) events.push(ev(at(22, 9, m), 'heartbeat')) // the app is alive throughout
    const notes: ReviewNote[] = [{ canvasId: 'acme', date: '2026-09-24', entry: { id: 'n1', createdAt: at(24, 14, 10), markdown: 'untracked day' } }]
    const sheet = draftTimesheet('2026-09-21', notes, events, { now: at(26, 12) })
    expect(sheet).toMatchObject({ week: '2026-09-21', status: 'draft', adjustments: { minutes: {}, notes: {}, removed: [] } })
    expect(sheet.entries.map((e) => [e.id, e.date, e.canvasId, hm(e.start), e.minutes, e.source])).toEqual([
      [trackedEntryId(at(22, 9, 2)), '2026-09-22', 'acme', '09:00', 60, 'tracked'],
      [trackedEntryId(at(22, 10, 7)), '2026-09-22', 'globex', '10:00', 15, 'tracked'],
      [trackedEntryId(at(22, 10, 11)), '2026-09-22', 'acme', '10:15', 15, 'tracked'],
      [estimatedEntryId('2026-09-24', 'acme'), '2026-09-24', 'acme', '14:15', 15, 'estimated']
    ])
    expect(sheet.entries[0].span).toEqual({ start: at(22, 9, 2), end: at(22, 10, 7) })
    expect(newEntryId(sheet.entries)).toBe('m5')
  })

  it('keeps an entry id while its session grows, and ids stay apart', () => {
    const base = [ev(at(22, 9), 'start', 'acme'), ...beats(22, 9, 10)]
    const early = draftTimesheet('2026-09-21', [], base, { now: at(22, 9, 58) })
    const later = draftTimesheet('2026-09-21', [], [...base, ...beats(22, 10, 12)], { now: at(22, 11, 58) })
    expect(early.entries.map((e) => e.id)).toEqual(later.entries.map((e) => e.id))
    expect(later.entries[0].minutes).toBeGreaterThan(early.entries[0].minutes)
    expect(estimatedEntryId('2026-09-24', 'acme')).not.toBe(estimatedEntryId('2026-09-24', 'globex'))
  })
})

describe('corrections to tracked time', () => {
  // Acme from 13:00, still running at 16:00; a meeting for Globex from 14:00 to 15:00 was never switched to.
  const running = [ev(at(22, 13), 'start', 'acme'), ...beats(22, 13, 16)]

  it('reassigns a window in the middle of a running task, which keeps counting after it', () => {
    const fixed = [...running, assign('a1', at(22, 14), at(22, 15), 'globex', at(22, 15, 30))]
    const sheet = draftTimesheet('2026-09-21', [], fixed, { now: at(22, 15, 58) })
    expect(rows(sheet)).toEqual([
      ['2026-09-22', 'acme', '13:00', 60, 'tracked'],
      ['2026-09-22', 'globex', '14:00', 60, 'tracked'],
      ['2026-09-22', 'acme', '15:00', 60, 'tracked']
    ])
    // An hour later the same correction still holds, and the afternoon session has grown in place.
    const later = draftTimesheet('2026-09-21', [], [...fixed, ...beats(22, 16, 17)], { now: at(22, 16, 58) })
    expect(rows(later).at(-1)).toEqual(['2026-09-22', 'acme', '15:00', 120, 'tracked'])
    expect(later.entries.at(-1)!.id).toBe(sheet.entries.at(-1)!.id)
  })

  it('does not bridge a window you said was not worked', () => {
    const fixed = [...running, assign('a1', at(22, 13, 30), at(22, 13, 45), null, at(22, 16))]
    const sheet = draftTimesheet('2026-09-21', [], fixed, { now: at(22, 15, 58) })
    expect(rows(sheet)).toEqual([
      ['2026-09-22', 'acme', '13:00', 30, 'tracked'],
      ['2026-09-22', 'acme', '13:45', 135, 'tracked']
    ])
  })

  it('moves a start earlier by assigning the time before it', () => {
    const fixed = [...running, assign('a1', at(22, 12, 30), at(22, 13), 'acme', at(22, 16))]
    const sheet = draftTimesheet('2026-09-21', [], fixed, { now: at(22, 15, 58) })
    expect(rows(sheet)).toEqual([['2026-09-22', 'acme', '12:30', 210, 'tracked']])
    expect(sheet.entries[0].id).toBe(trackedEntryId(at(22, 12, 30)))
  })

  it('applies corrections in the order they were made, and an undo takes one back', () => {
    const first = assign('a1', at(22, 14), at(22, 15), 'globex', at(22, 15, 30))
    const second = assign('a2', at(22, 14, 30), at(22, 15), 'initech', at(22, 15, 40))
    // Filed in the other order: what counts is when each was made.
    const sheet = draftTimesheet('2026-09-21', [], [...running, second, first], { now: at(22, 15, 58) })
    expect(rows(sheet).map((r) => `${r[1]} ${r[2]} ${r[3]}`)).toEqual(['acme 13:00 60', 'globex 14:00 30', 'initech 14:30 30', 'acme 15:00 60'])
    const undo: ActivityEvent = { t: at(22, 14, 30), type: 'assign', cancels: 'a2', at: at(22, 15, 50) }
    const undone = draftTimesheet('2026-09-21', [], [...running, first, second, undo], { now: at(22, 15, 58) })
    expect(rows(undone).map((r) => `${r[1]} ${r[2]} ${r[3]}`)).toEqual(['acme 13:00 60', 'globex 14:00 60', 'acme 15:00 60'])
  })

  it('never reads a correction as the app being alive', () => {
    // Monday's log ends without a stop; a correction for Monday made on Wednesday must not stretch it to Wednesday.
    const events = [ev(at(21, 9), 'start', 'acme'), ...beats(21, 9, 10), assign('a1', at(21, 9), at(21, 9, 15), 'globex', at(23, 12))]
    const time = computeWeekTime([], events, { dates: ['2026-09-21', '2026-09-22', '2026-09-23'], now: at(23, 12, 5) })
    const acme = time.taskSegments.filter((s) => s.canvasId === 'acme')
    expect(acme.at(-1)!.end < at(21, 11)).toBe(true)
  })

  it('counts a day as tracked when time was assigned to it, not when time was only removed', () => {
    const notes: ReviewNote[] = [{ canvasId: 'acme', date: '2026-09-24', entry: { id: 'n1', createdAt: at(24, 14, 10), markdown: 'a note' } }]
    const removed = computeWeekTime(notes, [assign('a1', at(24, 9), at(24, 10), null, at(25, 9))], { dates: ['2026-09-24'], now: at(26, 12) })
    expect(removed.method.get('2026-09-24')).toBe('estimated')
    const assigned = computeWeekTime(notes, [assign('a1', at(24, 9), at(24, 10), 'globex', at(25, 9))], { dates: ['2026-09-24'], now: at(26, 12) })
    expect(assigned.method.get('2026-09-24')).toBe('tracked')
    expect(assigned.byCanvasDay.get('2026-09-24')?.get('globex')).toBe(60)
  })
})

describe('a timesheet that follows tracked time', () => {
  const running = [ev(at(22, 13), 'start', 'acme'), ...beats(22, 13, 15)]
  const notes: ReviewNote[] = [{ canvasId: 'globex', date: '2026-09-24', entry: { id: 'n1', createdAt: at(24, 14, 10), markdown: 'untracked day' } }]
  const draftAt = (h: number, more: ActivityEvent[] = []): Timesheet => draftTimesheet('2026-09-21', notes, [...running, ...more], { now: at(22, h, 58) })

  it('lays your adjustments over every fresh draft', () => {
    const first = draftAt(14)
    const tracked = first.entries.find((e) => e.source === 'tracked')!
    const estimated = first.entries.find((e) => e.source === 'estimated')!
    const saved: Timesheet = {
      ...first,
      entries: [{ id: 'm1', date: '2026-09-23', start: at(23, 9), minutes: 30, canvasId: 'globex', worked: 0, source: 'manual', note: 'call' }],
      adjustments: { minutes: { [tracked.id]: -15 }, notes: { [tracked.id]: 'build' }, removed: [estimated.id] }
    }
    const now = resolveTimesheet(first, saved)
    expect(now.entries.map((e) => [e.id, e.minutes, e.note ?? ''])).toEqual([
      [tracked.id, tracked.minutes - 15, 'build'],
      ['m1', 30, 'call']
    ])
    // An hour later: the task has kept counting, with the same adjustments on it.
    const later = resolveTimesheet(draftAt(15, beats(22, 15, 16)), saved)
    expect(later.entries[0]).toMatchObject({ id: tracked.id, minutes: tracked.minutes + 60 - 15, note: 'build' })
  })

  it('keeps a final or a pre-0.19 timesheet exactly as saved', () => {
    const draft = draftAt(14)
    const legacy: Timesheet = { week: draft.week, status: 'draft', updatedAt: 'x', entries: [{ ...draft.entries[0], id: 'e1', minutes: 45 }] }
    expect(resolveTimesheet(draft, legacy)).toBe(legacy)
    const final: Timesheet = { ...draft, status: 'final', entries: [] }
    expect(resolveTimesheet(draft, final)).toBe(final)
  })

  it('has a pre-0.19 timesheet follow tracked time, keeping notes, trims and added entries', () => {
    const draft = draftAt(14)
    const t = draft.entries.find((e) => e.source === 'tracked')!
    const legacy: Timesheet = {
      week: draft.week,
      status: 'draft',
      updatedAt: 'x',
      entries: [
        { ...t, id: 'e1', minutes: t.minutes - 15, note: 'build' },
        { id: 'm2', date: '2026-09-23', start: at(23, 9), minutes: 30, canvasId: 'globex', worked: 0, source: 'manual' }
      ]
    }
    const adopted = adoptTimesheet(legacy, draft)
    expect(adopted.adjustments).toEqual({ minutes: { [t.id]: -15 }, notes: { [t.id]: 'build' }, removed: [] })
    expect(resolveTimesheet(draft, adopted).entries.map((e) => [e.id, e.minutes])).toEqual([
      [t.id, t.minutes - 15],
      ['m2', 30],
      [estimatedEntryId('2026-09-24', 'globex'), 15]
    ])
  })

  it('pushes a lengthened entry’s neighbour later rather than overlapping it', () => {
    const events = [ev(at(22, 9), 'start', 'acme'), ...beats(22, 9, 10), ev(at(22, 10), 'task', 'globex'), ...beats(22, 10, 11), ev(at(22, 11), 'stop')]
    const draft = draftTimesheet('2026-09-21', [], events, { now: at(26, 12) })
    const sheet = resolveTimesheet(draft, { ...draft, entries: [], adjustments: { minutes: { [draft.entries[0].id]: 30 }, notes: {}, removed: [] } })
    expect(rows(sheet).map((r) => `${r[1]} ${r[2]} ${r[3]}`)).toEqual(['acme 09:00 90', 'globex 10:30 60'])
  })

  it('stores adjustments and spans, and reads them back', () => {
    const draft = draftAt(14)
    const sheet = { ...resolveTimesheet(draft, null), adjustments: { minutes: { [draft.entries[0].id]: 15 }, notes: { m9: 'x' }, removed: ['bad id!', 'n1'] } }
    const back = parseTimesheet(serializeTimesheet(sanitizeTimesheet(sheet), (id) => id, (id) => id))!
    expect(back.adjustments).toEqual({ minutes: { [draft.entries[0].id]: 15 }, notes: { m9: 'x' }, removed: ['n1'] })
    expect(back.entries[0].span).toEqual(draft.entries[0].span)
    // A sheet saved before 0.19 reads back without adjustments, so it stays as saved.
    expect(sanitizeTimesheet({ week: '2026-09-21', entries: [] }).adjustments).toBeUndefined()
  })
})
