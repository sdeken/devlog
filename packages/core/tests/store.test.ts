import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevlogStore } from '../src/node/store'

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
    // A fresh repository starts at the current storage format.
    expect(JSON.parse(await fs.readFile(path.join(root, 'devlog.json'), 'utf8'))).toEqual({ format: 4 })
    expect(await fs.readFile(path.join(root, '.gitattributes'), 'utf8')).toContain('**/todos.md merge=union')
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('Thumbs.db')
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
    expect(file.startsWith('<!-- devlog:format 3 -->\n# 2026-09-19\n')).toBe(true)
    expect(file).not.toContain('### ')

    const updated = await store.updateEntry('journal', '2026-09-19', a.entry.id, 'Morning: rewrote it', new Date(2026, 8, 19, 10))
    expect(updated.updatedAt).toBeTruthy()
    expect((await store.readDay('journal', '2026-09-19')).entries[0].markdown).toBe('Morning: rewrote it')

    await store.deleteEntry('journal', '2026-09-19', a.entry.id)
    await store.deleteEntry('journal', '2026-09-19', b.entry.id)
    expect(await store.listDays('journal')).toEqual([])
    // Nothing is ever removed from a block file: the deletes are records too.
    expect((await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')).match(/<!-- devlog:delete /g)).toHaveLength(2)
  })

  it('only ever appends to block files', async () => {
    const files = async (): Promise<Map<string, string>> => {
      const out = new Map<string, string>()
      for (const f of await fs.readdir(root, { recursive: true })) {
        const rel = String(f).split(path.sep).join('/')
        if (rel.endsWith('.md') && (rel.includes('entries/') || rel.endsWith('todos.md'))) out.set(rel, await fs.readFile(path.join(root, rel), 'utf8'))
      }
      return out
    }
    let before = await files()
    const check = async (what: string): Promise<void> => {
      const after = await files()
      for (const [rel, text] of before) expect(after.get(rel)?.startsWith(text), `${what}: ${rel}`).toBe(true)
      before = after
    }
    const when = new Date(2026, 8, 19, 9)
    const acme = await store.createCanvas({ title: 'Acme' })
    const a = await store.addEntry('journal', 'A ![x](entries/2026/09/assets/x.png)', {}, when)
    await check('add')
    const r = await store.addEntry('journal', 'reply', { date: a.date, parentId: a.entry.id }, when)
    const b = await store.addEntry('journal', 'B', { date: a.date, beforeId: a.entry.id }, when)
    await check('reply and insert')
    await store.updateEntry('journal', a.date, a.entry.id, 'A edited')
    await store.setEntryHidden('journal', a.date, b.entry.id, true)
    await store.setEntryHidden('journal', a.date, b.entry.id, false)
    await check('edit and hide')
    await store.reorderEntry('journal', a.date, b.entry.id, { afterId: a.entry.id })
    await check('reorder')
    await store.promoteToTask('journal', a.date, b.entry.id)
    await check('promote')
    await store.moveEntry('journal', a.date, a.entry.id, acme.id)
    await check('move')
    const {
      date: tdate,
      entries: [t1, t2]
    } = await store.addTodos(acme.id, ['one', 'two'], {}, when)
    await store.addEntry(acme.id, 'note', { date: tdate, parentId: t1.id }, when)
    await store.reorderEntry(acme.id, tdate, t2.id, { beforeId: t1.id })
    await store.setTodoDone(acme.id, tdate, t1.id, true, when)
    await store.setTodoDone(acme.id, tdate, t1.id, false, when)
    await store.updateEntry(acme.id, tdate, t2.id, 'two, edited')
    await store.promoteToTask(acme.id, tdate, t2.id)
    await store.deleteEntry(acme.id, tdate, t1.id)
    await check('todos')
    await store.deleteEntry('journal', a.date, b.entry.id)
    await check('delete')
    expect((await store.readDay('journal', a.date)).entries).toEqual([])
    expect((await store.readDay(acme.id, a.date)).entries.map((e) => e.markdown)).toEqual(['A edited', 'reply', 'two, edited'])
    expect(r.entry.parentId).toBe(a.entry.id)
  })

  it('serialises concurrent writes to the same file', async () => {
    const when = new Date(2026, 8, 19, 9)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.addEntry('journal', `n${i}`, {}, when)))
    expect((await store.readDay('journal', '2026-09-19')).entries.map((e) => e.markdown).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`).sort())
    const keys = (await fs.readFile(path.join(root, 'entries/2026/09/2026-09-19.md'), 'utf8')).match(/ pos=(\S+)/g)!
    expect(new Set(keys).size).toBe(20) // every block got its own place
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
    expect(file).toContain(`parent=${r1.entry.id}`)

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
    const { blocks } = await store.search('alpha')
    expect(blocks.map((h) => h.entry.markdown)).toEqual(['ALPHA two', 'alpha one'])
    expect(blocks.every((h) => h.canvasId === 'journal')).toBe(true)
  })

  it('refuses paths outside the repository', () => {
    expect(() => store.resolve('../etc/passwd')).toThrow(/escapes/)
    expect(() => store.resolve('entries/../../x')).toThrow(/escapes/)
    expect(store.resolveAsset('entries/2026/09/assets/a.png')).toBe(path.join(root, 'entries/2026/09/assets/a.png'))
    expect(() => store.resolveAsset('.git/config')).toThrow(/asset/)
    expect(() => store.resolveAsset('entries/../.git/HEAD')).toThrow(/asset/)
    expect(() => store.resolveAsset('')).toThrow(/asset/)
  })

  it('emits change events on writes', async () => {
    const events: unknown[] = []
    store.on('change', (e) => events.push(e))
    await store.addEntry('journal', 'x')
    await store.saveAsset('journal', '2026-09-19', new Uint8Array([1]), 'image/png')
    expect(events).toHaveLength(2)
  })
})

describe('canvases in the store', () => {
  it('creates, lists, updates and deletes canvases', async () => {
    expect((await store.listCanvases()).map((c) => c.id)).toEqual(['journal'])
    const acme = await store.createCanvas({ title: 'Acme Corp' }, new Date(2026, 8, 19))
    expect(acme).toMatchObject({ title: 'Acme Corp', parentId: null, task: false, archived: false })
    // Random 10-character ids in a two-character shard folder.
    expect(acme.id).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/)
    expect(await fs.readFile(path.join(root, `canvases/${acme.id.slice(0, 2)}/${acme.id}/canvas.md`), 'utf8')).toContain('title: Acme Corp')
    const dup = await store.createCanvas({ title: 'Acme Corp' }, new Date(2026, 8, 20))
    expect(dup.id).not.toBe(acme.id)
    const j = await store.createCanvas({ title: 'Journal' }, new Date(2026, 8, 21))
    expect(j.id).not.toBe('journal')

    const web = await store.createCanvas({ title: 'Website', parentId: acme.id, task: true }, new Date(2026, 8, 22))
    expect(web).toMatchObject({ parentId: acme.id, task: true })
    const listed = await store.listCanvases()
    expect(listed.map((c) => c.id)).toEqual(['journal', acme.id, dup.id, j.id, web.id]) // by creation time

    const updated = await store.updateCanvas(web.id, { title: 'Site', task: false, parentId: null })
    expect(updated).toMatchObject({ id: web.id, title: 'Site', task: false, parentId: null })
    await expect(store.updateCanvas(acme.id, { parentId: web.id })).resolves.toMatchObject({ parentId: web.id })
    await expect(store.updateCanvas(web.id, { parentId: acme.id })).rejects.toThrow(/inside itself/)
    await expect(store.updateCanvas('journal', { title: 'x' })).rejects.toThrow(/journal/)
    await expect(store.createCanvas({ title: '   ' })).rejects.toThrow(/title/)
    await expect(store.createCanvas({ title: 'x', parentId: 'nope' })).rejects.toThrow(/not found/)

    await store.addEntry(acme.id, 'kickoff', {}, new Date(2026, 8, 19, 9))
    await store.addEntry(web.id, 'site note', {}, new Date(2026, 8, 19, 9))
    expect(await store.deleteCanvas(web.id)).toBe(2) // website + acme beneath it
    expect((await store.listCanvases()).map((c) => c.id)).toEqual(['journal', dup.id, j.id])
    await expect(store.readCanvas(acme.id)).rejects.toThrow(/not found/)
    await expect(store.deleteCanvas('journal')).rejects.toThrow(/journal/)
  })

  it('keeps same-named canvases under different parents distinct', async () => {
    const acme = await store.createCanvas({ title: 'Acme Corp' })
    const globex = await store.createCanvas({ title: 'Globex' })
    const a = await store.createCanvas({ title: 'Website', parentId: acme.id })
    const g = await store.createCanvas({ title: 'Website', parentId: globex.id })
    expect(a.id).not.toBe(g.id)
    expect(a.parentId).toBe(acme.id)
    expect(g.parentId).toBe(globex.id)
  })

  it('returns every canvas day within a range', async () => {
    const { id: acme } = await store.createCanvas({ title: 'Acme' })
    await store.addEntry('journal', 'j1', {}, new Date(2026, 8, 14, 9))
    await store.addEntry(acme, 'a1', {}, new Date(2026, 8, 15, 9))
    await store.addEntry(acme, 'a2', {}, new Date(2026, 8, 25, 9))
    const range = await store.getRange('2026-09-14', '2026-09-20')
    expect(range.map((r) => `${r.canvasId}:${r.day.date}`)).toEqual(['journal:2026-09-14', `${acme}:2026-09-15`])
  })

  it('keeps canvas blocks and assets under canvases/<xx>/<id>/ with relative links', async () => {
    const { id: acme } = await store.createCanvas({ title: 'Acme' })
    const dir = `canvases/${acme.slice(0, 2)}/${acme}`
    const when = new Date(2026, 8, 19, 14, 0, 0)
    const saved = await store.saveAsset(acme, '2026-09-19', new Uint8Array([1, 2]), 'image/png', undefined, when)
    expect(saved.src.startsWith(`${dir}/entries/2026/09/assets/`)).toBe(true)
    await store.addEntry(acme, `![a](${saved.src})`, {}, when)
    const file = await fs.readFile(path.join(root, `${dir}/entries/2026/09/2026-09-19.md`), 'utf8')
    expect(file).toContain('![a](assets/2026-09-19-140000-')
    expect((await store.readDay(acme, '2026-09-19')).entries[0].markdown).toContain(saved.src)
    expect(await store.listDays('journal')).toEqual([])
    expect(await store.listDays(acme)).toEqual([{ date: '2026-09-19', count: 1 }])
  })

  it('returns a timeline newest-first-limited, oldest-first-ordered', async () => {
    const { id: p } = await store.createCanvas({ title: 'P' })
    for (let d = 1; d <= 12; d++) await store.addEntry(p, `day ${d}`, {}, new Date(2026, 0, d, 9))
    const t = await store.getTimeline(p, { days: 5 })
    expect(t.days.map((x) => x.date)).toEqual(['2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11', '2026-01-12'])
    expect(t.hasMore).toBe(true)
    const older = await store.getTimeline(p, { days: 5, beforeDate: '2026-01-08' })
    expect(older.days.map((x) => x.date)).toEqual(['2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'])
    const rest = await store.getTimeline(p, { days: 5, beforeDate: '2026-01-03' })
    expect(rest.days.map((x) => x.date)).toEqual(['2026-01-01', '2026-01-02'])
    expect(rest.hasMore).toBe(false)
  })

  it('moves a thread between canvases, rewriting image links and keeping ids unique', async () => {
    const { id: acme } = await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 9)
    const img = await store.saveAsset('journal', '2026-09-19', new Uint8Array([1]), 'image/png', undefined, when)
    const a = await store.addEntry('journal', `about acme ![s](${img.src})`, {}, when)
    await store.addEntry('journal', 'reply', { date: '2026-09-19', parentId: a.entry.id }, when)
    const b = await store.addEntry('journal', 'unrelated', {}, when)

    const moved = await store.moveEntry('journal', '2026-09-19', a.entry.id, acme)
    expect(moved.entry.id).toBe(a.entry.id)
    expect((await store.readDay('journal', '2026-09-19')).entries.map((e) => e.id)).toEqual([b.entry.id])
    const target = await store.readDay(acme, '2026-09-19')
    expect(target.entries.map((e) => e.markdown)).toEqual([`about acme ![s](${img.src})`, 'reply'])
    expect(target.entries[1].parentId).toBe(a.entry.id)
    const file = await fs.readFile(path.join(root, `canvases/${acme.slice(0, 2)}/${acme}/entries/2026/09/2026-09-19.md`), 'utf8')
    expect(file).toContain('![s](../../../../../../entries/2026/09/assets/')
    await expect(store.moveEntry(acme, '2026-09-19', a.entry.id, acme)).rejects.toThrow(/already/)
    await expect(store.moveEntry(acme, '2026-09-19', a.entry.id, 'nope')).rejects.toThrow(/not found/)
  })

  it('stores commit blocks read-only and de-duplicates by hash', async () => {
    const { id: acme } = await store.createCanvas({ title: 'Acme', repos: ['/tmp/x'] })
    expect((await store.readCanvas(acme)).repos).toEqual(['/tmp/x'])
    const sys = { kind: 'commit' as const, meta: { repo: '/tmp/x', hash: 'deadbeef' } }
    const a = await store.addEntry(acme, 'commit one', {}, new Date(2026, 8, 19, 9), sys)
    const b = await store.addEntry(acme, 'commit one again', {}, new Date(2026, 8, 19, 9, 1), sys)
    expect(b.entry.id).toBe(a.entry.id)
    expect((await store.readDay(acme, '2026-09-19')).entries).toHaveLength(1)
    await expect(store.updateEntry(acme, '2026-09-19', a.entry.id, 'edited')).rejects.toThrow(/read-only/)
    await expect(store.promoteToTask(acme, '2026-09-19', a.entry.id)).rejects.toThrow(/automatic block/)
    await store.addEntry(acme, 'a reply', { date: '2026-09-19', parentId: a.entry.id })
    expect(await store.deleteEntry(acme, '2026-09-19', a.entry.id)).toBe(2)
  })

  it('turns a block into a task canvas beneath its canvas', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 9)
    const note = await store.addEntry(acme.id, '**Fix** the login redirect. It loops on Safari.\n\n```\ntrace\n```', {}, when)
    const { canvas, entry } = await store.promoteToTask(acme.id, '2026-09-19', note.entry.id, when)
    expect(canvas).toMatchObject({ title: 'Fix the login redirect', parentId: acme.id, task: true })
    expect(entry).toMatchObject({ id: note.entry.id, kind: 'task', meta: { canvas: canvas.id } })
    expect(entry.markdown).toContain('**Fix** the login redirect')
    const file = await fs.readFile(path.join(root, `canvases/${acme.id.slice(0, 2)}/${acme.id}/entries/2026/09/2026-09-19.md`), 'utf8')
    expect(file).toContain('kind=task')
    expect(file).toContain(`canvas=${canvas.id}`)
    const back = (await store.readDay(acme.id, '2026-09-19')).entries[0]
    expect(back.kind).toBe('task')
    expect(back.meta?.canvas).toBe(canvas.id)
    // Promoting again is a no-op returning the same canvas.
    expect((await store.promoteToTask(acme.id, '2026-09-19', note.entry.id)).canvas.id).toBe(canvas.id)
    // Journal blocks become top-level tasks.
    const j = await store.addEntry('journal', 'Write the incident report', {}, when)
    expect((await store.promoteToTask('journal', '2026-09-19', j.entry.id)).canvas.parentId).toBeNull()
    // The task block stays editable.
    await store.updateEntry(acme.id, '2026-09-19', note.entry.id, 'Fix the login redirect (edited)')
    expect((await store.readDay(acme.id, '2026-09-19')).entries[0]).toMatchObject({ kind: 'task', markdown: 'Fix the login redirect (edited)' })
  })

  it('searches across canvases', async () => {
    const { id: acme } = await store.createCanvas({ title: 'Acme' })
    await store.addEntry('journal', 'needle in journal', {}, new Date(2026, 8, 18, 9))
    await store.addEntry(acme, 'needle on canvas', {}, new Date(2026, 8, 19, 9))
    const { blocks, surfaces } = await store.search('needle')
    expect(blocks.map((h) => `${h.canvasId}:${h.entry.markdown}:${h.archived}`)).toEqual([`${acme}:needle on canvas:false`, 'journal:needle in journal:false']) // newest first
    expect(surfaces).toEqual([])
  })

  it('archives whole subtrees, keeps them searchable, and restores them', async () => {
    const acme = await store.createCanvas({ title: 'Acme Corp' })
    const web = await store.createCanvas({ title: 'Web', parentId: acme.id })
    const site = await store.createCanvas({ title: 'Website', parentId: web.id, task: true })
    const gen = await store.createCanvas({ title: 'General', parentId: acme.id })
    const other = await store.createCanvas({ title: 'Globex' })
    await store.addEntry(site.id, 'archived needle', {}, new Date(2026, 8, 19, 9))

    expect(await store.setCanvasArchived(site.id, true)).toEqual([site.id])
    expect(await fs.readFile(path.join(root, `canvases/${site.id.slice(0, 2)}/${site.id}/canvas.md`), 'utf8')).toContain('archived: true')
    const hits = await store.search('archived needle')
    expect(hits.blocks.map((h) => [h.canvasId, h.archived])).toEqual([[site.id, true]])
    expect(await store.setCanvasArchived(site.id, false)).toEqual([site.id])

    const changed = await store.setCanvasArchived(acme.id, true)
    expect(changed.sort()).toEqual([acme.id, gen.id, site.id, web.id].sort())
    const all = await store.listCanvases()
    expect(all.filter((c) => c.archived).map((c) => c.id).sort()).toEqual([acme.id, gen.id, site.id, web.id].sort())
    expect(all.find((c) => c.id === other.id)?.archived).toBe(false)

    expect((await store.setCanvasArchived(acme.id, false)).length).toBe(4)
    expect((await store.listCanvases()).filter((c) => c.archived)).toHaveLength(0)
    await expect(store.setCanvasArchived('journal', true)).rejects.toThrow(/journal/)
  })

  it('stores surfaces with assets and finds them in search', async () => {
    const web = await store.createCanvas({ title: 'Web' })
    expect(await store.readCanvas(web.id)).toMatchObject({ surface: '', hasSurface: false })
    const asset = await store.saveSurfaceAsset(web.id, new Uint8Array([1, 2, 3]), 'image/png', undefined, new Date(2026, 8, 19, 9, 0, 0))
    expect(asset.src.startsWith(`canvases/${web.id.slice(0, 2)}/${web.id}/assets/2026-09-19-090000-`)).toBe(true)
    const saved = await store.writeSurface(web.id, `# Links\n\nTracker: https://issues.example\n\n![diagram](${asset.src})\n`, new Date(2026, 8, 19, 10))
    expect(saved).toMatchObject({ id: web.id, hasSurface: true, updatedAt: new Date(2026, 8, 19, 10).toISOString() })
    const file = await fs.readFile(path.join(root, `canvases/${web.id.slice(0, 2)}/${web.id}/canvas.md`), 'utf8')
    expect(file).toContain('title: Web')
    expect(file).toContain('![diagram](assets/2026-09-19-090000-')
    const back = await store.readCanvas(web.id)
    expect(back.surface).toContain(`![diagram](${asset.src})`)
    expect((await store.listCanvases()).find((c) => c.id === web.id)?.hasSurface).toBe(true)
    const { surfaces } = await store.search('issues.example')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({ canvasId: web.id, archived: false })
    expect(surfaces[0].excerpt).toContain('issues.example')
    await expect(store.writeSurface('journal', 'x')).rejects.toThrow(/journal/)
  })

  it('keeps todos as blocks in the stream, at any depth, and lists them with where they live', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 25, 9)
    const { date, entries: added } = await store.addTodos(acme.id, ['Send Dana the redirect list', 'Check the CDN rules', '  '], {}, when)
    expect(date).toBe('2026-09-25')
    expect(added.map((t) => [t.kind, t.markdown])).toEqual([
      ['todo', 'Send Dana the redirect list'],
      ['todo', 'Check the CDN rules']
    ])
    expect(await fs.readFile(path.join(root, `canvases/${acme.id.slice(0, 2)}/${acme.id}/entries/2026/09/2026-09-25.md`), 'utf8')).toContain('kind=todo')

    // Todos inside a block ("asked Claude to review" → a pasted list), and a note inside a todo.
    const review = await store.addEntry(acme.id, 'Asked Claude to review the redirect', {}, new Date(2026, 8, 25, 10))
    const inner = await store.addTodos(acme.id, ['Handle the trailing slash'], { date: review.date, parentId: review.entry.id }, new Date(2026, 8, 25, 10, 5))
    await store.addEntry(acme.id, 'Tried a rewrite rule; no luck', { date, parentId: inner.entries[0].id }, new Date(2026, 8, 26, 9))
    let todos = await store.listTodos()
    expect(todos.map((t) => [t.entry.markdown, t.trail.map((x) => x.title), t.inside])).toEqual([
      ['Send Dana the redirect list', [], 0],
      ['Check the CDN rules', [], 0],
      ['Handle the trailing slash', ['Asked Claude to review the redirect'], 1]
    ])

    // Ticking off marks the todo where it is; no separate block is written.
    const ticked = await store.setTodoDone(acme.id, date, added[0].id, true, new Date(2026, 8, 25, 11))
    expect(ticked.meta?.done).toBe(new Date(2026, 8, 25, 11).toISOString())
    expect((await store.readDay(acme.id, date)).entries.filter((e) => e.kind === 'done')).toEqual([])
    todos = await store.listTodos()
    expect(todos.map((t) => t.entry.id)).not.toContain(added[0].id)
    expect((await store.listTodos({ doneSince: new Date(2026, 8, 25).toISOString() })).map((t) => t.entry.id)).toContain(added[0].id)
    await store.setTodoDone(acme.id, date, added[0].id, false, new Date(2026, 8, 25, 11, 5))
    expect((await store.readDay(acme.id, date)).entries.find((e) => e.id === added[0].id)?.meta?.done).toBeUndefined()
    await expect(store.setTodoDone(acme.id, date, review.entry.id, true)).rejects.toThrow(/Todo not found/)
    // A todo ticked off counts on the day it was ticked for the date range views.
    await store.setTodoDone(acme.id, date, added[1].id, true, new Date(2026, 8, 25, 12))
    expect((await store.getRange('2026-09-25', '2026-09-25')).some((r) => r.day.entries.some((e) => e.id === added[1].id))).toBe(true)

    // Search finds todos like any block; archived canvases drop out of the list.
    expect((await store.search('trailing slash')).blocks.map((h) => [h.canvasId, h.entry.kind])).toEqual([[acme.id, 'todo']])
    await store.setCanvasArchived(acme.id, true)
    expect(await store.listTodos()).toEqual([])
  })

  it('moves a block inside another, out again, and across days and canvases', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const web = await store.createCanvas({ title: 'Web', parentId: acme.id })
    const standup = await store.addEntry(acme.id, 'Standup Sep 28', {}, new Date(2026, 8, 28, 9))
    const note = await store.addEntry(acme.id, 'Remember the DNS', {}, new Date(2026, 8, 28, 9, 30))
    const inside = await store.addEntry(acme.id, 'with a reply', { date: note.date, parentId: note.entry.id }, new Date(2026, 8, 28, 9, 31))
    // Same file: one set record, and what is inside it follows.
    const moved = await store.moveBlock({ canvasId: acme.id, date: note.date, id: note.entry.id }, { canvasId: acme.id, date: note.date, parentId: standup.entry.id }, new Date(2026, 8, 28, 10))
    expect(moved.entry.parentId).toBe(standup.entry.id)
    let day = await store.readDay(acme.id, note.date)
    expect(day.entries.map((e) => [e.markdown, e.parentId ?? null])).toEqual([
      ['Standup Sep 28', null],
      ['Remember the DNS', standup.entry.id],
      ['with a reply', note.entry.id]
    ])
    await expect(store.moveBlock({ canvasId: acme.id, date: note.date, id: standup.entry.id }, { canvasId: acme.id, date: note.date, parentId: inside.entry.id })).rejects.toThrow(/inside itself/)
    // Out again: to the top level, right after the block it was in.
    await store.moveBlock({ canvasId: acme.id, date: note.date, id: note.entry.id }, { canvasId: acme.id }, new Date(2026, 8, 28, 11))
    day = await store.readDay(acme.id, note.date)
    expect(day.entries.filter((e) => !e.parentId).map((e) => e.markdown)).toEqual(['Standup Sep 28', 'Remember the DNS'])
    // Across days: into a block written on another day, in its file.
    const older = await store.addEntry(acme.id, 'Kickoff Sep 21', {}, new Date(2026, 8, 21, 9))
    const across = await store.moveBlock({ canvasId: acme.id, date: note.date, id: note.entry.id }, { canvasId: acme.id, date: older.date, parentId: older.entry.id }, new Date(2026, 8, 28, 12))
    expect(across).toMatchObject({ date: '2026-09-21', entry: { markdown: 'Remember the DNS', parentId: older.entry.id } })
    expect((await store.readDay(acme.id, older.date)).entries.map((e) => e.markdown)).toEqual(['Kickoff Sep 21', 'Remember the DNS', 'with a reply'])
    expect((await store.readDay(acme.id, note.date)).entries.map((e) => e.markdown)).toEqual(['Standup Sep 28'])
    // Across canvases, from inside a block to the top level (on its own date).
    const out = await store.moveBlock({ canvasId: acme.id, date: older.date, id: note.entry.id }, { canvasId: web.id })
    expect(out.date).toBe('2026-09-21')
    expect((await store.readDay(web.id, '2026-09-21')).entries.map((e) => [e.markdown, e.parentId ? 'inside' : 'top'])).toEqual([
      ['Remember the DNS', 'top'],
      ['with a reply', 'inside']
    ])
  })

  it('moves what was written inside a block into the task it becomes', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const b = await store.addEntry(acme.id, 'Migrate the CDN', {}, new Date(2026, 8, 28, 9))
    await store.addEntry(acme.id, 'first finding', { date: b.date, parentId: b.entry.id }, new Date(2026, 8, 28, 9, 5))
    await store.addTodos(acme.id, ['check the headers'], { date: b.date, parentId: b.entry.id }, new Date(2026, 8, 28, 9, 6))
    const { canvas } = await store.promoteToTask(acme.id, b.date, b.entry.id, new Date(2026, 8, 28, 10))
    expect((await store.readDay(acme.id, b.date)).entries.map((e) => [e.kind, e.markdown])).toEqual([['task', 'Migrate the CDN']])
    expect((await store.readDay(canvas.id, b.date)).entries.map((e) => [e.kind ?? 'note', e.markdown, e.parentId ?? null])).toEqual([
      ['note', 'first finding', null],
      ['todo', 'check the headers', null]
    ])
  })

  it('moves storage format 3 todo lists into the streams (format 4)', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const dir = `canvases/${acme.id.slice(0, 2)}/${acme.id}`
    const at = (d: number, h: number): string => new Date(2026, 8, d, h).toISOString()
    await fs.writeFile(
      path.join(root, dir, 'todos.md'),
      [
        '<!-- devlog:format 3 -->',
        '# Todos',
        '',
        `<!-- devlog:add id=t1aaaaaa pos=a0 kind=todo at=${at(20, 9)} -->`,
        'Send Dana the list',
        '',
        `<!-- devlog:add id=c1aaaaaa parent=t1aaaaaa pos=a0 at=${at(21, 9)} -->`,
        'Waiting on ops',
        '',
        `<!-- devlog:add id=t2aaaaaa pos=a1 kind=todo at=${at(22, 9)} -->`,
        'Renew the cert',
        '',
        `<!-- devlog:set id=t2aaaaaa at=${at(23, 9)} done=${at(23, 9)} -->`,
        ''
      ].join('\n')
    )
    await fs.writeFile(path.join(root, 'devlog.json'), JSON.stringify({ format: 3 }))
    expect(await store.upgradeStorage()).toBe(3)
    expect(JSON.parse(await fs.readFile(path.join(root, 'devlog.json'), 'utf8')).format).toBe(4)
    await expect(fs.stat(path.join(root, dir, 'todos.md'))).rejects.toThrow()
    const day20 = await store.readDay(acme.id, '2026-09-20')
    expect(day20.entries.map((e) => [e.id, e.kind ?? 'note', e.markdown, e.parentId ?? null])).toEqual([
      ['t1aaaaaa', 'todo', 'Send Dana the list', null],
      ['c1aaaaaa', 'note', 'Waiting on ops', 't1aaaaaa']
    ])
    expect((await store.readDay(acme.id, '2026-09-22')).entries[0]).toMatchObject({ id: 't2aaaaaa', kind: 'todo', meta: { done: at(23, 9) } })
    expect((await store.listTodos()).map((t) => [t.entry.id, t.inside])).toEqual([['t1aaaaaa', 1]])
    // Running it again changes nothing.
    expect(await store.upgradeStorage()).toBeNull()
    expect(await store.convertTodoLists()).toBe(0)
  })
})

