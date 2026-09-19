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
    const a = await store.addEntry('journal', 'Morning: started on the git sync', {}, t1)
    const b = await store.addEntry('journal', 'Evening: **done**', {}, t2)
    expect(a.date).toBe('2026-09-19')
    expect(b.date).toBe('2026-09-19')

    const days = await store.listDays('journal')
    expect(days).toEqual([{ date: '2026-09-19', count: 2 }])

    const day = await store.readDay('journal', '2026-09-19')
    expect(day.entries.map((e) => e.markdown)).toEqual(['Morning: started on the git sync', 'Evening: **done**'])

    const file = await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('### 09:05')
    expect(file).toContain('### 17:45')

    const updated = await store.updateEntry('journal', '2026-09-19', a.entry.id, 'Morning: rewrote it', new Date(2026, 8, 19, 10))
    expect(updated.updatedAt).toBeTruthy()
    expect((await store.readDay('journal', '2026-09-19')).entries[0].markdown).toBe('Morning: rewrote it')

    await store.deleteEntry('journal', '2026-09-19', a.entry.id)
    await store.deleteEntry('journal', '2026-09-19', b.entry.id)
    expect(await store.listDays('journal')).toEqual([])
    await expect(fs.stat(path.join(root, 'entries/2026/09/2026-09-19.md'))).rejects.toThrow()
  })

  it('supports replies, inserts between notes, and deletes whole threads', async () => {
    const d = (h: number, m = 0): Date => new Date(2026, 8, 19, h, m)
    const a = await store.addEntry('journal', 'A', {}, d(9))
    const b = await store.addEntry('journal', 'B', {}, d(10))
    // Reply to A, written on a later day but stored with its parent.
    const r1 = await store.addEntry('journal', 'reply to A', { date: '2026-09-19', parentId: a.entry.id }, new Date(2026, 8, 20, 8))
    const r2 = await store.addEntry('journal', 'reply to reply', { date: '2026-09-19', parentId: r1.entry.id }, d(11))
    const between = await store.addEntry('journal', 'between', { date: '2026-09-19', afterId: a.entry.id }, d(12))
    const first = await store.addEntry('journal', 'first', { date: '2026-09-19', beforeId: a.entry.id }, d(13))
    expect(r1.date).toBe('2026-09-19')

    const day = await store.readDay('journal', '2026-09-19')
    expect(day.entries.map((e) => e.markdown)).toEqual(['first', 'A', 'reply to A', 'reply to reply', 'between', 'B'])
    expect(day.entries[2].parentId).toBe(a.entry.id)
    expect(day.entries[3].parentId).toBe(r1.entry.id)
    expect(day.entries[4].parentId).toBeUndefined()
    expect(day.entries[0].id).toBe(first.entry.id)
    expect(day.entries[4].id).toBe(between.entry.id)
    expect(await store.listDays('journal')).toEqual([{ date: '2026-09-19', count: 6 }])

    const file = await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain(`parent=${a.entry.id}`)
    expect(file).toContain('#### ↳ 08:00')
    expect(file).toContain('##### ↳ 11:00')

    expect(await store.deleteEntry('journal', '2026-09-19', a.entry.id)).toBe(3)
    expect((await store.readDay('journal', '2026-09-19')).entries.map((e) => e.markdown)).toEqual(['first', 'between', 'B'])
    expect(await store.deleteEntry('journal', '2026-09-19', b.entry.id)).toBe(1)
    expect(r2.entry.parentId).toBe(r1.entry.id)
  })

  it('rejects empty entries and unknown ids', async () => {
    await expect(store.addEntry('journal', '   \n ')).rejects.toThrow(/empty/i)
    await expect(store.updateEntry('journal', '2026-09-19', 'nope', 'x')).rejects.toThrow(/not found/)
    await expect(store.addEntry('journal', 'x', { date: '2026-09-19', parentId: 'nope' })).rejects.toThrow(/not found/)
    await expect(store.deleteEntry('journal', '2026-09-19', 'nope')).rejects.toThrow(/not found/)
    await expect(store.readDay('journal', '2026-13-40')).rejects.toThrow(/Invalid date/)
  })

  it('saves pasted images next to the day and links them relative to the file', async () => {
    const when = new Date(2026, 8, 19, 14, 32, 1)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const saved = await store.saveAsset('journal', '2026-09-19', png, 'image/png', undefined, when)
    expect(saved.src).toMatch(/^entries\/2026\/09\/assets\/2026-09-19-143201-[a-z0-9]{4}\.png$/)
    expect(saved.size).toBe(7)
    expect(await fs.readFile(path.join(root, saved.src))).toEqual(Buffer.from(png))

    await store.addEntry('journal', `Look:\n\n![shot](${saved.src})`, {}, when)
    const file = await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![shot](assets/2026-09-19-143201-')
    const day = await store.readDay('journal', '2026-09-19')
    expect(day.entries[0].markdown).toContain(`![shot](${saved.src})`)
  })

  it('keeps cross-day image references valid', async () => {
    const png = new Uint8Array([1, 2, 3])
    const saved = await store.saveAsset('journal', '2026-09-30', png, 'image/png', undefined, new Date(2026, 8, 30, 23, 59))
    await store.addEntry('journal', `![late](${saved.src})`, {}, new Date(2026, 9, 1, 0, 1))
    const file = await fs.readFile(path.join(root, 'entries/2026/10/2026-10-01.md'), 'utf8')
    expect(file).toContain('![late](../09/assets/2026-09-30-235900-')
  })

  it('searches across days, newest first', async () => {
    await store.addEntry('journal', 'alpha one', {}, new Date(2026, 8, 18, 9))
    await store.addEntry('journal', 'beta', {}, new Date(2026, 8, 19, 9))
    await store.addEntry('journal', 'ALPHA two', {}, new Date(2026, 8, 19, 10))
    const hits = await store.search('alpha')
    expect(hits.map((h) => h.entry.markdown)).toEqual(['ALPHA two', 'alpha one'])
    expect(hits.every((h) => h.pageId === 'journal')).toBe(true)
  })

  it('refuses paths outside the repository', () => {
    expect(() => store.resolve('../etc/passwd')).toThrow(/escapes/)
    expect(() => store.resolve('entries/../../x')).toThrow(/escapes/)
  })

  it('emits change events on writes', async () => {
    const events: unknown[] = []
    store.on('change', (e) => events.push(e))
    await store.addEntry('journal', 'x')
    await store.saveAsset('journal', '2026-09-19', new Uint8Array([1]), 'image/png')
    expect(events).toHaveLength(2)
  })
})

