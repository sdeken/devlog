import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExtensionManifest } from '@devlog/core'
import { createTestContext, type TestCanvas } from '@devlog/extension-api/testing'
import { buildTaskSegments } from '@shared/activity'
import type { ActivityEvent } from '@shared/types'
import * as time from '../builtin-extensions/devlog-time/src/main'
import { Timesheets } from '../builtin-extensions/devlog-time/src/timesheets'
import { monthsOfWeek, targetHours, targetsFor, weeksOfMonth } from '../builtin-extensions/devlog-time/src/targets'
import type { CanvasMeta, TimesheetEntry } from '@devlog/core'

const ID = 'builtin.devlog-time'
const TASK = `${ID}/task`

function setup(extra: { settings?: Record<string, string>; state?: string } = {}) {
  const canvases: TestCanvas[] = [
    { id: 'acme', title: 'Acme', parentId: null, task: false, archived: false, fields: {} },
    { id: 'fix', title: 'Fix login', parentId: 'acme', task: true, type: TASK, archived: false, fields: {} },
    { id: 'docs', title: 'Write docs', parentId: 'acme', task: true, type: TASK, archived: false, fields: {} }
  ]
  const t = createTestContext({ id: ID, canvases, settings: extra.settings, machine: 'desk-1a2b' })
  if (extra.state) t.files.local.set('state.json', new TextEncoder().encode(extra.state))
  return t
}

const read = (t: ReturnType<typeof setup>, store: 'repo' | 'local' = 'repo'): Array<Record<string, unknown>> =>
  [...t.files[store].entries()].filter(([p]) => p.endsWith('.jsonl')).flatMap(([, b]) =>
    new TextDecoder()
      .decode(b)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  )

afterEach(async () => {
  await time.deactivate()
  vi.useRealTimers()
})

describe('built-in extensions', () => {
  it('each ships a manifest the app accepts', async () => {
    const dir = path.resolve(__dirname, '../builtin-extensions')
    const names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    expect(names).toContain('devlog-time')
    for (const name of names) {
      const m = parseExtensionManifest(JSON.parse(await fs.readFile(path.join(dir, name, 'devlog-extension.json'), 'utf8')))
      expect(m.name).toBe(name)
    }
  })
})

