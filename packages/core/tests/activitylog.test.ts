import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ActivityLog, datesBetween } from '../src/node/activityLog'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-act-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('ActivityLog', () => {
  it('appends one JSON line per event into per-day files and reads ranges back sorted', async () => {
    const log = new ActivityLog(() => root)
    const t1 = new Date(2026, 8, 14, 9).toISOString()
    const t2 = new Date(2026, 8, 15, 9).toISOString()
    const t0 = new Date(2026, 8, 14, 8).toISOString()
    await log.append({ t: t1, type: 'task', canvasId: 'acme' })
    await log.append({ t: t2, type: 'lock' })
    await log.append({ t: t0, type: 'start', canvasId: null })
    expect(await fs.readFile(path.join(root, 'activity/2026/09/2026-09-14.jsonl'), 'utf8')).toContain('"type":"task"')
    const all = await log.read('2026-09-14', '2026-09-15')
    expect(all.map((e) => e.type)).toEqual(['start', 'task', 'lock'])
    expect(await log.read('2026-09-15', '2026-09-20')).toHaveLength(1)
    expect(datesBetween('2026-09-30', '2026-10-02')).toEqual(['2026-09-30', '2026-10-01', '2026-10-02'])
  })
})
