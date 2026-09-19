import { describe, expect, it } from 'vitest'
import {
  applyExplicitDurations,
  buildFocusSegments,
  buildTaskSegments,
  classifyApp,
  focusSummaryByDay,
  splitByLocalDay,
  taskMinutesByDay
} from '../src/shared/activity'
import { normalizeDurationMarker, parseDurationMarker } from '../src/shared/entries'
import type { ActivityEvent } from '../src/shared/types'

const T = (h: number, m = 0, day = 14): string => new Date(2026, 8, day, h, m).toISOString()
const ev = (type: ActivityEvent['type'], t: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ t, type, ...extra })
const mins = (a: string, b: string): number => (new Date(b).getTime() - new Date(a).getTime()) / 60_000
// Synthetic streams below carry no heartbeats; the real tracker emits one every 5 minutes.
const ALIVE = { heartbeatMs: 24 * 60 * 60_000 }

describe('duration markers', () => {
  it('parses hours and minutes in brackets', () => {
    expect(parseDurationMarker('[2h] Acme sync')).toBe(120)
    expect(parseDurationMarker('wrap up [45m]')).toBe(45)
    expect(parseDurationMarker('[1h 30m] pairing')).toBe(90)
    expect(parseDurationMarker('[1.5h]')).toBe(90)
    expect(parseDurationMarker('[90 min]')).toBe(90)
    expect(parseDurationMarker('\\[45m\\] escaped by the editor')).toBe(45)
    expect(normalizeDurationMarker('\\[1h 30m\\] pairing \\[not a marker\\]')).toBe('[1h 30m] pairing \\[not a marker\\]')
    expect(parseDurationMarker('no marker here [x]')).toBeNull()
    expect(parseDurationMarker('link [text](http://x) and `[1h]` in code')).toBeNull()
    expect(parseDurationMarker('```\n[1h]\n```')).toBeNull()
  })
})

describe('task segments', () => {
  it('runs from a task event until the next task, stop or pause; pauses resume the same task', () => {
    const events = [
      ev('start', T(9), { pageId: null }),
      ev('task', T(9, 10), { pageId: 'acme' }),
      ev('heartbeat', T(9, 15)),
      ev('lock', T(10)),
      ev('unlock', T(10, 30)),
      ev('task', T(11), { pageId: 'globex' }),
      ev('idle', T(11, 45)),
      ev('active', T(12)),
      ev('task', T(12, 30), { pageId: null }),
      ev('stop', T(13))
    ]
    const segs = buildTaskSegments(events, ALIVE)
    expect(segs.map((s) => [s.pageId, mins(s.start, s.end)])).toEqual([
      ['acme', 50],
      ['acme', 30],
      ['globex', 45],
      ['globex', 30]
    ])
  })

  it('closes a segment when the app went silent and restores the task on start', () => {
    const events = [ev('task', T(9), { pageId: 'acme' }), ev('heartbeat', T(9, 5)), ev('start', T(14), { pageId: 'acme' }), ev('heartbeat', T(14, 5))]
    const segs = buildTaskSegments(events, { heartbeatMs: 5 * 60_000, now: T(14, 10) })
    expect(segs.map((s) => [s.pageId, mins(s.start, s.end)])).toEqual([
      ['acme', 10], // 9:00 → last heartbeat 9:05 + one heartbeat
      ['acme', 10] // 14:00 → now 14:10
    ])
  })

  it('caps an open segment at now', () => {
    const segs = buildTaskSegments([ev('task', T(9), { pageId: 'a' })], { ...ALIVE, now: T(9, 20) })
    expect(mins(segs[0].start, segs[0].end)).toBe(20)
  })

  it('lets explicit durations override tracked time in their window', () => {
    const tracked = buildTaskSegments([ev('task', T(9), { pageId: 'acme' }), ev('task', T(12), { pageId: 'globex' }), ev('stop', T(13))], ALIVE)
    const out = applyExplicitDurations(tracked, [{ pageId: 'meeting', end: T(12, 30), minutes: 60, entryId: 'x' }])
    expect(out.map((s) => [s.pageId, mins(s.start, s.end), s.source])).toEqual([
      ['acme', 150, 'tracked'],
      ['meeting', 60, 'explicit'],
      ['globex', 30, 'tracked']
    ])
    const byDay = taskMinutesByDay(out)
    expect(byDay.get('2026-09-14')?.get('acme')).toBe(150)
    expect(byDay.get('2026-09-14')?.get('meeting')).toBe(60)
  })

  it('splits segments at local midnight', () => {
    const pieces = splitByLocalDay([{ pageId: 'a', start: T(23, 30, 14), end: T(0, 30, 15), source: 'tracked' as const }])
    expect(pieces.map((p) => [p.date, p.minutes])).toEqual([
      ['2026-09-14', 30],
      ['2026-09-15', 30]
    ])
  })
})

describe('focus', () => {
  it('classifies apps and titles', () => {
    expect(classifyApp('Code', 'store.ts - devlog')).toBe('coding')
    expect(classifyApp('devenv', 'Solution')).toBe('coding')
    expect(classifyApp('ms-teams', 'Standup | Microsoft Teams')).toBe('meeting')
    expect(classifyApp('chrome', 'Meet - abc-defg-hij')).toBe('browser')
    expect(classifyApp('chrome', 'meet.google.com/abc')).toBe('meeting')
    expect(classifyApp('WindowsTerminal', 'pwsh')).toBe('terminal')
    expect(classifyApp('OUTLOOK', 'Inbox')).toBe('comms')
    expect(classifyApp('electron', 'Devlog')).toBe('devlog')
    expect(classifyApp('notepad', 'x')).toBe('other')
  })

  it('builds focus runs and summarises per day by app and kind', () => {
    const events = [
      ev('focus', T(9), { app: 'Code', title: 'a.ts' }),
      ev('focus', T(9, 30), { app: 'Code', title: 'b.ts' }),
      ev('focus', T(10), { app: 'ms-teams', title: 'Standup' }),
      ev('lock', T(10, 15)),
      ev('unlock', T(11)),
      ev('focus', T(11, 5), { app: 'chrome', title: 'Docs' }),
      ev('stop', T(11, 35))
    ]
    const segs = buildFocusSegments(events, ALIVE)
    expect(segs.map((s) => [s.app, mins(s.start, s.end)])).toEqual([
      ['Code', 30],
      ['Code', 30],
      ['ms-teams', 15],
      ['chrome', 30]
    ])
    const day = focusSummaryByDay(segs).get('2026-09-14')!
    expect(day.total).toBe(105)
    expect(day.kinds.get('coding')).toBe(60)
    expect(day.kinds.get('meeting')).toBe(15)
    expect(day.apps[0]).toMatchObject({ app: 'Code', minutes: 60 })
    expect(day.apps[0].titles.map((t) => t.title)).toEqual(['a.ts', 'b.ts'])
  })
})
