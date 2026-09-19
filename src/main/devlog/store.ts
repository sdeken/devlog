/**
 * DevlogStore: reads and writes the markdown files and attachments inside a
 * devlog repository. It knows nothing about git or Electron.
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
import type { Day, DaySummary, Entry, EntryPosition, SavedAsset, SearchHit } from '@shared/types'

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
          `- Posts live in \`${ENTRIES_DIR}/YYYY/MM/YYYY-MM-DD.md\`, one file per day.`,
          `- Pasted images live next to them in \`${ENTRIES_DIR}/YYYY/MM/${ASSETS_DIR}/\`.`,
          '- Every post is delimited by a `<!-- devlog:entry … -->` comment that carries its id and timestamps.',
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
  // Reading
  // -------------------------------------------------------------------------

  async listDays(): Promise<DaySummary[]> {
    const files = await this.listDayFiles()
    const out: DaySummary[] = []
    for (const date of files) {
      const day = await this.readDay(date)
      if (day.entries.length > 0) out.push({ date, count: day.entries.length })
    }
    out.sort((a, b) => b.date.localeCompare(a.date))
    return out
  }

  async readDay(date: string): Promise<Day> {
    assertDate(date)
    const abs = this.resolve(dayFilePath(date))
    let text: string
    try {
      text = await fs.readFile(abs, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { date, entries: [] }
      throw err
    }
    return parseDayFile(date, text)
  }

  async search(query: string, limit = 200): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: SearchHit[] = []
    const dates = (await this.listDayFiles()).sort((a, b) => b.localeCompare(a))
    for (const date of dates) {
      const day = await this.readDay(date)
      for (const entry of [...day.entries].reverse()) {
        if (entry.markdown.toLowerCase().includes(q)) {
          hits.push({ date, entry })
          if (hits.length >= limit) return hits
        }
      }
    }
    return hits
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Add a note. With no position it is appended to today; a position can
   * target another day, make it a reply, or slot it between two notes.
   */
  async addEntry(
    markdown: string,
    position: EntryPosition = {},
    now: Date = new Date()
  ): Promise<{ date: string; entry: Entry }> {
    if (isBlankMarkdown(markdown)) throw new Error('Cannot add an empty entry')
    const date = position.date ?? localDate(now)
    const day = await this.readDay(date)
    const entry: Entry = {
      id: uniqueId(day.entries),
      createdAt: now.toISOString(),
      markdown: markdown.trim()
    }
    day.entries = insertEntry(day.entries, entry, position)
    await this.writeDay(day)
    return { date, entry }
  }

  async updateEntry(date: string, id: string, markdown: string, now: Date = new Date()): Promise<Entry> {
    const day = await this.readDay(date)
    const entry = day.entries.find((e) => e.id === id)
    if (!entry) throw new Error(`Entry ${id} not found on ${date}`)
    entry.markdown = markdown.trim()
    entry.updatedAt = now.toISOString()
    await this.writeDay(day)
    return entry
  }

  /** Delete a note and every reply beneath it. Returns the number removed. */
  async deleteEntry(date: string, id: string): Promise<number> {
    const day = await this.readDay(date)
    if (!day.entries.some((e) => e.id === id)) throw new Error(`Entry ${id} not found on ${date}`)
    const removed = descendantIds(day.entries, id).size + 1
    day.entries = removeSubtree(day.entries, id)
    await this.writeDay(day)
    return removed
  }

  /** Persist an image for `date`; returns its repo-root-relative path. */
  async saveAsset(
    date: string,
    bytes: Uint8Array,
    mime: string,
    originalName?: string,
    now: Date = new Date()
  ): Promise<SavedAsset> {
    assertDate(date)
    if (bytes.byteLength === 0) throw new Error('Empty image')
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Image is larger than 25 MB')
    const ext = IMAGE_EXT_BY_MIME[mime] ?? extFromName(originalName) ?? 'png'
    const dir = assetDir(date)
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

  private async writeDay(day: Day): Promise<void> {
    const rel = dayFilePath(day.date)
    const abs = this.resolve(rel)
    if (day.entries.length === 0) {
      await fs.rm(abs, { force: true })
    } else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const tmp = `${abs}.${process.pid}.tmp`
      await fs.writeFile(tmp, serializeDayFile(day), 'utf8')
      await fs.rename(tmp, abs)
    }
    this.emit('change', { kind: 'day', date: day.date })
  }

  private async listDayFiles(): Promise<string[]> {
    const base = path.join(this.root, ENTRIES_DIR)
    const dates: string[] = []
    const years = await readdirSafe(base)
    for (const y of years) {
      if (!/^\d{4}$/.test(y.name) || !y.isDirectory()) continue
      const months = await readdirSafe(path.join(base, y.name))
      for (const m of months) {
        if (!/^\d{2}$/.test(m.name) || !m.isDirectory()) continue
        const files = await readdirSafe(path.join(base, y.name, m.name))
        for (const f of files) {
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