describe('pages in the store', () => {
  it('creates, lists, updates and deletes pages', async () => {
    expect((await store.listPages()).map((p) => p.id)).toEqual(['journal'])
    const acme = await store.createPage({ title: 'Acme Corp', category: '', description: 'Retainer client' }, new Date(2026, 8, 19))
    expect(acme).toMatchObject({ id: 'acme-corp', title: 'Acme Corp', category: '', description: 'Retainer client' })
    const dup = await store.createPage({ title: 'Acme Corp' })
    expect(dup.id).toBe('acme-corp-2')
    const j = await store.createPage({ title: 'Journal' })
    expect(j.id).toBe('journal-page')
    expect(await fs.readFile(path.join(root, 'pages/acme-corp/page.md'), 'utf8')).toContain('title: Acme Corp')

    const listed = await store.listPages()
    expect(listed.map((p) => p.id)).toEqual(['journal', 'acme-corp', 'acme-corp-2', 'journal-page'])

    const updated = await store.updatePage('acme-corp', { category: 'Customers', description: '' })
    expect(updated.category).toBe('Customers')
    expect((await store.readPage('acme-corp')).description).toBe('')
    await expect(store.updatePage('journal', { title: 'x' })).rejects.toThrow(/journal/)
    await expect(store.createPage({ title: '   ' })).rejects.toThrow(/title/)

    await store.addEntry('acme-corp', 'kickoff', {}, new Date(2026, 8, 19, 9))
    expect(await store.deletePage('acme-corp')).toBe(1)
    expect((await store.listPages()).map((p) => p.id)).toEqual(['journal', 'acme-corp-2', 'journal-page'])
    await expect(store.readPage('acme-corp')).rejects.toThrow(/not found/)
    await expect(store.deletePage('journal')).rejects.toThrow(/journal/)
  })

  it('slugs nested pages by their category path so same-named projects stay distinct', async () => {
    const a = await store.createPage({ title: 'Website', category: ' Acme Corp / Web ' })
    const g = await store.createPage({ title: 'Website', category: 'Globex / Web' })
    expect(a.id).toBe('acme-corp-web-website')
    expect(a.category).toBe('Acme Corp / Web')
    expect(g.id).toBe('globex-web-website')
    expect((await store.updatePage(a.id, { category: 'acme corp/mobile' })).category).toBe('acme corp / mobile')
  })

  it('returns every page day within a range', async () => {
    await store.createPage({ title: 'Acme' })
    await store.addEntry('journal', 'j1', {}, new Date(2026, 8, 14, 9))
    await store.addEntry('acme', 'a1', {}, new Date(2026, 8, 15, 9))
    await store.addEntry('acme', 'a2', {}, new Date(2026, 8, 25, 9))
    const range = await store.getRange('2026-09-14', '2026-09-20')
    expect(range.map((r) => `${r.pageId}:${r.day.date}`)).toEqual(['journal:2026-09-14', 'acme:2026-09-15'])
  })

  it('keeps page notes and assets under pages/<id>/ with relative links', async () => {
    await store.createPage({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 14, 0, 0)
    const saved = await store.saveAsset('acme', '2026-09-19', new Uint8Array([1, 2]), 'image/png', undefined, when)
    expect(saved.src).toMatch(/^pages\/acme\/entries\/2026\/09\/assets\//)
    await store.addEntry('acme', `![a](${saved.src})`, {}, when)
    const file = await fs.readFile(path.join(root, 'pages/acme/entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![a](assets/2026-09-19-140000-')
    expect((await store.readDay('acme', '2026-09-19')).entries[0].markdown).toContain(saved.src)
    expect(await store.listDays('journal')).toEqual([])
    expect(await store.listDays('acme')).toEqual([{ date: '2026-09-19', count: 1 }])
  })

  it('returns a timeline newest-first-limited, oldest-first-ordered', async () => {
    await store.createPage({ title: 'P' })
    for (let d = 1; d <= 12; d++) await store.addEntry('p', `day ${d}`, {}, new Date(2026, 0, d, 9))
    const t = await store.getTimeline('p', { days: 5 })
    expect(t.days.map((x) => x.date)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11', '2026-01-12'])
    expect(t.hasMore).toBe(true)
    const older = await store.getTimeline('p', { days: 5, beforeDate: '2026-01-08' })
    expect(older.days.map((x) => x.date)).toEqual(['2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'])
    const rest = await store.getTimeline('p', { days: 5, beforeDate: '2026-01-03' })
    expect(rest.days.map((x) => x.date)).toEqual(['2026-01-01', '2026-01-02'])
    expect(rest.hasMore).toBe(false)
  })

  it('moves a thread between pages, rewriting image links and keeping ids unique', async () => {
    await store.createPage({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 9)
    const img = await store.saveAsset('journal', '2026-09-19', new Uint8Array([1]), 'image/png', undefined, when)
    const a = await store.addEntry('journal', `about acme ![s](${img.src})`, {}, when)
    await store.addEntry('journal', 'reply', { date: '2026-09-19', parentId: a.entry.id }, when)
    const b = await store.addEntry('journal', 'unrelated', {}, when)

    const moved = await store.moveEntry('journal', '2026-09-19', a.entry.id, 'acme')
    expect(moved.entry.id).toBe(a.entry.id)
    expect((await store.readDay('journal', '2026-09-19')).entries.map((e) => e.id)).toEqual([b.entry.id])
    const target = await store.readDay('acme', '2026-09-19')
    expect(target.entries.map((e) => e.markdown)).toEqual([`about acme ![s](${img.src})`, 'reply'])
    expect(target.entries[1].parentId).toBe(a.entry.id)
    const file = await fs.readFile(path.join(root, 'pages/acme/entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![s](../../../../../entries/2026/09/assets/')
    await expect(store.moveEntry('acme', '2026-09-19', a.entry.id, 'acme')).rejects.toThrow(/already/)
    await expect(store.moveEntry('acme', '2026-09-19', a.entry.id, 'nope')).rejects.toThrow(/not found/)
  })

  it('stores commit notes read-only and de-duplicates by hash', async () => {
    await store.createPage({ title: 'Acme', repos: ['/tmp/x'] })
    expect((await store.readPage('acme')).repos).toEqual(['/tmp/x'])
    const sys = { kind: 'commit' as const, meta: { repo: '/tmp/x', hash: 'deadbeef' } }
    const a = await store.addEntry('acme', 'commit one', {}, new Date(2026, 8, 19, 9), sys)
    const b = await store.addEntry('acme', 'commit one again', {}, new Date(2026, 8, 19, 9, 1), sys)
    expect(b.entry.id).toBe(a.entry.id)
    expect((await store.readDay('acme', '2026-09-19')).entries).toHaveLength(1)
    await expect(store.updateEntry('acme', '2026-09-19', a.entry.id, 'edited')).rejects.toThrow(/read-only/)
    await store.addEntry('acme', 'a reply', { date: '2026-09-19', parentId: a.entry.id })
    expect(await store.deleteEntry('acme', '2026-09-19', a.entry.id)).toBe(2)
  })

  it('searches across pages', async () => {
    await store.createPage({ title: 'Acme' })
    await store.addEntry('journal', 'needle in journal', {}, new Date(2026, 8, 18, 9))
    await store.addEntry('acme', 'needle on page', {}, new Date(2026, 8, 19, 9))
    const hits = await store.search('needle')
    expect(hits.map((h) => `${h.pageId}:${h.entry.markdown}`)).toEqual(['journal:needle in journal', 'acme:needle on page'])
  })
})
