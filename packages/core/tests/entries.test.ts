import { describe, expect, it } from 'vitest'
import {
  buildTree,
  collectImageSrcs,
  dayFilePath,
  depthOf,
  descendantIds,
  insertEntry,
  moveSubtree,
  removeSubtree,
  subtreeEndIndex,
  localDate,
  parseDayFile,
  previewText,
  relativePosix,
  rewriteImageSrcs,
  serializeDayFile,
  blockFileFormat,
  escapeMarkerLines,
  unescapeMarkerLines,
  splitTodoLines,
  toDayRelative,
  toRelativeFrom,
  toRootRelative,
  toRootRelativeFrom
} from '../src/index'
import type { Day, Entry } from '../src/types'

describe('paths', () => {
  it('maps a date to its day file', () => {
    expect(dayFilePath('2026-09-19')).toBe('entries/2026/09/2026-09-19.md')
  })

  it('computes relative posix paths', () => {
    expect(relativePosix('entries/2026/09', 'entries/2026/09/assets/a.png')).toBe('assets/a.png')
    expect(relativePosix('entries/2026/10', 'entries/2026/09/assets/a.png')).toBe('../09/assets/a.png')
    expect(relativePosix('entries/2027/01', 'entries/2026/12/assets/a.png')).toBe('../../2026/12/assets/a.png')
  })

  it('formats local dates', () => {
    expect(localDate(new Date(2026, 8, 19, 23, 59))).toBe('2026-09-19')
  })
})

describe('image src rewriting', () => {
  it('rewrites markdown and html images but not external urls', () => {
    const md = 'a ![x](assets/a.png) b ![](https://e.com/i.png "t") <img src="assets/b.png"> ![y](<assets/c d.png>)'
    const out = rewriteImageSrcs(md, (s) => (s.startsWith('http') ? s : `R/${s}`))
    expect(out).toBe('a ![x](R/assets/a.png) b ![](https://e.com/i.png "t") <img src="R/assets/b.png"> ![y](<R/assets/c d.png>)')
  })

  it('round-trips day-relative <-> root-relative', () => {
    const rel = '![shot](assets/2026-09-19-1.png) and ![old](../08/assets/x.png)'
    const root = toRootRelative(rel, '2026-09-19')
    expect(root).toBe('![shot](entries/2026/09/assets/2026-09-19-1.png) and ![old](entries/2026/08/assets/x.png)')
    expect(toDayRelative(root, '2026-09-19')).toBe(rel)
    expect(collectImageSrcs(root)).toEqual(['entries/2026/09/assets/2026-09-19-1.png', 'entries/2026/08/assets/x.png'])
  })

  it('rewrites paths relative to any directory, including category wikis', () => {
    const md = '![d](assets/x.png) ![e](https://x/y.png)'
    const root = toRootRelativeFrom(md, 'categories/acme-corp/web')
    expect(root).toBe('![d](categories/acme-corp/web/assets/x.png) ![e](https://x/y.png)')
    expect(toRelativeFrom(root, 'categories/acme-corp/web')).toBe(md)
    expect(toRelativeFrom('![n](entries/2026/09/assets/n.png)', 'categories/acme-corp')).toBe('![n](../../entries/2026/09/assets/n.png)')
  })

  it('places a cross-month asset correctly when posted on a later day', () => {
    const root = '![p](entries/2026/09/assets/late.png)'
    expect(toDayRelative(root, '2026-10-01')).toBe('![p](../09/assets/late.png)')
  })
})

