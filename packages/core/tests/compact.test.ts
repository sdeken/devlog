import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RepoIndex } from '../src/node/repoIndex'
import { DevlogStore } from '../src/node/store'

let tmp: string
let root: string
let store: DevlogStore

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-compact-'))
  root = path.join(tmp, 'repo')
  await fs.mkdir(root)
  store = new DevlogStore(root)
  await store.initLayout()
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const aug = (d: number, h = 9, m = 0): Date => new Date(2026, 7, d, h, m)
const QUIET = new Date(2026, 8, 1)

/** A day with a history: edits, a hide, a move, a reply, deletes; and a todo list. */
async function busyHistory(): Promise<{ canvas: string; file: string; todos: string }> {
  const canvas = (await store.createCanvas({ title: 'Acme' })).id
  const a = await store.addEntry(canvas, 'first', {}, aug(3, 9))
  const b = await store.addEntry(canvas, 'second', {}, aug(3, 10))
  const c = await store.addEntry(canvas, 'third ![x](entries/2026/08/assets/x.png)', {}, aug(3, 11))
  await store.addEntry(canvas, 'a reply', { date: a.date, parentId: a.entry.id }, aug(3, 12))
  for (let i = 1; i <= 5; i++) await store.updateEntry(canvas, a.date, a.entry.id, `first, edit ${i}`, aug(3, 13, i))
  await store.setEntryHidden(canvas, a.date, b.entry.id, true, aug(3, 14))
  await store.reorderEntry(canvas, a.date, c.entry.id, { beforeId: a.entry.id }, aug(3, 15))
  const gone = await store.addEntry(canvas, 'deleted later', {}, aug(3, 16))
  await store.deleteEntry(canvas, a.date, gone.entry.id, aug(3, 17))
  const [t1, t2] = await store.addTodos(canvas, ['one', 'two'], aug(4))
  await store.addTodoReply(canvas, t1.id, 'a comment', aug(4, 10))
  await store.setTodoDone(canvas, t2.id, true, aug(4, 11))
  await store.reorderTodo(canvas, t2.id, { beforeId: t1.id }, aug(4, 12))
  const dir = `canvases/${canvas.slice(0, 2)}/${canvas}`
  return { canvas, file: `${dir}/entries/2026/08/2026-08-03.md`, todos: `${dir}/todos.md` }
}

describe('compaction', () => {
  it('rewrites quiet files to one record per block, with exactly the same blocks', async () => {
    const { canvas, file, todos } = await busyHistory()
    const dayBefore = await store.readDay(canvas, '2026-08-03')
    const todosBefore = await store.readTodos(canvas)
    const textBefore = await fs.readFile(path.join(root, file), 'utf8')
    expect(textBefore).toMatch(/devlog:edit /)

    const report = await store.compact({ quietSince: QUIET })
    const paths = report.compacted.map((c) => c.path).sort()
    // 2026-08-04 holds a single record (the done block): already compact, so untouched.
    expect(paths).toEqual([file, todos].sort())
    for (const c of report.compacted) expect(c.after).toBeLessThan(c.before)
    expect(report.skipped).toEqual([])

    expect(await store.readDay(canvas, '2026-08-03')).toEqual(dayBefore)
    expect(await store.readTodos(canvas)).toEqual(todosBefore)
    const text = await fs.readFile(path.join(root, file), 'utf8')
    expect(text).not.toMatch(/devlog:(edit|set|delete) /)
    expect(text.match(/devlog:add /g)).toHaveLength(dayBefore.entries.length)
    expect(text).not.toContain('deleted later')
    expect(text).toContain('![x](../../../../../../entries/2026/08/assets/x.png)')

    // Nothing left to do; and the file takes new records as usual.
    expect((await store.compact({ quietSince: QUIET })).compacted).toEqual([])
    await store.addEntry(canvas, 'after compaction', { date: '2026-08-03' }, new Date(2026, 8, 20))
    expect((await store.readDay(canvas, '2026-08-03')).entries.map((e) => e.markdown).at(-1)).toBe('after compaction')
    expect((await fs.readFile(path.join(root, file), 'utf8')).startsWith(text)).toBe(true)
  })

  it('leaves files alone that changed recently', async () => {
    const { canvas, file } = await busyHistory()
    await store.updateEntry(canvas, '2026-08-03', (await store.readDay(canvas, '2026-08-03')).entries[0].id, 'touched this month', new Date(2026, 8, 10))
    const before = await fs.readFile(path.join(root, file), 'utf8')
    const report = await store.compact({ quietSince: QUIET })
    expect(report.compacted.map((c) => c.path)).not.toContain(file)
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(before)
  })

  it('only reports in a dry run', async () => {
    const { file } = await busyHistory()
    const before = await fs.readFile(path.join(root, file), 'utf8')
    const report = await store.compact({ quietSince: QUIET, dryRun: true })
    expect(report.compacted.map((c) => c.path)).toContain(file)
    expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(before)
  })

  it('skips files still in an older format and keeps the index current', async () => {
    const { canvas } = await busyHistory()
    await fs.mkdir(path.join(root, 'entries/2026/07'), { recursive: true })
    await fs.writeFile(path.join(root, 'entries/2026/07/2026-07-01.md'), '<!-- devlog:format 2 -->\n# 2026-07-01\n\n<!-- devlog:entry id=aaaaaaaa created=2026-07-01T09:00:00.000Z -->\nold\n')
    const index = RepoIndex.open(path.join(tmp, 'index.sqlite'), root)
    store.attachIndex(index)
    await index.refresh()
    const hitsBefore = await store.search('edit 5')
    const report = await store.compact({ quietSince: QUIET })
    expect(report.skipped).toEqual([{ path: 'entries/2026/07/2026-07-01.md', reason: 'older format' }])
    expect(await store.search('edit 5')).toEqual(hitsBefore)
    expect(await store.search('deleted later')).toEqual({ blocks: [], surfaces: [] })
    expect(await index.refresh()).toMatchObject({ indexed: 0, removed: 0 }) // write-through kept it current
    expect(await store.listDays(canvas)).toEqual([
      { date: '2026-08-04', count: 1 },
      { date: '2026-08-03', count: 4 }
    ])
    index.close()
  })
})
