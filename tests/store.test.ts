import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevlogStore } from '../src/main/devlog/store'

let root: string
let store: DevlogStore

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-store-'))
  store = new DevlogStore(root)
  await store.initLayout()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('DevlogStore', () => {
  it('creates the repository skeleton', async () => {
    expect((await fs.stat(path.join(root, 'entries'))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toContain('# Devlog')
  })

  it('adds, lists, updates and deletes entries', async () => {
    const t1 = new Date(2026, 8, 19, 9, 5)
    const t2 = new Date(2026, 8, 19, 17, 45)
    const a = await store.addEntry('Morning: started on the git sync', t1)
    const b = await store.addEntry('Evening: **done**', t2)
    expect(a.date).toBe('2026-09-19')
    expect(b.date).toBe('2026-09-19')

    const days = await store.listDays()
    expect(days).toEqual([{ date: '2026-09-19', count: 2 }])

    const day = await store.readDay('2026-09-19')
    expect(day.entries.map((e) => e.markdown)).toEqual(['Morning: started on the git sync', 'Evening: **done**'])

    const file = await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('### 09:05')
    expect(file).toContain('### 17:45')

    const updated = await store.updateEntry('2026-09-19', a.entry.id, 'Morning: rewrote it', new Date(2026, 8, 19, 10))
    expect(updated.updatedAt).toBeTruthy()
    expect((await store.readDay('2026-09-19')).entries[0].markdown).toBe('Morning: rewrote it')

    await store.deleteEntry('2026-09-19', a.entry.id)
    await store.deleteEntry('2026-09-19', b.entry.id)
    expect(await store.listDays()).toEqual([])
    await expect(fs.stat(path.join(root, 'entries/2026/09/2026-09-19.md'))).rejects.toThrow()
  })

  it('rejects empty entries and unknown ids', async () => {
    await expect(store.addEntry('   \n ')).rejects.toThrow(/empty/i)
    await expect(store.updateEntry('2026-09-19', 'nope', 'x')).rejects.toThrow(/not found/)
    await expect(store.deleteEntry('2026-09-19', 'nope')).rejects.toThrow(/not found/)
    await expect(store.readDay('2026-13-40')).rejects.toThrow(/Invalid date/)
  })

  it('saves pasted images next to the day and links them relative to the file', async () => {
    const when = new Date(2026, 8, 19, 14, 32, 1)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const saved = await store.saveAsset('2026-09-19', png, 'image/png', undefined, when)
    expect(saved.src).toMatch(/^entries\/2026\/09\/assets\/2026-09-19-143201-[a-z0-9]{4}\.png$/)
    expect(saved.size).toBe(7)
    expect(await fs.readFile(path.join(root, saved.src))).toEqual(Buffer.from(png))

    await store.addEntry(`Look:\n\n![shot](${saved.src})`, when)
    const file = await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![shot](assets/2026-09-19-143201-')
    const day = await store.readDay('2026-09-19')
    expect(day.entries[0].markdown).toContain(`![shot](${saved.src})`)
  })

  it('keeps cross-day image references valid', async () => {
    const png = new Uint8Array([1, 2, 3])
    const saved = await store.saveAsset('2026-09-30', png, 'image/png', undefined, new Date(2026, 8, 30, 23, 59))
    await store.addEntry(`![late](${saved.src})`, new Date(2026, 9, 1, 0, 1))
    const file = await fs.readFile(path.join(root, 'entries/2026/10/2026-10-01.md'), 'utf8')
    expect(file).toContain('![late](../09/assets/2026-09-30-235900-')
  })

  it('searches across days, newest first', async () => {
    await store.addEntry('alpha one', new Date(2026, 8, 18, 9))
    await store.addEntry('beta', new Date(2026, 8, 19, 9))
    await store.addEntry('ALPHA two', new Date(2026, 8, 19, 10))
    const hits = await store.search('alpha')
    expect(hits.map((h) => h.entry.markdown)).toEqual(['ALPHA two', 'alpha one'])
  })

  it('refuses paths outside the repository', () => {
    expect(() => store.resolve('../etc/passwd')).toThrow(/escapes/)
    expect(() => store.resolve('entries/../../x')).toThrow(/escapes/)
  })

  it('emits change events on writes', async () => {
    const events: unknown[] = []
    store.on('change', (e) => events.push(e))
    await store.addEntry('x')
    await store.saveAsset('2026-09-19', new Uint8Array([1]), 'image/png')
    expect(events).toHaveLength(2)
  })
})
