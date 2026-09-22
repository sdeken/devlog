/**
 * A block: one post in a canvas's stream. Markdown image sources are
 * repo-root-relative (e.g. `entries/2026/09/assets/x.png`).
 *
 * Kinds: `note` (the default, user-written), `commit` (captured from git,
 * read-only), `task` (a note that was turned into a task; `meta.canvas` is
 * the task canvas it opened).
 */
export type EntryKind = 'note' | 'commit' | 'task'

export interface Entry {
  id: string
  /** Id of the note this one replies to; absent for top-level notes. */
  parentId?: string
  /** Absent means `note`. */
  kind?: EntryKind
  /** Extra attributes (`repo`, `hash`, `branch`, `author` for commits; `canvas` for tasks). */
  meta?: Record<string, string>
  /** ISO-8601 timestamp of creation (UTC). */
  createdAt: string
  /** ISO-8601 timestamp of the last edit (UTC), if any. */
  updatedAt?: string
  /** Hidden blocks collapse into a stub in the stream; the text is kept. */
  hidden?: boolean
  markdown: string
}

/**
 * One day's worth of entries, stored in a single markdown file. `entries` is
 * in display order (file order); replies carry `parentId` and normally follow
 * their parent.
 */
export interface Day {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
  entries: Entry[]
}

/** Where a new note goes. All ids refer to entries in the same day file. */
export interface EntryPosition {
  /** Day file to write into. Defaults to today. */
  date?: string
  /** Make the new note a reply to this one (appended at the end of its thread). */
  parentId?: string
  /** Insert as a sibling right after this note's thread. */
  afterId?: string
  /** Insert as a sibling right before this note. */
  beforeId?: string
}

export interface AttachedImage {
  name: string
  mime: string
  bytes: Uint8Array
}

export interface DaySummary {
  date: string
  count: number
}

/**
 * A canvas: a client, a project, a task, a topic. It has a surface (free
 * markdown) and a stream of blocks, nests under a parent canvas, and when
 * `task` is set it is something time is tracked against. The journal is the
 * built-in root canvas (`id: 'journal'`) whose stream lives at `entries/`.
 */
export interface CanvasMeta {
  /** Folder slug under `canvases/`, or `journal`. Stable: renaming or moving keeps it. */
  id: string
  title: string
  /** Enclosing canvas, or null at the top level. */
  parentId: string | null
  /** Tasks are what the tracker times. Posting on a task makes it the active task. */
  task: boolean
  createdAt: string
  /** Last surface edit. */
  updatedAt: string
  /** Local git repositories whose commits land in this canvas's stream. */
  repos: string[]
  /** Archived canvases (and everything beneath them) leave the sidebar but stay searchable. */
  archived: boolean
  /** True when the surface has any text. */
  hasSurface: boolean
}

export interface Canvas extends CanvasMeta {
  /** Surface markdown with repo-root-relative image paths. */
  surface: string
}

export interface CanvasInput {
  title: string
  parentId?: string | null
  task?: boolean
  repos?: string[]
}

/** A slice of a canvas's stream: whole days, oldest first. */
export interface Timeline {
  canvasId: string
  days: Day[]
  /** True when older days exist before the first one returned. */
  hasMore: boolean
}

export interface SearchHit {
  canvasId: string
  date: string
  entry: Entry
  /** True when the canvas holding this block is archived. */
  archived: boolean
}

export interface SurfaceHit {
  canvasId: string
  archived: boolean
  excerpt: string
}

export interface SearchResult {
  blocks: SearchHit[]
  surfaces: SurfaceHit[]
}

/** Result of turning a block into a task. */
export interface PromoteResult {
  canvas: CanvasMeta
  entry: Entry
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
  /** Capture commits from page repositories as read-only notes. */
  captureCommits: boolean
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
  autoUpdate: true,
  focusMinSeconds: 5,
  theme: { preset: 'graphite' }
}

export type SyncState =
  | 'idle'
  | 'clean'
  | 'dirty'
  | 'committing'
  | 'pulling'
  | 'pushing'
  | 'error'

export interface SyncStatus {
  state: SyncState
  /** Number of files with uncommitted changes. */
  dirtyFiles: number
  hasRemote: boolean
  remoteUrl: string | null
  branch: string | null
  ahead: number
  behind: number
  lastCommitAt: string | null
  lastPushAt: string | null
  lastPullAt: string | null
  lastError: string | null
  nextSyncAt: string | null
}

export interface RepoInfo {
  path: string
  remoteUrl: string | null
  branch: string | null
}

export interface SavedAsset {
  /** Repo-root-relative path, e.g. `entries/2026/09/assets/2026-09-19-143201-a1b2.png`. */
  src: string
  /** Bytes written. */
  size: number
}

/** Scheme used by the renderer to load files from inside the devlog repo. */
export const ASSET_SCHEME = 'devlog'
export const ASSET_HOST = 'asset'

// ---------------------------------------------------------------------------
// Activity tracking
// ---------------------------------------------------------------------------

export type ActivityEventType =
  | 'start' // app started (pageId = task restored, if any)
  | 'stop' // app quitting
  | 'heartbeat' // periodic "still running" marker
  | 'lock'
  | 'unlock'
  | 'idle'
  | 'active'
  | 'suspend'
  | 'resume'
  | 'task' // active task changed (canvasId, or null = stopped)
  | 'focus' // foreground window changed
  | 'git' // something happened in a watched repository

export type GitAction = 'commit' | 'branch' | 'checkout' | 'push' | 'merge' | 'rebase' | 'pull' | 'stash' | 'reset'

export interface ActivityEvent {
  /** ISO timestamp. */
  t: string
  type: ActivityEventType
  /** The canvas a task/start/git event refers to. Older logs wrote this as `pageId`. */
  canvasId?: string | null
  entryId?: string
  app?: string
  title?: string
  /** git events */
  repo?: string
  action?: GitAction
  branch?: string
  from?: string
  detail?: string
}

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
  checkedAt: string | null
  error: string | null
}
