/**
 * DevlogStore: reads and writes the markdown files and attachments inside a
 * devlog repository. It knows nothing about git or Electron.
 *
 * Content is organised in canvases. The journal is the built-in root canvas
 * whose stream lives at `entries/`; every other canvas lives under
 * `canvases/<xx>/<id>/` (xx = the id's first two characters) with a
 * `canvas.md` (metadata + surface) and its own `entries/` tree in the same
 * day-file format.
 *
 * This assumes storage format 2; open older repositories through
 * `migrateRepository()` first.
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
  moveSubtree,
  newEntryId,
  normalizeDurationMarker,
  parseBlockFile,
  parseDayFile,
  previewText,
  removeSubtree,
  serializeBlockFile,
  serializeDayFile,
  titleFromMarkdown,
  toRelativeFrom,
  toRootRelativeFrom
} from '../index'
import {
  CANVASES_DIR,
  JOURNAL,
  JOURNAL_ID,
  LEGACY_CATEGORIES_DIR,
  LEGACY_PAGES_DIR,
  MANIFEST_FILE,
  STORAGE_FORMAT,
  canvasDir,
  canvasEntriesBase,
  canvasFilePath,
  canvasShard,
  descendantCanvasIds,
  isValidCanvasId,
  isWithin,
  newCanvasId,
  parseCanvasFile,
  serializeCanvasFile
} from '../index'
import type { RepoIndex } from './repoIndex'
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
} from '../types'

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
  private index: RepoIndex | null = null

  constructor(readonly root: string) {
    super()
  }

  /**
   * Serve listings and search from `index` (once it has been built) and keep
   * it current with every write. Pass null to go back to reading the files.
   */
  attachIndex(index: RepoIndex | null): void {
    this.index = index
  }

  private get liveIndex(): RepoIndex | null {
    return this.index?.ready ? this.index : null
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

  /**
   * Absolute path of a file the UI may display (an image in a block or
   * surface). Refuses anything outside the repository or inside `.git`.
   */
  resolveAsset(repoRel: string): string {
    if (!repoRel || repoRel.includes('\0') || repoRel.split('/').some((seg) => seg === '.git' || seg === '..')) {
      throw new Error('Not an asset path')
    }
    return this.resolve(repoRel)
  }

  /** Create the on-disk skeleton for a new devlog (idempotent). */
  async initLayout(): Promise<void> {
    // A repository with no devlog content yet starts at the current format;
    // anything older is left for migrateRepository() to upgrade.
    if (!(await exists(path.join(this.root, MANIFEST_FILE))) && !(await this.hasContent())) {
      await fs.writeFile(path.join(this.root, MANIFEST_FILE), `${JSON.stringify({ format: STORAGE_FORMAT }, null, 2)}\n`)
    }
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
          `- Canvases (clients, projects, tasks, …) live in \`${CANVASES_DIR}/<xx>/<id>/\` (xx = the first two characters of the id) with a \`canvas.md\` (metadata + surface) and their own \`entries/\`.`,
          `- \`${MANIFEST_FILE}\` records the storage format; the Devlog app upgrades older layouts when it opens the repository.`,
          `- Pasted images live next to the notes in an \`${ASSETS_DIR}/\` folder.`,
          '- Every block is delimited by a `<!-- devlog:entry … -->` comment that carries its id, parent and timestamps.',
          ''
        ].join('\n')
      )
    }
    const gitignore = path.join(this.root, '.gitignore')
    if (!(await exists(gitignore))) {
      await fs.writeFile(gitignore, ['.DS_Store', 'Thumbs.db', '.devlog-migrate/', '.devlog-migrate-old/', ''].join('\n'))
    }
  }

  private async hasContent(): Promise<boolean> {
    for (const dir of [CANVASES_DIR, LEGACY_PAGES_DIR, LEGACY_CATEGORIES_DIR]) {
      if ((await readdirSafe(path.join(this.root, dir))).length > 0) return true
    }
    return (await readdirSafe(path.join(this.root, ENTRIES_DIR))).some((d) => d.isDirectory() || d.name === 'todos.md')
  }

  // -------------------------------------------------------------------------
  // Canvases
  // -------------------------------------------------------------------------

  async listCanvases(): Promise<CanvasMeta[]> {
    const index = this.liveIndex
    if (index) return [{ ...JOURNAL }, ...index.canvases().map(stripSurface)]
    const out: CanvasMeta[] = [{ ...JOURNAL }]
    const dir = path.join(this.root, CANVASES_DIR)
    for (const shard of await readdirSafe(dir)) {
      if (!shard.isDirectory()) continue
      for (const d of await readdirSafe(path.join(dir, shard.name))) {
        if (!d.isDirectory() || !isValidCanvasId(d.name) || d.name === JOURNAL_ID || canvasShard(d.name) !== shard.name) continue
        const c = await this.readCanvas(d.name).catch(() => null)
        if (c) out.push(stripSurface(c))
      }
    }
    out.sort((a, b) => (a.id === JOURNAL_ID ? -1 : b.id === JOURNAL_ID ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
    return out
  }

  /** Old canvas ids (from before the format 2 migration, or merged canvases) → current ids. */
  async aliasMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    for (const c of await this.listCanvases()) for (const a of c.aliases ?? []) map.set(a, c.id)
    return map
  }

  /** The current id for `id`, following aliases; null when no such canvas exists. */
  async resolveCanvasId(id: string): Promise<string | null> {
    if (id === JOURNAL_ID) return id
    const all = await this.listCanvases()
    if (all.some((c) => c.id === id)) return id
    return all.find((c) => c.aliases?.includes(id))?.id ?? null
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
    let id = newCanvasId()
    while (existing.has(id) || (await exists(this.resolve(canvasDir(id))))) id = newCanvasId()
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
      this.index?.noteRemovedDir(canvasDir(target))
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
    if (entry.kind === 'commit' || entry.kind === 'done') throw new Error('An automatic block cannot become a task')
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
    const text = serializeCanvasFile(meta, toRelativeFrom(surface, canvasDir(meta.id)))
    await writeAtomic(abs, text)
    this.index?.noteFile(canvasFilePath(meta.id), text)
    this.emit('change', { kind: 'canvas', canvasId: meta.id })
  }

  // -------------------------------------------------------------------------
  // Todos: a per-canvas list of todo blocks (with reply threads) in todos.md
  // -------------------------------------------------------------------------

  private todoDir(canvasId: string): string {
    return canvasId === JOURNAL_ID ? ENTRIES_DIR : canvasDir(canvasId)
  }

  private todoPath(canvasId: string): string {
    return `${this.todoDir(canvasId)}/todos.md`
  }

  /** The canvas's todo list in file order (open and done), replies included. */
  async readTodos(canvasId: string): Promise<Entry[]> {
    assertCanvasId(canvasId)
    try {
      return parseBlockFile(await fs.readFile(this.resolve(this.todoPath(canvasId)), 'utf8'), this.todoDir(canvasId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  private async writeTodos(canvasId: string, entries: Entry[]): Promise<void> {
    const abs = this.resolve(this.todoPath(canvasId))
    if (entries.length === 0) {
      await fs.rm(abs, { force: true })
      this.index?.noteFile(this.todoPath(canvasId), null)
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const text = serializeBlockFile(entries, this.todoDir(canvasId), '# Todos')
      await writeAtomic(abs, text)
      this.index?.noteFile(this.todoPath(canvasId), text)
    }
    this.emit('change', { kind: 'todos', canvasId })
  }

  /** Append todos (one per string) to the end of the canvas's list. */
  async addTodos(canvasId: string, texts: string[], now: Date = new Date()): Promise<Entry[]> {
    if (canvasId !== JOURNAL_ID) await this.readCanvas(canvasId)
    const list = await this.readTodos(canvasId)
    const added: Entry[] = []
    for (const t of texts.map((x) => x.trim()).filter(Boolean)) {
      const entry: Entry = { id: uniqueId([...list, ...added]), createdAt: now.toISOString(), kind: 'todo', markdown: t }
      added.push(entry)
    }
    if (added.length === 0) throw new Error('Nothing to add')
    await this.writeTodos(canvasId, [...list, ...added])
    return added
  }

  /** Comment on a todo (or on a comment in its thread). */
  async addTodoReply(canvasId: string, parentId: string, markdown: string, now: Date = new Date()): Promise<Entry> {
    if (isBlankMarkdown(markdown)) throw new Error('Cannot add an empty comment')
    const list = await this.readTodos(canvasId)
    const entry: Entry = { id: uniqueId(list), createdAt: now.toISOString(), markdown: markdown.trim() }
    await this.writeTodos(canvasId, insertEntry(list, entry, { parentId }))
    return entry
  }

  async updateTodoEntry(canvasId: string, id: string, markdown: string, now: Date = new Date()): Promise<Entry> {
    const list = await this.readTodos(canvasId)
    const entry = list.find((e) => e.id === id)
    if (!entry) throw new Error('Todo not found')
    if (isBlankMarkdown(markdown)) throw new Error('A todo needs some text')
    entry.markdown = markdown.trim()
    entry.updatedAt = now.toISOString()
    await this.writeTodos(canvasId, list)
    return entry
  }

  /** Delete a todo (or a comment) and its thread. */
  async deleteTodoEntry(canvasId: string, id: string): Promise<number> {
    const list = await this.readTodos(canvasId)
    if (!list.some((e) => e.id === id)) throw new Error('Todo not found')
    const removed = descendantIds(list, id).size + 1
    await this.writeTodos(canvasId, removeSubtree(list, id))
    return removed
  }

  async reorderTodo(canvasId: string, id: string, position: { afterId?: string; beforeId?: string }): Promise<Entry[]> {
    const list = moveSubtree(await this.readTodos(canvasId), id, position)
    await this.writeTodos(canvasId, list)
    return list
  }

  /**
   * Tick a todo off (or back on). Ticking writes a read-only "done" block into
   * today's stream on the same canvas; unticking the same day removes it again.
   */
  async setTodoDone(canvasId: string, id: string, done: boolean, now: Date = new Date()): Promise<{ todo: Entry; date: string }> {
    const list = await this.readTodos(canvasId)
    const todo = list.find((e) => e.id === id && e.kind === 'todo')
    if (!todo) throw new Error('Todo not found')
    const date = localDate(now)
    if (done) {
      if (todo.meta?.done) return { todo, date }
      todo.meta = { ...(todo.meta ?? {}), done: now.toISOString() }
      await this.writeTodos(canvasId, list)
      await this.addEntry(canvasId, `✓ ${todoTitle(todo.markdown)}`, { date }, now, { kind: 'done', meta: { todo: id } })
    } else {
      if (!todo.meta?.done) return { todo, date }
      const { done: _d, ...rest } = todo.meta
      todo.meta = Object.keys(rest).length ? rest : undefined
      await this.writeTodos(canvasId, list)
      const day = await this.readDay(canvasId, date)
      const mark = day.entries.find((e) => e.kind === 'done' && e.meta?.todo === id)
      if (mark) {
        day.entries = removeSubtree(day.entries, mark.id)
        await this.writeDay(canvasId, day)
      }
    }
    return { todo, date }
  }

  /**
   * A todo that turned out to be real work: make it a task canvas beneath this
   * one, record a task block in today's stream, and close the todo.
   */
  async promoteTodo(canvasId: string, id: string, now: Date = new Date()): Promise<PromoteResult> {
    const list = await this.readTodos(canvasId)
    const todo = list.find((e) => e.id === id && e.kind === 'todo')
    if (!todo) throw new Error('Todo not found')
    const canvas = await this.createCanvas({ title: titleFromMarkdown(todo.markdown), parentId: canvasId === JOURNAL_ID ? null : canvasId, task: true }, now)
    todo.meta = { ...(todo.meta ?? {}), done: now.toISOString(), task: canvas.id }
    await this.writeTodos(canvasId, list)
    const { entry } = await this.addEntry(canvasId, todo.markdown, { date: localDate(now) }, now)
    const day = await this.readDay(canvasId, localDate(now))
    const block = day.entries.find((e) => e.id === entry.id)!
    block.kind = 'task'
    block.meta = { canvas: canvas.id }
    await this.writeDay(canvasId, day)
    return { canvas, entry: block }
  }

  // -------------------------------------------------------------------------
  // Reading notes
  // -------------------------------------------------------------------------

  async listDays(canvasId: string = JOURNAL_ID): Promise<DaySummary[]> {
    const index = this.liveIndex
    if (index) {
      assertCanvasId(canvasId)
      return index.dayCounts(canvasId)
    }
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

  /**
   * Case-insensitive search over every block and todo (archived canvases
   * included, newest first) and every surface.
   */
  async search(query: string, limit = 200): Promise<SearchResult> {
    const q = query.trim().toLowerCase()
    if (!q) return { blocks: [], surfaces: [] }
    const index = this.liveIndex
    const canvases = index ? [{ ...JOURNAL, surface: '' }, ...index.canvases()] : await this.readAllCanvases()
    const archived = new Map(canvases.map((c) => [c.id, c.archived]))
    const surfaces: SurfaceHit[] = []
    for (const canvas of canvases) {
      const idx = canvas.surface.toLowerCase().indexOf(q)
      if (idx >= 0) {
        const start = Math.max(0, idx - 60)
        surfaces.push({ canvasId: canvas.id, archived: canvas.archived, excerpt: previewText(canvas.surface.slice(start, idx + 120), 180) })
      }
    }
    if (index) {
      const blocks = index.searchBlocks(q, limit).map((h) => ({ canvasId: h.canvasId, date: h.date, entry: h.entry, archived: archived.get(h.canvasId) ?? false }))
      return { blocks, surfaces }
    }
    const hits: Array<SearchHit & { seq: number; todo: number }> = []
    for (const canvas of canvases) {
      ;(await this.readTodos(canvas.id)).forEach((entry, seq) => {
        if (entry.markdown.toLowerCase().includes(q)) hits.push({ canvasId: canvas.id, date: localDate(new Date(entry.createdAt)), entry, archived: canvas.archived, seq, todo: 1 })
      })
      for (const date of await this.listDayFiles(canvas.id)) {
        ;(await this.readDay(canvas.id, date)).entries.forEach((entry, seq) => {
          if (entry.markdown.toLowerCase().includes(q)) hits.push({ canvasId: canvas.id, date, entry, archived: canvas.archived, seq, todo: 0 })
        })
      }
    }
    // Same order as the index: newest day, newest block, stream before todos, canvas, later in the file.
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
    hits.sort(
      (x, y) => cmp(y.date, x.date) || cmp(y.entry.createdAt, x.entry.createdAt) || x.todo - y.todo || cmp(x.canvasId, y.canvasId) || y.seq - x.seq
    )
    return { blocks: hits.slice(0, limit).map(({ seq: _s, todo: _t, ...h }) => h), surfaces }
  }

  private async readAllCanvases(): Promise<Canvas[]> {
    const out: Canvas[] = []
    for (const meta of await this.listCanvases()) {
      out.push(meta.id === JOURNAL_ID ? { ...meta, surface: '' } : meta.hasSurface ? await this.readCanvas(meta.id) : { ...meta, surface: '' })
    }
    return out
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
    if (entry.kind === 'commit' || entry.kind === 'done') throw new Error('Automatic blocks are read-only; reply, move or delete instead')
    entry.markdown = normalizeDurationMarker(markdown.trim())
    entry.updatedAt = now.toISOString()
    await this.writeDay(canvasId, day)
    return entry
  }

  /** Hide (or reveal) a block. Hidden blocks stay in the file and in search; the stream collapses them. */
  async setEntryHidden(canvasId: string, date: string, id: string, hidden: boolean): Promise<Entry> {
    const day = await this.readDay(canvasId, date)
    const entry = day.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`Entry ${id} not found on ${date}`)
    if (hidden) entry.hidden = true
    else delete entry.hidden
    await this.writeDay(canvasId, day)
    return entry
  }

  /** Reorder a top-level block (with its thread) within its day. */
  async reorderEntry(canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }): Promise<Day> {
    const day = await this.readDay(canvasId, date)
    day.entries = moveSubtree(day.entries, id, position)
    await this.writeDay(canvasId, day)
    return day
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
    const rel = dayFilePath(day.date, base)
    const abs = this.resolve(rel)
    if (day.entries.length === 0) {
      await fs.rm(abs, { force: true })
      this.index?.noteFile(rel, null)
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const text = serializeDayFile(day, base)
      await writeAtomic(abs, text)
      this.index?.noteFile(rel, text)
    }
    this.emit('change', { kind: 'day', canvasId, date: day.date })
  }

  private async listDayFiles(canvasId: string): Promise<string[]> {
    assertCanvasId(canvasId)
    const index = this.liveIndex
    if (index) return index.dates(canvasId)
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

/** First line of a todo as plain text, for the "done" block. */
function todoTitle(markdown: string): string {
  return previewText(markdown.split('\n')[0] ?? markdown, 200)
}

function assertCanvasId(canvasId: string): void {
  if (!isValidCanvasId(canvasId)) throw new Error(`Invalid canvas: ${canvasId}`)
}

function stripSurface(c: Canvas | CanvasMeta): CanvasMeta {
  const { surface: _s, ...meta } = c as Canvas
  return meta
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
