/**
 * Canvases: the one container type in a devlog.
 *
 * A canvas is a client, a project, a task, a topic — anything you want to
 * write about. Every canvas has a *surface* (free-form markdown: links,
 * how-tos, credentials, a research scratchpad) and a *stream* of blocks
 * (dated posts). Canvases nest through `parentId`. A canvas flagged `task`
 * is something time is tracked against.
 *
 *   canvases/<id>/canvas.md            ← front matter + the surface markdown
 *   canvases/<id>/entries/2026/09/…    ← the stream, one day file per day
 *   canvases/<id>/assets/              ← images pasted into the surface
 *
 * The journal is the built-in root canvas whose stream lives at `entries/`.
 */
import type { CanvasMeta } from './types'

export const JOURNAL_ID = 'journal'
export const CANVASES_DIR = 'canvases'
export const CANVAS_FILE = 'canvas.md'

export const JOURNAL: CanvasMeta = {
  id: JOURNAL_ID,
  title: 'Journal',
  parentId: null,
  task: false,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '',
  repos: [],
  archived: false,
  hasSurface: false
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidCanvasId(id: string): boolean {
  return id === JOURNAL_ID || SLUG_RE.test(id)
}

/** Repo-relative directory of a canvas (never for the journal). */
export function canvasDir(id: string): string {
  return `${CANVASES_DIR}/${id}`
}

/** Repo-relative directory holding a canvas's day files. */
export function canvasEntriesBase(id: string): string {
  return id === JOURNAL_ID ? 'entries' : `${canvasDir(id)}/entries`
}

/** Repo-relative path of a canvas's metadata + surface file (never for the journal). */
export function canvasFilePath(id: string): string {
  return `${canvasDir(id)}/${CANVAS_FILE}`
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
  return slug || 'canvas'
}

// ---------------------------------------------------------------------------
// Hierarchy helpers (pure, over a list of canvases)
// ---------------------------------------------------------------------------

export interface CanvasNode {
  canvas: CanvasMeta
  children: CanvasNode[]
}

/** Titles from the top-level ancestor down to the canvas itself. Journal → ["Journal"]. */
export function canvasPath(canvases: CanvasMeta[], id: string): string[] {
  const byId = new Map(canvases.map((c) => [c.id, c]))
  const out: string[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  if (!cur) return [id]
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    out.unshift(cur.title)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return out
}

/** "Acme Corp / Website / Fix login" */
export function canvasLabel(canvases: CanvasMeta[], id: string): string {
  return canvasPath(canvases, id).join(' / ')
}

/** Ids of every ancestor, nearest first. */
export function ancestorIds(canvases: CanvasMeta[], id: string): string[] {
  const byId = new Map(canvases.map((c) => [c.id, c]))
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    out.push(cur.parentId)
    cur = byId.get(cur.parentId)
  }
  return out
}

/** Ids of every canvas beneath `id` (any depth). */
export function descendantCanvasIds(canvases: CanvasMeta[], id: string): string[] {
  const out: string[] = []
  const stack = [id]
  const seen = new Set<string>([id])
  while (stack.length) {
    const cur = stack.pop()!
    for (const c of canvases) {
      if (c.parentId === cur && !seen.has(c.id)) {
        seen.add(c.id)
        out.push(c.id)
        stack.push(c.id)
      }
    }
  }
  return out
}

/** True when `id` is `ancestorId` or lies beneath it. */
export function isWithin(canvases: CanvasMeta[], id: string, ancestorId: string): boolean {
  return id === ancestorId || ancestorIds(canvases, id).includes(ancestorId)
}

/**
 * Nest canvases by `parentId`. The journal is never included; canvases whose
 * parent is missing are treated as top-level. Siblings sort by title, with
 * non-task canvases (clients, projects) before tasks.
 */
export function buildCanvasTree(canvases: CanvasMeta[], opts: { includeArchived?: boolean } = {}): CanvasNode[] {
  const list = canvases.filter((c) => c.id !== JOURNAL_ID && (opts.includeArchived || !c.archived))
  const ids = new Set(list.map((c) => c.id))
  const nodes = new Map<string, CanvasNode>(list.map((c) => [c.id, { canvas: c, children: [] }]))
  const roots: CanvasNode[] = []
  for (const c of list) {
    const node = nodes.get(c.id)!
    const parent = c.parentId && ids.has(c.parentId) && c.parentId !== c.id ? nodes.get(c.parentId)! : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortNodes = (ns: CanvasNode[]): CanvasNode[] =>
    ns
      .map((n) => ({ ...n, children: sortNodes(n.children) }))
      .sort((a, b) => Number(a.canvas.task) - Number(b.canvas.task) || a.canvas.title.localeCompare(b.canvas.title))
  return sortNodes(roots)
}

/** Depth-first flattening of the tree with each node's depth, for pickers. */
export function flattenTree(nodes: CanvasNode[], depth = 0): Array<{ canvas: CanvasMeta; depth: number }> {
  const out: Array<{ canvas: CanvasMeta; depth: number }> = []
  for (const n of nodes) {
    out.push({ canvas: n.canvas, depth })
    out.push(...flattenTree(n.children, depth + 1))
  }
  return out
}

// ---------------------------------------------------------------------------
// canvas.md
// ---------------------------------------------------------------------------

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

/** Parse `canvas.md`: front matter followed by the surface markdown (paths as stored, i.e. file-relative). */
export function parseCanvasFile(id: string, text: string): { meta: CanvasMeta; surface: string } {
  const meta: CanvasMeta = { id, title: id, parentId: null, task: false, createdAt: '', updatedAt: '', repos: [], archived: false, hasSurface: false }
  const { fields, body } = parseFrontMatter(text)
  for (const [key, value] of fields) {
    switch (key) {
      case 'title':
        meta.title = value || id
        break
      case 'parent':
        meta.parentId = value && isValidCanvasId(value) && value !== id ? value : null
        break
      case 'task':
        meta.task = isTrue(value)
        break
      case 'created':
        meta.createdAt = value
        break
      case 'updated':
        meta.updatedAt = value
        break
      case 'repo':
        if (value) meta.repos.push(value)
        break
      case 'archived':
        meta.archived = isTrue(value)
        break
    }
  }
  const surface = body.replace(/^\s*\n/, '').replace(/\s+$/, '')
  meta.hasSurface = surface.length > 0
  return { meta, surface }
}

export function serializeCanvasFile(meta: CanvasMeta, surface: string): string {
  const lines = ['---', `title: ${quote(meta.title)}`]
  if (meta.parentId) lines.push(`parent: ${meta.parentId}`)
  if (meta.task) lines.push('task: true')
  lines.push(`created: ${meta.createdAt}`)
  if (meta.updatedAt) lines.push(`updated: ${meta.updatedAt}`)
  for (const r of meta.repos) lines.push(`repo: ${quote(r)}`)
  if (meta.archived) lines.push('archived: true')
  lines.push('---', '')
  const body = surface.replace(/\s+$/, '')
  if (body) lines.push(body, '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Legacy layout (pages/ + categories/), read only for migration
// ---------------------------------------------------------------------------

export const LEGACY_PAGES_DIR = 'pages'
export const LEGACY_CATEGORIES_DIR = 'categories'

export interface LegacyPage {
  id: string
  title: string
  /** "Acme Corp / Web" */
  category: string
  description: string
  createdAt: string
  repos: string[]
  archived: boolean
}

/** Split a category string like "Acme Corp / Website" into trimmed segments. */
export function categoryPath(category: string): string[] {
  return category
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseLegacyPageFile(id: string, text: string): LegacyPage {
  const meta: LegacyPage = { id, title: id, category: '', description: '', createdAt: '', repos: [], archived: false }
  const { fields, body } = parseFrontMatter(text)
  for (const [key, value] of fields) {
    if (key === 'title') meta.title = value || id
    else if (key === 'category') meta.category = value
    else if (key === 'created') meta.createdAt = value
    else if (key === 'repo' && value) meta.repos.push(value)
    else if (key === 'archived') meta.archived = isTrue(value)
  }
  meta.description = body.trim()
  return meta
}

export function parseLegacyWikiFile(text: string, fallbackPath: string[]): { path: string[]; archived: boolean; updatedAt: string; markdown: string } {
  const { fields, body } = parseFrontMatter(text)
  let p = fallbackPath
  let archived = false
  let updatedAt = ''
  for (const [key, value] of fields) {
    if (key === 'path' && categoryPath(value).length > 0) p = categoryPath(value)
    else if (key === 'archived') archived = isTrue(value)
    else if (key === 'updated') updatedAt = value
  }
  return { path: p, archived, updatedAt, markdown: body.replace(/^\s*\n/, '').replace(/\s+$/, '') }
}

/** Id a legacy category path maps to: "Acme Corp / Web" → acme-corp-web. */
export function legacyCategoryId(path: string[]): string {
  return slugify(path.join(' '))
}
