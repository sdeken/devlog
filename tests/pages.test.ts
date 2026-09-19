import { describe, expect, it } from 'vitest'
import { buildCategoryTree, categoryPath, categorySuggestions, isValidPageId, normalizeCategory, pageEntriesBase, parsePageFile, serializePageFile, slugify } from '../src/shared/pages'
import type { PageMeta } from '../src/shared/types'

describe('pages', () => {
  it('slugifies titles', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp')
    expect(slugify('  Ünïcödé & Co. ')).toBe('unicode-co')
    expect(slugify('!!!')).toBe('page')
  })

  it('validates ids and maps bases', () => {
    expect(isValidPageId('journal')).toBe(true)
    expect(isValidPageId('acme-corp')).toBe(true)
    expect(isValidPageId('../etc')).toBe(false)
    expect(isValidPageId('Acme')).toBe(false)
    expect(pageEntriesBase('journal')).toBe('entries')
    expect(pageEntriesBase('acme')).toBe('pages/acme/entries')
  })

  it('round-trips page.md with front matter', () => {
    const meta: PageMeta = {
      id: 'acme',
      title: 'Acme: Corp',
      category: 'Clients',
      description: 'Big **client**.\n\n- retainer',
      createdAt: '2026-09-19T10:00:00.000Z',
      repos: ['C:\\src\\acme', '/home/me/src/acme site']
    }
    const text = serializePageFile(meta)
    expect(text.startsWith('---\ntitle: "Acme: Corp"\ncategory: Clients\ncreated: 2026-09-19T10:00:00.000Z\nrepo: "C:\\\\src\\\\acme"\nrepo: /home/me/src/acme site\n---\n')).toBe(true)
    expect(parsePageFile('acme', text)).toEqual(meta)
  })

  it('tolerates a missing or partial front matter', () => {
    expect(parsePageFile('x', 'just a description')).toEqual({ id: 'x', title: 'x', category: '', description: 'just a description', createdAt: '', repos: [] })
    expect(parsePageFile('x', '---\ntitle: Hi\n---\n')).toMatchObject({ title: 'Hi', description: '' })
  })

  it('parses and normalises category paths', () => {
    expect(categoryPath(' Acme Corp /Website/ ')).toEqual(['Acme Corp', 'Website'])
    expect(categoryPath('')).toEqual([])
    expect(normalizeCategory('acme//web /')).toBe('acme / web')
  })

  it('builds a category tree with nested projects and uncategorised pages last', () => {
    const p = (id: string, title: string, category: string): PageMeta => ({ id, title, category, description: '', createdAt: '', repos: [] })
    const tree = buildCategoryTree([
      p('journal', 'Journal', ''),
      p('zed', 'Zed', ''),
      p('acme-web', 'Website', 'Acme Corp / Web'),
      p('acme-app', 'App', 'Acme Corp / Mobile'),
      p('acme-general', 'General', 'Acme Corp'),
      p('globex-web', 'Website', 'Globex / Web')
    ])
    expect(tree.roots.map((r) => r.name)).toEqual(['Acme Corp', 'Globex'])
    const acme = tree.roots[0]
    expect(acme.pages.map((x) => x.id)).toEqual(['acme-general'])
    expect(acme.children.map((c) => c.path.join('/'))).toEqual(['Acme Corp/Mobile', 'Acme Corp/Web'])
    expect(acme.children[1].pages[0].id).toBe('acme-web')
    expect(tree.roots[1].children[0].pages[0].id).toBe('globex-web')
    expect(tree.uncategorised.map((x) => x.id)).toEqual(['zed'])
    expect(categorySuggestions([p('a', 'A', 'Acme Corp / Web'), p('b', 'B', 'Globex')])).toEqual(['Acme Corp', 'Acme Corp / Web', 'Globex'])
  })
})