describe('canvases extensions keep', () => {
  it('are found by their owner, made once, and take blocks of their kinds on any day', async () => {
    expect(await store.managedCanvas('builtin.x/sheets')).toBeNull()
    const kept = (await store.managedCanvas('builtin.x/sheets', 'Sheets'))!
    expect(kept).toMatchObject({ title: 'Sheets', fields: { 'devlog.managed': 'builtin.x/sheets' } })
    expect((await store.managedCanvas('builtin.x/sheets', 'Sheets'))!.id).toBe(kept.id)
    const { date, entry } = await store.addExtensionBlock(kept.id, 'builtin.x', 'week one', { week: '2026-09-21' }, new Date(2026, 8, 26, 10), { kind: 'timesheet', date: '2026-09-21', anyDate: true })
    expect(date).toBe('2026-09-21')
    expect(entry).toMatchObject({ kind: 'timesheet', meta: { ext: 'builtin.x', week: '2026-09-21' } })
    // A block the app wrote there before (no extension mark) can be changed by its keeper, and only with `any`.
    const old = await store.addEntry(kept.id, 'written by the app', { date: '2026-09-21' })
    await expect(store.updateExtensionBlock(kept.id, '2026-09-21', old.entry.id, 'builtin.x', 'x')).rejects.toThrow(/Only blocks it added/)
    expect((await store.updateExtensionBlock(kept.id, '2026-09-21', old.entry.id, 'builtin.x', 'rewritten', new Date(), { any: true })).markdown).toBe('rewritten')
    // Elsewhere, a date without a parent block is ignored: blocks land on today.
    const acme = await store.createCanvas({ title: 'Acme' })
    expect((await store.addExtensionBlock(acme.id, 'builtin.x', 'note', {}, new Date(2026, 8, 26, 10), { date: '2026-09-21' })).date).toBe('2026-09-26')
  })
})
