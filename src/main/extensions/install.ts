/**
 * Getting an extension's bytes: from a GitHub release, a URL, the app's
 * built-ins or a development folder. Downloads are checked against the
 * lockfile's SHA-256, unpacked into a cache keyed by that hash, and never
 * run anything on the way (there are no install scripts to run).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { unzipSync } from 'fflate'
import {
  EXTENSION_API_VERSION,
  EXTENSION_MANIFEST_FILE,
  extensionId,
  isSafeRelativePath,
  newestMatching,
  parseExtensionEntry,
  parseExtensionManifest,
  parseVersion,
  satisfies,
  type ExtensionManifest,
  type ExtensionSource
} from '@devlog/core'
import type { LockEntry } from '@devlog/core/node'

export interface InstalledExtension {
  /** The `devlog.json` key. */
  key: string
  spec: string
  id: string
  source: ExtensionSource
  dir: string
  sha256: string
  version: string
  url: string
  manifest: ExtensionManifest
  /** Loaded from a development folder (not locked). */
  dev: boolean
}

export interface InstallerOptions {
  /** Where downloads are unpacked (userData/extensions). */
  cacheDir: string
  /** Built-in extensions shipped with the app. */
  builtinDir: string
  /** Machine-local development overrides: `devlog.json` key → folder. */
  devOverrides: () => Promise<Record<string, string>>
  githubToken?: () => Promise<string | undefined>
  fetch?: typeof fetch
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024
const MAX_UNPACKED_BYTES = 100 * 1024 * 1024
const ASSET_SUFFIX = '.devlog-ext.zip'

export class ExtensionInstaller {
  constructor(private readonly opts: InstallerOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch
  }

  /** Make an extension available, from the lockfile when it has an entry for this spec. */
  async install(key: string, spec: string, lock?: LockEntry, opts: { fresh?: boolean } = {}): Promise<InstalledExtension> {
    const source = parseExtensionEntry(key, spec)
    const id = extensionId(source)
    const dev = (await this.opts.devOverrides().catch((): Record<string, string> => ({})))[key]
    if (dev) return this.fromFolder(key, spec, id, source, path.resolve(dev), `dev:${dev}`, true)
    if (source.kind === 'builtin') {
      const dir = path.join(this.opts.builtinDir, source.name)
      return this.fromFolder(key, spec, id, source, dir, `builtin:${source.name}`, false)
    }
    if (lock && lock.spec === spec && lock.id === id && !opts.fresh) {
      const dir = path.join(this.opts.cacheDir, lock.sha256)
      if (!(await exists(path.join(dir, EXTENSION_MANIFEST_FILE)))) {
        const bytes = await this.download(lock.url)
        const sha = sha256(bytes)
        if (sha !== lock.sha256) throw new Error(`The download for ${key} does not match devlog.lock.json (expected ${lock.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…)`)
        await this.unpack(bytes, dir)
      }
      return this.finish(key, spec, id, source, dir, lock.sha256, lock.url, false)
    }
    const { url } = await this.resolve(source)
    const bytes = await this.download(url)
    const sha = sha256(bytes)
    const dir = path.join(this.opts.cacheDir, sha)
    if (!(await exists(path.join(dir, EXTENSION_MANIFEST_FILE)))) await this.unpack(bytes, dir)
    return this.finish(key, spec, id, source, dir, sha, url, false)
  }

