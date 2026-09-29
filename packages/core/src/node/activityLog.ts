/**
 * Append-only activity log: one JSON line per event, one file per local day,
 * one folder per machine:
 *
 *   activity/<machine>/YYYY/MM/YYYY-MM-DD.jsonl
 *
 * Each machine only ever appends to its own files, so logs synced through git
 * never conflict. Reading merges every machine's files (and the pre-0.4
 * layout, `activity/YYYY/MM/…`, shared by all machines) and tags each event
 * with the machine it came from, so replays can keep machines apart.
 *
 * The log lives in the repository (`activity/…`) or in the app's user data
 * folder, depending on settings.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { localDate } from '../format/blocks'
import type { ActivityEvent } from '../types'

export const ACTIVITY_DIR = 'activity'
/** `machine` tag for events from the pre-0.4 shared layout. */
export const LEGACY_MACHINE = ''

const YEAR_RE = /^\d{4}$/
const MACHINE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Folder name for a machine: its host name, slugged, plus a short id so two "laptop"s stay apart. */
export function machineFolder(hostname: string, id: string): string {
  const host =
    hostname
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'machine'
  const suffix = id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || '0'
  return `${host}-${suffix}`
}

export class ActivityLog {
  /**
   * @param rootProvider where `activity/` lives (the repository or user data), asked on every call
   * @param machine this machine's folder name (see `machineFolder`)
   */
  constructor(
    private readonly rootProvider: () => string,
    readonly machine: string
  ) {
    if (!MACHINE_RE.test(machine) || YEAR_RE.test(machine)) throw new Error(`Invalid machine folder: ${machine}`)
  }

  /** This machine's file for a day. */
  fileFor(date: string, machine: string = this.machine): string {
    const [y, m] = date.split('-')
    const base = path.join(this.rootProvider(), ACTIVITY_DIR)
    return machine === LEGACY_MACHINE ? path.join(base, y, m, `${date}.jsonl`) : path.join(base, machine, y, m, `${date}.jsonl`)
  }

  async append(event: ActivityEvent): Promise<void> {
    const file = this.fileFor(localDate(new Date(event.t)))
    await fs.mkdir(path.dirname(file), { recursive: true })
    const { machine: _m, ...stored } = event
    await fs.appendFile(file, `${JSON.stringify(stored)}\n`, 'utf8')
  }

  /** Every machine with a log folder (plus the legacy shared layout when present). */
  async machines(): Promise<string[]> {
    const out: string[] = []
    let legacy = false
    for (const d of await readdirSafe(path.join(this.rootProvider(), ACTIVITY_DIR))) {
      if (!d.isDirectory()) continue
      if (YEAR_RE.test(d.name)) legacy = true
      else if (MACHINE_RE.test(d.name)) out.push(d.name)
    }
    if (!out.includes(this.machine)) out.push(this.machine)
    out.sort()
    return legacy ? [LEGACY_MACHINE, ...out] : out
  }

  /** Events from every machine for every day in [fromDate, toDate], sorted by time, each tagged with `machine`. */
  async read(fromDate: string, toDate: string): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = []
    const dates = datesBetween(fromDate, toDate)
    for (const machine of await this.machines()) {
      for (const date of dates) {
        let text: string
        try {
          text = await fs.readFile(this.fileFor(date, machine), 'utf8')
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw err
        }
        for (const line of text.split('\n')) {
          const ev = parseLine(line)
          if (ev) out.push({ ...ev, machine })
        }
      }
    }
    return out.sort((a, b) => a.t.localeCompare(b.t))
  }
}

function parseLine(line: string): ActivityEvent | null {
  if (!line.trim()) return null
  try {
    const ev = JSON.parse(line) as ActivityEvent & { pageId?: string | null }
    if (!ev || typeof ev.t !== 'string' || typeof ev.type !== 'string') return null
    // Logs written before 0.3 named the canvas `pageId`.
    if (ev.canvasId === undefined && ev.pageId !== undefined) {
      ev.canvasId = ev.pageId
      delete ev.pageId
    }
    delete ev.machine
    return ev
  } catch {
    return null // skip a corrupt line
  }
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  const [y, m, d] = from.split('-').map(Number)
  const cur = new Date(y, m - 1, d)
  for (let i = 0; i < 400; i++) {
    const date = localDate(cur)
    if (date > to) break
    out.push(date)
    cur.setDate(cur.getDate() + 1)
  }
  return out
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
