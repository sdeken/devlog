/**
 * DevlogStore: reads and writes the markdown files and attachments inside a
 * devlog repository. It knows nothing about git or Electron.
 *
 * Content is organised in canvases. The journal is the built-in root canvas
 * whose stream lives at `entries/`; every other canvas lives under
 * `canvases/<id>/` with a `canvas.md` (metadata + surface) and its own
 * `entries/` tree in the same day-file format.
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
  normalizeDurationMarker,
  parseDayFile,
  previewText,
  removeSubtree,
  serializeDayFile,
  titleFromMarkdown,
  toRelativeFrom,
  toRootRelativeFrom
} from '@shared/entries'
import {
  CANVASES_DIR,
  JOURNAL,
  JOURNAL_ID,
  LEGACY_CATEGORIES_DIR,
  LEGACY_PAGES_DIR,
  canvasDir,
  canvasEntriesBase,
  canvasFilePath,
  categoryPath,
  descendantCanvasIds,
  isValidCanvasId,
  isWithin,
  legacyCategoryId,
  parseCanvasFile,
  parseLegacyPageFile,
  parseLegacyWikiFile,
  serializeCanvasFile,
  slugify
} from '@shared/canvases'
import type {
  Canvas,
  CanvasInput,
  CanvasMeta,
  Day,
  DaySummary,
  Entry,
  EntryKind,
  EntryPosition,
  PromoteResult,
  SavedAsset,
  SearchHit,
  SearchResult,
  SurfaceHit,
  Timeline
} from '@shared/types'

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
          `- Canvases (clients, projects, tasks, …) live in \`${CANVASES_DIR}/<id>/\` with a \`canvas.md\` (metadata + surface) and their own \`entries/\`.`,
          `- Pasted images live next to the notes in an \`${ASSETS_DIR}/\` folder.`,
          '- Every block is delimited by a `<!-- devlog:entry … -->` comment that carries its id, parent and timestamps.',
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
  // Canvases
  // -------------------------------------------------------------------------

  async listCanvases(): Promise<CanvasMeta[]> {
    const out: CanvasMeta[] = [{ ...JOURNAL }]
    const dir = path.join(this.root, CANVASES_DIR)
    for (const d of await readdirSafe(dir)) {
      if (!d.isDirectory() || !isValidCanvasId(d.name) || d.name === JOURNAL_ID) continue
      const c = await this.readCanvas(d.name).catch(() => null)
      if (c) out.push(stripSurface(c))
    }
    return out
  }

  async readCanvas(id: string): Promise<Canvas> {
    assertCanvasId(id)
    if (id === JOURNAL_ID) return { ...JOURNAL, surface: '' }
    let text = ''
    try {
      text = await fs.readFile(this.resolve(canvasFilePath(id)), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // A bare folder with entries but no canvas.md still counts.
      if (!(await exists(this.resolve(canvasEntriesBase(id))))) throw new Error(`Canvas ${id} not found`)
    }
    const { meta, surface } = parseCanvasFile(id, text)
    return { ...meta, surface: toRootRelativeFrom(surface, canvasDir(id)) }
  }

  async createCanvas(input: CanvasInput, now: Date = new Date()): Promise<CanvasMeta> {
    const title = input.title.trim()
    if (!title) throw new Error('A canvas needs a title')
    const all = await this.listCanvases()
    const parentId = await this.checkParent(all, input.parentId ?? null)
    const existing = new Set(all.map((c) => c.id))
    const id = uniqueSlug(title, existing)
    const meta: CanvasMeta = {
      id,
      title,
      parentId,
      task: Boolean(input.task),
      createdAt: now.toISOString(),
      updatedAt: '',
      repos: cleanRepos(input.repos),
      archived: false,
      hasSurface: false
    }
    await fs.mkdir(this.resolve(canvasEntriesBase(id)), { recursive: true })
    await this.writeCanvas(meta, '')
    return meta
  }

  async updateCanvas(id: string, patch: Partial<CanvasInput>): Promise<CanvasMeta> {
    if (id === JOURNAL_ID) throw new Error('The journal cannot be edited')
    const canvas = await this.readCanvas(id)
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) throw new Error('A canvas needs a title')
      canvas.title = title
    }
    if (patch.parentId !== undefined) {
      const all = await this.listCanvases()
      const parentId = await this.checkParent(all, patch.parentId)
      if (parentId && isWithin(all, parentId, id)) throw new Error('A canvas cannot be moved inside itself')
      canvas.parentId = parentId
    }
    if (patch.task !== undefined) canvas.task = Boolean(patch.task)
    if (patch.repos !== undefined) canvas.repos = cleanRepos(patch.repos)
    if (!canvas.createdAt) canvas.createdAt = new Date().toISOString()
    await this.writeCanvas(stripSurface(canvas), canvas.surface)
    return stripSurface(canvas)
  }

  /**
   * Archive (or restore) a canvas and everything beneath it. Returns the ids
   * that changed.
   */
  async setCanvasArchived(id: string, archived: boolean): Promise<string[]> {
    if (id === JOURNAL_ID) throw new Error('The journal cannot be archived')
    const all = await this.listCanvases()
    if (!all.some((c) => c.id === id)) throw new Error(`Canvas ${id} not found`)
    const changed: string[] = []
    for (const target of [id, ...descendantCanvasIds(all, id)]) {
      const canvas = await this.readCanvas(target)
      if (canvas.archived === archived) continue
      canvas.archived = archived
      await this.writeCanvas(stripSurface(canvas), canvas.surface)
      changed.push(target)
    }
    return changed
  }

  /** Delete a canvas, its stream and every canvas beneath it. Returns the number of blocks removed. */
  async deleteCanvas(id: string): Promise<number> {
    if (id === JOURNAL_ID) throw new Error('The journal cannot be deleted')
    const all = await this.listCanvases()
    if (!all.some((c) => c.id === id)) throw new Error(`Canvas ${id} not found`)
    let count = 0
    for (const target of [id, ...descendantCanvasIds(all, id)]) {
      for (const d of await this.listDays(target)) count += d.count
      await fs.rm(this.resolve(canvasDir(target)), { recursive: true, force: true })
    }
    this.emit('change', { kind: 'canvas', canvasId: id })
    return count
  }

  /** Replace the surface markdown (root-relative image paths in, file-relative on disk). */
  async writeSurface(id: string, markdown: string, now: Date = new Date()): Promise<Canvas> {
    if (id === JOURNAL_ID) throw new Error('The journal has no surface')
    const canvas = await this.readCanvas(id)
    const surface = markdown.replace(/\s+$/, '')
    const meta = { ...stripSurface(canvas), updatedAt: now.toISOString(), hasSurface: surface.length > 0 }
    await this.writeCanvas(meta, surface)
    return { ...meta, surface }
  }

  async saveSurfaceAsset(id: string, bytes: Uint8Array, mime: string, originalName?: string, now: Date = new Date()): Promise<SavedAsset> {
    assertCanvasId(id)
    if (id === JOURNAL_ID) throw new Error('The journal has no surface')
    return this.writeAsset(`${canvasDir(id)}/${ASSETS_DIR}`, bytes, mime, originalName, now)
  }

  /**
   * Turn a block into a task: a new task canvas beneath the block's canvas,
   * titled from the block's first line, and the block becomes the link to it.
   */
  async promoteToTask(canvasId: string, date: string, entryId: string, now: Date = new Date()): Promise<PromoteResult> {
    const day = await this.readDay(canvasId, date)
    const entry = day.entries.find((e) => e.id === entryId)
    if (!entry) throw new Error(`Entry ${entryId} not found on ${date}`)
    if (entry.kind === 'commit') throw new Error('A captured commit cannot become a task')
    if (entry.kind === 'task' && entry.meta?.canvas) {
      const existing = await this.readCanvas(entry.meta.canvas).catch(() => null)
      if (existing) return { canvas: stripSurface(existing), entry }
    }
    const canvas = await this.createCanvas({ title: titleFromMarkdown(entry.markdown), parentId: canvasId === JOURNAL_ID ? null : canvasId, task: true }, now)
    entry.kind = 'task'
    entry.meta = { ...(entry.meta ?? {}), canvas: canvas.id }
    await this.writeDay(canvasId, day)
    return { canvas, entry }
  }

  private async checkParent(all: CanvasMeta[], parentId: string | null | undefined): Promise<string | null> {
    if (!parentId || parentId === JOURNAL_ID) return null
    assertCanvasId(parentId)
    if (!all.some((c) => c.id === parentId)) throw new Error(`Parent canvas ${parentId} not found`)
    return parentId
  }

  private async writeCanvas(meta: CanvasMeta, surface: string): Promise<void> {
    const abs = this.resolve(canvasFilePath(meta.id))
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await writeAtomic(abs, serializeCanvasFile(meta, toRelativeFrom(surface, canvasDir(meta.id))))
    this.emit('change', { kind: 'canvas', canvasId: meta.id })
  }

  // -------------------------------------------------------------------------
  // Migration from the pages/ + categories/ layout (Devlog ≤ 0.2)
  // -------------------------------------------------------------------------

  /**
   * Move legacy pages and category wikis into `canvases/`. Idempotent: does
   * nothing when neither legacy folder exists. Returns the ids created.
   */
  async migrateLegacyLayout(now: Date = new Date()): Promise<string[]> {
    const pagesDir = path.join(this.root, LEGACY_PAGES_DIR)
    const catsDir = path.join(this.root, LEGACY_CATEGORIES_DIR)
    if (!(await exists(pagesDir)) && !(await exists(catsDir))) return []
    const created: string[] = []
    const existing = new Set((await this.listCanvases()).map((c) => c.id))
    const byPath = new Map<string, string>() // lower-cased "a / b" → canvas id

    // Category chain → canvases, deepest last so parents exist first.
    const ensureChain = async (segments: string[]): Promise<string | null> => {
      let parentId: string | null = null
      for (let i = 1; i <= segments.length; i++) {
        const key = segments.slice(0, i).join(' / ').toLowerCase()
        let id = byPath.get(key)
        if (!id) {
          id = uniqueSlug(legacyCategoryId(segments.slice(0, i)), existing)
          existing.add(id)
          byPath.set(key, id)
          const meta: CanvasMeta = { id, title: segments[i - 1], parentId, task: false, createdAt: now.toISOString(), updatedAt: '', repos: [], archived: false, hasSurface: false }
          await fs.mkdir(this.resolve(canvasEntriesBase(id)), { recursive: true })
          await this.writeCanvas(meta, '')
          created.push(id)
        }
        parentId = id
      }
      return parentId
    }

    // Wikis first: their text becomes the category canvas's surface.
    const wikis: Array<{ dir: string; rel: string[] }> = []
    const walk = async (dir: string, rel: string[]): Promise<void> => {
      for (const d of await readdirSafe(dir)) {
        if (d.isFile() && d.name === 'wiki.md') wikis.push({ dir, rel })
        else if (d.isDirectory() && d.name !== ASSETS_DIR) await walk(path.join(dir, d.name), [...rel, d.name])
      }
    }
    await walk(catsDir, [])
    wikis.sort((a, b) => a.rel.length - b.rel.length)
    for (const w of wikis) {
      const text = await fs.readFile(path.join(w.dir, 'wiki.md'), 'utf8').catch(() => '')
      const parsed = parseLegacyWikiFile(text, w.rel)
      const id = await ensureChain(parsed.path)
      if (!id) continue
      const canvas = await this.readCanvas(id)
      const oldDir = path.relative(this.root, w.dir).split(path.sep).join('/')
      const surface = toRootRelativeFrom(parsed.markdown, oldDir).replaceAll(`${oldDir}/${ASSETS_DIR}/`, `${canvasDir(id)}/${ASSETS_DIR}/`)
      const oldAssets = path.join(w.dir, ASSETS_DIR)
      if (await exists(oldAssets)) await moveDir(oldAssets, this.resolve(`${canvasDir(id)}/${ASSETS_DIR}`))
      await this.writeCanvas({ ...stripSurface(canvas), archived: canvas.archived || parsed.archived, updatedAt: parsed.updatedAt, hasSurface: surface.length > 0 }, surface)
    }

    // Pages: the folder moves as a whole (day files keep their relative links: same depth).
    for (const d of await readdirSafe(pagesDir)) {
      if (!d.isDirectory() || !isValidCanvasId(d.name) || d.name === JOURNAL_ID) continue
      const text = await fs.readFile(path.join(pagesDir, d.name, 'page.md'), 'utf8').catch(() => '')
      const page = parseLegacyPageFile(d.name, text)
      const parentId = await ensureChain(categoryPath(page.category))
      const id = existing.has(d.name) ? uniqueSlug(d.name, existing) : d.name
      existing.add(id)
      await fs.mkdir(this.resolve(CANVASES_DIR), { recursive: true })
      await moveDir(path.join(pagesDir, d.name), this.resolve(canvasDir(id)))
      await fs.rm(this.resolve(`${canvasDir(id)}/page.md`), { force: true })
      const meta: CanvasMeta = { id, title: page.title, parentId, task: false, createdAt: page.createdAt || now.toISOString(), updatedAt: '', repos: page.repos, archived: page.archived, hasSurface: page.description.length > 0 }
      await this.writeCanvas(meta, page.description)
      created.push(id)
    }

    await fs.rm(pagesDir, { recursive: true, force: true })
    await fs.rm(catsDir, { recursive: true, force: true })
    this.emit('change', { kind: 'migration' })
    return created
  }

  // -------------------------------------------------------------------------
  // Reading notes
  // -------------------------------------------------------------------------

  async listDays(canvasId: string = JOURNAL_ID): Promise<DaySummary[]> {
    const out: DaySummary[] = []
    for (const date of await this.listDayFiles(canvasId)) {
      const day = await this.readDay(canvasId, date)
      if (day.entries.length > 0) out.push({ date, count: day.entries.length })
    }
    out.sort((a, b) => b.date.localeCompare(a.date))
    return out
  }

  async readDay(canvasId: string, date: string): Promise<Day> {
    assertCanvasId(canvasId)
    assertDate(date)
    const base = canvasEntriesBase(canvasId)
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
  async getTimeline(canvasId: string, opts: { beforeDate?: string; days?: number } = {}): Promise<Timeline> {
    assertCanvasId(canvasId)
    const limit = Math.max(1, opts.days ?? DEFAULT_TIMELINE_DAYS)
    let dates = (await this.listDayFiles(canvasId)).sort((a, b) => b.localeCompare(a))
    if (opts.beforeDate) dates = dates.filter((d) => d < opts.beforeDate!)
    const days: Day[] = []
    let i = 0
    for (; i < dates.length && days.length < limit; i++) {
      const day = await this.readDay(canvasId, dates[i])
      if (day.entries.length > 0) days.push(day)
    }
    days.reverse()
    return { canvasId, days, hasMore: i < dates.length }
  }

  /** Every day file across all canvases within [fromDate, toDate], inclusive. */
  async getRange(fromDate: string, toDate: string): Promise<Array<{ canvasId: string; day: Day }>> {
    assertDate(fromDate)
    assertDate(toDate)
    const out: Array<{ canvasId: string; day: Day }> = []
    for (const canvas of await this.listCanvases()) {
      const dates = (await this.listDayFiles(canvas.id)).filter((d) => d >= fromDate && d <= toDate).sort()
      for (const date of dates) {
        const day = await this.readDay(canvas.id, date)
        if (day.entries.length > 0) out.push({ canvasId: canvas.id, day })
      }
    }
    return out
  }

  /** Full-text search over every block (archived canvases included) and every surface. */
  async search(query: string, limit = 200): Promise<SearchResult> {
    const q = query.trim().toLowerCase()
    if (!q) return { blocks: [], surfaces: [] }
    const canvases = await this.listCanvases()
    const surfaces: SurfaceHit[] = []
    for (const meta of canvases) {
      if (!meta.hasSurface) continue
      const canvas = await this.readCanvas(meta.id)
      const idx = canvas.surface.toLowerCase().indexOf(q)
      if (idx >= 0) {
        const start = Math.max(0, idx - 60)
        surfaces.push({ canvasId: meta.id, archived: meta.archived, excerpt: previewText(canvas.surface.slice(start, idx + 120), 180) })
      }
    }
    const blocks: SearchHit[] = []
    for (const canvas of canvases) {
      const dates = (await this.listDayFiles(canvas.id)).sort((a, b) => b.localeCompare(a))
      for (const date of dates) {
        const day = await this.readDay(canvas.id, date)
        for (const entry of [...day.entries].reverse()) {
          if (entry.markdown.toLowerCase().includes(q)) {
            blocks.push({ canvasId: canvas.id, date, entry, archived: canvas.archived })
            if (blocks.length >= limit) return { blocks, surfaces }
          }
        }
      }
    }
    return { blocks, surfaces }
  }

  // -------------------------------------------------------------------------
  // Writing notes
  // -------------------------------------------------------------------------

  /**
   * Add a block to a canvas. With no position it is appended to today; a
   * position can target another day, make it a reply, or slot it between notes.
   */
  async addEntry(
    canvasId: string,
    markdown: string,
    position: EntryPosition = {},
    now: Date = new Date(),
    system?: { kind: EntryKind; meta?: Record<string, string> }
  ): Promise<{ date: string; entry: Entry }> {
    if (isBlankMarkdown(markdown)) throw new Error('Cannot add an empty entry')
    const date = position.date ?? localDate(now)
    const day = await this.readDay(canvasId, date)
    if (system?.kind === 'commit' && system.meta?.hash) {
      const dup = day.entries.find((e) => e.kind === 'commit' && e.meta?.hash === system.meta?.hash)
      if (dup) return { date, entry: dup }
    }
    const entry: Entry = {
      id: uniqueId(day.entries),
      createdAt: now.toISOString(),
      markdown: normalizeDurationMarker(markdown.trim())
    }
    if (system?.kind && system.kind !== 'note') {
      entry.kind = system.kind
      if (system.meta) entry.meta = { ...system.meta }
    }
    day.entries = insertEntry(day.entries, entry, position)
    await this.writeDay(canvasId, day)
    return { date, entry }
  }

  async updateEntry(canvasId: string, date: string, id: string, markdown: string, now: Date = new Date()): Promise<Entry> {
    const day = await this.readDay(canvasId, date)
    const entry = day.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`Entry ${id} not found on ${date}`)
    if (entry.kind === 'commit') throw new Error('Captured commits are read-only; reply, move or delete instead')
    entry.markdown = normalizeDurationMarker(markdown.trim())
    entry.updatedAt = now.toISOString()
    await this.writeDay(canvasId, day)
    return entry
  }

  /** Delete a block and every reply beneath it. Returns the number removed. */
  async deleteEntry(canvasId: string, date: string, id: string): Promise<number> {
    const day = await this.readDay(canvasId, date)
    if (!day.entries.some((e) => e.id === id)) throw new Error(`Entry ${id} not found on ${date}`)
    const removed = descendantIds(day.entries, id).size + 1
    day.entries = removeSubtree(day.entries, id)
    await this.writeDay(canvasId, day)
    return removed
  }

  /**
   * Move a block (with its thread) to another canvas, keeping its date. Images
   * stay where they are; links are rewritten relative to the new file.
   */
  async moveEntry(fromCanvasId: string, date: string, id: string, toCanvasId: string): Promise<{ date: string; entry: Entry }> {
    assertCanvasId(toCanvasId)
    if (fromCanvasId === toCanvasId) throw new Error('Block is already on that canvas')
    await this.readCanvas(toCanvasId)
    const source = await this.readDay(fromCanvasId, date)
    const root = source.entries.find((e) => e.id === id)
    if (!root) throw new Error(`Entry ${id} not found on ${date}`)
    const ids = descendantIds(source.entries, id)
    ids.add(id)
    const moving = source.entries.filter((e) => ids.has(e.id)).map((e) => ({ ...e }))
    const target = await this.readDay(toCanvasId, date)

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
    await this.writeDay(toCanvasId, target)
    await this.writeDay(fromCanvasId, source)
    return { date, entry: movedRoot }
  }

  /** Persist an image for a canvas/day; returns its repo-root-relative path. */
  async saveAsset(
    canvasId: string,
    date: string,
    bytes: Uint8Array,
    mime: string,
    originalName?: string,
    now: Date = new Date()
  ): Promise<SavedAsset> {
    assertCanvasId(canvasId)
    assertDate(date)
    return this.writeAsset(assetDir(date, canvasEntriesBase(canvasId)), bytes, mime, originalName, now)
  }

  private async writeAsset(dir: string, bytes: Uint8Array, mime: string, originalName?: string, now: Date = new Date()): Promise<SavedAsset> {
    if (bytes.byteLength === 0) throw new Error('Empty image')
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Image is larger than 25 MB')
    const ext = IMAGE_EXT_BY_MIME[mime] ?? extFromName(originalName) ?? 'png'
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

  private async writeDay(canvasId: string, day: Day): Promise<void> {
    const base = canvasEntriesBase(canvasId)
    const abs = this.resolve(dayFilePath(day.date, base))
    if (day.entries.length === 0) {
      await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await writeAtomic(abs, serializeDayFile(day, base))
    }
    this.emit('change', { kind: 'day', canvasId, date: day.date })
  }

  private async listDayFiles(canvasId: string): Promise<string[]> {
    assertCanvasId(canvasId)
    const base = this.resolve(canvasEntriesBase(canvasId))
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

function cleanRepos(repos?: string[]): string[] {
  const out: string[] = []
  for (const r of repos ?? []) {
    const t = r.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function assertDate(date: string): void {
  if (!isValidDate(date)) throw new Error(`Invalid date: ${date}`)
}

function assertCanvasId(canvasId: string): void {
  if (!isValidCanvasId(canvasId)) throw new Error(`Invalid canvas: ${canvasId}`)
}

function stripSurface(c: Canvas | CanvasMeta): CanvasMeta {
  const { surface: _s, ...meta } = c as Canvas
  return meta
}

/** A slug for `title` that is not already taken (`-2`, `-3`, …). */
function uniqueSlug(title: string, taken: Set<string>): string {
  let id = slugify(title)
  if (id === JOURNAL_ID) id = `${id}-canvas`
  const base = id
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

/** Move a directory, falling back to copy+delete across devices. */
async function moveDir(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch {
    await fs.cp(from, to, { recursive: true })
    await fs.rm(from, { recursive: true, force: true })
  }
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
