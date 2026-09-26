import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLog, datesBetween, machineFolder } from '../src/node/activityLog'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-act-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('ActivityLog', () => {
  it('appends one JSON line per event into per-day files and reads ranges back sorted', async () => {
    const log = new ActivityLog(() => root, 'desk-1a2b')
    const t1 = new Date(2026, 8, 14, 9).toISOString()
    const t2 = new Date(2026, 8, 15, 9).toISOString()
    const t0 = new Date(2026, 8, 14, 8).toISOString()
    await log.append({ t: t1, type: 'task', canvasId: 'acme' })
    await log.append({ t: t2, type: 'lock' })
    await log.append({ t: t0, type: 'start', canvasId: null })
    expect(await fs.readFile(path.join(root, 'activity/desk-1a2b/2026/09/2026-09-14.jsonl'), 'utf8')).toContain('"type":"task"')
    const all = await log.read('2026-09-14', '2026-09-15')
    expect(all.map((e) => e.type)).toEqual(['start', 'task', 'lock'])
    expect(all.every((e) => e.machine === 'desk-1a2b')).toBe(true)
    expect(await log.read('2026-09-15', '2026-09-20')).toHaveLength(1)
    expect(datesBetween('2026-09-30', '2026-10-02')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02'])
  })

  it('keeps one folder per machine and reads them all, tagged, together with the old shared layout', async () => {
    const desk = new ActivityLog(() => root, machineFolder('DESKTOP-ÆØ 42', 'ab12cd'))
    const laptop = new ActivityLog(() => root, machineFolder('Stephen’s MacBook Pro', 'ff00'))
    expect(desk.machine).toBe('desktop-42-ab12cd')
    expect(laptop.machine).toBe('stephen-s-macbook-pro-ff00')
    expect(() => new ActivityLog(() => root, '2026')).toThrow()
    expect(() => new ActivityLog(() => root, '../x')).toThrow()

    await desk.append({ t: new Date(2026, 8, 14, 9).toISOString(), type: 'task', canvasId: 'a', machine: 'spoofed' })
    await laptop.append({ t: new Date(2026, 8, 14, 10).toISOString(), type: 'lock' })
    // Pre-0.4 shared file in the repository.
    await fs.mkdir(path.join(root, 'activity/2026/09'), { recursive: true })
    await fs.writeFile(path.join(root, 'activity/2026/09/2026-09-14.jsonl'), `${JSON.stringify({ t: new Date(2026, 8, 14, 8).toISOString(), type: 'start', pageId: 'old' })}\nnot json\n`)

    expect(await desk.machines()).toEqual(['', 'desktop-42-ab12cd', 'stephen-s-macbook-pro-ff00'])
    const evs = await laptop.read('2026-09-14', '2026-09-14')
    expect(evs.map((e) => [e.type, e.machine, e.canvasId ?? null])).toEqual([
      ['start', '', 'old'],
      ['task', 'desktop-42-ab12cd', 'a'],
      ['lock', 'stephen-s-macbook-pro-ff00', null]
    ])
    // The machine tag is never written to disk.
    expect(await fs.readFile(desk.fileFor('2026-09-14'), 'utf8')).not.toContain('machine')
  })

})
