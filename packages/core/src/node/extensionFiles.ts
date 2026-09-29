/**
 * ExtensionFileStore: one extension's private folder, reached only through
 * relative paths. This is the broker behind `ctx.files`: the extension never
 * sees a real path, and nothing it passes can reach outside its folder
 * (absolute paths, `..`, symlinks, Windows device names and alternate data
 * streams are all refused). Writes are atomic; sizes are capped.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface ExtensionFileInfo {
  path: string
  size: number
  mtime: string
}

export interface ExtensionFileLimits {
  /** Largest single file. Default 16 MB. */
  maxFileBytes?: number
  /** Largest folder. Default 256 MB. */
  maxTotalBytes?: number
  /** Most files. Default 20 000. */
  maxFiles?: number
  /**
   * The folder `base` lives in (the repository root, say): every folder
   * between the two must be a real folder, not a link (git can commit links).
   */
  anchor?: string
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i
const BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/

export class ExtensionFileStore {
  private readonly maxFileBytes: number
  private readonly maxTotalBytes: number
  private readonly maxFiles: number
  private readonly baseSegs: string[]
  private readonly anchor: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly base: string,
    limits: ExtensionFileLimits = {}
  ) {
    this.maxFileBytes = limits.maxFileBytes ?? 16 * 1024 * 1024
    this.maxTotalBytes = limits.maxTotalBytes ?? 256 * 1024 * 1024
    this.maxFiles = limits.maxFiles ?? 20_000
    this.anchor = limits.anchor ?? base
    const rel = path.relative(this.anchor, base)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('The folder must be inside its anchor')
    this.baseSegs = rel ? rel.split(path.sep) : []
  }

  /** Check a relative path and map it into the folder. Throws for anything that could leave it. */
  private resolve(rel: string, allowRoot = false): { abs: string; segs: string[] } {
    if (typeof rel !== 'string') throw new Error('A path must be a string')
    const trimmed = rel.replace(/^\.\/+/, '').replace(/\/+$/, '')
    if (trimmed === '' || trimmed === '.') {
      if (allowRoot) return { abs: this.base, segs: [] }
      throw new Error('A file path is required')
    }
    if (trimmed.length > 400 || trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) throw new Error(`Not a relative path: ${rel}`)
    const segs = trimmed.split('/')
    for (const seg of segs) {
      if (seg === '' || seg === '.' || seg === '..') throw new Error(`Not allowed in a path: ${rel}`)
      if (BAD_CHARS.test(seg) || WINDOWS_DEVICE.test(seg) || /[. ]$/.test(seg) || seg.length > 128) throw new Error(`Not allowed in a file name: ${seg}`)
    }
    return { abs: path.join(this.base, ...segs), segs }
  }

  /** Refuse to go through a symlink anywhere between the folder and the target. */
  private async noLinks(segs: string[]): Promise<void> {
    let cur = this.anchor
    for (const seg of [...this.baseSegs, ...segs]) {
      cur = path.join(cur, seg)
      let st
      try {
        st = await fs.lstat(cur)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      if (st.isSymbolicLink()) throw new Error('Links are not followed')
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  async read(rel: string): Promise<Buffer | undefined> {
    const { abs, segs } = this.resolve(rel)
    await this.noLinks(segs)
    try {
      const st = await fs.stat(abs)
      if (!st.isFile()) return undefined
      return await fs.readFile(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw err
    }
  }

  async readText(rel: string): Promise<string | undefined> {
    return (await this.read(rel))?.toString('utf8')
  }

  async stat(rel: string): Promise<ExtensionFileInfo | undefined> {
    const { abs, segs } = this.resolve(rel)
    await this.noLinks(segs)
    const st = await fs.stat(abs).catch(() => null)
    return st?.isFile() ? { path: segs.join('/'), size: st.size, mtime: st.mtime.toISOString() } : undefined
  }

  /** Replace a file (atomically). */
  write(rel: string, data: string | Uint8Array): Promise<void> {
    return this.serial(async () => {
      const { abs, segs } = this.resolve(rel)
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
      await this.noLinks(segs)
      const before = (await fs.stat(abs).catch(() => null))?.size ?? null
      await this.checkRoom(bytes.length, before)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await this.noLinks(segs)
      const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`)
      await fs.writeFile(tmp, bytes)
      await fs.rename(tmp, abs)
    })
  }

  /** Add to the end of a file (created if needed). */
  append(rel: string, text: string): Promise<void> {
    return this.serial(async () => {
      const { abs, segs } = this.resolve(rel)
      const bytes = Buffer.from(String(text), 'utf8')
      await this.noLinks(segs)
      const before = (await fs.stat(abs).catch(() => null))?.size ?? null
      if ((before ?? 0) + bytes.length > this.maxFileBytes) throw new Error('File too large')
      await this.checkRoom(bytes.length, null, before === null)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await this.noLinks(segs)
      await fs.appendFile(abs, bytes)
    })
  }

  remove(rel: string): Promise<void> {
    return this.serial(async () => {
      const { abs, segs } = this.resolve(rel)
      await this.noLinks(segs)
      await fs.rm(abs, { force: true })
    })
  }

  /** Every file under `dir` (default: the whole folder), with paths relative to the folder. */
  async list(dir = ''): Promise<ExtensionFileInfo[]> {
    const { abs, segs } = this.resolve(dir, true)
    await this.noLinks(segs)
    const out: ExtensionFileInfo[] = []
    const walk = async (d: string, prefix: string[]): Promise<void> => {
      let entries
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (e.isSymbolicLink() || e.name.endsWith('.tmp')) continue
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p, [...prefix, e.name])
        else if (e.isFile()) {
          const st = await fs.stat(p).catch(() => null)
          if (st) out.push({ path: [...prefix, e.name].join('/'), size: st.size, mtime: st.mtime.toISOString() })
        }
      }
    }
    await walk(abs, segs)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async checkRoom(adding: number, replacing: number | null, newFile = replacing === null): Promise<void> {
    if (adding > this.maxFileBytes) throw new Error('File too large')
    const all = await this.list()
    const total = all.reduce((n, f) => n + f.size, 0) - (replacing ?? 0) + adding
    if (total > this.maxTotalBytes) throw new Error('The extension folder is full')
    if (newFile && all.length + 1 > this.maxFiles) throw new Error('Too many files in the extension folder')
  }
}
