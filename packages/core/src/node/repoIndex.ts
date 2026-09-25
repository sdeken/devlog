/**
 * RepoIndex: a disposable SQLite cache of a devlog repository's metadata and
 * text, so listing canvases, finding days and searching don't have to read
 * every file. The markdown files stay the source of truth: the index can be
 * deleted at any time and is rebuilt from them.
 *
 * It is kept current two ways:
 *  - write-through: DevlogStore reports every file it writes or removes;
 *  - refresh(): a stat walk of the repository that re-reads files whose size
 *    or mtime changed (on open, and after a pull brings in other machines' work).
 */
import { rmSync, statSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  CANVAS_FILE,
  CANVASES_DIR,
  ENTRIES_DIR,
  JOURNAL_ID,
  canvasDir,
  canvasShard,
  dateFromFilePath,
  isValidCanvasId,
  localDate,
  parseBlockFile,
  parseCanvasFile,
  toRootRelativeFrom
} from '../index'
import type { CanvasMeta, Entry } from '../types'

/** Bump when the schema or what gets indexed changes: the index is then rebuilt. */
export const INDEX_SCHEMA = 2
const TODO_FILE = 'todos.md'

/** What a repository file means to the index. */
export type IndexedFile =
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'day'; canvasId: string; date: string }
  | { kind: 'todos'; canvasId: string }

/** Classify a repo-relative POSIX path; null for files the index ignores. */
export function classifyPath(rel: string): IndexedFile | null {
  const parts = rel.split('/')
  let canvasId = JOURNAL_ID
  let rest = parts
  if (parts[0] === CANVASES_DIR) {
    const [, shard, id, ...tail] = parts
    if (!id || !isValidCanvasId(id) || id === JOURNAL_ID || canvasShard(id) !== shard) return null
    if (tail.length === 1 && tail[0] === CANVAS_FILE) return { kind: 'canvas', canvasId: id }
    if (tail.length === 1 && tail[0] === TODO_FILE) return { kind: 'todos', canvasId: id }
    canvasId = id
    rest = tail
  } else if (parts[0] === ENTRIES_DIR && parts.length === 2 && parts[1] === TODO_FILE) {
    return { kind: 'todos', canvasId: JOURNAL_ID }
  }
  if (rest.length !== 4 || rest[0] !== ENTRIES_DIR || !/^\d{4}$/.test(rest[1]) || !/^\d{2}$/.test(rest[2])) return null
  const date = dateFromFilePath(rest[3])
  if (!date || !date.startsWith(`${rest[1]}-${rest[2]}`)) return null
  return { kind: 'day', canvasId, date }
}

export interface IndexedHit {
  canvasId: string
  /** The day the block is on (for todos: the day it was written). */
  date: string
  todo: boolean
  entry: Entry
}

export interface RefreshReport {
  scanned: number
  indexed: number
  removed: number
}

export class RepoIndex {
  private db: DatabaseSync
  private refreshing: Set<string> | null = null
  private refreshRun: Promise<RefreshReport> | null = null
  /** True once a refresh has completed at least once: until then callers should read the files. */
  ready = false

  private constructor(
    readonly root: string,
    db: DatabaseSync
  ) {
    this.db = db
  }

  /**
   * Open (or create) the index for `root` at `dbPath`. A database from another
   * schema version, or one that fails to open, is thrown away and rebuilt.
   */
  static open(dbPath: string, root: string): RepoIndex {
    const make = (): DatabaseSync => {
      const db = new DatabaseSync(dbPath)
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
      return db
    }
    let db: DatabaseSync
    try {
      db = make()
      const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const storedRoot = version === INDEX_SCHEMA ? (db.prepare("SELECT value FROM meta WHERE key = 'root'").get() as { value?: string } | undefined)?.value : undefined
      if (version !== INDEX_SCHEMA || storedRoot !== root) {
        db.close()
        removeDb(dbPath)
        db = make()
      }
    } catch {
      removeDb(dbPath)
      db = make()
    }
    const index = new RepoIndex(root, db)
    index.createSchema()
    index.ready = index.getMeta('complete') === '1'
    return index
  }

