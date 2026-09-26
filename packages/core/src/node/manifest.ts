/**
 * The repository manifest, `devlog.json`: `{ "format": 3 }`, the storage
 * format the repository is in. This version of Devlog reads and writes
 * format 3 only; older repositories must be opened once with Devlog 0.5,
 * which upgrades them.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MANIFEST_FILE, STORAGE_FORMAT } from '../index'

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

export async function writeManifest(root: string): Promise<void> {
  await fs.writeFile(path.join(root, MANIFEST_FILE), `${JSON.stringify({ format: STORAGE_FORMAT }, null, 2)}\n`)
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
