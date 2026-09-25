/** App-level types (settings, window, tracker, updates). Data types come from @devlog/core. */
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
  /** Record task, lock/idle and focus events while the app runs. */
  trackingEnabled: boolean
  /** Record the foreground window (app + title). */
  trackFocus: boolean
  /** Minutes without input before the active task is paused. 0 disables. */
  idleMinutes: number
  /** Keep the activity log inside the devlog repository (synced) instead of locally. */
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
  trackFocus: true,
  idleMinutes: 10,
  activityInRepo: false,
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
// Activity tracking
// ---------------------------------------------------------------------------

export interface TrackerStatus {
  tracking: boolean
  activeCanvasId: string | null
  /** When the current task segment started (after the last pause). */
  since: string | null
  paused: boolean
  pausedReason: 'locked' | 'idle' | 'suspended' | null
  focusAvailable: boolean
  lastFocus: { app: string; title: string } | null
}

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
