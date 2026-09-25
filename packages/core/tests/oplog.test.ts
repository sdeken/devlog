import { describe, expect, it } from 'vitest'
import {
  blockFileFormat,
  blockFileHeader,
  compactOps,
  insertEntry,
  isValidOrderKey,
  keyBetween,
  keysBetween,
  moveSubtree,
  parseBlockFile,
  parseOps,
  planAdd,
  planDelete,
  planEdit,
  planMove,
  planSet,
  readBlockLog,
  removeSubtree,
  replayOps,
  serializeBlockFile,
  serializeOps,
  stampFor,
  type BlockLog,
  type Op
} from '../src/index'
import type { Entry } from '../src/types'

const DIR = 'entries/2026/09'
const T = (min: number): string => new Date(Date.UTC(2026, 8, 19, 9, min)).toISOString()

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  return () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
}

describe('order keys', () => {
  it('generates short keys at the ends and between neighbours', () => {
    expect(keyBetween(null, null)).toBe('a0')
    expect(keyBetween('a0', null)).toBe('a1')
    expect(keyBetween(null, 'a0')).toBe('Zz')
    expect(keyBetween('a0', 'a1')).toBe('a0V')
    expect(keyBetween('az', null)).toBe('b00')
    expect(keysBetween(null, null, 3)).toEqual(['a0', 'a1', 'a2'])
    expect(keysBetween('a0', 'a1', 3).every((k, i, all) => k > 'a0' && k < 'a1' && (i === 0 || all[i - 1] < k))).toBe(true)
  })

  it('refuses malformed or out-of-order bounds', () => {
    expect(() => keyBetween('a1', 'a0')).toThrow()
    expect(() => keyBetween('a1', 'a1')).toThrow()
    expect(() => keyBetween('', null)).toThrow()
    expect(() => keyBetween('a10', null)).toThrow() // trailing zero in the fraction
    expect(isValidOrderKey('a0')).toBe(true)
    expect(isValidOrderKey('x')).toBe(false)
  })

  it('always sorts strictly between its neighbours, and appends stay short', () => {
    const rnd = rng(7)
    const keys: string[] = []
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(rnd() * (keys.length + 1))
      const k = keyBetween(keys[at - 1] ?? null, keys[at] ?? null)
      expect(isValidOrderKey(k)).toBe(true)
      keys.splice(at, 0, k)
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true)
    let last: string | null = null
    for (let i = 0; i < 5000; i++) last = keyBetween(last, null)
    expect(last!.length).toBeLessThanOrEqual(4)
  })
})

