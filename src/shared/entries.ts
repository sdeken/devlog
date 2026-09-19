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
 * Image references inside a file are relative to that file (so they render on
 * GitHub); in memory they are normalised to repo-root-relative paths so the
 * renderer and asset server can resolve them without knowing which day they
 * belong to.
 */
import type { Day, Entry } from './types'

export const ENTRIES_DIR = 'entries'
export const ASSETS_DIR = 'assets'

const MARKER_RE = /^<!--\s*devlog:entry\s+([^>]*?)\s*-->\s*$/
const TIME_HEADING_RE = /^###\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/
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

/** Repo-relative POSIX path of a day's markdown file. */
export function dayFilePath(date: string): string {
  const [y, m] = date.split('-')
  return `${ENTRIES_DIR}/${y}/${m}/${date}.md`
}

/** Repo-relative POSIX directory that holds a day's file. */
export function dayDir(date: string): string {
  const [y, m] = date.split('-')
  return `${ENTRIES_DIR}/${y}/${m}`
}

/** Repo-relative POSIX directory for a day's attachments. */
export function assetDir(date: string): string {
  return `${dayDir(date)}/${ASSETS_DIR}`
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

/** Convert image paths relative to a day's file into repo-root-relative paths. */
export function toRootRelative(markdown: string, date: string): string {
  const dir = dayDir(date)
  return rewriteImageSrcs(markdown, (src) => (isExternalSrc(src) ? src : joinPosix(dir, src)))
}

/** Convert repo-root-relative image paths into paths relative to a day's file. */
export function toDayRelative(markdown: string, date: string): string {
  const dir = dayDir(date)
  return rewriteImageSrcs(markdown, (src) => {
    if (isExternalSrc(src)) return src
    if (!src.startsWith(`${ENTRIES_DIR}/`)) return src // already relative / unknown
    return relativePosix(dir, src)
  })
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

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const m of s.matchAll(/([a-zA-Z_-]+)=("([^"]*)"|\S+)/g)) {
    attrs[m[1]] = m[3] ?? m[2]
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
export function parseDayFile(date: string, text: string): Day {
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
    const createdAt = current.attrs.created ?? `${date}T00:00:00.000Z`
    const entry: Entry = {
      id: current.attrs.id || newEntryId(),
      createdAt,
      markdown: toRootRelative(body.join('\n'), date)
    }
    if (current.attrs.updated) entry.updatedAt = current.attrs.updated
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

  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { date, entries }
}

/** Serialise a day to markdown. Image paths are written relative to the day file. */
export function serializeDayFile(day: Day): string {
  const parts: string[] = [`# ${day.date}`, '']
  const sorted = [...day.entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const e of sorted) {
    const attrs = [`id=${e.id}`, `created=${e.createdAt}`]
    if (e.updatedAt) attrs.push(`updated=${e.updatedAt}`)
    parts.push(`<!-- devlog:entry ${attrs.join(' ')} -->`)
    parts.push(`### ${localTime(new Date(e.createdAt))}`)
    parts.push('')
    const body = toDayRelative(e.markdown, day.date).replace(/\s+$/, '')
    if (body) {
      parts.push(body)
      parts.push('')
    }
  }
  return parts.join('\n')
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