describe('devlog-time', () => {
  it('asks the app for idle detection, the tray and keeping running; restores the saved task', async () => {
    const t = setup({ settings: { idle_minutes: '15' }, state: JSON.stringify({ active: 'fix' }) })
    await time.activate(t.ctx)
    expect(t.app).toMatchObject({ idleMinutes: 15, keepRunning: true, trayLabel: 'Acme / Fix login', highlight: 'fix' })
    expect(read(t)).toEqual([expect.objectContaining({ type: 'start', canvasId: 'fix' })])
    expect(t.commands().sort()).toEqual(['maketask', 'open-summary', 'posttask', 'start', 'stop', 'switch'])
  })

  it('drops a saved task that is gone', async () => {
    const t = setup({ state: JSON.stringify({ active: 'deleted' }) })
    await time.activate(t.ctx)
    expect(read(t)).toEqual([expect.objectContaining({ type: 'start', canvasId: null })])
    expect(t.app.trayLabel).toBe('no active task')
  })

  it('starts, switches and stops; posting on a task starts it, unless the block records the past', async () => {
    const t = setup()
    await time.activate(t.ctx)
    await t.run('start', { source: 'menu', canvasId: 'fix' })
    expect(t.app.highlight).toBe('fix')
    await expect(t.run('start', { source: 'menu', canvasId: 'acme' })).rejects.toThrow(/not a task/)

    t.post('docs', '2026-09-29', { id: 'b1', createdAt: new Date().toISOString(), markdown: 'Outline the guide' })
    await vi.waitFor(() => expect(t.app.highlight).toBe('docs'))
    t.post('fix', '2026-09-29', { id: 'b2', createdAt: new Date().toISOString(), markdown: '[30m] Paired on it yesterday' })
    t.post('acme', '2026-09-29', { id: 'b3', createdAt: new Date().toISOString(), markdown: 'A note on the client' })
    await new Promise((r) => setTimeout(r, 20))
    expect(t.app.highlight).toBe('docs')

    await t.run('stop')
    expect(t.app).toMatchObject({ highlight: null, trayLabel: 'no active task' })
    expect(read(t).map((e) => [e.type, e.canvasId ?? null, e.blockId ?? null])).toEqual([
      ['start', null, null],
      ['task', 'fix', null],
      ['task', 'docs', 'b1'],
      ['task', null, null]
    ])
  })

  it('posts as a task (Mod+Shift+Enter, #task) and turns a block into one', async () => {
    const t = setup()
    await time.activate(t.ctx)
    t.post('acme', '2026-09-29', { id: 'n1', createdAt: new Date().toISOString(), markdown: 'Rebuild the widget' })
    await t.run('posttask', { source: 'post', canvasId: 'acme', date: '2026-09-29', blockId: 'n1' })
    const made = t.created[0]
    await expect(t.ctx.devlog.canvases()).resolves.toContainEqual(expect.objectContaining({ id: made, title: 'Rebuild the widget', parentId: 'acme', type: TASK }))
    expect(t.app.highlight).toBe(made)
    await expect(t.run('maketask', { source: 'menu', canvasId: 'acme' })).rejects.toThrow(/on a block/)
  })

  it('picks a task, or stops, from a quick pick', async () => {
    const t = setup()
    await time.activate(t.ctx)
    t.answerPick = (items) => items.find((i) => i.label === 'Write docs')?.id ?? null
    await t.run('switch', { source: 'tray' })
    expect(t.picks[0].items.map((i) => i.label)).toEqual(['Fix login', 'Write docs'])
    expect(t.app.highlight).toBe('docs')
    t.answerPick = (items) => items[0].id
    await t.run('switch', { source: 'tray' })
    expect(t.picks[1].items[0]).toMatchObject({ label: 'Stop the clock' })
    expect(t.app.highlight).toBeNull()
  })

  it('pauses with the machine, and its events make task time with the machine state', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-29T09:00:00'), toFake: ['Date', 'setInterval', 'clearInterval'] })
    const t = setup()
    await time.activate(t.ctx)
    await t.run('start', { source: 'menu', canvasId: 'fix' })
    const views = t.viewMessages
    expect((views.get('status')?.at(-1) as { since: string }).since).toBe(new Date('2026-09-29T09:00:00').toISOString())

    await vi.advanceTimersByTimeAsync(30 * 60_000) // six heartbeats
    const lockAt = new Date().toISOString()
    t.notice({ t: lockAt, type: 'pause', reason: 'locked' })
    expect(views.get('status')?.at(-1)).toMatchObject({ active: 'fix', since: null, paused: 'locked' })
    await vi.advanceTimersByTimeAsync(60 * 60_000) // locked: no heartbeats
    const unlockAt = new Date().toISOString()
    t.notice({ t: unlockAt, type: 'resume' })
    expect(views.get('status')?.at(-1)).toMatchObject({ since: unlockAt, paused: null })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await t.run('stop')

    const events = await t.timeEvents('2026-09-29', '2026-09-29')
    expect(events.filter((e) => e.type === 'heartbeat')).toHaveLength(8)
    expect(events.every((e) => e.machine === 'desk-1a2b')).toBe(true)
    // With the app's record of the lock, the time is 30 + 10 minutes.
    const machine: ActivityEvent[] = [
      { t: lockAt, type: 'lock', machine: 'desk-1a2b' },
      { t: unlockAt, type: 'unlock', machine: 'desk-1a2b' }
    ]
    const segs = buildTaskSegments([...events.map((e) => ({ ...e, entryId: e.blockId })), ...machine] as ActivityEvent[], { now: new Date().toISOString() })
    expect(segs.map((s) => [s.canvasId, (Date.parse(s.end) - Date.parse(s.start)) / 60_000])).toEqual([
      ['fix', 30],
      ['fix', 10]
    ])
  })

  it('keeps time on this machine only when asked', async () => {
    const t = setup({ settings: { in_repo: 'false' } })
    await time.activate(t.ctx)
    await t.run('start', { source: 'menu', canvasId: 'fix' })
    expect(read(t, 'repo')).toEqual([])
    expect(read(t, 'local').map((e) => e.type)).toEqual(['start', 'task'])
  })

  it('answers its views: status, tasks near a canvas, a new task', async () => {
    const t = setup()
    await time.activate(t.ctx)
    expect(await t.viewCall('status', 'task', 'fix')).toMatchObject({ id: 'fix', title: 'Fix login', label: 'Acme / Fix login', path: 'Acme' })
    expect(await t.viewCall('status', 'task', 'acme')).toBeNull()
    expect(((await t.viewCall('picker', 'tasks', 'docs')) as Array<{ id: string }>).map((x) => x.id)).toEqual(['docs', 'fix'])
    const st = (await t.viewCall('picker', 'newTask', 'Review PRs', 'acme')) as { active: string; label: string }
    expect(st.label).toBe('Acme / Review PRs')
    await expect(t.viewCall('picker', 'newTask', '  ')).rejects.toThrow(/name/)
  })
})

