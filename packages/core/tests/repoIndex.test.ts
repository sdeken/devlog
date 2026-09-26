import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canvasDir } from '../src/format/canvases'
import { classifyPath, INDEX_SCHEMA, RepoIndex } from '../src/node/repoIndex'
import { DevlogStore } from '../src/node/store'

let tmp: string
let root: string
let dbPath: string
let plain: DevlogStore
let indexed: DevlogStore
let index: RepoIndex

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-index-'))
  root = path.join(tmp, 'repo')
  dbPath = path.join(tmp, 'index.sqlite')
  await fs.mkdir(root)
  plain = new DevlogStore(root)
  await plain.initLayout()
  indexed = new DevlogStore(root)
})

afterEach(async () => {
  index?.close()
  await fs.rm(tmp, { recursive: true, force: true })
})

async function corpus(): Promise<{ acme: string; web: string; old: string }> {
  const acme = await plain.createCanvas({ title: 'Acme Corp' }, new Date(2026, 0, 1))
  const web = await plain.createCanvas({ title: 'Website', parentId: acme.id, task: true }, new Date(2026, 0, 2))
  const old = await plain.createCanvas({ title: 'Old client' }, new Date(2025, 5, 1))
  await plain.writeSurface(acme.id, '# Acme\n\nRunbook: restart the Needle service')
  for (let d = 1; d <= 20; d++) await plain.addEntry('journal', `journal day ${d} ${d % 3 === 0 ? 'needle' : 'hay'}`, {}, new Date(2026, 0, d, 9))
  const a = await plain.addEntry(acme.id, 'Kickoff with **Dana** — needle in the haystack', {}, new Date(2026, 0, 5, 10))
  await plain.addEntry(acme.id, 'reply: “Ünïcode” NEEDLE', { date: a.date, parentId: a.entry.id }, new Date(2026, 0, 5, 11))
  const hidden = await plain.addEntry(web.id, 'hidden needle', {}, new Date(2026, 0, 6, 9))
  await plain.setEntryHidden(web.id, hidden.date, hidden.entry.id, true)
  await plain.addEntry(web.id, 'quotes "needle" and ab', {}, new Date(2026, 0, 7, 9))
  await plain.addEntry(old.id, 'archived needle', {}, new Date(2025, 5, 2, 9))
  await plain.setCanvasArchived(old.id, true)
  await plain.addTodos(acme.id, ['Send Dana the needle list', 'Check CDN'], new Date(2026, 0, 8, 9))
  await plain.addTodos('journal', ['Renew the needle cert'], new Date(2026, 0, 9, 9))
  return { acme: acme.id, web: web.id, old: old.id }
}

/** The indexed store must answer exactly like the one that reads the files. */
async function expectSameAnswers(): Promise<void> {
  const canvases = await plain.listCanvases()
  expect(await indexed.listCanvases()).toEqual(canvases)
  for (const c of canvases) {
    expect(await indexed.listDays(c.id)).toEqual(await plain.listDays(c.id))
    expect(await indexed.getTimeline(c.id, { days: 5 })).toEqual(await plain.getTimeline(c.id, { days: 5 }))
  }
  expect(await indexed.getRange('2025-01-01', '2026-12-31')).toEqual(await plain.getRange('2025-01-01', '2026-12-31'))
  expect(await indexed.getRange('2026-01-03', '2026-01-06')).toEqual(await plain.getRange('2026-01-03', '2026-01-06'))
  for (const q of ['needle', 'NEEDLE', 'ab', 'Ü', 'ünïcode', '"needle"', 'dana', 'restart the needle', 'nothing matches this', 'a', 'hay']) {
    expect(await indexed.search(q), q).toEqual(await plain.search(q))
  }
}

