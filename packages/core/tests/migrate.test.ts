import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvasDir } from '../src/format/canvases'
import { migratedCanvasId, migrateRepository, needsMigration, OLD_DIR, readStorageFormat, recoverInterruptedMigration, upgradeRepository } from '../src/node/migrate'
import { DevlogStore } from '../src/node/store'
import { SyncManager } from '../src/node/sync'

let tmp: string
let root: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-migrate-'))
  root = path.join(tmp, 'repo')
  await fs.mkdir(root)
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function write(base: string, rel: string, text: string): Promise<void> {
  await fs.mkdir(path.join(base, path.dirname(rel)), { recursive: true })
  await fs.writeFile(path.join(base, rel), text)
}

/** A format 1 repository as written by Devlog 0.3. */
async function formatOneRepo(base: string): Promise<void> {
  await write(base, 'README.md', '# Devlog\n')
  await write(base, 'canvases/acme-corp/canvas.md', '---\ntitle: Acme Corp\ncreated: 2026-09-01T00:00:00.000Z\nrepo: "C:\\\\src\\\\acme"\n---\n\n# Acme\n\n![logo](assets/logo.png)\n')
  await write(base, 'canvases/acme-corp/assets/logo.png', 'logo')
  await write(
    base,
    'canvases/acme-corp/todos.md',
    '# Todos\n\n<!-- devlog:entry id=t0d0t0d0 created=2026-09-18T09:00:00.000Z kind=todo done=2026-09-19T09:00:00.000Z task=website -->\nCheck the CDN rules\n'
  )
  await write(base, 'canvases/website/canvas.md', '---\ntitle: Website\nparent: acme-corp\ntask: true\ncreated: 2026-09-02T00:00:00.000Z\n---\n')
  await write(
    base,
    'canvases/website/entries/2026/09/2026-09-19.md',
    [
      '# 2026-09-19',
      '',
      '<!-- devlog:entry id=aaaaaaaa created=2026-09-19T09:00:00.000Z -->',
      '### 09:00',
      '',
      'kickoff ![s](assets/pic.png) with ![logo](../../../../acme-corp/assets/logo.png) and ![j](../../../../../entries/2026/09/assets/j.png)',
      '',
      '<!-- devlog:entry id=bbbbbbbb parent=aaaaaaaa created=2026-09-19T09:30:00.000Z kind=commit hash=deadbeef repo=acme -->',
      '#### ↳ 09:30',
      '',
      'Fix redirect (`deadbeef`)',
      ''
    ].join('\n')
  )
  await write(base, 'canvases/website/entries/2026/09/assets/pic.png', 'pic')
  await write(
    base,
    'entries/2026/09/2026-09-19.md',
    [
      '# 2026-09-19',
      '',
      '<!-- devlog:entry id=cccccccc created=2026-09-19T08:00:00.000Z kind=task canvas=website -->',
      '### 08:00',
      '',
      'Website rebuild ![p](../../../canvases/website/entries/2026/09/assets/pic.png)',
      ''
    ].join('\n')
  )
  await write(base, 'entries/2026/09/assets/j.png', 'j')
}

async function tree(base: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name)
      if (d.isDirectory()) await walk(abs)
      else out[path.relative(base, abs).split(path.sep).join('/')] = await fs.readFile(abs, 'utf8')
    }
  }
  await walk(base)
  return out
}

