/**
 * Append-only activity log: one JSON line per event, one file per local day.
 * Lives in the repository (`activity/…`) or in the app's user data folder
 * depending on settings.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { localDate } from '@shared/entries'
import type { ActivityEvent } from '@shared/types'

export const ACTIVITY_DIR = 'activity'

export class ActivityLog {
  constructor(private readonly rootProvider: () => string) {}

  fileFor(date: string): string {
    const [y, m] = date.split('-')
    return path.join(this.rootProvider(), ACTIVITY_DIR, y, m, `${date}.jsonl`)
  }

  async append(event: ActivityEvent): Promise<void> {
    const file = this.fileFor(localDate(new Date(event.t)))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8')
  }

  /** Events for every day in [fromDate, toDate], sorted by time. */
  async read(fromDate: string, toDate: string): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = []
    for (const date of datesBetween(fromDate, toDate)) {
      let text: string
      try {
        text = await fs.readFile(this.fileFor(date), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw err
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line) as ActivityEvent
          if (ev && typeof ev.t === 'string' && typeof ev.type === 'string') out.push(ev)
        } catch {
          /* skip corrupt line */
        }
      }
    }
    return out.sort((a, b) => a.t.localeCompare(b.t))
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
