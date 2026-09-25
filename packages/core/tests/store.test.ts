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
    expect(file.startsWith('<!-- devlog:format 2 -->\n# 2026-09-19\n')).toBe(true)
    expect(file).not.toContain('### ')

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
    expect(acme).toMatchObject({ id: 'acme-corp', title: 'Acme Corp', parentId: null, task: false, archived: false })
    const dup = await store.createCanvas({ title: 'Acme Corp' })
    expect(dup.id).toBe('acme-corp-2')
    const j = await store.createCanvas({ title: 'Journal' })
    expect(j.id).toBe('journal-canvas')
    expect(await fs.readFile(path.join(root, 'canvases/acme-corp/canvas.md'), 'utf8')).toContain('title: Acme Corp')

    const web = await store.createCanvas({ title: 'Website', parentId: 'acme-corp', task: true })
    expect(web).toMatchObject({ id: 'website', parentId: 'acme-corp', task: true })
    const listed = await store.listCanvases()
    expect(listed.map((c) => c.id)).toEqual(['journal', 'acme-corp', 'acme-corp-2', 'journal-canvas', 'website'])

    const updated = await store.updateCanvas('website', { title: 'Site', task: false, parentId: null })
    expect(updated).toMatchObject({ title: 'Site', task: false, parentId: null })
    await expect(store.updateCanvas('acme-corp', { parentId: 'website' })).resolves.toMatchObject({ parentId: 'website' })
    await expect(store.updateCanvas('website', { parentId: 'acme-corp' })).rejects.toThrow(/inside itself/)
    await expect(store.updateCanvas('journal', { title: 'x' })).rejects.toThrow(/journal/)
    await expect(store.createCanvas({ title: '   ' })).rejects.toThrow(/title/)
    await expect(store.createCanvas({ title: 'x', parentId: 'nope' })).rejects.toThrow(/not found/)

    await store.addEntry('acme-corp', 'kickoff', {}, new Date(2026, 8, 19, 9))
    await store.addEntry('website', 'site note', {}, new Date(2026, 8, 19, 9))
    expect(await store.deleteCanvas('website')).toBe(2) // website + acme-corp beneath it
    expect((await store.listCanvases()).map((c) => c.id)).toEqual(['journal', 'acme-corp-2', 'journal-canvas'])
    await expect(store.readCanvas('acme-corp')).rejects.toThrow(/not found/)
    await expect(store.deleteCanvas('journal')).rejects.toThrow(/journal/)
  })

  it('keeps same-named canvases under different parents distinct', async () => {
    const acme = await store.createCanvas({ title: 'Acme Corp' })
    const globex = await store.createCanvas({ title: 'Globex' })
    const a = await store.createCanvas({ title: 'Website', parentId: acme.id })
    const g = await store.createCanvas({ title: 'Website', parentId: globex.id })
    expect([a.id, g.id]).toEqual(['website', 'website-2'])
    expect(a.parentId).toBe('acme-corp')
    expect(g.parentId).toBe('globex')
  })

  it('returns every canvas day within a range', async () => {
    await store.createCanvas({ title: 'Acme' })
    await store.addEntry('journal', 'j1', {}, new Date(2026, 8, 14, 9))
    await store.addEntry('acme', 'a1', {}, new Date(2026, 8, 15, 9))
    await store.addEntry('acme', 'a2', {}, new Date(2026, 8, 25, 9))
    const range = await store.getRange('2026-09-14', '2026-09-20')
    expect(range.map((r) => `${r.canvasId}:${r.day.date}`)).toEqual(['journal:2026-09-14', 'acme:2026-09-15'])
  })

  it('keeps canvas blocks and assets under canvases/<id>/ with relative links', async () => {
    await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 14, 0, 0)
    const saved = await store.saveAsset('acme', '2026-09-19', new Uint8Array([1, 2]), 'image/png', undefined, when)
    expect(saved.src).toMatch(/^canvases\/acme\/entries\/2026\/09\/assets\//)
    await store.addEntry('acme', `![a](${saved.src})`, {}, when)
    const file = await fs.readFile(path.join(root, 'canvases/acme/entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![a](assets/2026-09-19-140000-')
    expect((await store.readDay('acme', '2026-09-19')).entries[0].markdown).toContain(saved.src)
    expect(await store.listDays('journal')).toEqual([])
    expect(await store.listDays('acme')).toEqual([{ date: '2026-09-19', count: 1 }])
  })

  it('returns a timeline newest-first-limited, oldest-first-ordered', async () => {
    await store.createCanvas({ title: 'P' })
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

  it('moves a thread between canvases, rewriting image links and keeping ids unique', async () => {
    await store.createCanvas({ title: 'Acme' })
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
    const file = await fs.readFile(path.join(root, 'canvases/acme/entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('![s](../../../../../entries/2026/09/assets/')
    await expect(store.moveEntry('acme', '2026-09-19', a.entry.id, 'acme')).rejects.toThrow(/already/)
    await expect(store.moveEntry('acme', '2026-09-19', a.entry.id, 'nope')).rejects.toThrow(/not found/)
  })

  it('stores commit blocks read-only and de-duplicates by hash', async () => {
    await store.createCanvas({ title: 'Acme', repos: ['/tmp/x'] })
    expect((await store.readCanvas('acme')).repos).toEqual(['/tmp/x'])
    const sys = { kind: 'commit' as const, meta: { repo: '/tmp/x', hash: 'deadbeef' } }
    const a = await store.addEntry('acme', 'commit one', {}, new Date(2026, 8, 19, 9), sys)
    const b = await store.addEntry('acme', 'commit one again', {}, new Date(2026, 8, 19, 9, 1), sys)
    expect(b.entry.id).toBe(a.entry.id)
    expect((await store.readDay('acme', '2026-09-19')).entries).toHaveLength(1)
    await expect(store.updateEntry('acme', '2026-09-19', a.entry.id, 'edited')).rejects.toThrow(/read-only/)
    await expect(store.promoteToTask('acme', '2026-09-19', a.entry.id)).rejects.toThrow(/automatic block/)
    await store.addEntry('acme', 'a reply', { date: '2026-09-19', parentId: a.entry.id })
    expect(await store.deleteEntry('acme', '2026-09-19', a.entry.id)).toBe(2)
  })

  it('turns a block into a task canvas beneath its canvas', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 19, 9)
    const note = await store.addEntry(acme.id, '**Fix** the login redirect. It loops on Safari.\n\n```\ntrace\n```', {}, when)
    const { canvas, entry } = await store.promoteToTask(acme.id, '2026-09-19', note.entry.id, when)
    expect(canvas).toMatchObject({ id: 'fix-the-login-redirect', title: 'Fix the login redirect', parentId: 'acme', task: true })
    expect(entry).toMatchObject({ id: note.entry.id, kind: 'task', meta: { canvas: 'fix-the-login-redirect' } })
    expect(entry.markdown).toContain('**Fix** the login redirect')
    const file = await fs.readFile(path.join(root, 'canvases/acme/entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file).toContain('kind=task')
    expect(file).toContain('canvas=fix-the-login-redirect')
    const back = (await store.readDay(acme.id, '2026-09-19')).entries[0]
    expect(back.kind).toBe('task')
    expect(back.meta?.canvas).toBe('fix-the-login-redirect')
    // Promoting again is a no-op returning the same canvas.
    expect((await store.promoteToTask(acme.id, '2026-09-19', note.entry.id)).canvas.id).toBe('fix-the-login-redirect')
    // Journal blocks become top-level tasks.
    const j = await store.addEntry('journal', 'Write the incident report', {}, when)
    expect((await store.promoteToTask('journal', '2026-09-19', j.entry.id)).canvas.parentId).toBeNull()
    // The task block stays editable.
    await store.updateEntry(acme.id, '2026-09-19', note.entry.id, 'Fix the login redirect (edited)')
    expect((await store.readDay(acme.id, '2026-09-19')).entries[0]).toMatchObject({ kind: 'task', markdown: 'Fix the login redirect (edited)' })
  })

  it('searches across canvases', async () => {
    await store.createCanvas({ title: 'Acme' })
    await store.addEntry('journal', 'needle in journal', {}, new Date(2026, 8, 18, 9))
    await store.addEntry('acme', 'needle on canvas', {}, new Date(2026, 8, 19, 9))
    const { blocks, surfaces } = await store.search('needle')
    expect(blocks.map((h) => `${h.canvasId}:${h.entry.markdown}:${h.archived}`)).toEqual(['journal:needle in journal:false', 'acme:needle on canvas:false'])
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
    expect(await fs.readFile(path.join(root, `canvases/${site.id}/canvas.md`), 'utf8')).toContain('archived: true')
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
    expect(asset.src).toMatch(/^canvases\/web\/assets\/2026-09-19-090000-/)
    const saved = await store.writeSurface(web.id, `# Links\n\nTracker: https://issues.example\n\n![diagram](${asset.src})\n`, new Date(2026, 8, 19, 10))
    expect(saved).toMatchObject({ id: 'web', hasSurface: true, updatedAt: new Date(2026, 8, 19, 10).toISOString() })
    const file = await fs.readFile(path.join(root, 'canvases/web/canvas.md'), 'utf8')
    expect(file).toContain('title: Web')
    expect(file).toContain('![diagram](assets/2026-09-19-090000-')
    const back = await store.readCanvas('web')
    expect(back.surface).toContain(`![diagram](${asset.src})`)
    expect((await store.listCanvases()).find((c) => c.id === 'web')?.hasSurface).toBe(true)
    const { surfaces } = await store.search('issues.example')
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]).toMatchObject({ canvasId: 'web', archived: false })
    expect(surfaces[0].excerpt).toContain('issues.example')
    await expect(store.writeSurface('journal', 'x')).rejects.toThrow(/journal/)
  })

  it('migrates the pages/ + categories/ layout into canvases/', async () => {
    // Legacy layout as written by Devlog 0.2.
    const w = async (rel: string, text: string): Promise<void> => {
      await fs.mkdir(path.join(root, path.dirname(rel)), { recursive: true })
      await fs.writeFile(path.join(root, rel), text)
    }
    await w('pages/acme-corp-web-website/page.md', '---\ntitle: Website\ncategory: Acme Corp / Web\ncreated: 2026-09-01T00:00:00.000Z\nrepo: /src/site\n---\n\nMarketing site rebuild.\n')
    await w('pages/acme-corp-web-website/entries/2026/09/2026-09-19.md', '# 2026-09-19\n\n<!-- devlog:entry id=aaaaaaaa created=2026-09-19T09:00:00.000Z -->\n### 09:00\n\nkickoff ![s](assets/pic.png) and ![j](../../../../../entries/2026/09/assets/j.png)\n')
    await w('pages/acme-corp-web-website/entries/2026/09/assets/pic.png', 'png')
    await w('pages/loose/page.md', '---\ntitle: Loose page\narchived: true\n---\n')
    await w('categories/acme-corp/wiki.md', '---\npath: Acme Corp\nupdated: 2026-09-02T00:00:00.000Z\n---\n\n# Acme\n\n![logo](assets/logo.png)\n')
    await w('categories/acme-corp/assets/logo.png', 'png')
    await w('categories/globex/ops/wiki.md', '---\npath: Globex / Ops\narchived: true\n---\n\nRunbooks\n')

    const created = await store.migrateLegacyLayout(new Date(2026, 8, 20))
    expect(created.sort()).toEqual(['acme-corp', 'acme-corp-web', 'acme-corp-web-website', 'globex', 'globex-ops', 'loose'].sort())
    expect(await store.migrateLegacyLayout()).toEqual([]) // idempotent
    await expect(fs.stat(path.join(root, 'pages'))).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'categories'))).rejects.toThrow()

    const all = await store.listCanvases()
    const byId = new Map(all.map((c) => [c.id, c]))
    expect(byId.get('acme-corp')).toMatchObject({ title: 'Acme Corp', parentId: null, hasSurface: true })
    expect(byId.get('acme-corp-web')).toMatchObject({ title: 'Web', parentId: 'acme-corp' })
    expect(byId.get('acme-corp-web-website')).toMatchObject({ title: 'Website', parentId: 'acme-corp-web', repos: ['/src/site'], createdAt: '2026-09-01T00:00:00.000Z', hasSurface: true })
    expect(byId.get('loose')).toMatchObject({ title: 'Loose page', parentId: null, archived: true })
    expect(byId.get('globex-ops')).toMatchObject({ title: 'Ops', parentId: 'globex', archived: true, hasSurface: true })

    const acme = await store.readCanvas('acme-corp')
    expect(acme.surface).toBe('# Acme\n\n![logo](canvases/acme-corp/assets/logo.png)')
    expect(await fs.readFile(path.join(root, 'canvases/acme-corp/assets/logo.png'), 'utf8')).toBe('png')
    expect((await store.readCanvas('acme-corp-web-website')).surface).toBe('Marketing site rebuild.')
    const day = await store.readDay('acme-corp-web-website', '2026-09-19')
    expect(day.entries[0].markdown).toBe('kickoff ![s](canvases/acme-corp-web-website/entries/2026/09/assets/pic.png) and ![j](entries/2026/09/assets/j.png)')
  })

  it('keeps a todo list per canvas with comments, reorders it, and ticks items off into the stream', async () => {
    const acme = await store.createCanvas({ title: 'Acme' })
    const when = new Date(2026, 8, 25, 9)
    const added = await store.addTodos(acme.id, ['Send Dana the redirect list', 'Check the CDN rules', '  '], when)
    expect(added.map((t) => [t.kind, t.markdown])).toEqual([
      ['todo', 'Send Dana the redirect list'],
      ['todo', 'Check the CDN rules']
    ])
    const file = await fs.readFile(path.join(root, 'canvases/acme/todos.md'), 'utf8')
    expect(file.startsWith('<!-- devlog:format 2 -->\n# Todos')).toBe(true)
    expect(file).toContain('kind=todo')

    const reply = await store.addTodoReply(acme.id, added[0].id, 'Waiting on their ops team', when)
    expect((await store.readTodos(acme.id)).map((e) => [e.markdown, e.parentId ?? null])).toEqual([
      ['Send Dana the redirect list', null],
      ['Waiting on their ops team', added[0].id],
      ['Check the CDN rules', null]
    ])
    // Reordering moves the thread with the todo.
    await store.reorderTodo(acme.id, added[1].id, { beforeId: added[0].id })
    expect((await store.readTodos(acme.id)).map((e) => e.id)).toEqual([added[1].id, added[0].id, reply.id])

    // Ticking off writes a read-only done block into today's stream; unticking removes it.
    const { date } = await store.setTodoDone(acme.id, added[0].id, true, new Date(2026, 8, 25, 11))
    expect(date).toBe('2026-09-25')
    expect((await store.readTodos(acme.id)).find((e) => e.id === added[0].id)?.meta?.done).toBe(new Date(2026, 8, 25, 11).toISOString())
    const day = await store.readDay(acme.id, '2026-09-25')
    expect(day.entries.map((e) => [e.kind, e.markdown, e.meta?.todo])).toEqual([['done', '✓ Send Dana the redirect list', added[0].id]])
    await expect(store.updateEntry(acme.id, '2026-09-25', day.entries[0].id, 'x')).rejects.toThrow(/read-only/)
    await store.setTodoDone(acme.id, added[0].id, false, new Date(2026, 8, 25, 11, 5))
    expect((await store.readTodos(acme.id)).find((e) => e.id === added[0].id)?.meta?.done).toBeUndefined()
    expect((await store.readDay(acme.id, '2026-09-25')).entries).toEqual([])

    // Promoting a todo makes a task canvas, records a task block, and closes the todo.
    const { canvas, entry } = await store.promoteTodo(acme.id, added[1].id, new Date(2026, 8, 25, 12))
    expect(canvas).toMatchObject({ title: 'Check the CDN rules', parentId: 'acme', task: true })
    expect(entry).toMatchObject({ kind: 'task', meta: { canvas: canvas.id }, markdown: 'Check the CDN rules' })
    expect((await store.readTodos(acme.id)).find((e) => e.id === added[1].id)?.meta).toMatchObject({ task: canvas.id })

    // Journal todos live next to the journal; search finds todos; deleting removes the thread.
    await store.addTodos('journal', ['Renew the certificate'], when)
    expect((await fs.stat(path.join(root, 'entries/todos.md'))).isFile()).toBe(true)
    expect((await store.search('renew the cert')).blocks.map((h) => [h.canvasId, h.entry.kind])).toEqual([['journal', 'todo']])
    expect(await store.deleteTodoEntry(acme.id, added[0].id)).toBe(2)
    expect(await store.listDays('journal')).toEqual([])
  })
})