describe('RepoIndex', () => {
  it('classifies repository paths', () => {
    expect(classifyPath('entries/2026/01/2026-01-05.md')).toEqual({ kind: 'day', canvasId: 'journal', date: '2026-01-05' })
    expect(classifyPath('entries/todos.md')).toEqual({ kind: 'todos', canvasId: 'journal' })
    expect(classifyPath('canvases/k3/k3m9x2q7vd/canvas.md')).toEqual({ kind: 'canvas', canvasId: 'k3m9x2q7vd' })
    expect(classifyPath('canvases/k3/k3m9x2q7vd/todos.md')).toEqual({ kind: 'todos', canvasId: 'k3m9x2q7vd' })
    expect(classifyPath('canvases/k3/k3m9x2q7vd/entries/2026/01/2026-01-05.md')).toEqual({ kind: 'day', canvasId: 'k3m9x2q7vd', date: '2026-01-05' })
    expect(classifyPath('canvases/xx/k3m9x2q7vd/canvas.md')).toBeNull() // wrong shard
    expect(classifyPath('entries/2026/02/2026-01-05.md')).toBeNull() // wrong month folder
    expect(classifyPath('entries/2026/01/assets/x.png')).toBeNull()
    expect(classifyPath('README.md')).toBeNull()
  })

  it('answers listings and search exactly like reading the files', async () => {
    await corpus()
    index = RepoIndex.open(dbPath, root)
    expect(index.ready).toBe(false)
    indexed.attachIndex(index)
    const report = await index.refresh()
    expect(report).toMatchObject({ indexed: report.scanned, removed: 0 })
    expect(index.ready).toBe(true)
    await expectSameAnswers()
    expect((await indexed.search('needle')).blocks.map((h) => h.entry.markdown)).toContain('hidden needle')
    expect((await indexed.search('needle')).blocks.find((h) => h.entry.markdown === 'archived needle')?.archived).toBe(true)
    expect(await index.refresh()).toMatchObject({ indexed: 0, removed: 0 }) // nothing changed
  })

  it('stays current through the store without a refresh', async () => {
    const { acme, web, old } = await corpus()
    index = RepoIndex.open(dbPath, root)
    indexed.attachIndex(index)
    await index.refresh()

    const c = await indexed.createCanvas({ title: 'Globex' }, new Date(2026, 1, 1))
    await indexed.addEntry(c.id, 'globex needle', {}, new Date(2026, 1, 2, 9))
    await indexed.updateCanvas(web, { title: 'Site' })
    await indexed.writeSurface(c.id, 'needle surface')
    const day = await indexed.readDay('journal', '2026-01-03')
    await indexed.deleteEntry('journal', '2026-01-03', day.entries[0].id)
    await indexed.moveEntry(acme, '2026-01-05', (await indexed.readDay(acme, '2026-01-05')).entries[0].id, c.id)
    const [todo] = await indexed.readTodos(acme)
    await indexed.setTodoDone(acme, todo.id, true, new Date(2026, 1, 3, 9))
    await indexed.deleteCanvas(old)
    await expectSameAnswers()
    expect(await index.refresh()).toMatchObject({ indexed: 0, removed: 0 })
  })

  it('picks up files changed behind its back (a pull) on refresh', async () => {
    const { acme } = await corpus()
    index = RepoIndex.open(dbPath, root)
    indexed.attachIndex(index)
    await index.refresh()

    // Another machine's work arrives: a new canvas, an edited day, a deleted day.
    const other = new DevlogStore(root)
    const remote = await other.createCanvas({ title: 'From laptop' }, new Date(2026, 2, 1))
    await other.addEntry(remote.id, 'laptop needle', {}, new Date(2026, 2, 1, 9))
    await other.addEntry(acme, 'more needle', {}, new Date(2026, 0, 5, 12))
    await fs.rm(path.join(root, 'entries/2026/01/2026-01-04.md'))
    // A canvas folder with blocks but no canvas.md.
    await fs.mkdir(path.join(root, canvasDir('bare000000'), 'entries/2026/01'), { recursive: true })
    await fs.writeFile(path.join(root, canvasDir('bare000000'), 'entries/2026/01/2026-01-10.md'), '<!-- devlog:format 3 -->\n<!-- devlog:add id=zzzzzzzz pos=a0 at=2026-01-10T09:00:00.000Z -->\nbare needle\n')

    const report = await index.refresh()
    // The new canvas's canvas.md and day file, the edited day, the bare canvas's day; one day gone.
    expect(report).toMatchObject({ indexed: 4, removed: 1 })
    await expectSameAnswers()
  })

  it('does not let a refresh overwrite a write that happened while it was reading', async () => {
    await corpus()
    index = RepoIndex.open(dbPath, root)
    indexed.attachIndex(index)
    await index.refresh()
    await new DevlogStore(root).addEntry('journal', 'external edit', {}, new Date(2026, 0, 2, 12))
    const running = index.refresh()
    await indexed.addEntry('journal', 'local edit during refresh', {}, new Date(2026, 0, 2, 13))
    await running
    await expectSameAnswers()
    expect((await indexed.search('local edit during')).blocks).toHaveLength(1)
  })

  it('persists between runs and rebuilds on a schema change or a different repository', async () => {
    await corpus()
    index = RepoIndex.open(dbPath, root)
    await index.refresh()
    index.close()

    index = RepoIndex.open(dbPath, root)
    expect(index.ready).toBe(true)
    indexed.attachIndex(index)
    await expectSameAnswers()
    index.close()

    const db = new DatabaseSync(dbPath)
    db.exec(`PRAGMA user_version = ${INDEX_SCHEMA + 1}`)
    db.close()
    index = RepoIndex.open(dbPath, root)
    expect(index.ready).toBe(false)
    index.close()

    index = RepoIndex.open(dbPath, root)
    await index.refresh()
    index.close()
    index = RepoIndex.open(dbPath, path.join(tmp, 'elsewhere'))
    expect(index.ready).toBe(false)
  })

  it('recovers from a corrupt database file', async () => {
    await fs.writeFile(dbPath, 'this is not a database')
    index = RepoIndex.open(dbPath, root)
    expect(index.ready).toBe(false)
    await index.refresh()
    expect(index.ready).toBe(true)
  })
})
