/**
 * The repository manifest, `devlog.json`: `{ "format": 3 }`, the storage
 * format the repository is in. This version of Devlog reads and writes
 * format 3 only; older repositories must be opened once with Devlog 0.5,
 * which upgrades them.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { LOCK_FILE, MANIFEST_FILE, STORAGE_FORMAT } from '../index'

/** The storage format recorded in the manifest, or null when there is no (readable) manifest. */
export async function readStorageFormat(root: string): Promise<number | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')) as { format?: unknown }
    const n = Number(m.format)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Refuse a repository this version cannot safely read or write: one from
 * before format 3, or one written by a newer Devlog. Call after
 * `DevlogStore.initLayout()`, which stamps new, empty repositories.
 */
export async function assertSupportedFormat(root: string): Promise<void> {
  const format = await readStorageFormat(root)
  if (format === STORAGE_FORMAT) return
  if (format !== null && format > STORAGE_FORMAT) {
    throw new Error(`This devlog uses storage format ${format}, which is newer than this version of Devlog understands (${STORAGE_FORMAT}). Update Devlog, then open it again.`)
  }
  throw new Error(
    `This devlog uses an older storage format (${format ?? 'no devlog.json'}). Devlog 0.5 upgrades it: open it once with Devlog 0.5, then again with this version.`
  )
}

// ---------------------------------------------------------------------------
// Extensions in devlog.json and devlog.lock.json
// ---------------------------------------------------------------------------

/** `devlog.json` as a whole. Unknown keys are kept when it is rewritten. */
export interface DevlogManifest {
  format: number
  /** Where each extension comes from (see parseExtensionEntry). */
  extensions?: Record<string, string>
  /** Non-secret, devlog-wide extension settings, by extension id. */
  settings?: Record<string, Record<string, string>>
  [key: string]: unknown
}

export async function readManifest(root: string): Promise<DevlogManifest> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(root, MANIFEST_FILE), 'utf8')) as DevlogManifest
    if (m && typeof m === 'object' && !Array.isArray(m)) return m
  } catch {
    /* missing or unreadable: an empty manifest */
  }
  return { format: STORAGE_FORMAT }
}

let manifestQueue: Promise<unknown> = Promise.resolve()

/** Read, change and write `devlog.json` (one change at a time, atomically). */
export function updateManifest(root: string, change: (m: DevlogManifest) => void): Promise<DevlogManifest> {
  const run = manifestQueue.then(async () => {
    const m = await readManifest(root)
    change(m)
    await writeJsonAtomic(path.join(root, MANIFEST_FILE), m)
    return m
  })
  manifestQueue = run.catch(() => undefined)
  return run
}

export interface LockEntry {
  id: string
  /** The `devlog.json` value it was resolved from. */
  spec: string
  version: string
  /** Where the bytes came from (`builtin:` for built-ins). */
  url: string
  sha256: string
}

export interface LockFile {
  lockfileVersion: 1
  extensions: Record<string, LockEntry>
}

export async function readLockFile(root: string): Promise<LockFile> {
  try {
    const l = JSON.parse(await fs.readFile(path.join(root, LOCK_FILE), 'utf8')) as LockFile
    if (l && typeof l === 'object' && l.extensions && typeof l.extensions === 'object') return { lockfileVersion: 1, extensions: l.extensions }
  } catch {
    /* none yet */
  }
  return { lockfileVersion: 1, extensions: {} }
}

export async function writeLockFile(root: string, lock: LockFile): Promise<void> {
  const sorted: Record<string, LockEntry> = {}
  for (const k of Object.keys(lock.extensions).sort()) sorted[k] = lock.extensions[k]
  await writeJsonAtomic(path.join(root, LOCK_FILE), { lockfileVersion: 1, extensions: sorted })
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await fs.rename(tmp, file)
}