describe('op-log records', () => {
  it('round-trips records, escaping marker-like body lines and relativising images', () => {
    const ops: Op[] = [
      { op: 'add', id: 'aaaaaaaa', at: T(0), attrs: { pos: 'a0' }, body: 'Hello ![s](entries/2026/09/assets/x.png)\n\n<!-- devlog:add id=forged at=x -->' },
      { op: 'add', id: 'bbbbbbbb', at: T(1), attrs: { parent: 'aaaaaaaa', pos: 'a0', kind: 'commit', repo: 'C:\\src\\my proj', hash: 'abc' }, body: 'commit' },
      { op: 'edit', id: 'aaaaaaaa', at: T(2), attrs: {}, body: 'Edited' },
      { op: 'set', id: 'bbbbbbbb', at: T(3), attrs: { hidden: '1', done: '' } },
      { op: 'delete', id: 'bbbbbbbb', at: T(4), attrs: {} }
    ]
    const text = blockFileHeader('# 2026-09-19') + serializeOps(ops, DIR)
    expect(text).toContain('![s](assets/x.png)')
    expect(text).toContain('\\<!-- devlog:add id=forged')
    expect(text).toContain('<!-- devlog:set id=bbbbbbbb at=2026-09-19T09:03:00.000Z hidden=1 done="" -->')
    expect(text.match(/^<!-- devlog:(add|edit|set|delete) /gm)).toHaveLength(5)
    expect(blockFileFormat(text)).toBe(3)
    expect(parseOps(text, DIR)).toEqual(ops)
  })

  it('replays adds, edits, field changes and deletes', () => {
    const ops: Op[] = [
      { op: 'add', id: 'a', at: T(0), attrs: { pos: 'a0' }, body: 'first' },
      { op: 'add', id: 'b', at: T(1), attrs: { pos: 'a1', kind: 'commit', hash: 'h' }, body: 'second' },
      { op: 'add', id: 'r', at: T(2), attrs: { parent: 'a', pos: 'a0' }, body: 'reply' },
      { op: 'edit', id: 'a', at: T(3), attrs: {}, body: 'first, edited' },
      { op: 'set', id: 'b', at: T(4), attrs: { hidden: '1', hash: '', task: 'x' } },
      { op: 'set', id: 'b', at: T(5), attrs: { pos: 'Zz' } }, // before a
      { op: 'add', id: 'gone', at: T(6), attrs: { pos: 'a2' }, body: 'deleted' },
      { op: 'delete', id: 'gone', at: T(7), attrs: {} }
    ]
    const log = replayOps(ops)
    expect(log.entries).toEqual([
      { id: 'b', createdAt: T(1), markdown: 'second', kind: 'commit', hidden: true, meta: { task: 'x' } },
      { id: 'a', createdAt: T(0), updatedAt: T(3), markdown: 'first, edited' },
      { id: 'r', createdAt: T(2), markdown: 'reply', parentId: 'a' }
    ])
    expect([...log.ids].sort()).toEqual(['a', 'b', 'gone', 'r'])
    expect(log.maxAt).toBe(T(7))
    // Unhide and clear the kind.
    const back = replayOps([...ops, { op: 'set', id: 'b', at: T(8), attrs: { hidden: '0', kind: '' } }])
    expect(back.entries[0]).toMatchObject({ id: 'b', markdown: 'second' })
    expect(back.entries[0].hidden).toBeUndefined()
    expect(back.entries[0].kind).toBeUndefined()
  })

  it('is last-writer-wins per field, whatever the record order', () => {
    const add: Op = { op: 'add', id: 'a', at: T(0), attrs: { pos: 'a0' }, body: 'v0' }
    const newer: Op = { op: 'edit', id: 'a', at: T(5), attrs: {}, body: 'newer' }
    const older: Op = { op: 'edit', id: 'a', at: T(3), attrs: {}, body: 'older' }
    expect(replayOps([add, newer, older]).entries[0].markdown).toBe('newer')
    expect(replayOps([add, older, newer]).entries[0].markdown).toBe('newer')
    // Same timestamp: the later record wins (a machine's own records stay in order).
    const same: Op = { op: 'edit', id: 'a', at: T(5), attrs: {}, body: 'same time, later' }
    expect(replayOps([add, newer, same]).entries[0].markdown).toBe('same time, later')
    // A record merged in above its block's add still applies; delete is final.
    expect(replayOps([newer, add]).entries[0].markdown).toBe('newer')
    expect(replayOps([add, { op: 'delete', id: 'a', at: T(1), attrs: {} }, newer]).entries).toEqual([])
  })

  it('shows orphaned replies at the top level and breaks parent cycles', () => {
    const log = replayOps([
      { op: 'add', id: 'p', at: T(0), attrs: { pos: 'a0' }, body: 'parent' },
      { op: 'add', id: 'c', at: T(1), attrs: { parent: 'p', pos: 'a0' }, body: 'child' },
      { op: 'add', id: 'd', at: T(2), attrs: { parent: 'nowhere', pos: 'a1' }, body: 'dangling' },
      { op: 'delete', id: 'p', at: T(3), attrs: {} }
    ])
    expect(log.entries.map((e) => [e.id, e.parentId ?? null])).toEqual([
      ['c', null],
      ['d', null]
    ])
    const cyc = replayOps([
      { op: 'add', id: 'x', at: T(0), attrs: { parent: 'y', pos: 'a0' }, body: 'x' },
      { op: 'add', id: 'y', at: T(1), attrs: { parent: 'x', pos: 'a0' }, body: 'y' },
      { op: 'add', id: 's', at: T(2), attrs: { parent: 's', pos: 'a1' }, body: 'self' }
    ])
    expect(cyc.entries.map((e) => [e.id, e.parentId ?? null])).toEqual([
      ['x', null],
      ['y', 'x'],
      ['s', null]
    ])
  })

  it('survives a torn last record, stray headers and records from a newer version', () => {
    const good = blockFileHeader('# 2026-09-19') + serializeOps([{ op: 'add', id: 'a', at: T(0), attrs: { pos: 'a0' }, body: 'intact' }], DIR)
    for (const tail of ['<!-- devlog:ed', '<!-- devlog:edit id=a at=2026-09-19T09:05:00.000Z', '<!-- devlog:frobnicate id=a -->\nnot a body\n']) {
      expect(parseBlockFile(good + tail, DIR)).toEqual([{ id: 'a', createdAt: T(0), markdown: 'intact' }])
    }
    // Two machines created the same day file; git's union merge stacked both.
    const other = blockFileHeader('# 2026-09-19') + serializeOps([{ op: 'add', id: 'b', at: T(1), attrs: { pos: 'a0' }, body: 'from the laptop' }], DIR)
    expect(parseBlockFile(good + other, DIR).map((e) => [e.id, e.markdown])).toEqual([
      ['a', 'intact'],
      ['b', 'from the laptop']
    ])
  })

  it('compacts deterministically and reads older formats through the same path', () => {
    const entries: Entry[] = [
      { id: 'a', createdAt: T(0), markdown: 'one', hidden: true },
      { id: 'r', createdAt: T(1), markdown: 'reply', parentId: 'a', kind: 'commit', meta: { hash: 'h' } },
      { id: 'b', createdAt: T(2), updatedAt: T(3), markdown: 'two' }
    ]
    const text = serializeBlockFile(entries, DIR, '# 2026-09-19')
    expect(text).toBe(serializeBlockFile(entries.map((e) => ({ ...e })), DIR, '# 2026-09-19'))
    expect(compactOps(entries).map((o) => o.attrs.pos)).toEqual(['a0', 'a0', 'a1'])
    expect(parseBlockFile(text, DIR)).toEqual(entries)
    const v1 = '# 2026-09-19\n\n<!-- devlog:entry id=a created=2026-09-19T09:00:00.000Z -->\n### 09:00\n\nold\n'
    expect(readBlockLog(v1, DIR).entries).toEqual([{ id: 'a', createdAt: T(0), markdown: 'old' }])
  })
})