  /** Extensions that ship with the app, for the "add" list. */
  async listBuiltins(): Promise<Array<{ name: string; displayName: string; description?: string }>> {
    const out: Array<{ name: string; displayName: string; description?: string }> = []
    for (const d of await fs.readdir(this.opts.builtinDir, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue
      try {
        const m = parseExtensionManifest(JSON.parse(await fs.readFile(path.join(this.opts.builtinDir, d.name, EXTENSION_MANIFEST_FILE), 'utf8')))
        out.push({ name: d.name, displayName: m.displayName, ...(m.description ? { description: m.description } : {}) })
      } catch {
        /* not an extension */
      }
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /** Where the newest matching release is (GitHub), or the URL itself. */
  async resolve(source: ExtensionSource): Promise<{ url: string; version: string | null }> {
    if (source.kind === 'url') return { url: source.url, version: null }
    if (source.kind === 'builtin') return { url: `builtin:${source.name}`, version: null }
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Devlog' }
    const token = await this.opts.githubToken?.()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await this.fetch(`https://api.github.com/repos/${source.owner}/${source.repo}/releases?per_page=100`, { headers })
    if (!res.ok) throw new Error(`GitHub: ${source.owner}/${source.repo} releases: HTTP ${res.status}`)
    const releases = (await res.json()) as Array<{ tag_name: string; draft: boolean; assets: Array<{ name: string; url: string; browser_download_url: string }> }>
    const usable = releases.filter((r) => !r.draft && r.assets.some((a) => a.name.endsWith(ASSET_SUFFIX)))
    const tag = newestMatching(
      usable.map((r) => r.tag_name),
      source.range
    )
    if (!tag) throw new Error(`${source.owner}/${source.repo} has no release matching ${source.range} with a ${ASSET_SUFFIX} file`)
    const release = usable.find((r) => r.tag_name === tag)!
    const asset = release.assets.find((a) => a.name.endsWith(ASSET_SUFFIX))!
    return { url: token ? asset.url : asset.browser_download_url, version: parseVersion(tag) ? tag.replace(/^v/, '') : tag }
  }

  private async download(url: string): Promise<Uint8Array> {
    if (!/^https:\/\//i.test(url)) throw new Error(`Not an https URL: ${url}`)
    const headers: Record<string, string> = { Accept: 'application/octet-stream', 'User-Agent': 'Devlog' }
    if (url.startsWith('https://api.github.com/')) {
      const token = await this.opts.githubToken?.()
      if (token) headers.Authorization = `Bearer ${token}`
    }
    const res = await this.fetch(url, { headers, redirect: 'follow' })
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength > MAX_ZIP_BYTES) throw new Error('The extension download is too large')
    return buf
  }

  /** Unpack a zip into `dir` (via a temporary folder), refusing any path that would leave it. */
  async unpack(bytes: Uint8Array, dir: string): Promise<void> {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(bytes)
    } catch {
      throw new Error('The extension download is not a zip file')
    }
    const entries = Object.entries(files).filter(([p]) => !p.endsWith('/'))
    // Allow one wrapping folder around the manifest.
    const top = entries.some(([p]) => p === EXTENSION_MANIFEST_FILE)
      ? ''
      : (() => {
          const m = entries.find(([p]) => p.endsWith(`/${EXTENSION_MANIFEST_FILE}`) && p.split('/').length === 2)
          return m ? `${m[0].split('/')[0]}/` : null
        })()
    if (top === null) throw new Error(`The zip has no ${EXTENSION_MANIFEST_FILE}`)
    let total = 0
    const tmp = `${dir}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(tmp, { recursive: true })
    try {
      for (const [p, data] of entries) {
        if (!p.startsWith(top)) continue
        const rel = p.slice(top.length)
        if (!isSafeRelativePath(rel)) throw new Error(`Unsafe path in the zip: ${p}`)
        total += data.byteLength
        if (total > MAX_UNPACKED_BYTES) throw new Error('The extension is too large')
        const out = path.join(tmp, ...rel.split('/'))
        await fs.mkdir(path.dirname(out), { recursive: true })
        await fs.writeFile(out, data)
      }
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rename(tmp, dir)
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true })
      throw err
    }
  }

  private async fromFolder(key: string, spec: string, id: string, source: ExtensionSource, dir: string, url: string, dev: boolean): Promise<InstalledExtension> {
    if (!(await exists(path.join(dir, EXTENSION_MANIFEST_FILE)))) throw new Error(`No ${EXTENSION_MANIFEST_FILE} in ${dir}`)
    return this.finish(key, spec, id, source, dir, await hashFolder(dir), url, dev)
  }

  private async finish(key: string, spec: string, id: string, source: ExtensionSource, dir: string, sha: string, url: string, dev: boolean): Promise<InstalledExtension> {
    const manifest = parseExtensionManifest(JSON.parse(await fs.readFile(path.join(dir, EXTENSION_MANIFEST_FILE), 'utf8')))
    if (!satisfies(EXTENSION_API_VERSION, manifest.api)) {
      throw new Error(`${manifest.displayName} needs extension API ${manifest.api}; this Devlog provides ${EXTENSION_API_VERSION}`)
    }
    return { key, spec, id, source, dir, sha256: sha, version: manifest.version, url, manifest, dev }
  }
}

/** The extension's main bundle, as text. */
export async function readMainCode(ext: InstalledExtension): Promise<string | null> {
  if (!ext.manifest.main) return null
  const file = path.join(ext.dir, ...ext.manifest.main.split('/'))
  return fs.readFile(file, 'utf8')
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A stable hash of a folder's files (paths and contents), for built-ins and development folders. */
export async function hashFolder(dir: string): Promise<string> {
  const h = createHash('sha256')
  const walk = async (d: string, prefix: string): Promise<void> => {
    const entries = (await fs.readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(d, e.name), rel)
      else if (e.isFile()) {
        h.update(`${rel}\0`)
        h.update(await fs.readFile(path.join(d, e.name)))
        h.update('\0')
      }
    }
  }
  await walk(dir, '')
  return h.digest('hex')
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false)
}
