import { describe, expect, it } from 'vitest'
import {
  balanceDays,
  buildSessions,
  draftEntries,
  roundToQuarterHour,
  roundWorkMinutes,
  topLevelCanvasId,
  type TimesheetEntry,
  type WorkSegment
} from '../src/index'
import type { CanvasMeta } from '../src/types'

/** A local time on Tuesday 2026-09-22 (or another day), as ISO. */
const at = (h: number, m = 0, s = 0, day = 22): string => new Date(2026, 8, day, h, m, s).toISOString()
const seg = (canvasId: string, start: string, end: string): WorkSegment => ({ canvasId, start, end })
const localHM = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('the rounding rule', () => {
  it('counts anything above zero as a quarter hour, then rounds to the nearest quarter, halves up', () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [-3, 0],
      [0.01, 15],
      [0.5, 15],
      [7.5, 15],
      [22.49, 15],
      [22.5, 30],
      [30, 30],
      [37.49, 30],
      [37.5, 45],
      [52.49, 45],
      [52.5, 60],
      [420, 420],
      [427.4, 420],
      [427.5, 435]
    ]
    for (const [m, want] of cases) expect(roundWorkMinutes(m), `${m} min`).toBe(want)
  })

  it('rounds start times to the nearest local quarter hour, halves up', () => {
    expect(localHM(roundToQuarterHour(new Date(at(9, 7, 29))).toISOString())).toBe('09:00')
    expect(localHM(roundToQuarterHour(new Date(at(9, 7, 30))).toISOString())).toBe('09:15')
    expect(localHM(roundToQuarterHour(new Date(at(9, 53))).toISOString())).toBe('10:00')
    expect(localHM(roundToQuarterHour(new Date(at(23, 55))).toISOString())).toBe('00:00')
  })
})

describe('sessions', () => {
  it('counts short breaks on the same task as work and splits at longer ones', () => {
    const sessions = buildSessions([
      seg('a', at(9), at(10)),
      seg('a', at(10, 20), at(11)), // a 20-minute bathroom/coffee lock: still one session
      seg('a', at(12, 0), at(13)), // a 60-minute lunch: a new session
      seg('a', at(13, 30), at(13, 45)) // exactly 30 minutes: still the same session
    ])
    expect(sessions.map((s) => [localHM(s.start), localHM(s.end), s.workedMinutes])).toEqual([
      ['09:00', '11:00', 120],
      ['12:00', '13:45', 105]
    ])
    expect(buildSessions([seg('a', at(9), at(10)), seg('a', at(10, 31), at(11))])).toHaveLength(2)
  })

  it('never joins across a switch to another task, and splits at midnight', () => {
    const sessions = buildSessions([seg('a', at(9), at(9, 30)), seg('b', at(9, 35), at(9, 40)), seg('a', at(9, 45), at(10))])
    expect(sessions.map((s) => s.canvasId)).toEqual(['a', 'b', 'a'])
    const late = buildSessions([seg('a', at(23, 30), at(0, 30, 0, 23))])
    expect(late.map((s) => [s.date, s.workedMinutes])).toEqual([
      ['2026-09-22', 30],
      ['2026-09-23', 30]
    ])
  })
})

describe('draft entries', () => {
  it('rounds each session once and lays starts out on quarter hours without overlaps', () => {
    const entries = draftEntries(
      buildSessions([
        seg('a', at(9, 2), at(9, 6)), // 4 min → 15, starts 09:00
        seg('b', at(9, 7), at(9, 10)), // 3 min → 15, would start 09:15 (09:07 rounds to 09:00, but a holds it)
        seg('c', at(9, 11), at(10, 40)) // 89 min → 90, 09:11 rounds to 09:15 but b holds it → 09:30
      ])
    )
    expect(entries.map((e) => [e.canvasId, localHM(e.start), e.minutes, e.worked])).toEqual([
      ['a', '09:00', 15, 4],
      ['b', '09:15', 15, 3],
      ['c', '09:30', 90, 89]
    ])
    for (const e of entries) expect(e.minutes % 15).toBe(0)
  })
})

