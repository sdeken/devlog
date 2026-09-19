import { describe, expect, it } from 'vitest'
import { groupPages, isValidPageId, pageEntriesBase, parsePageFile, serializePageFile, slugify } from '../src/shared/pages'
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
      createdAt: '2026-09-19T10:00:00.000Z'
    }
    const text = serializePageFile(meta)
    expect(text.startsWith('---\ntitle: "Acme: Corp"\ncategory: Clients\ncreated: 2026-09-19T10:00:00.000Z\n---\n')).toBe(true)
    expect(parsePageFile('acme', text)).toEqual(meta)
  })

  it('tolerates a missing or partial front matter', () => {
    expect(parsePageFile('x', 'just a description')).toEqual({ id: 'x', title: 'x', category: '', description: 'just a description', createdAt: '' })
    expect(parsePageFile('x', '---\ntitle: Hi\n---\n')).toMatchObject({ title: 'Hi', description: '' })
  })

  it('groups pages by category with uncategorised last', () => {
    const p = (id: string, category: string): PageMeta => ({ id, title: id.toUpperCase(), category, description: '', createdAt: '' })
    const groups = groupPages([p('journal', ''), p('zed', ''), p('acme', 'Clients'), p('app', 'Projects'), p('beta', 'Clients')])
    expect(groups.map((g) => g.category)).toEqual(['Clients', 'Projects', ''])
    expect(groups[0].pages.map((x) => x.id)).toEqual(['acme', 'beta'])
    expect(groups[2].pages.map((x) => x.id)).toEqual(['zed'])
  })
})
