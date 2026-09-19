/**
 * DevlogStore: reads and writes the markdown files and attachments inside a
 * devlog repository. It knows nothing about git or Electron.
 *
 * Notes are organised in pages. The journal is the built-in page rooted at
 * `entries/`; every other page lives under `pages/<slug>/` with a `page.md`
 * for metadata and its own `entries/` tree in the same day-file format.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  ASSETS_DIR,
  ENTRIES_DIR,
  assetDir,
  dateFromFilePath,
  dayFilePath,
  descendantIds,
  insertEntry,
  isBlankMarkdown,
  isValidDate,
  localDate,
  newEntryId,
  parseDayFile,
  removeSubtree,
  serializeDayFile
} from '@shared/entries'
import {
  JOURNAL_PAGE,
  JOURNAL_PAGE_ID,
  PAGES_DIR,
  categoryPath,
  isValidPageId,
  normalizeCategory,
  pageEntriesBase,
  pageFilePath,
  parsePageFile,
  serializePageFile,
  slugify
} from '@shared/pages'
import type { Day, DaySummary, Entry, EntryPosition, PageInput, PageMeta, SavedAsset, SearchHit, Timeline } from '@shared/types'

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
}

const MAX_ASSET_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMELINE_DAYS = 10

export class DevlogStore extends EventEmitter {
  constructor(readonly root: string) {
    super()
  }

  /** Absolute OS path for a repo-relative POSIX path, guarded against traversal. */
  resolve(repoRel: string): string {
    const abs = path.resolve(this.root, ...repoRel.split('/'))
    const rel = path.relative(this.root, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes repository: ${repoRel}`)
    }
    return abs
  }

  /** Create the on-disk skeleton for a new devlog (idempotent). */
  async initLayout(): Promise<void> {
    await fs.mkdir(path.join(this.root, ENTRIES_DIR), { recursive: true })
    const readme = path.join(this.root, 'README.md')
    if (!(await exists(readme))) {
      await fs.writeFile(
        readme,
        [
          '# Devlog',
          '',
          'This repository is a developer log managed by the Devlog app.',
          '',
          `- Journal notes live in \`${ENTRIES_DIR}/YYYY/MM/YYYY-MM-DD.md\`, one file per day.`,
          `- Pages (clients, projects, …) live in \`${PAGES_DIR}/<name>/\` with a \`page.md\` and their own \`entries/\`.`,
          `- Pasted images live next to the notes in an \`${ASSETS_DIR}/\` folder.`,
          '- Every note is delimited by a `<!-- devlog:entry … -->` comment that carries its id, parent and timestamps.',
          ''
        ].join('\n')
      )
    }
    const gitignore = path.join(this.root, '.gitignore')
    if (!(await exists(gitignore))) {
      await fs.writeFile(gitignore, ['.DS_Store', 'Thumbs.db', ''].join('\n'))
    }
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  async listPages(): Promise<PageMeta[]> {
    const pages: PageMeta[] = [{ ...JOURNAL_PAGE }]
    const dir = path.join(this.root, PAGES_DIR)
    for (const d of await readdirSafe(dir)) {
      if (!d.isDirectory() || !isValidPageId(d.name) || d.name === JOURNAL_PAGE_ID) continue
      const meta = await this.readPage(d.name).catch(() => null)
      if (meta) pages.push(meta)
    }
    return pages
  }

  async readPage(pageId: string): Promise<PageMeta> {
    assertPageId(pageId)
    if (pageId === JOURNAL_PAGE_ID) return { ...JOURNAL_PAGE }
    const abs = this.resolve(pageFilePath(pageId))
    let text = ''
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // A bare folder with entries but no page.md still counts as a page.
      if (!(await exists(this.resolve(pageEntriesBase(pageId))))) throw new Error(`Page ${pageId} not found`)
    }
    return parsePageFile(pageId, text)
  }

  async createPage(input: PageInput, now: Date = new Date()): Promise<PageMeta> {
    const title = input.title.trim()
    if (!title) throw new Error('A page needs a title')
    const existing = new Set((await this.listPages()).map((p) => p.id))
    const category = normalizeCategory(input.category ?? '')
    // "Website" under "Acme Corp" becomes acme-corp-website, so two clients'
    // "Website" projects get distinct, readable folders.
    let id = slugify([...categoryPath(category), title].join(' '))
    if (id === JOURNAL_PAGE_ID) id = `${id}-page`
    const base = id
    for (let n = 2; existing.has(id); n++) id = `${base}-${n}`
    const meta: PageMeta = {
      id,
      title,
      category,
      description: (input.description ?? '').trim(),
      createdAt: now.toISOString()
    }
    await fs.mkdir(this.resolve(pageEntriesBase(id)), { recursive: true })
    await this.writePage(meta)
    return meta
  }

  async updatePage(pageId: string, patch: Partial<PageInput>): Promise<PageMeta> {
    if (pageId === JOURNAL_PAGE_ID) throw new Error('The journal cannot be edited')
    const meta = await this.readPage(pageId)
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('A page needs a title')
      meta.title = title
    }
    if (patch.category !== undefined) meta.category = normalizeCategory(patch.category)
    if (patch.description !== undefined) meta.description = patch.description.trim()
    if (!meta.createdAt) meta.createdAt = new Date().toISOString()
    await this.writePage(meta)
    return meta
  }

  /** Delete a page and every note in it. Returns the number of notes removed. */
  async deletePage(pageId: string): Promise<number> {
    if (pageId === JOURNAL_PAGE_ID) throw new Error('The journal cannot be deleted')
    await this.readPage(pageId)
    let count = 0
    for (const d of await this.listDays(pageId)) count += d.count
    await fs.rm(this.resolve(`${PAGES_DIR}/${pageId}`), { recursive: true, force: true })
    this.emit('change', { kind: 'page', pageId })
    return count
  }

  private async writePage(meta: PageMeta): Promise<void> {
    const abs = this.resolve(pageFilePath(meta.id))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await writeAtomic(abs, serializePageFile(meta))
    this.emit('change', { kind: 'page', pageId: meta.id })
  }

  // -------------------------------------------------------------------------
  // Reading notes
  // -------------------------------------------------------------------------

  async listDays(pageId: string = JOURNAL_PAGE_ID): Promise<DaySummary[]> {
    const out: DaySummary[] = []
    for (const date of await this.listDayFiles(pageId)) {
      const day = await this.readDay(pageId, date)
      if (day.entries.length > 0) out.push({ date, count: day.entries.length })
    }
    out.sort((a, b) => b.date.localeCompare(a.date))
    return out
  }

  async readDay(pageId: string, date: string): Promise<Day> {
    assertPageId(pageId)
    assertDate(date)
    const base = pageEntriesBase(pageId)
    const abs = this.resolve(dayFilePath(date, base))
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { date, entries: [] }
      throw err
    }
    return parseDayFile(date, text, base)
  }

  /**
   * The most recent `days` non-empty days of a page (oldest first), optionally
   * only those strictly before `beforeDate`, for infinite scrolling upwards.
   */
  async getTimeline(pageId: string, opts: { beforeDate?: string; days?: number } = {}): Promise<Timeline> {
    assertPageId(pageId)
    const limit = Math.max(1, opts.days ?? DEFAULT_TIMELINE_DAYS)
    let dates = (await this.listDayFiles(pageId)).sort((a, b) => b.localeCompare(a))
    if (opts.beforeDate) dates = dates.filter((d) => d < opts.beforeDate!)
    const days: Day[] = []
    let i = 0
    for (; i < dates.length && days.length < limit; i++) {
      const day = await this.readDay(pageId, dates[i])
      if (day.entries.length > 0) days.push(day)
    }
    days.reverse()
    return { pageId, days, hasMore: i < dates.length }
  }

  /** Every day file across all pages within [fromDate, toDate], inclusive. */
  async getRange(fromDate: string, toDate: string): Promise<Array<{ pageId: string; day: Day }>> {
    assertDate(fromDate)
    assertDate(toDate)
    const out: Array<{ pageId: string; day: Day }> = []
    for (const page of await this.listPages()) {
      const dates = (await this.listDayFiles(page.id)).filter((d) => d >= fromDate && d <= toDate).sort()
      for (const date of dates) {
        const day = await this.readDay(page.id, date)
        if (day.entries.length > 0) out.push({ pageId: page.id, day })
      }
    }
    return out
  }

  async search(query: string, limit = 200): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    for (const page of await this.listPages()) {
      const dates = (await this.listDayFiles(page.id)).sort((a, b) => b.localeCompare(a))
      for (const date of dates) {
        const day = await this.readDay(page.id, date)
        for (const entry of [...day.entries].reverse()) {
          if (entry.markdown.toLowerCase().includes(q)) {
            hits.push({ pageId: page.id, date, entry })
            if (hits.length >= limit) return hits
          }
        }
      }
    }
    return hits
  }

  // -------------------------------------------------------------------------
  // Writing notes
  // -------------------------------------------------------------------------

  /**
   * Add a note to a page. With no position it is appended to today; a
   * position can target another day, make it a reply, or slot it between notes.
   */
  async addEntry(
    pageId: string,
    markdown: string,
    position: EntryPosition = {},
    now: Date = new Date()
  ): Promise<{ date: string; entry: Entry }> {
    if (isBlankMarkdown(markdown)) throw new Error('Cannot add an empty entry')
    const date = position.date ?? localDate(now)
    const day = await this.readDay(pageId, date)
    const entry: Entry = {
      id: uniqueId(day.entries),
      createdAt: now.toISOString(),
      markdown: markdown.trim()
    }
    day.entries = insertEntry(day.entries, entry, position)
    await this.writeDay(pageId, day)
    return { date, entry }
  }

  async updateEntry(pageId: string, date: string, id: string, markdown: string, now: Date = new Date()): Promise<Entry> {
    const day = await this.readDay(pageId, date)
    const entry = day.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`Entry ${id} not found on ${date}`)
    entry.markdown = markdown.trim()
    entry.updatedAt = now.toISOString()
    await this.writeDay(pageId, day)
    return entry
  }

  /** Delete a note and every reply beneath it. Returns the number removed. */
  async deleteEntry(pageId: string, date: string, id: string): Promise<number> {
    const day = await this.readDay(pageId, date)
    if (!day.entries.some((e) => e.id === id)) throw new Error(`Entry ${id} not found on ${date}`)
    const removed = descendantIds(day.entries, id).size + 1
    day.entries = removeSubtree(day.entries, id)
    await this.writeDay(pageId, day)
    return removed
  }

  /**
   * Move a note (with its thread) to another page, keeping its date. Images
   * stay where they are; links are rewritten relative to the new file.
   */
  async moveEntry(fromPageId: string, date: string, id: string, toPageId: string): Promise<{ date: string; entry: Entry }> {
    assertPageId(toPageId)
    if (fromPageId === toPageId) throw new Error('Note is already on that page')
    await this.readPage(toPageId)
    const source = await this.readDay(fromPageId, date)
    const root = source.entries.find((e) => e.id === id)
    if (!root) throw new Error(`Entry ${id} not found on ${date}`)
    const ids = descendantIds(source.entries, id)
    ids.add(id)
    const moving = source.entries.filter((e) => ids.has(e.id)).map((e) => ({ ...e }))
    const target = await this.readDay(toPageId, date)

    // Re-id on collision, keeping the thread's parent links consistent.
    const taken = new Set(target.entries.map((e) => e.id))
    const rename = new Map<string, string>()
    for (const e of moving) {
      if (taken.has(e.id)) {
        let next = newEntryId()
        while (taken.has(next) || moving.some((m) => m.id === next)) next = newEntryId()
        rename.set(e.id, next)
      }
    }
    for (const e of moving) {
      if (rename.has(e.id)) e.id = rename.get(e.id)!
      if (e.parentId && rename.has(e.parentId)) e.parentId = rename.get(e.parentId)!
      taken.add(e.id)
    }
    const movedRoot = moving[0]
    delete movedRoot.parentId

    source.entries = removeSubtree(source.entries, id)
    target.entries = [...target.entries, ...moving]
    await this.writeDay(toPageId, target)
    await this.writeDay(fromPageId, source)
    return { date, entry: movedRoot }
  }

  /** Persist an image for a page/day; returns its repo-root-relative path. */
  async saveAsset(
    pageId: string,
    date: string,
    bytes: Uint8Array,
    mime: string,
    originalName?: string,
    now: Date = new Date()
  ): Promise<SavedAsset> {
    assertPageId(pageId)
    assertDate(date)
    if (bytes.byteLength === 0) throw new Error('Empty image')
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Image is larger than 25 MB')
    const ext = IMAGE_EXT_BY_MIME[mime] ?? extFromName(originalName) ?? 'png'
    const dir = assetDir(date, pageEntriesBase(pageId))
    await fs.mkdir(this.resolve(dir), { recursive: true })
    const stamp = `${localDate(now)}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    let name = `${stamp}-${newEntryId().slice(0, 4)}.${ext}`
    while (await exists(this.resolve(`${dir}/${name}`))) {
      name = `${stamp}-${newEntryId().slice(0, 4)}.${ext}`
    }
    const src = `${dir}/${name}`
    await fs.writeFile(this.resolve(src), bytes)
    this.emit('change', { kind: 'asset', src })
    return { src, size: bytes.byteLength }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async writeDay(pageId: string, day: Day): Promise<void> {
    const base = pageEntriesBase(pageId)
    const abs = this.resolve(dayFilePath(day.date, base))
    if (day.entries.length === 0) {
      await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeAtomic(abs, serializeDayFile(day, base))
    }
    this.emit('change', { kind: 'day', pageId, date: day.date })
  }

  private async listDayFiles(pageId: string): Promise<string[]> {
    assertPageId(pageId)
    const base = this.resolve(pageEntriesBase(pageId))
    const dates: string[] = []
    for (const y of await readdirSafe(base)) {
      if (!/^\d{4}$/.test(y.name) || !y.isDirectory()) continue
      for (const m of await readdirSafe(path.join(base, y.name))) {
        if (!/^\d{2}$/.test(m.name) || !m.isDirectory()) continue
        for (const f of await readdirSafe(path.join(base, y.name, m.name))) {
          if (!f.isFile()) continue
          const d = dateFromFilePath(f.name)
          if (d && d.startsWith(`${y.name}-${m.name}`)) dates.push(d)
        }
      }
    }
    return dates
  }
}

function assertDate(date: string): void {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`)
}

function assertPageId(pageId: string): void {
  if (!isValidPageId(pageId)) throw new Error(`Invalid page: ${pageId}`)
}

function uniqueId(entries: Entry[]): string {
  let id = newEntryId()
  while (entries.some((e) => e.id === id)) id = newEntryId()
  return id
}

function extFromName(name?: string): string | undefined {
  if (!name) return undefined
  const m = /\.([a-z0-9]{1,5})$/i.exec(name)
  return m ? m[1].toLowerCase() : undefined
}

const pad = (n: number): string => String(n).padStart(2, '0')

async function writeAtomic(abs: string, text: string): Promise<void> {
  const tmp = `${abs}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, abs)
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
