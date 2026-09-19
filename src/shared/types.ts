/** A single devlog post. Markdown image sources are repo-root-relative (e.g. `entries/2026/09/assets/x.png`). */
export interface Entry {
  id: string
  /** Id of the note this one replies to; absent for top-level notes. */
  parentId?: string
  /** ISO-8601 timestamp of creation (UTC). */
  createdAt: string
  /** ISO-8601 timestamp of the last edit (UTC), if any. */
  updatedAt?: string
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
 * A page is a separate stream of notes (a client, a project, …). The journal
 * is the built-in page whose notes live at the repository root.
 */
export interface PageMeta {
  /** Folder slug under `pages/`, or `journal` for the built-in page. */
  id: string
  title: string
  /** Free-text grouping shown in the sidebar (e.g. "Clients"). Empty for none. */
  category: string
  /** Markdown shown at the top of the page. */
  description: string
  createdAt: string
}

export interface PageInput {
  title: string
  category?: string
  description?: string
}

/** A slice of a page's history: whole days, oldest first. */
export interface Timeline {
  pageId: string
  days: Day[]
  /** True when older days exist before the first one returned. */
  hasMore: boolean
}

export interface SearchHit {
  pageId: string
  date: string
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
}

export const DEFAULT_SETTINGS: Settings = {
  repoPath: null,
  syncIntervalMinutes: 5,
  commitDebounceSeconds: 30,
  autoPush: true,
  pullOnStart: true,
  commitOnQuit: true,
  authorName: '',
  authorEmail: ''
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
