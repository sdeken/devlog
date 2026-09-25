/**
 * Storage migrations. Run once, when a repository is opened, before anything
 * else reads it.
 *
 *   Devlog 0.2  pages/ + categories/                      → format 1
 *   format 1    canvases/<slug>/, block files v1 (0.3)    → format 3 directly
 *   format 2    canvases/<xx>/<id>/, block files v2 (0.4) → format 3
 *   format 3    canvases/<xx>/<id>/, append-only block files (op log),
 *               devlog.json { "format": 3 }, .gitattributes union merges
 *
 * The layout step (format 1 → sharded) is staged: the new `canvases/` and
 * `entries/` trees are built in `.devlog-migrate/`, then swapped in with
 * renames, and the manifest is written last. An interrupted run is rolled
 * back (or finished, if the manifest made it) the next time the repository
 * is opened. Format 2 → 3 rewrites block files in place, one atomic write
 * each; both formats are readable, so an interrupted run simply resumes.
 *
 * It is also deterministic: a migrated canvas's id is derived from its old
 * folder name, and files are re-serialised canonically. Two machines that
 * migrate the same history independently produce identical trees, so their
 * commits merge cleanly instead of duplicating every canvas.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ASSETS_DIR,
  ENTRIES_DIR,
  categoryPath,
  CANVAS_FILE,
  CANVAS_ID_ALPHABET,
  CANVAS_ID_LENGTH,
  CANVASES_DIR,
  JOURNAL_ID,
  LEGACY_CATEGORIES_DIR,
  LEGACY_PAGES_DIR,
  MANIFEST_FILE,
  SHARDED_FORMAT,
  STORAGE_FORMAT,
  canvasDir,
  canvasDirV1,
  dateFromFilePath,
  isValidCanvasId,
  legacyCategoryId,
  parseBlockFile,
  parseCanvasFile,
  parseLegacyPageFile,
  parseLegacyWikiFile,
  blockFileFormat,
  rewriteImageSrcs,
  serializeBlockFile,
  serializeCanvasFile,
  slugify,
  toRelativeFrom,
  toRootRelativeFrom
} from '../index'
import type { CanvasMeta, Entry } from '../types'
import type { SyncManager } from './sync'
import { ensureRepoFiles } from './repoFiles'

export const STAGE_DIR = '.devlog-migrate'
export const OLD_DIR = '.devlog-migrate-old'
const TODO_FILE = 'todos.md'

export interface MigrationReport {
  from: number
  to: number
  /** Canvases moved into format 2 (old id → new id). */
  canvases: Record<string, string>
  /** Block files rewritten. */
  files: number
}

export interface Manifest {
  format: number
}

/** The storage format of a repository: the manifest's, or 1 when there is none. */
export async function readStorageFormat(root: string): Promise<number> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')) as Partial<Manifest>
    return Number(m.format) || 1
  } catch {
    return 1
  }
}

export async function writeManifest(root: string): Promise<void> {
  await fs.writeFile(path.join(root, MANIFEST_FILE), `${JSON.stringify({ format: STORAGE_FORMAT }, null, 2)}\n`)
}

/** True when opening this repository will change files on disk. */
export async function needsMigration(root: string): Promise<boolean> {
  if ((await exists(path.join(root, STAGE_DIR))) || (await exists(path.join(root, OLD_DIR)))) return true
  if ((await exists(path.join(root, LEGACY_PAGES_DIR))) || (await exists(path.join(root, LEGACY_CATEGORIES_DIR)))) return true
  return (await readStorageFormat(root)) < STORAGE_FORMAT
}

/**
 * Id of a format 1 canvas in format 2: a hash of its old folder name, so every
 * machine derives the same one. `taken` resolves the (astronomically unlikely)
 * collision the same way everywhere, because callers process ids in sorted order.
 */
export function migratedCanvasId(oldId: string, taken: Set<string> = new Set()): string {
  for (let n = 0; ; n++) {
    const digest = createHash('sha256').update(`devlog-canvas:${oldId}${n ? `:${n}` : ''}`).digest()
    let id = ''
    for (let i = 0; i < CANVAS_ID_LENGTH; i++) id += CANVAS_ID_ALPHABET[digest[i] % CANVAS_ID_ALPHABET.length]
    if (!taken.has(id)) return id
  }
}

