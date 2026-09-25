/**
 * The devlog storage format.
 *
 * Each local calendar day is one markdown file at `entries/YYYY/MM/YYYY-MM-DD.md`.
 * The file reads naturally on GitHub and every post is delimited by an HTML
 * comment marker that carries its metadata:
 *
 *   # 2026-09-19
 *
 *   <!-- devlog:entry id=k3j9d2ab created=2026-09-19T14:32:00.000Z -->
 *   ### 14:32
 *
 *   Post body in markdown…
 *
 *   <!-- devlog:entry id=p0q1r2s3 parent=k3j9d2ab created=2026-09-19T15:02:00.000Z -->
 *   #### ↳ 15:02
 *
 *   A threaded reply. Replies follow their parent; file order is display order.
 *
 * Image references inside a file are relative to that file (so they render on
 * GitHub); in memory they are normalised to repo-root-relative paths so the
 * renderer and asset server can resolve them without knowing which day they
 * belong to.
 */
import { ENTRY_KINDS, type Day, type Entry, type EntryKind, type EntryPosition } from '../types'

export const ENTRIES_DIR = 'entries'
export const ASSETS_DIR = 'assets'

const MARKER_RE = /^<!--\s*devlog:entry\s+([^>]*?)\s*-->\s*$/
const TIME_HEADING_RE = /^#{3,6}\s+(?:↳\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*$/
const TITLE_RE = /^#\s+\d{4}-\d{2}-\d{2}\s*$/

// ---------------------------------------------------------------------------
// Dates & ids
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')

/** Local calendar date `YYYY-MM-DD` of a Date. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local `HH:MM` of a Date. */
export function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

export function newEntryId(random: () => number = Math.random): string {
  let out = ''
  while (out.length < 8) out += Math.floor(random() * 36).toString(36)
  return out
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo-relative POSIX path of a day's markdown file. `base` is the page's entries dir. */
export function dayFilePath(date: string, base: string = ENTRIES_DIR): string {
  const [y, m] = date.split('-')
  return `${base}/${y}/${m}/${date}.md`
}

/** Repo-relative POSIX directory that holds a day's file. */
export function dayDir(date: string, base: string = ENTRIES_DIR): string {
  const [y, m] = date.split('-')
  return `${base}/${y}/${m}`
}

/** Repo-relative POSIX directory for a day's attachments. */
export function assetDir(date: string, base: string = ENTRIES_DIR): string {
  return `${dayDir(date, base)}/${ASSETS_DIR}`
}

/** Parse a `YYYY-MM-DD` out of a day file path, or null. */
export function dateFromFilePath(p: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})\.md$/.exec(p)
  return m && isValidDate(m[1]) ? m[1] : null
}

// ---------------------------------------------------------------------------
// Relative path helpers (POSIX only – these are repo paths, never OS paths)
// ---------------------------------------------------------------------------