describe('storage migration', () => {
  it('moves format 1 canvases to sharded ids, rewriting references, links and block files', async () => {
    await formatOneRepo(root)
    expect(await readStorageFormat(root)).toBe(1)
    expect(await needsMigration(root)).toBe(true)

    const report = await migrateRepository(root)
    const acme = migratedCanvasId('acme-corp')
    const web = migratedCanvasId('website')
    expect(report).toEqual({ from: 1, to: 2, canvases: { 'acme-corp': acme, website: web }, files: 3 })
    expect(acme).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/)
    expect(await readStorageFormat(root)).toBe(2)
    expect(await needsMigration(root)).toBe(false)
    await expect(fs.stat(path.join(root, 'canvases/acme-corp'))).rejects.toThrow()
    await expect(fs.stat(path.join(root, OLD_DIR))).rejects.toThrow()
    expect(await fs.readFile(path.join(root, '.gitignore'), 'utf8')).toContain('.devlog-migrate/')

    const store = new DevlogStore(root)
    const canvases = await store.listCanvases()
    expect(canvases.map((c) => c.id)).toEqual(['journal', acme, web])
    expect(canvases[1]).toMatchObject({ title: 'Acme Corp', parentId: null, repos: ['C:\\src\\acme'], aliases: ['acme-corp'], hasSurface: true })
    expect(canvases[2]).toMatchObject({ title: 'Website', parentId: acme, task: true, aliases: ['website'] })
    expect(await store.resolveCanvasId('website')).toBe(web)
    expect(await store.resolveCanvasId(web)).toBe(web)
    expect(await store.resolveCanvasId('nope')).toBeNull()
    expect(Object.fromEntries(await store.aliasMap())).toEqual({ 'acme-corp': acme, website: web })

    // Surface and its assets moved with the canvas.
    expect((await store.readCanvas(acme)).surface).toBe(`# Acme\n\n![logo](${canvasDir(acme)}/assets/logo.png)`)
    expect(await fs.readFile(path.join(root, canvasDir(acme), 'assets/logo.png'), 'utf8')).toBe('logo')

    // Blocks: links into moved canvases rewritten, threads and automatic blocks intact.
    const day = await store.readDay(web, '2026-09-19')
    expect(day.entries.map((e) => [e.id, e.parentId ?? null, e.kind ?? 'note'])).toEqual([
      ['aaaaaaaa', null, 'note'],
      ['bbbbbbbb', 'aaaaaaaa', 'commit']
    ])
    expect(day.entries[0].markdown).toBe(
      `kickoff ![s](${canvasDir(web)}/entries/2026/09/assets/pic.png) with ![logo](${canvasDir(acme)}/assets/logo.png) and ![j](entries/2026/09/assets/j.png)`
    )
    expect(day.entries[1].meta).toEqual({ hash: 'deadbeef', repo: 'acme' })
    const file = await fs.readFile(path.join(root, canvasDir(web), 'entries/2026/09/2026-09-19.md'), 'utf8')
    expect(file.startsWith('<!-- devlog:format 2 -->\n# 2026-09-19\n')).toBe(true)
    expect(file).not.toContain('### 09:00')
    expect(await fs.readFile(path.join(root, canvasDir(web), 'entries/2026/09/assets/pic.png'), 'utf8')).toBe('pic')

    // Task links (journal block → canvas, todo → task canvas) follow the new ids.
    const journal = await store.readDay('journal', '2026-09-19')
    expect(journal.entries[0]).toMatchObject({ kind: 'task', meta: { canvas: web } })
    expect(journal.entries[0].markdown).toBe(`Website rebuild ![p](${canvasDir(web)}/entries/2026/09/assets/pic.png)`)
    expect((await store.readTodos(acme))[0]).toMatchObject({ kind: 'todo', meta: { task: web, done: '2026-09-19T09:00:00.000Z' } })

    // Idempotent.
    expect(await migrateRepository(root)).toBeNull()
  })

  it('is deterministic, so two machines migrating the same history agree byte for byte', async () => {
    const a = path.join(tmp, 'a')
    const b = path.join(tmp, 'b')
    await formatOneRepo(a)
    await formatOneRepo(b)
    await migrateRepository(a, new Date(2026, 8, 25))
    await migrateRepository(b, new Date(2026, 8, 26))
    expect(await tree(b)).toEqual(await tree(a))
  })

  it('leaves a fresh format 2 repository alone', async () => {
    const store = new DevlogStore(root)
    await store.initLayout()
    expect(await needsMigration(root)).toBe(false)
    const c = await store.createCanvas({ title: 'New' })
    expect(await migrateRepository(root)).toBeNull()
    expect((await store.listCanvases()).map((x) => x.id)).toEqual(['journal', c.id])
  })

  it('does not stamp an existing format 1 repository as format 2 on open', async () => {
    await formatOneRepo(root)
    await new DevlogStore(root).initLayout()
    expect(await readStorageFormat(root)).toBe(1)
    expect(await needsMigration(root)).toBe(true)
  })

  it('rolls back a migration interrupted before the manifest was written', async () => {
    await formatOneRepo(root)
    const before = await tree(root)
    // Crash mid-swap: old trees set aside, a partial new tree in place, no manifest.
    await fs.mkdir(path.join(root, OLD_DIR), { recursive: true })
    await fs.rename(path.join(root, 'canvases'), path.join(root, OLD_DIR, 'canvases'))
    await fs.rename(path.join(root, 'entries'), path.join(root, OLD_DIR, 'entries'))
    await write(root, 'canvases/zz/zzzzzzzzzz/canvas.md', 'partial')
    await write(root, '.devlog-migrate/entries/x.md', 'staged')
    expect(await needsMigration(root)).toBe(true)

    expect(await recoverInterruptedMigration(root)).toBe('rolled-back')
    expect(await tree(root)).toEqual(before)
    // …and the next open migrates normally.
    expect((await migrateRepository(root))?.to).toBe(2)
  })

  it('finishes a migration interrupted after the manifest was written', async () => {
    await formatOneRepo(root)
    await migrateRepository(root)
    const after = await tree(root)
    await write(root, `${OLD_DIR}/canvases/acme-corp/canvas.md`, 'old')
    expect(await recoverInterruptedMigration(root)).toBe('completed')
    expect(await tree(root)).toEqual(after)
  })

  it('upgrades the Devlog 0.2 pages/ + categories/ layout all the way', async () => {
    await write(root, 'pages/acme-corp-web-website/page.md', '---\ntitle: Website\ncategory: Acme Corp / Web\ncreated: 2026-09-01T00:00:00.000Z\nrepo: /src/site\n---\n\nMarketing site rebuild.\n')
    await write(
      root,
      'pages/acme-corp-web-website/entries/2026/09/2026-09-19.md',
      '# 2026-09-19\n\n<!-- devlog:entry id=aaaaaaaa created=2026-09-19T09:00:00.000Z -->\n### 09:00\n\nkickoff ![s](assets/pic.png) and ![j](../../../../../entries/2026/09/assets/j.png)\n'
    )
    await write(root, 'pages/acme-corp-web-website/entries/2026/09/assets/pic.png', 'png')
    await write(root, 'pages/loose/page.md', '---\ntitle: Loose page\narchived: true\n---\n')
    await write(root, 'categories/acme-corp/wiki.md', '---\npath: Acme Corp\nupdated: 2026-09-02T00:00:00.000Z\n---\n\n# Acme\n\n![logo](assets/logo.png)\n')
    await write(root, 'categories/acme-corp/assets/logo.png', 'png')
    await write(root, 'categories/globex/ops/wiki.md', '---\npath: Globex / Ops\narchived: true\n---\n\nRunbooks\n')
    expect(await needsMigration(root)).toBe(true)

    const report = await migrateRepository(root, new Date(2026, 8, 20))
    expect(Object.keys(report!.canvases).sort()).toEqual(['acme-corp', 'acme-corp-web', 'acme-corp-web-website', 'globex', 'globex-ops', 'loose'])
    await expect(fs.stat(path.join(root, 'pages'))).rejects.toThrow()
    await expect(fs.stat(path.join(root, 'categories'))).rejects.toThrow()
    expect(await needsMigration(root)).toBe(false)

    const store = new DevlogStore(root)
    const id = (old: string): string => report!.canvases[old]
    const byId = new Map((await store.listCanvases()).map((c) => [c.id, c]))
    expect(byId.get(id('acme-corp'))).toMatchObject({ title: 'Acme Corp', parentId: null, hasSurface: true })
    expect(byId.get(id('acme-corp-web'))).toMatchObject({ title: 'Web', parentId: id('acme-corp') })
    expect(byId.get(id('acme-corp-web-website'))).toMatchObject({
      title: 'Website',
      parentId: id('acme-corp-web'),
      repos: ['/src/site'],
      createdAt: '2026-09-01T00:00:00.000Z',
      hasSurface: true
    })
    expect(byId.get(id('loose'))).toMatchObject({ title: 'Loose page', parentId: null, archived: true })
    expect(byId.get(id('globex-ops'))).toMatchObject({ title: 'Ops', parentId: id('globex'), archived: true, hasSurface: true })

    expect((await store.readCanvas(id('acme-corp'))).surface).toBe(`# Acme\n\n![logo](${canvasDir(id('acme-corp'))}/assets/logo.png)`)
    expect(await fs.readFile(path.join(root, canvasDir(id('acme-corp')), 'assets/logo.png'), 'utf8')).toBe('png')
    const web = id('acme-corp-web-website')
    expect((await store.readCanvas(web)).surface).toBe('Marketing site rebuild.')
    const day = await store.readDay(web, '2026-09-19')
    expect(day.entries[0].markdown).toBe(`kickoff ![s](${canvasDir(web)}/entries/2026/09/assets/pic.png) and ![j](entries/2026/09/assets/j.png)`)
  })
})