  close(): void {
    this.db.close()
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS canvases (
        id TEXT PRIMARY KEY, meta TEXT NOT NULL, surface TEXT NOT NULL,
        created TEXT NOT NULL, bare INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (alias, id));
      CREATE TABLE IF NOT EXISTS days (canvas TEXT NOT NULL, date TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (canvas, date));
      CREATE TABLE IF NOT EXISTS blocks (
        rowid INTEGER PRIMARY KEY, path TEXT NOT NULL, canvas TEXT NOT NULL, date TEXT NOT NULL,
        todo INTEGER NOT NULL, created TEXT NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL,
        folded TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS blocks_path ON blocks (path);
      CREATE INDEX IF NOT EXISTS blocks_date ON blocks (date, created);
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5 (markdown, content='', contentless_delete=1, tokenize='trigram');
    `)
    this.db.exec(`PRAGMA user_version = ${INDEX_SCHEMA}`)
    this.setMeta('root', this.root)
  }

  // -------------------------------------------------------------------------
  // Keeping it current
  // -------------------------------------------------------------------------

  /** Record a file's new content (null: it was deleted). Called by the store after every write. */
  noteFile(rel: string, text: string | null): void {
    this.refreshing?.add(rel)
    this.tx(() => {
      if (text === null) this.dropFile(rel)
      else this.putFile(rel, text, fileStamp(path.join(this.root, ...rel.split('/'))))
    })
  }

  /** Forget everything under a directory (a canvas that was deleted). */
  noteRemovedDir(relDir: string): void {
    const prefix = `${relDir.replace(/\/$/, '')}/`
    const paths = (this.db.prepare("SELECT path FROM files WHERE substr(path, 1, ?) = ?").all(prefix.length, prefix) as Array<{ path: string }>).map((r) => r.path)
    for (const p of paths) this.refreshing?.add(p)
    this.tx(() => {
      for (const p of paths) this.dropFile(p)
    })
  }

  /**
   * Bring the index in line with the files on disk: re-read what changed since
   * it was last indexed, drop what disappeared. Concurrent calls share one run.
   */
  refresh(): Promise<RefreshReport> {
    if (!this.refreshRun) {
      this.refreshRun = this.runRefresh().finally(() => {
        this.refreshRun = null
      })
    }
    return this.refreshRun
  }

  private async runRefresh(): Promise<RefreshReport> {
    const touched = new Set<string>()
    this.refreshing = touched
    try {
      const known = new Map((this.db.prepare('SELECT path, size, mtime FROM files').all() as Array<{ path: string; size: number; mtime: number }>).map((r) => [r.path, r]))
      const seen = new Set<string>()
      const changed: Array<{ rel: string; text: string; stamp: Stamp }> = []
      for (const { rel, abs } of await this.walk()) {
        seen.add(rel)
        const st = await fs.stat(abs).catch(() => null)
        if (!st) continue
        const prev = known.get(rel)
        if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue
        const text = await fs.readFile(abs, 'utf8').catch(() => null)
        if (text !== null) changed.push({ rel, text, stamp: { size: st.size, mtime: st.mtimeMs } })
      }
      const gone = [...known.keys()].filter((p) => !seen.has(p))
      // Apply in one transaction; skip files the store rewrote while we were reading.
      this.tx(() => {
        for (const c of changed) if (!touched.has(c.rel)) this.putFile(c.rel, c.text, c.stamp)
        for (const p of gone) if (!touched.has(p)) this.dropFile(p)
        this.setMeta('complete', '1')
      })
      this.ready = true
      return { scanned: seen.size, indexed: changed.length, removed: gone.length }
    } finally {
      this.refreshing = null
    }
  }

  /** Every file the index cares about, found by walking the known layout (not the whole repo). */
  private async walk(): Promise<Array<{ rel: string; abs: string }>> {
    const out: Array<{ rel: string; abs: string }> = []
    const add = (rel: string): void => {
      out.push({ rel, abs: path.join(this.root, ...rel.split('/')) })
    }
    const stream = async (base: string): Promise<void> => {
      const absBase = path.join(this.root, ...base.split('/'))
      for (const y of await readdirSafe(absBase)) {
        if (y.isFile() && y.name === TODO_FILE && base === ENTRIES_DIR) add(`${base}/${y.name}`)
        if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue
        for (const m of await readdirSafe(path.join(absBase, y.name))) {
          if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue
          for (const f of await readdirSafe(path.join(absBase, y.name, m.name))) {
            if (f.isFile() && dateFromFilePath(f.name)) add(`${base}/${y.name}/${m.name}/${f.name}`)
          }
        }
      }
    }
    await stream(ENTRIES_DIR)
    for (const shard of await readdirSafe(path.join(this.root, CANVASES_DIR))) {
      if (!shard.isDirectory()) continue
      for (const c of await readdirSafe(path.join(this.root, CANVASES_DIR, shard.name))) {
        if (!c.isDirectory() || !isValidCanvasId(c.name) || c.name === JOURNAL_ID || canvasShard(c.name) !== shard.name) continue
        const dir = canvasDir(c.name)
        for (const f of await readdirSafe(path.join(this.root, ...dir.split('/')))) {
          if (f.isFile() && (f.name === CANVAS_FILE || f.name === TODO_FILE)) add(`${dir}/${f.name}`)
        }
        await stream(`${dir}/${ENTRIES_DIR}`)
      }
    }
    return out.filter((f) => classifyPath(f.rel) !== null)
  }

  private putFile(rel: string, text: string, stamp: Stamp | null): void {
    const what = classifyPath(rel)
    if (!what) return
    this.dropFile(rel)
    if (stamp) this.db.prepare('INSERT OR REPLACE INTO files (path, size, mtime) VALUES (?, ?, ?)').run(rel, stamp.size, stamp.mtime)
    if (what.kind === 'canvas') {
      const { meta, surface } = parseCanvasFile(what.canvasId, text)
      const root = toRootRelativeFrom(surface, canvasDir(what.canvasId))
      this.db
        .prepare('INSERT OR REPLACE INTO canvases (id, meta, surface, created, bare) VALUES (?, ?, ?, ?, 0)')
        .run(meta.id, JSON.stringify(meta), root, meta.createdAt)
      for (const a of meta.aliases ?? []) this.db.prepare('INSERT OR IGNORE INTO aliases (alias, id) VALUES (?, ?)').run(a, meta.id)
      return
    }
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    const entries =
      what.kind === 'day' ? parseBlockFile(text, dir, `${what.date}T00:00:00.000Z`) : parseBlockFile(text, dir)
    if (what.kind === 'day' && entries.length > 0) {
      this.db.prepare('INSERT OR REPLACE INTO days (canvas, date, count) VALUES (?, ?, ?)').run(what.canvasId, what.date, entries.length)
    }
    // A canvas with blocks but no canvas.md yet still exists.
    if (what.canvasId !== JOURNAL_ID) this.ensureBareCanvas(what.canvasId)
    const insert = this.db.prepare('INSERT INTO blocks (path, canvas, date, todo, created, seq, entry, folded) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const fts = this.db.prepare('INSERT INTO blocks_fts (rowid, markdown) VALUES (?, ?)')
    entries.forEach((e, seq) => {
      const date = what.kind === 'day' ? what.date : localDate(new Date(e.createdAt))
      // Searched lower-cased the way JavaScript does it, so results match a plain file scan.
      const folded = e.markdown.toLowerCase()
      const res = insert.run(rel, what.canvasId, date, what.kind === 'todos' ? 1 : 0, e.createdAt, seq, JSON.stringify(e), folded)
      fts.run(res.lastInsertRowid, folded)
    })
  }

  private dropFile(rel: string): void {
    const what = classifyPath(rel)
    this.db.prepare('DELETE FROM files WHERE path = ?').run(rel)
    if (!what) return
    if (what.kind === 'canvas') {
      this.db.prepare('DELETE FROM canvases WHERE id = ?').run(what.canvasId)
      this.db.prepare('DELETE FROM aliases WHERE id = ?').run(what.canvasId)
      if (this.db.prepare('SELECT 1 FROM blocks WHERE canvas = ?').get(what.canvasId)) this.ensureBareCanvas(what.canvasId)
      return
    }
    if (what.kind === 'day') this.db.prepare('DELETE FROM days WHERE canvas = ? AND date = ?').run(what.canvasId, what.date)
    const rows = this.db.prepare('SELECT rowid FROM blocks WHERE path = ?').all(rel) as Array<{ rowid: number }>
    const del = this.db.prepare('DELETE FROM blocks_fts WHERE rowid = ?')
    for (const r of rows) del.run(r.rowid)
    this.db.prepare('DELETE FROM blocks WHERE path = ?').run(rel)
  }

  /** Placeholder row for a canvas folder with blocks but no canvas.md; replaced when one appears. */
  private ensureBareCanvas(id: string): void {
    if (this.db.prepare('SELECT 1 FROM canvases WHERE id = ?').get(id)) return
    const { meta } = parseCanvasFile(id, '')
    this.db.prepare('INSERT INTO canvases (id, meta, surface, created, bare) VALUES (?, ?, ?, ?, 1)').run(id, JSON.stringify(meta), '', '')
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Every canvas except the journal, in creation order. Bare canvases are dropped once they have no blocks. */
  canvases(): Array<CanvasMeta & { surface: string }> {
    const rows = this.db
      .prepare(
        `SELECT c.meta, c.surface FROM canvases c
         WHERE c.bare = 0 OR EXISTS (SELECT 1 FROM blocks b WHERE b.canvas = c.id)
         ORDER BY c.created, c.id`
      )
      .all() as Array<{ meta: string; surface: string }>
    return rows.map((r) => ({ ...(JSON.parse(r.meta) as CanvasMeta), surface: r.surface }))
  }

  /** Dates with at least one block on a canvas. */
  dates(canvasId: string): string[] {
    return (this.db.prepare('SELECT date FROM days WHERE canvas = ? ORDER BY date').all(canvasId) as Array<{ date: string }>).map((r) => r.date)
  }

  dayCounts(canvasId: string): Array<{ date: string; count: number }> {
    return this.db.prepare('SELECT date, count FROM days WHERE canvas = ? ORDER BY date DESC').all(canvasId) as Array<{ date: string; count: number }>
  }

  /** (canvas, date) pairs with blocks within [from, to]. */
  daysInRange(from: string, to: string): Array<{ canvasId: string; date: string }> {
    return (this.db.prepare('SELECT canvas, date FROM days WHERE date >= ? AND date <= ? ORDER BY date').all(from, to) as Array<{ canvas: string; date: string }>).map(
      (r) => ({ canvasId: r.canvas, date: r.date })
    )
  }

  /** Blocks (stream and todos) containing `query`, case-insensitively; newest first. */
  searchBlocks(query: string, limit: number): IndexedHit[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    let rows: Array<{ canvas: string; date: string; todo: number; entry: string }>
    if ([...q].length >= 3) {
      rows = this.db
        .prepare(
          `SELECT b.canvas, b.date, b.todo, b.entry FROM blocks_fts f JOIN blocks b ON b.rowid = f.rowid
           WHERE blocks_fts MATCH ? ORDER BY b.date DESC, b.created DESC, b.todo, b.canvas, b.seq DESC LIMIT ?`
        )
        .all(`"${q.replaceAll('"', '""')}"`, limit) as typeof rows
    } else {
      rows = this.db
        .prepare('SELECT canvas, date, todo, entry FROM blocks WHERE instr(folded, ?) > 0 ORDER BY date DESC, created DESC, todo, canvas, seq DESC LIMIT ?')
        .all(q, limit) as typeof rows
    }
    return rows.map((r) => ({ canvasId: r.canvas, date: r.date, todo: r.todo === 1, entry: JSON.parse(r.entry) as Entry }))
  }

  // -------------------------------------------------------------------------

  private getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

interface Stamp {
  size: number
  mtime: number
}

function fileStamp(abs: string): Stamp | null {
  try {
    const st = statSync(abs)
    return { size: st.size, mtime: st.mtimeMs }
  } catch {
    return null
  }
}

function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true })
    } catch {
      // ignore
    }
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