function normalizePosix(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') out.push('..')
      else out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

export function joinPosix(dir: string, rel: string): string {
  return normalizePosix(`${dir}/${rel}`)
}

export function relativePosix(fromDir: string, to: string): string {
  const a = normalizePosix(fromDir).split('/').filter(Boolean)
  const b = normalizePosix(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = a.slice(i).map(() => '..')
  return [...up, ...b.slice(i)].join('/')
}

const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i

export function isExternalSrc(src: string): boolean {
  return ABSOLUTE_URL_RE.test(src)
}

// ---------------------------------------------------------------------------
// Image source rewriting
// ---------------------------------------------------------------------------

const MD_IMAGE_RE = /(!\[[^\]]*]\()(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\))/g
const HTML_IMG_RE = /(<img\b[^>]*?\bsrc=)(["'])([^"']*)\2/gi

/** Apply `fn` to every image source in a markdown string (markdown and inline HTML syntax). */
export function rewriteImageSrcs(markdown: string, fn: (src: string) => string): string {
  return markdown
    .replace(MD_IMAGE_RE, (_m, pre: string, src: string, post: string) => {
      const bare = src.startsWith('<') ? src.slice(1, -1) : src
      const next = fn(bare)
      const wrapped = src.startsWith('<') || /\s/.test(next) ? `<${next}>` : next
      return `${pre}${wrapped}${post}`
    })
    .replace(HTML_IMG_RE, (_m, pre: string, q: string, src: string) => `${pre}${q}${fn(src)}${q}`)
}

/** Root-relative image paths always start with one of the top-level content folders. */
export function isRootRelativeSrc(src: string): boolean {
  return src.startsWith(`${ENTRIES_DIR}/`) || src.startsWith('canvases/') || src.startsWith('pages/') || src.startsWith('categories/')
}

/** Convert image paths relative to the file in `dir` into repo-root-relative paths. */
export function toRootRelativeFrom(markdown: string, dir: string): string {
  return rewriteImageSrcs(markdown, (src) => (isExternalSrc(src) ? src : joinPosix(dir, src)))
}

/** Convert repo-root-relative image paths into paths relative to the file in `dir`. */
export function toRelativeFrom(markdown: string, dir: string): string {
  return rewriteImageSrcs(markdown, (src) => {
    if (isExternalSrc(src)) return src
    if (!isRootRelativeSrc(src)) return src // already relative / unknown
    return relativePosix(dir, src)
  })
}

/** Convert image paths relative to a day's file into repo-root-relative paths. */
export function toRootRelative(markdown: string, date: string, base: string = ENTRIES_DIR): string {
  return toRootRelativeFrom(markdown, dayDir(date, base))
}

/** Convert repo-root-relative image paths into paths relative to a day's file. */
export function toDayRelative(markdown: string, date: string, base: string = ENTRIES_DIR): string {
  return toRelativeFrom(markdown, dayDir(date, base))
}

/** Collect the repo-root-relative image sources referenced by an entry. */
export function collectImageSrcs(markdown: string): string[] {
  const found: string[] = []
  rewriteImageSrcs(markdown, (src) => {
    if (!isExternalSrc(src)) found.push(src)
    return src
  })
  return found
}

// ---------------------------------------------------------------------------
// Parsing & serialising day files
// ---------------------------------------------------------------------------

const RESERVED_ATTRS = new Set(['id', 'parent', 'created', 'updated', 'kind', 'hidden'])

function quoteAttr(v: string): string {
  return /[\s"]/.test(v) || v === '' ? `"${v.replace(/"/g, '&quot;')}"` : v
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of s.matchAll(/([a-zA-Z_-]+)=("([^"]*)"|\S+)/g)) {
    attrs[m[1]] = (m[3] ?? m[2]).replace(/&quot;/g, '"')
  }
  return attrs
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/** Parse the contents of a day file. Image paths are returned repo-root-relative. */
export function parseDayFile(date: string, text: string, base: string = ENTRIES_DIR): Day {
  return { date, entries: parseBlockFile(text, dayDir(date, base), `${date}T00:00:00.000Z`) }
}

/**
 * Parse any file of blocks (a day file, a canvas's todo list). `dir` is the
 * file's repo-relative directory, used to make image paths root-relative.
 */
export function parseBlockFile(text: string, dir: string, fallbackCreatedAt = '1970-01-01T00:00:00.000Z'): Entry[] {
  const lines = text.split(/\r?\n/)
  const entries: Entry[] = []
  let current: { attrs: Record<string, string>; lines: string[] } | null = null

  const flush = (): void => {
    if (!current) return
    let body = current.lines
    // Drop the derived time heading that immediately follows the marker.
    const firstIdx = body.findIndex((l) => l.trim() !== '')
    if (firstIdx !== -1 && TIME_HEADING_RE.test(body[firstIdx])) body = body.slice(firstIdx + 1)
    body = trimBlankLines(body)
    const createdAt = current.attrs.created ?? fallbackCreatedAt
    const entry: Entry = {
      id: current.attrs.id || newEntryId(),
      createdAt,
      markdown: toRootRelativeFrom(body.join('\n'), dir)
    }
    if (current.attrs.parent) entry.parentId = current.attrs.parent
    if (current.attrs.updated) entry.updatedAt = current.attrs.updated
    if (current.attrs.kind && (ENTRY_KINDS as readonly string[]).includes(current.attrs.kind)) entry.kind = current.attrs.kind as EntryKind
    if (current.attrs.hidden && /^(1|true|yes)$/i.test(current.attrs.hidden)) entry.hidden = true
    const meta: Record<string, string> = {}
    for (const [k, v] of Object.entries(current.attrs)) {
      if (!RESERVED_ATTRS.has(k)) meta[k] = v
    }
    if (Object.keys(meta).length > 0) entry.meta = meta
    entries.push(entry)
    current = null
  }

  for (const line of lines) {
    const m = MARKER_RE.exec(line)
    if (m) {
      flush()
      current = { attrs: parseAttrs(m[1]), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
    // Lines before the first marker (title, hand-written preamble) are ignored.
  }
  flush()

  // Drop dangling parent links (hand edits, deleted parents) so they render as top-level notes.
  const ids = new Set(entries.map((e) => e.id))
  for (const e of entries) if (e.parentId && !ids.has(e.parentId)) delete e.parentId
  return entries
}

/** Serialise a day to markdown. Image paths are written relative to the day file. */
export function serializeDayFile(day: Day, base: string = ENTRIES_DIR): string {
  return serializeBlockFile(day.entries, dayDir(day.date, base), `# ${day.date}`)
}

/** Serialise any file of blocks under a title line. Image paths are written relative to `dir`. */
export function serializeBlockFile(entries: Entry[], dir: string, title: string): string {
  const parts: string[] = [title, '']
  for (const e of entries) {
    const depth = depthOf(entries, e.id)
    const attrs = [`id=${e.id}`]
    if (e.parentId) attrs.push(`parent=${e.parentId}`)
    attrs.push(`created=${e.createdAt}`)
    if (e.updatedAt) attrs.push(`updated=${e.updatedAt}`)
    if (e.kind && e.kind !== 'note') attrs.push(`kind=${e.kind}`)
    if (e.hidden) attrs.push('hidden=1')
    for (const [k, v] of Object.entries(e.meta ?? {})) {
      if (!RESERVED_ATTRS.has(k) && /^[a-zA-Z_][\w-]*$/.test(k)) attrs.push(`${k}=${quoteAttr(v)}`)
    }
    parts.push(`<!-- devlog:entry ${attrs.join(' ')} -->`)
    const level = '#'.repeat(Math.min(3 + depth, 6))
    parts.push(`${level} ${depth > 0 ? '↳ ' : ''}${localTime(new Date(e.createdAt))}`)
    parts.push('')
    const body = toRelativeFrom(e.markdown, dir).replace(/\s+$/, '')
    if (body) {
      parts.push(body)
      parts.push('')
    }
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Tree helpers. Entries are a flat, ordered list; replies point at a parent.
// ---------------------------------------------------------------------------

export interface EntryNode {
  entry: Entry
  depth: number
  children: EntryNode[]
}

/** Nesting depth of an entry (0 for top-level). Cycles and unknown parents stop the walk. */
export function depthOf(entries: Entry[], id: string): number {
  const byId = new Map(entries.map((e) => [e.id, e]))
  let depth = 0
  const seen = new Set<string>([id])
  let cur = byId.get(id)
  while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    cur = byId.get(cur.parentId)
    depth++
  }
  return depth
}

/** Ids of every reply below `id`, transitively. */
export function descendantIds(entries: Entry[], id: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const e of entries) {
      if (e.parentId && !out.has(e.id) && (e.parentId === id || out.has(e.parentId))) {
        out.add(e.id)
        grew = true
      }
    }
  }
  return out
}

/** Index of the last entry belonging to `id`'s thread (itself or any descendant). */
export function subtreeEndIndex(entries: Entry[], id: string): number {
  const ids = descendantIds(entries, id)
  ids.add(id)
  let last = -1
  entries.forEach((e, i) => {
    if (ids.has(e.id)) last = i
  })
  return last
}

/** Return a new list with `entry` inserted according to `position`. Sets `entry.parentId`. */
export function insertEntry(entries: Entry[], entry: Entry, position: EntryPosition = {}): Entry[] {
  const find = (id: string): Entry => {
    const e = entries.find((x) => x.id === id)
    if (!e) throw new Error(`Entry ${id} not found`)
    return e
  }
  const next = [...entries]
  delete entry.parentId
  if (position.parentId) {
    find(position.parentId)
    entry.parentId = position.parentId
    next.splice(subtreeEndIndex(entries, position.parentId) + 1, 0, entry)
  } else if (position.afterId) {
    const anchor = find(position.afterId)
    if (anchor.parentId) entry.parentId = anchor.parentId
    next.splice(subtreeEndIndex(entries, position.afterId) + 1, 0, entry)
  } else if (position.beforeId) {
    const anchor = find(position.beforeId)
    if (anchor.parentId) entry.parentId = anchor.parentId
    next.splice(entries.indexOf(anchor), 0, entry)
  } else {
    next.push(entry)
  }
  return next
}

/**
 * Move a top-level entry (with its thread) to another spot in the same day:
 * after `afterId`'s thread or before `beforeId`. Timestamps are untouched;
 * file order is display order.
 */
export function moveSubtree(entries: Entry[], id: string, position: { afterId?: string; beforeId?: string }): Entry[] {
  const root = entries.find((e) => e.id === id)
  if (!root) throw new Error(`Entry ${id} not found`)
  if (root.parentId) throw new Error('Only top-level blocks can be reordered')
  const ids = descendantIds(entries, id)
  ids.add(id)
  const moving = entries.filter((e) => ids.has(e.id))
  const rest = entries.filter((e) => !ids.has(e.id))
  const anchorId = position.afterId ?? position.beforeId
  if (!anchorId) throw new Error('Nowhere to move to')
  if (ids.has(anchorId)) return entries
  const anchor = rest.find((e) => e.id === anchorId)
  if (!anchor) throw new Error(`Entry ${anchorId} not found`)
  // Anchor on the top of the anchor's thread so a drop next to a reply lands beside its root.
  let top = anchor
  while (top.parentId) top = rest.find((e) => e.id === top.parentId) ?? top
  const at = position.afterId ? subtreeEndIndex(rest, top.id) + 1 : rest.indexOf(top)
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}

/** Return a new list without `id` and all of its replies. */
export function removeSubtree(entries: Entry[], id: string): Entry[] {
  const ids = descendantIds(entries, id)
  ids.add(id)
  return entries.filter((e) => !ids.has(e.id))
}

/** Nest a flat entry list into threads, preserving order. */
export function buildTree(entries: Entry[]): EntryNode[] {
  const ids = new Set(entries.map((e) => e.id))
  const nodes = new Map<string, EntryNode>()
  const roots: EntryNode[] = []
  for (const entry of entries) nodes.set(entry.id, { entry, depth: 0, children: [] })
  for (const entry of entries) {
    const node = nodes.get(entry.id)!
    const parent = entry.parentId && ids.has(entry.parentId) ? nodes.get(entry.parentId) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const setDepth = (list: EntryNode[], depth: number, seen: Set<string>): void => {
    for (const n of list) {
      if (seen.has(n.entry.id)) continue
      seen.add(n.entry.id)
      n.depth = depth
      setDepth(n.children, depth + 1, seen)
    }
  }
  setDepth(roots, 0, new Set())
  return roots
}

// ---------------------------------------------------------------------------
// Explicit duration markers: "[2h]", "[45m]", "[1h 30m]", "[1.5h]"
// ---------------------------------------------------------------------------

export const DURATION_MARKER_RE = /\\?\[\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?\s*\\?\]/i

/**
 * Editors that serialise markdown escape square brackets (`\[2h\]`); store
 * the marker unescaped so the file reads cleanly and the parser stays simple.
 */
export function normalizeDurationMarker(markdown: string): string {
  return markdown.replace(DURATION_MARKER_RE, (m, h, min) => {
    if (h === undefined && min === undefined) return m
    return m.replace(/\\\[/, '[').replace(/\\\]/, ']')
  })
}

/** Minutes declared by the first duration marker in a note, or null. */
export function parseDurationMarker(markdown: string): number | null {
  // Skip fenced code so "[1h]" in a snippet is not a marker.
  const stripped = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
  const m = DURATION_MARKER_RE.exec(stripped)
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  const minutes = (m[1] ? parseFloat(m[1]) * 60 : 0) + (m[2] ? parseInt(m[2], 10) : 0)
  return minutes > 0 ? Math.round(minutes) : null
}

/** True if a markdown string has no meaningful content. */
export function isBlankMarkdown(markdown: string): boolean {
  return markdown.replace(/[\s​]/g, '') === ''
}

/** A one-line plain-text preview of an entry, for lists and search results. */
export function previewText(markdown: string, max = 120): string {
  const text = markdown
    .replace(/!\[[^\]]*]\([^)]*\)/g, '[image]')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[#>*_`~]/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function isTitleLine(line: string): boolean {
  return TITLE_RE.test(line)
}

// ---------------------------------------------------------------------------
// Task tag: `#task` anywhere on the first line turns a new block into a task.
// ---------------------------------------------------------------------------

const TASK_TAG_RE = /(^|\s)\\?#task\b[ \t]*/i

export function hasTaskTag(markdown: string): boolean {
  const first = markdown.trimStart().split('\n')[0] ?? ''
  return TASK_TAG_RE.test(first)
}

/** Remove the `#task` tag from the first line. */
export function stripTaskTag(markdown: string): string {
  const lines = markdown.trimStart().split('\n')
  lines[0] = (lines[0] ?? '').replace(TASK_TAG_RE, '$1').replace(/[ \t]+$/, '')
  return lines.join('\n').trim()
}

/** A short title for a block, from its first meaningful line. */
export function titleFromMarkdown(markdown: string, max = 80): string {
  const text = previewText(stripTaskTag(markdown).replace(DURATION_MARKER_RE, ''), 400)
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text
  const t = first.trim().replace(/[.:;,]+$/, '')
  if (t.length <= max) return t || 'Task'
  const cut = t.slice(0, max)
  return `${cut.slice(0, Math.max(20, cut.lastIndexOf(' ')))}…`
}

// ---------------------------------------------------------------------------
// Todos
// ---------------------------------------------------------------------------

/**
 * Turn typed or pasted text into todo items: one per non-empty line, with
 * list markers (bullets, numbers, markdown checkboxes) stripped. Indented
 * continuation lines are kept with the item above them.
 */
export function splitTodoLines(text: string): string[] {
  const out: string[] = []
  const MARKER = /^\s*(?:[-*+•▪◦‣]|\d+[.)]|[a-z][.)])\s+(?:\[[ xX]\]\s+)?|^\s*\[[ xX]\]\s+/
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue
    const isItem = MARKER.test(raw) || !/^\s{2,}/.test(raw)
    const item = raw.replace(MARKER, '').trim()
    if (!item) continue
    if (!isItem && out.length > 0) out[out.length - 1] += ` ${item}`
    else out.push(item)
  }
  return out
}
