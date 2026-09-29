/** App-level types (settings, window, updates). Data types come from @devlog/core. */
export * from '@devlog/core/types'
export interface AttachedImage {
  name: string
  mime: string
  bytes: Uint8Array
}

export interface Settings {
  repoPath: string | null
  /** Minutes between scheduled commit/push runs. */
  syncIntervalMinutes: number
  /** Seconds to wait after the last edit before committing. */
  commitDebounceSeconds: number
  autoPush: boolean
  pullOnStart: boolean
  commitOnQuit: boolean
  authorName: string
  authorEmail: string
  /** Time was tracked on this machine before 0.17 (it is now the devlog-time extension); only used to switch over once. */
  trackingEnabled: boolean
  /** The switch to devlog-time has been made on this machine. */
  timeSwitched: boolean
  /** Window tracking was on before 0.8 (it is now the devlog-focus extension); only used to say so once. */
  trackFocus: boolean
  /** Before 0.17: minutes without input before the active task paused (carried over to devlog-time). */
  idleMinutes: number
  /** Keep the app's activity log (locks, idle, sleep, git events) inside the devlog repository (synced) instead of locally. */
  activityInRepo: boolean
  /** Capture commits from canvas repositories as read-only blocks. */
  captureCommits: boolean
  /** Days offered when importing a linked repository's history (the import itself is opt-in per link). */
  commitBackfillDays: number
  /** Download releases in the background and restart into them at a quiet moment. */
  autoUpdate: boolean
  /** Foreground windows held for less than this many seconds are folded into their neighbour in views. */
  focusMinSeconds: number
  /** Colours: a preset name plus optional overrides. */
  theme: ThemeSettings
}

export interface ThemeSettings {
  /** One of the presets in shared/theme.ts. */
  preset: string
  /** Sidebar / top bar colour override (hex). */
  sidebar?: string
  /** Accent colour override (hex). */
  accent?: string
}

export const DEFAULT_SETTINGS: Settings = {
  repoPath: null,
  syncIntervalMinutes: 5,
  commitDebounceSeconds: 30,
  autoPush: true,
  pullOnStart: true,
  commitOnQuit: true,
  authorName: '',
  authorEmail: '',
  trackingEnabled: true,
  timeSwitched: false,
  trackFocus: false,
  idleMinutes: 10,
  activityInRepo: true,
  captureCommits: true,
  commitBackfillDays: 30,
  autoUpdate: true,
  focusMinSeconds: 5,
  theme: { preset: 'graphite' }
}

export interface RepoInfo {
  path: string
  remoteUrl: string | null
  branch: string | null
}

/** Scheme used by the renderer to load files from inside the devlog repo. */
export const ASSET_SCHEME = 'devlog'
export const ASSET_HOST = 'asset'

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------

export type UpdateState = 'unavailable' | 'idle' | 'checking' | 'downloading' | 'downloaded' | 'installing' | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  availableVersion: string | null
  /** Download progress percent while downloading. */
  progress?: number
  /** The user pressed "Update now" while the download was still running. */
  installRequested?: boolean
  checkedAt: string | null
  error: string | null
}