describe('planning records', () => {
  const log = (entries: Entry[]): BlockLog => readBlockLog(serializeBlockFile(entries, DIR, '# d'), DIR)
  const shape = (entries: Entry[]): string[] => entries.map((e) => `${e.id}<${e.parentId ?? ''}`)

  it('does what the list operations did, for any sequence of adds, moves and deletes', () => {
    const rnd = rng(1234)
    for (let run = 0; run < 60; run++) {
      let list: Entry[] = []
      let text = blockFileHeader('# d')
      let n = 0
      let clock = 0
      for (let step = 0; step < 40; step++) {
        const current = readBlockLog(text, DIR)
        expect(shape(current.entries)).toEqual(shape(list))
        const at = T(++clock)
        const pick = (): Entry | undefined => list[Math.floor(rnd() * list.length)]
        const r = rnd()
        let ops: Op[] = []
        if (r < 0.55 || list.length < 2) {
          const id = `e${n++}`
          const target = pick()
          const kind = Math.floor(rnd() * 4)
          const position = !target || kind === 0 ? {} : kind === 1 ? { parentId: target.id } : kind === 2 ? { afterId: target.id } : { beforeId: target.id }
          const entry: Entry = { id, createdAt: at, markdown: id }
          list = insertEntry(list, { ...entry }, position)
          ops = planAdd(current, entry, position, at)
        } else if (r < 0.8) {
          const tops = list.filter((e) => !e.parentId)
          const mover = tops[Math.floor(rnd() * tops.length)]
          const anchor = pick()!
          const position = rnd() < 0.5 ? { afterId: anchor.id } : { beforeId: anchor.id }
          if (!mover) continue
          list = moveSubtree(list, mover.id, position)
          ops = planMove(current, mover.id, position, at)
        } else {
          const victim = pick()!
          list = removeSubtree(list, victim.id)
          ops = planDelete(current, victim.id, at)
        }
        text += serializeOps(ops, DIR)
      }
      expect(shape(readBlockLog(text, DIR).entries)).toEqual(shape(list))
    }
  })

  it('merges two machines appending to the same file to the same state in either order', () => {
    const rnd = rng(99)
    for (let run = 0; run < 40; run++) {
      const base = [0, 1, 2, 3].map((i): Entry => ({ id: `b${i}`, createdAt: T(i), markdown: `base ${i}` }))
      const prefix = serializeBlockFile(base, DIR, '# d')
      const machine = (name: string, offset: number): string => {
        let text = prefix
        for (let step = 0; step < 6; step++) {
          const current = readBlockLog(text, DIR)
          const at = T(10 + step * 2 + offset)
          const pick = (): Entry => current.entries[Math.floor(rnd() * current.entries.length)]
          const r = rnd()
          let ops: Op[]
          if (r < 0.4 || current.entries.length < 2) ops = planAdd(current, { id: `${name}${step}`, createdAt: at, markdown: name }, rnd() < 0.5 ? {} : { afterId: pick().id }, at)
          else if (r < 0.6) ops = planEdit(current, pick().id, `${name} edit ${step}`, at)
          else if (r < 0.75) ops = planSet(current, pick().id, { hidden: rnd() < 0.5 ? '1' : '0' }, at)
          else if (r < 0.9) {
            const top = current.entries.filter((e) => !e.parentId)
            ops = planMove(current, top[Math.floor(rnd() * top.length)].id, { beforeId: pick().id }, at)
          } else ops = planDelete(current, pick().id, at)
          text += serializeOps(ops, DIR)
        }
        return text.slice(prefix.length)
      }
      const a = machine('a', 0)
      const b = machine('b', 1)
      const ab = parseBlockFile(prefix + a + b, DIR)
      const ba = parseBlockFile(prefix + b + a, DIR)
      expect(ab).toEqual(ba)
    }
  })

  it('renumbers siblings when their keys leave no room', () => {
    // Two machines appended at the end at once and picked the same key.
    const text =
      blockFileHeader('# d') +
      serializeOps(
        [
          { op: 'add', id: 'a', at: T(0), attrs: { pos: 'a0' }, body: 'a' },
          { op: 'add', id: 'b', at: T(1), attrs: { pos: 'a1' }, body: 'b' },
          { op: 'add', id: 'c', at: T(1), attrs: { pos: 'a1' }, body: 'c' }
        ],
        DIR
      )
    const current = readBlockLog(text, DIR)
    const ops = planAdd(current, { id: 'x', createdAt: T(2), markdown: 'x' }, { afterId: 'b' }, T(2))
    expect(ops.filter((o) => o.op === 'set')).toHaveLength(3)
    expect(parseBlockFile(text + serializeOps(ops, DIR), DIR).map((e) => e.id)).toEqual(['a', 'b', 'x', 'c'])
  })

  it('stamps new records no earlier than the latest one in the file', () => {
    const current = log([{ id: 'a', createdAt: T(30), markdown: 'a' }])
    expect(stampFor(current, new Date(T(10)))).toBe(T(30))
    expect(stampFor(current, new Date(T(40)))).toBe(T(40))
  })

  it('refuses to plan against blocks that are not there', () => {
    const current = log([{ id: 'a', createdAt: T(0), markdown: 'a' }, { id: 'r', createdAt: T(0), markdown: 'r', parentId: 'a' }])
    expect(() => planAdd(current, { id: 'x', createdAt: T(1), markdown: 'x' }, { afterId: 'zz' }, T(1))).toThrow(/not found/)
    expect(() => planEdit(current, 'zz', 'x', T(1))).toThrow(/not found/)
    expect(() => planMove(current, 'r', { afterId: 'a' }, T(1))).toThrow(/top-level/)
    expect(planMove(current, 'a', { afterId: 'r' }, T(1))).toEqual([])
    expect(planDelete(current, 'a', T(1)).map((o) => o.id)).toEqual(['a', 'r'])
  })
})
