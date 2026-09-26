import { describe, expect, it } from 'vitest'
import {
  ancestorIds,
  buildCanvasTree,
  canvasDir,
  canvasEntriesBase,
  canvasLabel,
  canvasPath,
  descendantCanvasIds,
  flattenTree,
  isValidCanvasId,
  isWithin,
  newCanvasId,
  parseCanvasFile,
  serializeCanvasFile
} from '../src/format/canvases'
import { hasTaskTag, stripTaskTag, titleFromMarkdown } from '../src/format/blocks'
import type { CanvasMeta } from '../src/types'

const c = (id: string, title: string, parentId: string | null = null, extra: Partial<CanvasMeta> = {}): CanvasMeta => ({
  id,
  title,
  parentId,
  task: false,
  createdAt: '',
  updatedAt: '',
  repos: [],
  archived: false,
  hasSurface: false,
  ...extra
})

describe('canvases', () => {
  it('validates ids and maps bases', () => {
    expect(isValidCanvasId('journal')).toBe(true)
    expect(isValidCanvasId('acme-corp')).toBe(true)
    expect(isValidCanvasId('../etc')).toBe(false)
    expect(isValidCanvasId('Acme')).toBe(false)
    expect(canvasEntriesBase('journal')).toBe('entries')
    expect(canvasEntriesBase('acme')).toBe('canvases/ac/acme/entries')
    expect(canvasDir('k3m9x2q7vd')).toBe('canvases/k3/k3m9x2q7vd')
  })

  it('makes random ids from the unambiguous alphabet', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const id = newCanvasId()
      expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{10}$/)
      expect(isValidCanvasId(id)).toBe(true)
      seen.add(id)
    }
    expect(seen.size).toBe(500)
    expect(newCanvasId(() => 0)).toBe('0000000000')
    expect(newCanvasId(() => 0.9999)).toBe('zzzzzzzzzz')
  })

  it('round-trips aliases in canvas.md', () => {
    const meta = { ...parseCanvasFile('k3m9x2q7vd', '---\ntitle: Acme\nalias: acme-corp\nalias: acme\nalias: Bad Alias\n---\n').meta }
    expect(meta.aliases).toEqual(['acme-corp', 'acme'])
    const text = serializeCanvasFile(meta, '')
    expect(text).toContain('alias: acme-corp\nalias: acme\n')
    expect(parseCanvasFile('k3m9x2q7vd', text).meta.aliases).toEqual(['acme-corp', 'acme'])
  })

  it('round-trips canvas.md with front matter and surface', () => {
    const meta: CanvasMeta = {
      id: 'website',
      title: 'Website: relaunch',
      parentId: 'acme-corp',
      task: true,
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
      repos: ['C:\\src\\acme', '/home/me/src/acme site'],
      archived: true,
      hasSurface: true
    }
    const text = serializeCanvasFile(meta, '# Links\n\n- [Tracker](https://x)')
    expect(text).toBe(
      '---\ntitle: "Website: relaunch"\nparent: acme-corp\ntask: true\ncreated: 2026-09-19T10:00:00.000Z\nupdated: 2026-09-20T10:00:00.000Z\nrepo: "C:\\\\src\\\\acme"\nrepo: /home/me/src/acme site\narchived: true\n---\n\n# Links\n\n- [Tracker](https://x)\n'
    )
    const parsed = parseCanvasFile('website', text)
    expect(parsed.meta).toEqual(meta)
    expect(parsed.surface).toBe('# Links\n\n- [Tracker](https://x)')
  })

  it('tolerates a missing or partial front matter', () => {
    expect(parseCanvasFile('x', 'just a surface')).toEqual({
      meta: { id: 'x', title: 'x', parentId: null, task: false, createdAt: '', updatedAt: '', repos: [], archived: false, hasSurface: true },
      surface: 'just a surface'
    })
    expect(parseCanvasFile('x', '---\ntitle: Hi\nparent: x\n---\n').meta).toMatchObject({ title: 'Hi', parentId: null, hasSurface: false })
  })

  it('walks the hierarchy', () => {
    const all = [c('journal', 'Journal'), c('acme', 'Acme Corp'), c('web', 'Website', 'acme'), c('fix', 'Fix login', 'web', { task: true }), c('globex', 'Globex'), c('gweb', 'Website', 'globex')]
    expect(canvasPath(all, 'fix')).toEqual(['Acme Corp', 'Website', 'Fix login'])
    expect(canvasLabel(all, 'gweb')).toBe('Globex / Website')
    expect(canvasLabel(all, 'journal')).toBe('Journal')
    expect(canvasLabel(all, 'missing')).toBe('missing')
    expect(ancestorIds(all, 'fix')).toEqual(['web', 'acme'])
    expect(descendantCanvasIds(all, 'acme').sort()).toEqual(['fix', 'web'])
    expect(isWithin(all, 'fix', 'acme')).toBe(true)
    expect(isWithin(all, 'gweb', 'acme')).toBe(false)
    expect(isWithin(all, 'acme', 'acme')).toBe(true)
  })

  it('builds a tree: non-tasks before tasks, sorted by title, archived hidden unless asked', () => {
    const all = [
      c('journal', 'Journal'),
      c('zed', 'Zed', null, { task: true }),
      c('acme', 'Acme Corp'),
      c('mobile', 'Mobile', 'acme'),
      c('web', 'Web', 'acme'),
      c('fix', 'Fix login', 'web', { task: true }),
      c('old', 'Old', 'acme', { archived: true }),
      c('orphan', 'Orphan', 'gone')
    ]
    const tree = buildCanvasTree(all)
    expect(tree.map((n) => n.canvas.id)).toEqual(['acme', 'orphan', 'zed'])
    expect(tree[0].children.map((n) => n.canvas.id)).toEqual(['mobile', 'web'])
    expect(tree[0].children[1].children[0].canvas.id).toBe('fix')
    expect(flattenTree(tree).map((x) => `${x.canvas.id}@${x.depth}`)).toEqual(['acme@0', 'mobile@1', 'web@1', 'fix@2', 'orphan@0', 'zed@0'])
    expect(buildCanvasTree(all, { includeArchived: true })[0].children.map((n) => n.canvas.id)).toEqual(['mobile', 'old', 'web'])
  })

})

describe('task tags and titles', () => {
  it('detects and strips #task on the first line', () => {
    expect(hasTaskTag('#task Fix the login redirect')).toBe(true)
    expect(hasTaskTag('Fix the login redirect #task')).toBe(true)
    expect(hasTaskTag('Fix the login \\#task redirect')).toBe(true)
    expect(hasTaskTag('Look at #tasks later')).toBe(false)
    expect(hasTaskTag('first line\n#task second')).toBe(false)
    expect(stripTaskTag('#task Fix the login redirect')).toBe('Fix the login redirect')
    expect(stripTaskTag('Fix the login redirect #task\n\nmore')).toBe('Fix the login redirect\n\nmore')
    expect(stripTaskTag('Fix \\#task it')).toBe('Fix it')
  })

  it('titles a task from the first sentence', () => {
    expect(titleFromMarkdown('#task **Fix** the login redirect. It loops on Safari.\n\nDetails')).toBe('Fix the login redirect')
    expect(titleFromMarkdown('[45m] Retro with the team')).toBe('Retro with the team')
    expect(titleFromMarkdown('')).toBe('Task')
    const long = titleFromMarkdown('a'.repeat(30) + ' ' + 'b'.repeat(70))
    expect(long.length).toBeLessThanOrEqual(82)
    expect(long.endsWith('…')).toBe(true)
  })
})
