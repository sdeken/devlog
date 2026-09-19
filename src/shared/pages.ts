/**
 * Pages: independent streams of notes stored under `pages/<slug>/`.
 *
 *   pages/acme/page.md                 ← metadata (front matter) + description
 *   pages/acme/entries/2026/09/…       ← day files, same format as the journal
 *
 * The journal is the built-in page at the repository root (`entries/`).
 */
import type { PageMeta, WikiMeta } from './types'

export const JOURNAL_PAGE_ID = 'journal'
export const PAGES_DIR = 'pages'
export const PAGE_FILE = 'page.md'
export const CATEGORIES_DIR = 'categories'
export const WIKI_FILE = 'wiki.md'

export const JOURNAL_PAGE: PageMeta = {
  id: JOURNAL_PAGE_ID,
  title: 'Journal',
  category: '',
  description: '',
  createdAt: '1970-01-01T00:00:00.000Z',
  repos: [],
  archived: false
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

/** Split a category string like "Acme Corp / Website" into trimmed segments. */
export function categoryPath(category: string): string[] {
  return category
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function formatCategory(segments: string[]): string {
  return segments.join(' / ')
}

/** Normalise a user-typed category to the canonical "A / B" form. */
export function normalizeCategory(category: string): string {
  return formatCategory(categoryPath(category))
}

/** True when `path` equals `prefix` or lies beneath it (segments compared case-insensitively). */
export function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (prefix.length === 0 || prefix.length > path.length) return prefix.length === 0
  return prefix.every((seg, i) => seg.toLowerCase() === path[i].toLowerCase())
}

export function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && pathStartsWith(a, b)
}

/** Repo-relative directory holding a category's wiki and assets. */
export function categoryDir(path: string[]): string {
  return `${CATEGORIES_DIR}/${path.map(slugify).join('/')}`
}

export interface CategoryNode {
  /** Last segment, e.g. "Website". */
  name: string
  /** Full path segments, e.g. ["Acme Corp", "Website"]. */
  path: string[]
  pages: PageMeta[]
  children: CategoryNode[]
}

/**
 * Nest pages by their category path. The journal is never included. Pages
 * without a category are returned separately as `uncategorised`.
 * `extraPaths` (e.g. categories that only have a wiki) become nodes too.
 */
export function buildCategoryTree(pages: PageMeta[], extraPaths: string[][] = []): { roots: CategoryNode[]; uncategorised: PageMeta[] } {
  const rootMap = new Map<string, CategoryNode>()
  const uncategorised: PageMeta[] = []
  const byTitle = (a: PageMeta, b: PageMeta): number => a.title.localeCompare(b.title)
  const ensure = (segments: string[]): CategoryNode | undefined => {
    let level = rootMap
    let node: CategoryNode | undefined
    const path: string[] = []
    for (const seg of segments) {
      path.push(seg)
      const key = seg.toLowerCase()
      let next = level.get(key)
      if (!next) {
        next = { name: seg, path: [...path], pages: [], children: [] }
        level.set(key, next)
        if (node) node.children.push(next)
      }
      node = next
      level = childMap(next)
    }
    return node
  }
  for (const page of pages) {
    if (page.id === JOURNAL_PAGE_ID) continue
    const segments = categoryPath(page.category)
    if (segments.length === 0) {
      uncategorised.push(page)
      continue
    }
    ensure(segments)!.pages.push(page)
  }
  for (const extra of extraPaths) if (extra.length > 0) ensure(extra)
  const finish = (nodes: CategoryNode[]): CategoryNode[] =>
    nodes
      .map((n) => ({ ...n, pages: [...n.pages].sort(byTitle), children: finish(n.children) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  return { roots: finish([...rootMap.values()]), uncategorised: uncategorised.sort(byTitle) }
}

const childMaps = new WeakMap<CategoryNode, Map<string, CategoryNode>>()
function childMap(node: CategoryNode): Map<string, CategoryNode> {
  let m = childMaps.get(node)
  if (!m) {
    m = new Map()
    childMaps.set(node, m)
  }
  return m
}

/** Every distinct category path and prefix in use, for suggestions. */
export function categorySuggestions(pages: PageMeta[]): string[] {
  const out = new Set<string>()
  for (const p of pages) {
    const segs = categoryPath(p.category)
    for (let i = 1; i <= segs.length; i++) out.add(formatCategory(segs.slice(0, i)))
  }
  return [...out].sort((a, b) => a.localeCompare(b))
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
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1)
  return t
}

function quote(v: string): string {
  return /[:#"'\\\n]|^\s|\s$/.test(v) || v === '' ? JSON.stringify(v) : v
}

/** Split simple `key: value` front matter from a markdown body. Repeated keys collect in order. */
export function parseFrontMatter(text: string): { fields: Array<[string, string]>; body: string } {
  const fields: Array<[string, string]> = []
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { fields, body: text }
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) fields.push([kv[1].toLowerCase(), unquote(kv[2])])
  }
  return { fields, body: text.slice(m[0].length) }
}

const isTrue = (v: string): boolean => /^(true|yes|1)$/i.test(v.trim())

/** Parse `page.md`: simple `key: value` front matter followed by a markdown description. */
export function parsePageFile(id: string, text: string): PageMeta {
  const meta: PageMeta = { id, title: id, category: '', description: '', createdAt: '', repos: [], archived: false }
  const { fields, body } = parseFrontMatter(text)
  for (const [key, value] of fields) {
    switch (key) {
      case 'title':
        meta.title = value || id
        break
      case 'category':
        meta.category = value
        break
      case 'created':
        meta.createdAt = value
        break
      case 'repo':
        if (value) meta.repos.push(value)
        break
      case 'archived':
        meta.archived = isTrue(value)
        break
    }
  }
  meta.description = body.trim()
  return meta
}

export function serializePageFile(meta: PageMeta): string {
  const lines = ['---', `title: ${quote(meta.title)}`]
  if (meta.category) lines.push(`category: ${quote(meta.category)}`)
  lines.push(`created: ${meta.createdAt}`)
  for (const r of meta.repos) lines.push(`repo: ${quote(r)}`)
  if (meta.archived) lines.push('archived: true')
  lines.push('---', '')
  if (meta.description.trim()) lines.push(meta.description.trim(), '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Category wikis
// ---------------------------------------------------------------------------

/** Parse `wiki.md`. `fallbackPath` is used when the front matter lacks one. */
export function parseWikiFile(text: string, fallbackPath: string[]): { meta: WikiMeta; markdown: string } {
  const { fields, body } = parseFrontMatter(text)
  const meta: WikiMeta = { path: fallbackPath, archived: false, updatedAt: '' }
  for (const [key, value] of fields) {
    if (key === 'path' && categoryPath(value).length > 0) meta.path = categoryPath(value)
    else if (key === 'archived') meta.archived = isTrue(value)
    else if (key === 'updated') meta.updatedAt = value
  }
  return { meta, markdown: body.replace(/^\s*\n/, '').replace(/\s+$/, '') }
}

export function serializeWikiFile(meta: WikiMeta, markdown: string): string {
  const lines = ['---', `path: ${quote(formatCategory(meta.path))}`]
  if (meta.updatedAt) lines.push(`updated: ${meta.updatedAt}`)
  if (meta.archived) lines.push('archived: true')
  lines.push('---', '')
  const body = markdown.replace(/\s+$/, '')
  if (body) lines.push(body, '')
  return lines.join('\n')
}