describe('balancing rounding inflation', () => {
  const entry = (id: string, canvasId: string, minutes: number, worked: number, date = '2026-09-22'): TimesheetEntry => ({
    id,
    date,
    start: at(9),
    minutes,
    canvasId,
    worked,
    source: 'tracked'
  })
  const sameGroup = (): string => 'acme'

  it('suggests logging the long task shorter when many short tasks inflate the day', () => {
    // A dozen 4-minute tasks and a 7-hour task, all for the same client: 7 h 48 m worked.
    const entries = [...Array.from({ length: 12 }, (_, i) => entry(`s${i}`, `t${i}`, 15, 4)), entry('long', 'big', 420, 420)]
    const [day] = balanceDays(entries, sameGroup)
    expect(day).toMatchObject({ worked: 468, target: 465, reported: 600, residual: 0 })
    expect(day.suggestions).toEqual([{ entryId: 'long', from: 420, to: 285 }]) // 7 h → 4 h 45 m
  })

  it('spreads trims over the longest entries in turn and never goes below 15 minutes', () => {
    const entries = [entry('a', 'x', 60, 55), entry('b', 'y', 60, 52), ...Array.from({ length: 6 }, (_, i) => entry(`s${i}`, `z${i}`, 15, 2))]
    const [day] = balanceDays(entries, sameGroup)
    // worked 119 → target 120; reported 210; trim 90 minutes from a and b, 15 at a time, longest first.
    expect(day.target).toBe(120)
    expect(day.suggestions).toEqual([
      { entryId: 'a', from: 60, to: 15 },
      { entryId: 'b', from: 60, to: 15 }
    ])
    expect(day.residual).toBe(0)
  })

  it('says so when the inflation cannot be evened out', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`s${i}`, `t${i}`, 15, 2))
    const [day] = balanceDays(entries, sameGroup)
    expect(day).toMatchObject({ worked: 10, target: 15, reported: 75, suggestions: [], residual: 60 })
  })

  it('adds to the longest entry when rounding under-reports', () => {
    const entries = [entry('a', 'x', 30, 37), entry('b', 'y', 30, 36)] // 73 worked → 75, reported 60
    const [day] = balanceDays(entries, sameGroup)
    expect(day.suggestions).toEqual([{ entryId: 'a', from: 30, to: 45 }])
    expect(day.residual).toBe(0)
  })

  it('balances each client and each day separately', () => {
    const canvases = [
      { id: 'acme', parentId: null },
      { id: 'acme-web', parentId: 'acme' },
      { id: 'fix-login', parentId: 'acme-web' },
      { id: 'globex', parentId: null }
    ] as CanvasMeta[]
    const client = (id: string): string => topLevelCanvasId(canvases, id)
    expect(client('fix-login')).toBe('acme')
    expect(client('globex')).toBe('globex')
    const entries = [
      entry('a1', 'fix-login', 15, 3),
      entry('a2', 'acme-web', 15, 3),
      entry('a3', 'acme', 120, 118),
      entry('g1', 'globex', 240, 240),
      entry('a4', 'fix-login', 60, 58, '2026-09-23')
    ]
    const days = balanceDays(entries, client)
    expect(days.map((d) => [d.date, d.group, d.reported, d.target])).toEqual([
      ['2026-09-22', 'acme', 150, 120],
      ['2026-09-22', 'globex', 240, 240],
      ['2026-09-23', 'acme', 60, 60]
    ])
    // Acme's short tasks are paid for out of Acme's long entry, never Globex's.
    expect(days[0].suggestions).toEqual([{ entryId: 'a3', from: 120, to: 90 }])
    expect(days[1].suggestions).toEqual([])
  })
})