describe('devlog-time timesheets', () => {
  const entry = { id: 'e1', date: '2026-09-22', start: new Date(2026, 8, 22, 9).toISOString(), minutes: 60, canvasId: 'fix', worked: 55, source: 'tracked' as const }

  it('keeps one block per week in its Timesheets canvas; later saves are edits', async () => {
    const t = setup()
    const sheets = new Timesheets(t.ctx, () => new Date(2026, 8, 26, 10))
    expect(await sheets.read('2026-09-21')).toBeNull()
    const saved = await sheets.save({ week: '2026-09-21', status: 'draft', entries: [entry] })
    expect(saved.updatedAt).toBe(new Date(2026, 8, 26, 10).toISOString())
    expect(await sheets.read('2026-09-21')).toEqual(saved)
    const canvasId = await sheets.canvas()
    const kept = (await t.ctx.devlog.canvases()).find((c) => c.id === canvasId)
    expect(kept).toMatchObject({ title: 'Timesheets' })
    const [block] = await t.ctx.devlog.blocks(canvasId, '2026-09-21')
    expect(block).toMatchObject({ kind: 'timesheet', meta: { week: '2026-09-21' } })
    expect(block.markdown).toContain('| 2026-09-22 | 09:00 | 1:00 | Acme / Fix login | Acme |')

    await sheets.save({ ...saved, status: 'final', entries: [{ ...entry, minutes: 45 }] })
    expect(await sheets.read('2026-09-21')).toMatchObject({ status: 'final', entries: [{ minutes: 45 }] })
    expect(await t.ctx.devlog.blocks(canvasId, '2026-09-21')).toHaveLength(1)
    await expect(sheets.save({ week: '2026-09-22', entries: [] })).rejects.toThrow(/Monday/)
  })

  it('sends the saved week through another extension, and writes what happened inside it', async () => {
    const sent: unknown[] = []
    const t = createTestContext({
      id: ID,
      canvases: [
        { id: 'acme', title: 'Acme', parentId: null, task: false, archived: false, fields: {} },
        { id: 'fix', title: 'Fix login', parentId: 'acme', task: true, type: TASK, archived: false, fields: {} }
      ],
      destinations: [
        {
          extension: 'devlog-jira',
          from: 'Jira worklogs',
          id: 'worklogs',
          label: 'Jira',
          destination: {
            preview: async (sheet) => sheet.entries.map((e) => ({ id: e.id, entryIds: [e.id], date: e.date, minutes: e.minutes, target: e.task, action: 'create' as const })),
            send: async (sheet) => {
              sent.push(sheet)
              return { done: sheet.entries.map((e) => e.id), failed: [], summary: '1 worklog created' }
            }
          }
        }
      ]
    })
    const sheets = new Timesheets(t.ctx)
    const to = { extension: 'devlog-jira', id: 'worklogs' }
    await expect(sheets.send(to, '2026-09-21')).rejects.toThrow(/Save the timesheet/)
    await sheets.save({ week: '2026-09-21', status: 'draft', entries: [entry] })
    expect((await sheets.preview(to, '2026-09-21'))[0]).toMatchObject({ target: 'Acme / Fix login', action: 'create' })
    await expect(sheets.send(to, '2026-09-21')).rejects.toThrow(/final/)
    await sheets.save({ week: '2026-09-21', status: 'final', entries: [entry] })
    expect(await sheets.send(to, '2026-09-21')).toMatchObject({ done: ['e1'], summary: '1 worklog created' })
    expect(sent).toHaveLength(1)
    const blocks = await t.ctx.devlog.blocks(await sheets.canvas(), '2026-09-21')
    const sheetBlock = blocks.find((b) => b.kind === 'timesheet')!
    expect(blocks.find((b) => b.parentId === sheetBlock.id)).toMatchObject({ markdown: 'Sent to Jira: 1 worklog created.', meta: { destination: 'worklogs', to: 'devlog-jira' } })
  })

  it('answers its pages: canvases without its own, what the app recorded, remembered choices', async () => {
    const activity = [{ t: new Date(2026, 8, 22, 9).toISOString(), type: 'task' as const, canvasId: 'fix', machine: 'm' }]
    const t = createTestContext({ id: ID, canvases: [{ id: 'fix', title: 'Fix login', parentId: null, task: true, type: TASK, archived: false, fields: {} }], activity })
    await time.activate(t.ctx)
    await t.viewCall('timesheet', 'saveTimesheet', { week: '2026-09-21', status: 'draft', entries: [entry] })
    expect(((await t.viewCall('timesheet', 'canvases')) as Array<{ id: string }>).map((c) => c.id)).toEqual(['fix'])
    expect(await t.viewCall('summary', 'activity', '2026-09-22', '2026-09-22')).toEqual(activity)
    expect(await t.viewCall('summary', 'pref', 'summary.granularity')).toBeNull()
    await t.viewCall('summary', 'setPref', 'summary.granularity', '30')
    expect(await t.viewCall('summary', 'pref', 'summary.granularity')).toBe('30')
    await t.run('open-summary')
    expect(t.openedPages).toEqual(['summary'])
  })
})