/** Bring a repository to the current storage format. Returns null when nothing had to change. */
export async function migrateRepository(root: string, now: Date = new Date()): Promise<MigrationReport | null> {
  await recoverInterruptedMigration(root)
  const from = await readStorageFormat(root)
  const legacy = (await exists(path.join(root, LEGACY_PAGES_DIR))) || (await exists(path.join(root, LEGACY_CATEGORIES_DIR)))
  if (from >= STORAGE_FORMAT && !legacy) return null
  if (legacy) await migrateLegacyToV1(root, now)
  if (from >= STORAGE_FORMAT) return { from, to: from, canvases: {}, files: 0 }
  const report = from < SHARDED_FORMAT ? await migrateLayout(root) : await migrateBlockFiles(root)
  return { ...report, from }
}

export interface UpgradeResult {
  report: MigrationReport | null
  /** How the remote's history was brought in: pulled before migrating, or merged after. */
  remote: 'none' | 'pulled' | 'merged' | 'merge-failed'
  error?: string
}

/**
 * Open-time upgrade of a repository that syncs through git. Nothing happens
 * when the repository is already current.
 *
 *  - If the remote has not been upgraded yet (or cannot be reached), pull
 *    first so the migration covers the latest history, then migrate and commit.
 *  - If another machine already pushed the upgrade and this one has nothing
 *    unsynced, pulling is all it takes.
 *  - If the remote was upgraded while this machine has unsynced old-format
 *    work, replaying that work onto the moved files would splice old-format
 *    text into them (git follows the renames). Instead, merge the remote's
 *    last old-format commit (an ordinary merge, like any sync), migrate the
 *    result, mark the remote's migration commit as merged without taking its
 *    tree (ours is the same migration of a superset of its history), and
 *    then merge the remote: everything is in the new layout on both sides by
 *    then, so it is an ordinary merge too.
 */