describe('upgrading repositories that sync between machines', () => {
  const cfg = (name: string): string[] => [`user.name=${name}`, `user.email=${name}@example.com`]
  const options = { intervalMinutes: 60, debounceSeconds: 60, autoPush: true, pullOnStart: false, authorName: 'b', authorEmail: 'b@example.com' }
  let bare: string
  let a: string
  let b: string

  /** A pushed format 1 history, cloned onto machines A and B. */
  async function twoMachines(): Promise<void> {
    bare = path.join(tmp, 'remote.git')
    a = path.join(tmp, 'a')
    b = path.join(tmp, 'b')
    await simpleGit().init(true, [bare, '--initial-branch=main'])
    await fs.mkdir(a)
    const gitA = simpleGit({ baseDir: a, config: cfg('a') })
    await gitA.init(['--initial-branch=main'])
    await formatOneRepo(a)
    await gitA.add('-A')
    await gitA.commit('format 1 history')
    await gitA.addRemote('origin', bare)
    await gitA.push('origin', 'main', ['--set-upstream'])
    await simpleGit().clone(bare, b)
  }

  async function upgradeA(): Promise<void> {
    const sync = new SyncManager(a, { ...options, authorName: 'a', authorEmail: 'a@example.com' })
    const res = await upgradeRepository(a, sync)
    expect(res.error).toBeUndefined()
    expect(res.remote).toBe('none')
    expect(res.report?.to).toBe(2)
    expect((await sync.syncNow('manual')).pushed).toBe(true)
    sync.stop()
  }

  it('the first machine pulls, migrates, commits', async () => {
    await twoMachines()
    await upgradeA()
    const log = await simpleGit({ baseDir: bare }).log()
    expect(log.all.map((c) => c.message)).toEqual(['devlog: migrate to storage format 2', 'format 1 history'])
  })

  it('a machine with nothing unsynced just pulls the upgrade', async () => {
    await twoMachines()
    await upgradeA()
    const sync = new SyncManager(b, options)
    const res = await upgradeRepository(b, sync)
    expect(res).toEqual({ report: null, remote: 'pulled', error: undefined })
    expect(await readStorageFormat(b)).toBe(2)
    expect(await tree(path.join(b, 'canvases'))).toEqual(await tree(path.join(a, 'canvases')))
    sync.stop()
  })

  it('a machine with unsynced old-format work migrates it and merges, instead of splicing it into moved files', async () => {
    await twoMachines()
    const gitB = simpleGit({ baseDir: b, config: cfg('b') })
    // Machine B (still on the old version, offline) writes a note, commits it, and leaves another uncommitted.
    const dayB = path.join(b, 'canvases/website/entries/2026/09/2026-09-19.md')
    await fs.appendFile(dayB, '\n<!-- devlog:entry id=dddddddd created=2026-09-19T17:00:00.000Z -->\n### 17:00\n\nwritten offline on machine B\n')
    await gitB.add('-A')
    await gitB.commit('offline note')
    await write(b, 'canvases/website/entries/2026/09/2026-09-20.md', '# 2026-09-20\n\n<!-- devlog:entry id=eeeeeeee created=2026-09-20T08:00:00.000Z -->\n### 08:00\n\nnot yet committed\n')
    await upgradeA()

    const sync = new SyncManager(b, options)
    const res = await upgradeRepository(b, sync)
    expect(res.error).toBeUndefined()
    expect(res.remote).toBe('merged')
    expect(res.report?.to).toBe(2)
    expect((await gitB.status()).files).toEqual([])

    const storeA = new DevlogStore(a)
    const storeB = new DevlogStore(b)
    expect(await storeB.listCanvases()).toEqual(await storeA.listCanvases())
    const web = migratedCanvasId('website')
    const day = await storeB.readDay(web, '2026-09-19')
    expect(day.entries.map((e) => e.markdown)).toEqual([
      expect.stringContaining('kickoff'),
      'Fix redirect (`deadbeef`)',
      'written offline on machine B' // format 1 time heading dropped, not spliced in
    ])
    expect((await storeB.readDay(web, '2026-09-20')).entries.map((e) => e.markdown)).toEqual(['not yet committed'])
    await expect(fs.stat(path.join(b, 'canvases/website'))).rejects.toThrow()

    // The next sync pushes it all, and machine A pulls it cleanly.
    const res2 = await sync.syncNow('manual')
    expect(res2.error).toBeUndefined()
    expect(res2.pushed).toBe(true)
    sync.stop()
    await simpleGit({ baseDir: a, config: cfg('a') }).pull('origin', 'main', { '--rebase': 'true' })
    expect(await tree(path.join(a, 'canvases'))).toEqual(await tree(path.join(b, 'canvases')))
  })

  it('backs out a pull that conflicts instead of leaving the repository mid-rebase', async () => {
    await twoMachines()
    const gitB = simpleGit({ baseDir: b, config: cfg('b') })
    await write(b, 'README.md', 'machine B\n')
    await gitB.add('-A')
    await gitB.commit('b readme')
    await write(a, 'README.md', 'machine A\n')
    await simpleGit({ baseDir: a, config: cfg('a') }).add('-A')
    await simpleGit({ baseDir: a, config: cfg('a') }).commit('a readme')
    await simpleGit({ baseDir: a }).push('origin', 'main')
    const sync = new SyncManager(b, options)
    const res = await sync.syncNow('manual')
    expect(res.error).toMatch(/^Pull failed/)
    await expect(fs.stat(path.join(b, '.git/rebase-merge'))).rejects.toThrow()
    await expect(fs.stat(path.join(b, '.git/rebase-apply'))).rejects.toThrow()
    expect((await gitB.log()).latest?.message).toBe('b readme')
    sync.stop()
  })
})
