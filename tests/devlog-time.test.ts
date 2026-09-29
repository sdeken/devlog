import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseExtensionManifest } from '@devlog/core'
import { createTestContext, type TestCanvas } from '@devlog/extension-api/testing'
import { buildTaskSegments } from '@shared/activity'
import type { ActivityEvent } from '@shared/types'
import * as time from '../builtin-extensions/devlog-time/src/main'

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
    expect(t.commands().sort()).toEqual(['maketask', 'posttask', 'start', 'stop', 'switch'])
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