export async function upgradeRepository(root: string, sync: SyncManager, now: Date = new Date()): Promise<UpgradeResult> {
  await recoverInterruptedMigration(root)
  if (!(await needsMigration(root))) return { report: null, remote: 'none' }
  const remoteManifest = await sync.readRemoteFile(MANIFEST_FILE)
  const remoteFormat = remoteManifest === null ? 1 : Number((safeJson(remoteManifest) as Partial<Manifest>).format) || 1
  const remoteRef = remoteFormat >= STORAGE_FORMAT ? await sync.fetchRemoteRef() : null
  const upgradeCommit = remoteRef ? await sync.firstCommitMatching(remoteRef, MANIFEST_FILE, `"format": ${STORAGE_FORMAT}`) : null

  if (!remoteRef || !upgradeCommit || !(await sync.hasUnsyncedWork())) {
    const pulled = await sync.syncNow('startup')
    const report = await migrateRepository(root, now)
    if (report) await sync.commitAll(`devlog: migrate to storage format ${report.to}`)
    // A failed pull was backed out; the next sync reports it again.
    return { report, remote: pulled.pulled ? 'pulled' : 'none', error: pulled.error }
  }

  await sync.commitAll('devlog: save work from before the storage upgrade')
  const lastOld = await sync.parentOf(upgradeCommit)
  if (lastOld) {
    const pre = await sync.mergeRef(lastOld, { message: 'devlog: merge other machines\' work from before the storage upgrade' })
    if (pre.error) {
      throw new Error(
        `This devlog was upgraded on another machine, and this machine has changes from before the upgrade that conflict with it. Merge ${lastOld.slice(0, 10)} into this repository with git, then open it again. (${pre.error})`
      )
    }
  }
  const report = await migrateRepository(root, now)
  if (report) await sync.commitAll(`devlog: migrate to storage format ${report.to}`)
  const adopt = await sync.mergeRef(upgradeCommit, { ours: true, message: 'devlog: adopt the storage upgrade made on another machine' })
  if (adopt.error) return { report, remote: 'merge-failed', error: adopt.error }
  const merged = await sync.mergeRef(remoteRef)
  return { report, remote: merged.merged ? 'merged' : 'merge-failed', error: merged.error }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Undo (or finish) a format 1 → 2 migration that was interrupted part way through. */
export async function recoverInterruptedMigration(root: string): Promise<'none' | 'rolled-back' | 'completed'> {
  const old = path.join(root, OLD_DIR)
  const stage = path.join(root, STAGE_DIR)
  let outcome: 'none' | 'rolled-back' | 'completed' = 'none'
  if (await exists(old)) {
    if ((await readStorageFormat(root)) >= SHARDED_FORMAT) {
      outcome = 'completed' // the manifest is written after the swap: only cleanup was left
    } else {
      for (const name of [CANVASES_DIR, ENTRIES_DIR]) {
        if (await exists(path.join(old, name))) {
          await fs.rm(path.join(root, name), { recursive: true, force: true })
          await fs.rename(path.join(old, name), path.join(root, name))
        }
      }
      outcome = 'rolled-back'
    }
    await fs.rm(old, { recursive: true, force: true })
  }
  await fs.rm(stage, { recursive: true, force: true })
  return outcome
}

// ---------------------------------------------------------------------------
// format 2 → format 3: block files become append-only logs
// ---------------------------------------------------------------------------

async function migrateBlockFiles(root: string): Promise<Omit<MigrationReport, 'from'>> {
  await ensureRepoFiles(root)
  let files = 0
  const rewrite = async (rel: string, title: string, fallback?: string): Promise<void> => {
    const abs = path.join(root, ...rel.split('/'))
    const text = await fs.readFile(abs, 'utf8')
    if (blockFileFormat(text) >= 3) return
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    const tmp = `${abs}.migrate.tmp`
    await fs.writeFile(tmp, serializeBlockFile(parseBlockFile(text, dir, fallback), dir, title))
    await fs.rename(tmp, abs)
    files++
  }
  const stream = async (base: string): Promise<void> => {
    const absBase = path.join(root, ...base.split('/'))
    for (const y of await readdirSafe(absBase)) {
      if (y.isFile() && y.name === TODO_FILE) await rewrite(`${base}/${y.name}`, '# Todos')
      if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue
      for (const m of await readdirSafe(path.join(absBase, y.name))) {
        if (!m.isDirectory()) continue
        for (const f of await readdirSafe(path.join(absBase, y.name, m.name))) {
          const date = f.isFile() ? dateFromFilePath(f.name) : null
          if (date) await rewrite(`${base}/${y.name}/${m.name}/${f.name}`, `# ${date}`, `${date}T00:00:00.000Z`)
        }
      }
    }
  }
  await stream(ENTRIES_DIR)
  for (const shard of await readdirSafe(path.join(root, CANVASES_DIR))) {
    if (!shard.isDirectory()) continue
    for (const c of await readdirSafe(path.join(root, CANVASES_DIR, shard.name))) {
      if (!c.isDirectory()) continue
      const dir = `${CANVASES_DIR}/${shard.name}/${c.name}`
      if (await exists(path.join(root, CANVASES_DIR, shard.name, c.name, TODO_FILE))) await rewrite(`${dir}/${TODO_FILE}`, '# Todos')
      await stream(`${dir}/${ENTRIES_DIR}`)
    }
  }
  await writeManifest(root)
  return { to: STORAGE_FORMAT, canvases: {}, files }
}

// ---------------------------------------------------------------------------
// format 1 → sharded layout (and format 3 block files)
// ---------------------------------------------------------------------------

async function migrateLayout(root: string): Promise<Omit<MigrationReport, 'from'>> {
  await ensureRepoFiles(root)
  const stage = path.join(root, STAGE_DIR)
  await fs.rm(stage, { recursive: true, force: true })
  await fs.mkdir(stage, { recursive: true })

  // Every format 1 canvas: a folder directly under canvases/ with a canvas.md or an entries/ folder.
  const oldIds: string[] = []
  for (const d of await readdirSafe(path.join(root, CANVASES_DIR))) {
    if (!d.isDirectory() || !isValidCanvasId(d.name) || d.name === JOURNAL_ID) continue
    const dir = path.join(root, CANVASES_DIR, d.name)
    if ((await exists(path.join(dir, CANVAS_FILE))) || (await exists(path.join(dir, ENTRIES_DIR)))) oldIds.push(d.name)
  }
  oldIds.sort()
  const idMap = new Map<string, string>()
  const taken = new Set<string>()
  for (const old of oldIds) {
    const id = migratedCanvasId(old, taken)
    taken.add(id)
    idMap.set(old, id)
  }
  const mapId = (id: string | undefined | null): string | undefined => (id ? (idMap.get(id) ?? id) : undefined)
  // Image paths move with their canvas: canvases/<old>/… → canvases/<xx>/<new>/…
  const mapSrc = (src: string): string => {
    const m = /^canvases\/([^/]+)\/(.*)$/.exec(src)
    if (!m || !idMap.has(m[1])) return src
    return `${canvasDir(idMap.get(m[1])!)}/${m[2]}`
  }
  const rewrite = (entries: Entry[]): Entry[] =>
    entries.map((e) => {
      const next: Entry = { ...e, markdown: rewriteImageSrcs(e.markdown, mapSrc) }
      if (e.meta) {
        next.meta = { ...e.meta }
        if (next.meta.canvas) next.meta.canvas = mapId(next.meta.canvas)!
        if (next.meta.task) next.meta.task = mapId(next.meta.task)!
      }
      return next
    })

  let files = 0
  // A block file (day file or todo list) read at its old directory and written at its new one.
  const moveBlockFile = async (srcAbs: string, fromDir: string, destAbs: string, toDir: string, title: string): Promise<void> => {
    const entries = rewrite(parseBlockFile(await fs.readFile(srcAbs, 'utf8'), fromDir))
    await fs.mkdir(path.dirname(destAbs), { recursive: true })
    await fs.writeFile(destAbs, serializeBlockFile(entries, toDir, title))
    files++
  }
  const copyStream = async (srcBase: string, fromBase: string, destBase: string, toBase: string): Promise<void> => {
    // srcBase/destBase: absolute entries/ folders; fromBase/toBase: their repo-relative paths.
    for (const y of await readdirSafe(srcBase)) {
      if (y.isFile() && y.name === TODO_FILE) {
        await moveBlockFile(path.join(srcBase, y.name), fromBase, path.join(destBase, y.name), toBase, '# Todos')
        continue
      }
      if (!y.isDirectory()) continue
      if (!/^\d{4}$/.test(y.name)) {
        await fs.cp(path.join(srcBase, y.name), path.join(destBase, y.name), { recursive: true })
        continue
      }
      for (const m of await readdirSafe(path.join(srcBase, y.name))) {
        if (!m.isDirectory()) continue
        const srcMonth = path.join(srcBase, y.name, m.name)
        const destMonth = path.join(destBase, y.name, m.name)
        for (const f of await readdirSafe(srcMonth)) {
          const date = f.isFile() ? dateFromFilePath(f.name) : null
          if (date) {
            await moveBlockFile(path.join(srcMonth, f.name), `${fromBase}/${y.name}/${m.name}`, path.join(destMonth, f.name), `${toBase}/${y.name}/${m.name}`, `# ${date}`)
          } else if (f.isDirectory()) {
            await fs.cp(path.join(srcMonth, f.name), path.join(destMonth, f.name), { recursive: true })
          } else {
            await fs.mkdir(destMonth, { recursive: true })
            await fs.copyFile(path.join(srcMonth, f.name), path.join(destMonth, f.name))
          }
        }
      }
    }
  }

  // Canvases.
  for (const old of oldIds) {
    const id = idMap.get(old)!
    const srcDir = path.join(root, CANVASES_DIR, old)
    const destDir = path.join(stage, ...canvasDir(id).split('/'))
    await fs.mkdir(destDir, { recursive: true })
    for (const d of await readdirSafe(srcDir)) {
      if (d.name === CANVAS_FILE || d.name === ENTRIES_DIR) continue
      await fs.cp(path.join(srcDir, d.name), path.join(destDir, d.name), { recursive: true })
    }
    const text = await fs.readFile(path.join(srcDir, CANVAS_FILE), 'utf8').catch(() => '')
    const { meta, surface } = parseCanvasFile(old, text)
    const surfaceRoot = rewriteImageSrcs(toRootRelativeFrom(surface, canvasDirV1(old)), mapSrc)
    const next: CanvasMeta = {
      ...meta,
      id,
      parentId: meta.parentId ? (idMap.get(meta.parentId) ?? null) : null,
      aliases: [...(meta.aliases ?? []), old]
    }
    await fs.writeFile(path.join(destDir, CANVAS_FILE), serializeCanvasFile(next, toRelativeFrom(surfaceRoot, canvasDir(id))))
    await copyStream(path.join(srcDir, ENTRIES_DIR), `${canvasDirV1(old)}/${ENTRIES_DIR}`, path.join(destDir, ENTRIES_DIR), `${canvasDir(id)}/${ENTRIES_DIR}`)
    if (await exists(path.join(srcDir, TODO_FILE))) {
      await moveBlockFile(path.join(srcDir, TODO_FILE), canvasDirV1(old), path.join(destDir, TODO_FILE), canvasDir(id), '# Todos')
    }
  }
  // The journal: same place, rewritten (new format, references to moved canvases).
  await copyStream(path.join(root, ENTRIES_DIR), ENTRIES_DIR, path.join(stage, ENTRIES_DIR), ENTRIES_DIR)
  await fs.mkdir(path.join(stage, ENTRIES_DIR), { recursive: true })

  // Swap in: old trees aside, staged trees into place, manifest last, then clean up.
  const old = path.join(root, OLD_DIR)
  await fs.mkdir(old, { recursive: true })
  for (const name of [CANVASES_DIR, ENTRIES_DIR]) {
    if (await exists(path.join(root, name))) await fs.rename(path.join(root, name), path.join(old, name))
  }
  for (const name of [CANVASES_DIR, ENTRIES_DIR]) {
    if (await exists(path.join(stage, name))) await fs.rename(path.join(stage, name), path.join(root, name))
  }
  await writeManifest(root)
  await fs.rm(old, { recursive: true, force: true })
  await fs.rm(stage, { recursive: true, force: true })
  return { to: STORAGE_FORMAT, canvases: Object.fromEntries(idMap), files }
}

// ---------------------------------------------------------------------------
// Devlog 0.2 (pages/ + categories/) → format 1
// ---------------------------------------------------------------------------

/**
 * Turn legacy pages and category wikis into format 1 canvases
 * (`canvases/<slug>/`); the format 2 step then takes it from there.
 */
async function migrateLegacyToV1(root: string, now: Date): Promise<void> {
  const pagesDir = path.join(root, LEGACY_PAGES_DIR)
  const catsDir = path.join(root, LEGACY_CATEGORIES_DIR)
  const existing = new Set((await readdirSafe(path.join(root, CANVASES_DIR))).filter((d) => d.isDirectory()).map((d) => d.name))
  const metas = new Map<string, { meta: CanvasMeta; surface: string }>()
  const byPath = new Map<string, string>()
  const write = async (id: string): Promise<void> => {
    const { meta, surface } = metas.get(id)!
    const dir = path.join(root, ...canvasDirV1(id).split('/'))
    await fs.mkdir(path.join(dir, ENTRIES_DIR), { recursive: true })
    await fs.writeFile(path.join(dir, CANVAS_FILE), serializeCanvasFile(meta, toRelativeFrom(surface, canvasDirV1(id))))
  }
  const ensureChain = async (segments: string[]): Promise<string | null> => {
    let parentId: string | null = null
    for (let i = 1; i <= segments.length; i++) {
      const key = segments.slice(0, i).join(' / ').toLowerCase()
      let id = byPath.get(key)
      if (!id) {
        id = uniqueSlug(legacyCategoryId(segments.slice(0, i)), existing)
        existing.add(id)
        byPath.set(key, id)
        metas.set(id, { meta: { id, title: segments[i - 1], parentId, task: false, createdAt: now.toISOString(), updatedAt: '', repos: [], archived: false, hasSurface: false }, surface: '' })
        await write(id)
      }
      parentId = id
    }
    return parentId
  }

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
    const parsed = parseLegacyWikiFile(await fs.readFile(path.join(w.dir, 'wiki.md'), 'utf8').catch(() => ''), w.rel)
    const id = await ensureChain(parsed.path)
    if (!id) continue
    const oldDir = path.relative(root, w.dir).split(path.sep).join('/')
    const surface = toRootRelativeFrom(parsed.markdown, oldDir).replaceAll(`${oldDir}/${ASSETS_DIR}/`, `${canvasDirV1(id)}/${ASSETS_DIR}/`)
    const oldAssets = path.join(w.dir, ASSETS_DIR)
    if (await exists(oldAssets)) await moveDir(oldAssets, path.join(root, ...canvasDirV1(id).split('/'), ASSETS_DIR))
    const entry = metas.get(id)!
    entry.meta = { ...entry.meta, archived: entry.meta.archived || parsed.archived, updatedAt: parsed.updatedAt, hasSurface: surface.length > 0 }
    entry.surface = surface
    await write(id)
  }

  for (const d of await readdirSafe(pagesDir)) {
    if (!d.isDirectory() || !isValidCanvasId(d.name) || d.name === JOURNAL_ID) continue
    const page = parseLegacyPageFile(d.name, await fs.readFile(path.join(pagesDir, d.name, 'page.md'), 'utf8').catch(() => ''))
    const parentId = await ensureChain(categoryPath(page.category))
    const id = existing.has(d.name) ? uniqueSlug(d.name, existing) : d.name
    existing.add(id)
    const dir = path.join(root, ...canvasDirV1(id).split('/'))
    await moveDir(path.join(pagesDir, d.name), dir)
    await fs.rm(path.join(dir, 'page.md'), { force: true })
    metas.set(id, {
      meta: { id, title: page.title, parentId, task: false, createdAt: page.createdAt || now.toISOString(), updatedAt: '', repos: page.repos, archived: page.archived, hasSurface: page.description.length > 0 },
      surface: page.description
    })
    await write(id)
  }

  await fs.rm(pagesDir, { recursive: true, force: true })
  await fs.rm(catsDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------

function uniqueSlug(title: string, taken: Set<string>): string {
  let id = slugify(title)
  if (id === JOURNAL_ID) id = `${id}-canvas`
  const base = id
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

async function moveDir(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch {
    await fs.cp(from, to, { recursive: true })
    await fs.rm(from, { recursive: true, force: true })
  }
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