describe('day file format', () => {
  const day: Day = {
    date: '2026-09-19',
    entries: [
      { id: 'aaaaaaaa', createdAt: '2026-09-19T14:32:00.000Z', markdown: 'First post\n\n- with a list\n- **bold**' },
      {
        id: 'bbbbbbbb',
        createdAt: '2026-09-19T15:10:00.000Z',
        updatedAt: '2026-09-19T15:12:00.000Z',
        markdown: 'Second post with image\n\n![shot](entries/2026/09/assets/2026-09-19-151000-ab12.png)\n\n```ts\nconst x = 1\n```'
      }
    ]
  }

  it('serialises to readable markdown with entry markers', () => {
    const text = serializeDayFile(day)
    expect(text.startsWith('<!-- devlog:format 3 -->\n# 2026-09-19\n\n<!-- devlog:add id=aaaaaaaa pos=a0 at=2026-09-19T14:32:00.000Z -->\n')).toBe(true)
    expect(text).not.toMatch(/^#{3,6} /m) // no derived time headings
    expect(text).toContain('<!-- devlog:add id=bbbbbbbb pos=a1 at=2026-09-19T15:10:00.000Z updated=2026-09-19T15:12:00.000Z -->')
    expect(text).toContain('![shot](assets/2026-09-19-151000-ab12.png)')
    expect(text).not.toContain('entries/2026/09/assets')
  })

  it('round-trips through parse', () => {
    const parsed = parseDayFile('2026-09-19', serializeDayFile(day))
    expect(parsed).toEqual(day)
  })

  it('ignores a hand-written preamble and tolerates missing time headings', () => {
    const text = [
      '# 2026-09-19',
      '',
      'Some notes someone typed by hand.',
      '',
      '<!-- devlog:entry id=zzzzzzzz created=2026-09-19T01:00:00.000Z -->',
      'No heading here',
      '',
      '### 03:00',
      '',
      'a user heading that looks like a time, kept because it is not first',
      '<!-- devlog:entry id=yyyyyyyy created=2026-09-19T00:30:00.000Z -->',
      '### 00:30',
      '',
      'earlier entry, kept in file order',
      ''
    ].join('\n')
    const parsed = parseDayFile('2026-09-19', text)
    expect(parsed.entries.map((e) => e.id)).toEqual(['zzzzzzzz', 'yyyyyyyy'])
    expect(parsed.entries[0].markdown).toBe('No heading here\n\n### 03:00\n\na user heading that looks like a time, kept because it is not first')
    expect(parsed.entries[1].markdown).toBe('earlier entry, kept in file order')
  })

  it('handles CRLF files', () => {
    const text = serializeDayFile(day).replace(/\n/g, '\r\n')
    expect(parseDayFile('2026-09-19', text)).toEqual(day)
  })

  it('assigns ids to markers that lack one', () => {
    const parsed = parseDayFile('2026-09-19', '<!-- devlog:entry created=2026-09-19T01:00:00.000Z -->\nhi\n')
    expect(parsed.entries[0].id).toMatch(/^[a-z0-9]{8}$/)
  })
})

describe('previewText', () => {
  it('strips markdown syntax', () => {
    expect(previewText('# Title\n\nSome **bold** and ![img](x.png) and `code` [link](http://x)')).toBe(
      'Title Some bold and [image] and code link'
    )
  })
})

describe('threads and ordering', () => {
  const e = (id: string, parentId?: string): Entry => ({ id, createdAt: `2026-09-19T0${id.length}:00:00.000Z`, markdown: id, ...(parentId ? { parentId } : {}) })
  const base: Entry[] = [e('a'), e('aa', 'a'), e('aaa', 'aa'), e('b'), e('bb', 'b'), e('c')]

  it('builds a tree in file order', () => {
    const roots = buildTree(base)
    expect(roots.map((r) => r.entry.id)).toEqual(['a', 'b', 'c'])
    expect(roots[0].children.map((c) => c.entry.id)).toEqual(['aa'])
    expect(roots[0].children[0].children[0].entry.id).toBe('aaa')
    expect(roots[0].children[0].children[0].depth).toBe(2)
  })

  it('computes depth and descendants', () => {
    expect(depthOf(base, 'aaa')).toBe(2)
    expect(depthOf(base, 'c')).toBe(0)
    expect([...descendantIds(base, 'a')].sort()).toEqual(['aa', 'aaa'])
    expect(subtreeEndIndex(base, 'a')).toBe(2)
    expect(subtreeEndIndex(base, 'c')).toBe(5)
  })

  it('appends a reply at the end of its thread', () => {
    const out = insertEntry(base, e('x'), { parentId: 'a' })
    expect(out.map((x) => x.id)).toEqual(['a', 'aa', 'aaa', 'x', 'b', 'bb', 'c'])
    expect(out[3].parentId).toBe('a')
  })

  it('inserts a sibling after a whole thread', () => {
    const out = insertEntry(base, e('x'), { afterId: 'a' })
    expect(out.map((x) => x.id)).toEqual(['a', 'aa', 'aaa', 'x', 'b', 'bb', 'c'])
    expect(out[3].parentId).toBeUndefined()
  })

  it('inserts before a note, inheriting its parent', () => {
    expect(insertEntry(base, e('x'), { beforeId: 'a' }).map((x) => x.id)[0]).toBe('x')
    const out = insertEntry(base, e('x'), { beforeId: 'bb' })
    expect(out.map((x) => x.id)).toEqual(['a', 'aa', 'aaa', 'b', 'x', 'bb', 'c'])
    expect(out[4].parentId).toBe('b')
  })

  it('appends to the end by default and rejects unknown anchors', () => {
    expect(insertEntry(base, e('x')).map((x) => x.id).at(-1)).toBe('x')
    expect(() => insertEntry(base, e('x'), { afterId: 'nope' })).toThrow(/not found/)
  })

  it('removes a subtree', () => {
    expect(removeSubtree(base, 'a').map((x) => x.id)).toEqual(['b', 'bb', 'c'])
    expect(removeSubtree(base, 'bb').map((x) => x.id)).toEqual(['a', 'aa', 'aaa', 'b', 'c'])
  })

  it('serialises replies with parent links and parses them back in order', () => {
    const day: Day = { date: '2026-09-19', entries: base }
    const text = serializeDayFile(day)
    expect(text).toContain('<!-- devlog:add id=aa parent=a pos=a0 at=')
    expect(text).toContain('<!-- devlog:add id=aaa parent=aa pos=a0 at=')
    const parsed = parseDayFile('2026-09-19', text)
    expect(parsed.entries).toEqual(base)
  })

  it('keeps file order rather than sorting by time', () => {
    const later = e('late')
    later.createdAt = '2026-09-19T23:00:00.000Z'
    const early = e('early')
    early.createdAt = '2026-09-19T01:00:00.000Z'
    const parsed = parseDayFile('2026-09-19', serializeDayFile({ date: '2026-09-19', entries: [later, early] }))
    expect(parsed.entries.map((x) => x.id)).toEqual(['late', 'early'])
  })

  it('round-trips system entries with kind and meta attributes', () => {
    const day: Day = {
      date: '2026-09-19',
      entries: [
        { id: 'c1', createdAt: '2026-09-19T10:00:00.000Z', markdown: '⎇ **proj** · `abc1234` — Fix', kind: 'commit', meta: { repo: 'C:\\src\\my proj', hash: 'abc1234def', branch: 'main' } }
      ]
    }
    const text = serializeDayFile(day)
    expect(text).toContain('kind=commit repo="C:\\src\\my proj" hash=abc1234def branch=main')
    expect(parseDayFile('2026-09-19', text).entries).toEqual(day.entries)
  })

  it('drops dangling parent links', () => {
    const parsed = parseDayFile('2026-09-19', '<!-- devlog:entry id=zz parent=gone created=2026-09-19T01:00:00.000Z -->\nhi\n')
    expect(parsed.entries[0].parentId).toBeUndefined()
  })
})

describe('hidden blocks and reordering', () => {
  const e = (id: string, parentId?: string, extra: Partial<Entry> = {}): Entry => ({ id, createdAt: '2026-09-19T09:00:00.000Z', markdown: id, ...(parentId ? { parentId } : {}), ...extra })

  it('round-trips the hidden flag', () => {
    const day: Day = { date: '2026-09-19', entries: [e('a', undefined, { hidden: true }), e('b')] }
    const text = serializeDayFile(day)
    expect(text).toContain('id=a pos=a0 at=2026-09-19T09:00:00.000Z hidden=1')
    const back = parseDayFile('2026-09-19', text)
    expect(back.entries.map((x) => [x.id, x.hidden ?? false])).toEqual([['a', true], ['b', false]])
  })

  it('moves a thread within the day without touching timestamps', () => {
    const list = [e('a'), e('a1', 'a'), e('b'), e('c'), e('c1', 'c')]
    expect(moveSubtree(list, 'a', { afterId: 'b' }).map((x) => x.id)).toEqual(['b', 'a', 'a1', 'c', 'c1'])
    expect(moveSubtree(list, 'c', { beforeId: 'a' }).map((x) => x.id)).toEqual(['c', 'c1', 'a', 'a1', 'b'])
    // Dropping next to a reply lands beside the reply's root.
    expect(moveSubtree(list, 'b', { afterId: 'c1' }).map((x) => x.id)).toEqual(['a', 'a1', 'c', 'c1', 'b'])
    expect(moveSubtree(list, 'b', { beforeId: 'a1' }).map((x) => x.id)).toEqual(['b', 'a', 'a1', 'c', 'c1'])
    // No-ops and errors.
    expect(moveSubtree(list, 'a', { afterId: 'a1' })).toBe(list)
    expect(() => moveSubtree(list, 'a1', { afterId: 'b' })).toThrow(/top-level/)
    expect(() => moveSubtree(list, 'a', { afterId: 'zz' })).toThrow(/not found/)
    expect(moveSubtree(list, 'a', { afterId: 'b' })[1].createdAt).toBe('2026-09-19T09:00:00.000Z')
  })
})

describe('pasting todos', () => {
  it('splits lines and strips list markers', () => {
    expect(splitTodoLines('- [ ] Send Dana the list\n* check CDN\n\n1. renew cert\n2) call Priya\n[x] done thing\n• bullet\nplain line')).toEqual([
      'Send Dana the list',
      'check CDN',
      'renew cert',
      'call Priya',
      'done thing',
      'bullet',
      'plain line'
    ])
    expect(splitTodoLines('- first item\n  continues here\n- second')).toEqual(['first item continues here', 'second'])
    expect(splitTodoLines('  \n')).toEqual([])
  })
})

describe('marker safety', () => {
  const one = (markdown: string): Entry => ({ id: 'aaaaaaaa', createdAt: '2026-09-19T14:32:00.000Z', markdown })
  const roundTrip = (markdown: string): string[] => parseDayFile('2026-09-19', serializeDayFile({ date: '2026-09-19', entries: [one(markdown)] })).entries.map((x) => x.markdown)

  it('keeps a heading that looks like a time as the first line of a block', () => {
    expect(roundTrip('### 09:15\n\nstandup notes')).toEqual(['### 09:15\n\nstandup notes'])
    expect(roundTrip('#### ↳ 10:00')).toEqual(['#### ↳ 10:00'])
  })

  it('never lets block text split a block, inside or outside code fences', () => {
    const tricky = [
      'Pasted from a devlog file:',
      '',
      '<!-- devlog:entry id=zzzzzzzz created=2026-01-01T00:00:00.000Z -->',
      '```',
      '<!-- devlog:entry id=yyyyyyyy created=2026-01-01T00:00:00.000Z -->',
      '<!-- devlog:format 2 -->',
      '```',
      '  <!-- DEVLOG:entry id=x -->',
      '\\<!-- devlog:entry already has a backslash -->',
      '\\\\<!-- devlog:entry two backslashes -->'
    ].join('\n')
    expect(roundTrip(tricky)).toEqual([tricky])
    const text = serializeDayFile({ date: '2026-09-19', entries: [one(tricky)] })
    expect(text.match(/^<!-- devlog:/gm)).toHaveLength(2) // the format header and one record
  })

  it('escapes and unescapes marker-like lines losslessly', () => {
    const samples = ['<!-- devlog:entry x -->', '\\<!-- devlog:x', '   <!--devlog:y', 'plain <!-- devlog:entry mid-line', 'nothing']
    for (const s of samples) expect(unescapeMarkerLines(escapeMarkerLines(s))).toBe(s)
    expect(escapeMarkerLines('plain <!-- devlog:entry mid-line')).toBe('plain <!-- devlog:entry mid-line')
  })

  it('round-trips randomly generated bodies', () => {
    let seed = 42
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const pieces = ['### 09:15', '#### ↳ 10:00', '```', '<!-- devlog:entry id=q created=x -->', '\\<!-- devlog:format 2 -->', '- item', '> quote', 'text with **bold**', '', '   indented', '# 2026-09-19']
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 8)
      const lines = Array.from({ length: n }, () => pieces[Math.floor(rnd() * pieces.length)])
      const body = lines.join('\n').replace(/^\s*\n|\s+$/g, '').replace(/^\n+/, '')
      if (!body.trim()) continue
      expect(roundTrip(body)).toEqual([body.replace(/^(?:[ \t]*\n)+/, '')])
    }
  })

  it('reads v1 files (derived time headings) and tells the formats apart', () => {
    const v1 = '# 2026-09-19\n\n<!-- devlog:entry id=aaaaaaaa created=2026-09-19T14:32:00.000Z -->\n### 14:32\n\nhello\n'
    expect(blockFileFormat(v1)).toBe(1)
    expect(parseDayFile('2026-09-19', v1).entries.map((x) => x.markdown)).toEqual(['hello'])
    const v3 = serializeDayFile(parseDayFile('2026-09-19', v1))
    expect(blockFileFormat(v3)).toBe(3)
    expect(v3).not.toContain('### 14:32')
    const v2 = '<!-- devlog:format 2 -->\n# 2026-09-19\n\n<!-- devlog:entry id=aaaaaaaa created=2026-09-19T14:32:00.000Z -->\n### 14:32\n\n\\<!-- devlog:entry kept -->\n'
    expect(blockFileFormat(v2)).toBe(2)
    expect(parseDayFile('2026-09-19', v2).entries.map((x) => x.markdown)).toEqual(['### 14:32\n\n<!-- devlog:entry kept -->'])
  })
})
