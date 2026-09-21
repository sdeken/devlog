import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

export class SettingsStore {
  private data: Settings = { ...DEFAULT_SETTINGS }

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<Settings>
      this.data = sanitize({ ...DEFAULT_SETTINGS, ...raw })
    } catch {
      this.data = { ...DEFAULT_SETTINGS }
    }
    return this.get()
  }

  get(): Settings {
    return { ...this.data }
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    this.data = sanitize({ ...this.data, ...patch })
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2))
    await fs.rename(tmp, this.file)
    return this.get()
  }
}

function sanitize(s: Settings): Settings {
  return {
    repoPath: typeof s.repoPath === 'string' && s.repoPath ? s.repoPath : null,
    syncIntervalMinutes: clamp(Number(s.syncIntervalMinutes) || DEFAULT_SETTINGS.syncIntervalMinutes, 1, 24 * 60),
    commitDebounceSeconds: clamp(Number(s.commitDebounceSeconds) || DEFAULT_SETTINGS.commitDebounceSeconds, 1, 3600),
    autoPush: Boolean(s.autoPush),
    pullOnStart: Boolean(s.pullOnStart),
    commitOnQuit: Boolean(s.commitOnQuit),
    authorName: String(s.authorName ?? '').trim(),
    authorEmail: String(s.authorEmail ?? '').trim(),
    trackingEnabled: s.trackingEnabled !== false,
    trackFocus: s.trackFocus !== false,
    idleMinutes: clamp(Number.isFinite(Number(s.idleMinutes)) ? Number(s.idleMinutes) : DEFAULT_SETTINGS.idleMinutes, 0, 240),
    activityInRepo: Boolean(s.activityInRepo),
    captureCommits: s.captureCommits !== false,
    autoUpdate: s.autoUpdate !== false
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)))