describe('hour targets', () => {
  const canvas = (id: string, title: string, parentId: string | null, fields: Record<string, string> = {}): CanvasMeta => ({ id, title, parentId, task: false, archived: false, createdAt: '', updatedAt: '', repos: [], hasSurface: false, fields })
  // 168 h for Globex in September, and 20 h a week for a task under Globex: two separate measures.
  const canvases = [canvas('globex', 'Globex', null, { target_month: '168' }), canvas('site', 'Site', 'globex'), canvas('fix', 'Fix login', 'site', { target_week: '20' }), canvas('acme', 'Acme', null)]
  let n = 0
  const e = (canvasId: string, date: string, minutes: number): TimesheetEntry => ({ id: `e${++n}`, date, start: `${date}T09:00:00.000Z`, minutes, canvasId, worked: minutes, source: 'tracked' })

  it('reads a target as hours, or none', () => {
    expect(targetHours('20')).toBe(20)
    expect(targetHours('7,5')).toBe(7.5)
    expect(targetHours('')).toBeNull()
    expect(targetHours('0')).toBeNull()
    expect(targetHours('lots')).toBeNull()
  })

  it('knows the months a week touches and the weeks of a month', () => {
    expect(monthsOfWeek('2026-09-21')).toEqual(['2026-09'])
    expect(monthsOfWeek('2026-09-28')).toEqual(['2026-09', '2026-10'])
    expect(weeksOfMonth('2026-09')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
  })

  it('measures each target on its own: its canvas and what is inside, in its own period, not taken on by canvases inside', () => {
    const week = [e('fix', '2026-09-22', 600), e('site', '2026-09-23', 120), e('acme', '2026-09-23', 60)]
    const earlier = [e('fix', '2026-09-08', 480), e('globex', '2026-08-31', 300)] // 31 Aug is outside September
    const rows = targetsFor(canvases, '2026-09-21', week, new Map([['2026-09', [...week, ...earlier]]]))
    expect(rows).toEqual([
      { canvasId: 'globex', period: 'month', key: '2026-09', target: 168 * 60, actual: 600 + 120 + 480 },
      { canvasId: 'fix', period: 'week', key: '2026-09-21', target: 20 * 60, actual: 600 }
    ])
  })

  it('a week across two months shows the monthly target for each', () => {
    const week = [e('fix', '2026-09-29', 60), e('fix', '2026-10-01', 90)]
    const rows = targetsFor(canvases, '2026-09-28', week, new Map([['2026-09', week], ['2026-10', week]]))
    expect(rows.filter((r) => r.period === 'month').map((r) => [r.key, r.actual])).toEqual([
      ['2026-09', 60],
      ['2026-10', 90]
    ])
  })
})
