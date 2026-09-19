/**
 * Pages: independent streams of notes stored under `pages/<slug>/`.
 *
 *   pages/acme/page.md                 ← metadata (front matter) + description
 *   pages/acme/entries/2026/09/…       ← day files, same format as the journal
 *
 * The journal is the built-in page at the repository root (`entries/`).
 */
import type { PageMeta } from './types'

export const JOURNAL_PAGE_ID = 'journal'
export const PAGES_DIR = 'pages'
export const PAGE_FILE = 'page.md'

export const JOURNAL_PAGE: PageMeta = {
  id: JOURNAL_PAGE_ID,
  title: 'Journal',
  category: '',
  description: '',
  createdAt: '1970-01-01T00:00:00.000Z'
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidPageId(id: string): boolean {
  return id === JOURNAL_PAGE_ID || SLUG_RE.test(id)
}

/** Repo-relative directory holding a page's day files. */
export function pageEntriesBase(pageId: string): string {
  return pageId === JOURNAL_PAGE_ID ? 'entries' : `${PAGES_DIR}/${pageId}/entries`
}

/** Repo-relative path of a page's metadata file (never for the journal). */
export function pageFilePath(pageId: string): string {
  return `${PAGES_DIR}/${pageId}/${PAGE_FILE}`
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || 'page'
}

function unquote(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

function quote(v: string): string {
  return /[:#"'\n]|^\s|\s$/.test(v) || v === '' ? JSON.stringify(v) : v
}

/** Parse `page.md`: simple `key: value` front matter followed by a markdown description. */
export function parsePageFile(id: string, text: string): PageMeta {
  const meta: PageMeta = { id, title: id, category: '', description: '', createdAt: '' }
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (!kv) continue
      const value = unquote(kv[2])
      switch (kv[1].toLowerCase()) {
        case 'title':
          meta.title = value || id
          break
        case 'category':
          meta.category = value
          break
        case 'created':
          meta.createdAt = value
          break
      }
    }
    body = text.slice(m[0].length)
  }
  meta.description = body.trim()
  return meta
}

export function serializePageFile(meta: PageMeta): string {
  const lines = ['---', `title: ${quote(meta.title)}`]
  if (meta.category) lines.push(`category: ${quote(meta.category)}`)
  lines.push(`created: ${meta.createdAt}`, '---', '')
  if (meta.description.trim()) lines.push(meta.description.trim(), '')
  return lines.join('\n')
}

/** Group pages by category for display; the journal is never included. */
export function groupPages(pages: PageMeta[]): Array<{ category: string; pages: PageMeta[] }> {
  const groups = new Map<string, PageMeta[]>()
  for (const p of pages) {
    if (p.id === JOURNAL_PAGE_ID) continue
    const key = p.category.trim()
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
  return sorted.map(([category, list]) => ({
    category,
    pages: [...list].sort((a, b) => a.title.localeCompare(b.title))
  }))
}
