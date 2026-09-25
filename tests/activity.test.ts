import { describe, expect, it } from 'vitest'
import {
  activeExclusions,
  applyExclusions,
  buildTrackedSegments,
  applyExplicitDurations,
  bucketizeDay,
  buildFocusSegments,
  buildTaskSegments,
  classifyApp,
  cleanFocusSegments,
  isIgnoredFocus,
  focusSummaryByDay,
  splitByLocalDay,
  taskMinutesByDay
} from '../src/shared/activity'
import { normalizeDurationMarker, parseDurationMarker } from '../packages/core/src/format/blocks'
import type { ActivityEvent } from '../src/shared/types'

const T = (h: number, m = 0, day = 14): string => new Date(2026, 8, day, h, Math.floor(m), Math.round((m % 1) * 60)).toISOString()
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
      ev('start', T(9), { canvasId: null }),
      ev('task', T(9, 10), { canvasId: 'acme' }),
      ev('heartbeat', T(9, 15)),
      ev('lock', T(10)),
      ev('unlock', T(10, 30)),
      ev('task', T(11), { canvasId: 'globex' }),
      ev('idle', T(11, 45)),
      ev('active', T(12)),
      ev('task', T(12, 30), { canvasId: null }),
      ev('stop', T(13))
    ]
    const segs = buildTaskSegments(events, ALIVE)
    expect(segs.map((s) => [s.canvasId, mins(s.start, s.end)])).toEqual([
      ['acme', 50],
      ['acme', 30],
      ['globex', 45],
      ['globex', 30]
    ])
  })

  it('closes a segment when the app went silent and restores the task on start', () => {
    const events = [ev('task', T(9), { canvasId: 'acme' }), ev('heartbeat', T(9, 5)), ev('start', T(14), { canvasId: 'acme' }), ev('heartbeat', T(14, 5))]
    const segs = buildTaskSegments(events, { heartbeatMs: 5 * 60_000, now: T(14, 10) })
    expect(segs.map((s) => [s.canvasId, mins(s.start, s.end)])).toEqual([
      ['acme', 10], // 9:00 → last heartbeat 9:05 + one heartbeat
      ['acme', 10] // 14:00 → now 14:10
    ])
  })

  it('caps an open segment at now', () => {
    const segs = buildTaskSegments([ev('task', T(9), { canvasId: 'a' })], { ...ALIVE, now: T(9, 20) })
    expect(mins(segs[0].start, segs[0].end)).toBe(20)
  })

  it('lets explicit durations override tracked time in their window', () => {
    const tracked = buildTaskSegments([ev('task', T(9), { canvasId: 'acme' }), ev('task', T(12), { canvasId: 'globex' }), ev('stop', T(13))], ALIVE)
    const out = applyExplicitDurations(tracked, [{ canvasId: 'meeting', end: T(12, 30), minutes: 60, entryId: 'x' }])
    expect(out.map((s) => [s.canvasId, mins(s.start, s.end), s.source])).toEqual([
      ['acme', 150, 'tracked'],
      ['meeting', 60, 'explicit'],
      ['globex', 30, 'tracked']
    ])
    const byDay = taskMinutesByDay(out)
    expect(byDay.get('2026-09-14')?.get('acme')).toBe(150)
    expect(byDay.get('2026-09-14')?.get('meeting')).toBe(60)
  })

  it('splits segments at local midnight', () => {
    const pieces = splitByLocalDay([{ canvasId: 'a', start: T(23, 30, 14), end: T(0, 30, 15), source: 'tracked' as const }])
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

describe('timeline buckets', () => {
  it('summarises tasks, apps, notes and system events per interval and skips empty ones', () => {
    const events = [
      ev('task', T(9), { canvasId: 'acme' }),
      ev('focus', T(9), { app: 'Code', title: 'a.ts' }),
      ev('focus', T(9, 10), { app: 'chrome', title: 'Docs' }),
      ev('lock', T(9, 20)),
      ev('unlock', T(11)),
      ev('focus', T(11), { app: 'Code', title: 'b.ts' }),
      ev('task', T(11, 5), { canvasId: 'globex' }),
      ev('stop', T(11, 20))
    ]
    const tasks = buildTaskSegments(events, ALIVE)
    const focus = buildFocusSegments(events, ALIVE)
    const notes = [{ canvasId: 'acme', entry: { id: 'n1', createdAt: T(9, 3), markdown: 'hi' } }]
    const buckets = bucketizeDay({ date: '2026-09-14', intervalMinutes: 15, taskSegments: tasks, focusSegments: focus, notes, events, now: T(12) })
    expect(buckets.map((b) => new Date(b.start).getHours() * 60 + new Date(b.start).getMinutes())).toEqual([540, 555, 660, 675])
    const first = buckets[0]
    expect(first.tasks).toEqual([{ canvasId: 'acme', minutes: 15, source: 'tracked' }])
    expect(first.apps.map((a) => [a.app, a.minutes])).toEqual([
      ['Code', 10],
      ['chrome', 5]
    ])
    expect(first.apps[0].titles).toEqual([{ title: 'a.ts', minutes: 10 }])
    expect(first.screenMinutes).toBe(15)
    expect(first.notes.map((n) => n.entry.id)).toEqual(['n1'])
    const second = buckets[1]
    expect(second.tasks[0].minutes).toBe(5) // 9:15–9:20, then locked
    expect(second.system.map((e) => e.type)).toEqual(['lock'])
    const third = buckets[2]
    expect(third.system.map((e) => e.type)).toEqual(['unlock'])
    expect(third.tasks.map((t) => [t.canvasId, t.minutes])).toEqual([
      ['acme', 5],
      ['globex', 10]
    ])
    expect(buckets[3].system.map((e) => e.type)).toEqual(['stop'])
  })

  it('does not produce buckets in the future', () => {
    const buckets = bucketizeDay({ date: '2026-09-14', intervalMinutes: 30, taskSegments: [{ canvasId: 'a', start: T(9), end: T(18), source: 'tracked' }], focusSegments: [], notes: [], events: [], now: T(10, 10) })
    expect(buckets).toHaveLength(3) // 9:00, 9:30, 10:00
  })
})

describe('focus cleanup', () => {
  const seg = (app: string, title: string, a: string, b: string) => ({ app, title, kind: classifyApp(app, title), start: a, end: b })

  it('recognises window-manager chrome', () => {
    expect(isIgnoredFocus('explorer', 'Task Switching')).toBe(true)
    expect(isIgnoredFocus('explorer', '')).toBe(true)
    expect(isIgnoredFocus('explorer', 'Downloads')).toBe(false)
    expect(isIgnoredFocus('SearchHost', 'Search')).toBe(true)
    expect(isIgnoredFocus('LockApp', '')).toBe(true)
    expect(isIgnoredFocus('Code', 'a.ts')).toBe(false)
  })

  it('drops the task switcher, folds brief flips into their neighbour and merges identical windows', () => {
    const segs = [
      seg('Code', 'a.ts', T(9, 0), T(9, 10)),
      seg('explorer', 'Task Switching', T(9, 10), T(9, 10.02)), // 1.2 s of alt-tab UI
      seg('chrome', 'Docs', T(9, 10.02), T(9, 10.05)), // 1.8 s "wrong window"
      seg('OUTLOOK', 'Inbox', T(9, 10.05), T(9, 20)),
      seg('OUTLOOK', 'Inbox', T(9, 20), T(9, 25)),
      seg('Code', 'b.ts', T(9, 25), T(9, 30))
    ]
    const out = cleanFocusSegments(segs, { minSeconds: 5 })
    expect(out.map((s) => [s.app, s.title, mins(s.start, s.end)])).toEqual([
      ['Code', 'a.ts', 10.05],
      ['OUTLOOK', 'Inbox', 14.95],
      ['Code', 'b.ts', 5]
    ])
  })

  it('folds a brief first flip forward into the next window', () => {
    const out = cleanFocusSegments([seg('chrome', 'x', T(9), T(9, 0.03)), seg('Code', 'a', T(9, 0.03), T(9, 5))], { minSeconds: 5 })
    expect(out.map((s) => [s.app, mins(s.start, s.end)])).toEqual([['Code', 5]])
  })
})

describe('pauses and corrections', () => {
  it('does not restart the clock when the machine wakes while still locked', () => {
    // Lock at 17:00, sleep, background wakes overnight, unlock next morning at 08:30.
    const events = [
      ev('task', T(16), { canvasId: 'acme' }),
      ev('lock', T(17)),
      ev('suspend', T(17, 30)),
      ev('resume', T(19)),
      ev('heartbeat', T(19, 5)),
      ev('suspend', T(19, 10)),
      ev('resume', T(23)),
      ...Array.from({ length: 12 }, (_, i) => ev('heartbeat', T(23, i * 5))),
      ev('unlock', T(8, 30, 15)),
      ev('stop', T(9, 0, 15))
    ]
    const segs = buildTaskSegments(events, ALIVE)
    expect(segs.map((s) => [s.canvasId, mins(s.start, s.end)])).toEqual([
      ['acme', 60],
      ['acme', 30]
    ])
  })

  it('keeps idle and sleep independent: input after idle does not end a sleep, waking does not end idle', () => {
    const events = [ev('task', T(9), { canvasId: 'a' }), ev('idle', T(10)), ev('suspend', T(10, 5)), ev('active', T(10, 10)), ev('resume', T(10, 20)), ev('stop', T(11))]
    expect(buildTaskSegments(events, ALIVE).map((s) => mins(s.start, s.end))).toEqual([60, 40])
  })

  it('cuts removed windows out of tracked time, honours undo, and leaves explicit durations alone', () => {
    const events: ActivityEvent[] = [
      ev('task', T(9), { canvasId: 'a' }),
      ev('stop', T(17)),
      { t: T(12), type: 'exclude', id: 'x1', start: T(12), end: T(13) },
      { t: T(15), type: 'exclude', id: 'x2', start: T(15), end: T(18) },
      { t: T(16), type: 'exclude', id: 'x3', start: T(9), end: T(10) },
      { t: T(16), type: 'exclude', cancels: 'x3' }
    ]
    expect(activeExclusions(events).map((w) => w.id)).toEqual(['x1', 'x2'])
    const segs = buildTrackedSegments(events, ALIVE)
    expect(segs.map((s) => [hm(s.start), hm(s.end)])).toEqual([
      ['9:00', '12:00'],
      ['13:00', '15:00']
    ])
    const explicit = applyExclusions([{ canvasId: 'a', start: T(12), end: T(13), source: 'explicit' }], activeExclusions(events))
    expect(explicit).toHaveLength(1)
  })
})

function hm(iso: string): string {
  const d = new Date(iso)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
