import { describe, expect, it } from 'vitest'
import {
  collectImageSrcs,
  dayFilePath,
  localDate,
  parseDayFile,
  previewText,
  relativePosix,
  rewriteImageSrcs,
  serializeDayFile,
  toDayRelative,
  toRootRelative
} from '../src/shared/entries'
import type { Day } from '../src/shared/types'

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
    expect(text.startsWith('# 2026-09-19\n\n<!-- devlog:entry id=aaaaaaaa created=2026-09-19T14:32:00.000Z -->\n### ')).toBe(true)
    expect(text).toContain('<!-- devlog:entry id=bbbbbbbb created=2026-09-19T15:10:00.000Z updated=2026-09-19T15:12:00.000Z -->')
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
      'earlier entry, sorted first',
      ''
    ].join('\n')
    const parsed = parseDayFile('2026-09-19', text)
    expect(parsed.entries.map((e) => e.id)).toEqual(['yyyyyyyy', 'zzzzzzzz'])
    expect(parsed.entries[1].markdown).toBe('No heading here\n\n### 03:00\n\na user heading that looks like a time, kept because it is not first')
    expect(parsed.entries[0].markdown).toBe('earlier entry, sorted first')
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
