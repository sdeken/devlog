/**
 * Data types of a devlog repository: blocks, canvases, search results,
 * activity events and git sync status. Pure types and constants; safe to
 * import anywhere (renderer included).
 */

/**
 * A block: one post in a canvas's stream. Markdown image sources are
 * repo-root-relative (e.g. `entries/2026/09/assets/x.png`).
 *
 * Kinds: `note` (the default, user-written), `commit` (captured from git,
 * read-only), `task` (a note that was turned into a task; `meta.canvas` is
 * the task canvas it opened).
 */
export const ENTRY_KINDS = ['note', 'commit', 'task', 'todo', 'done'] as const
/**
 * `todo` blocks live in a canvas's todo list (`todos.md`), not in the dated
 * stream; `meta.done` is the ISO time they were ticked off, `meta.task` the
 * task canvas they turned into. `done` blocks are written into the stream
 * when a todo is ticked off (`meta.todo` is the todo's id).
 */
export type EntryKind = (typeof ENTRY_KINDS)[number]

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
  /** Former ids (e.g. the folder name before storage format 2); references to them resolve here. */
  aliases?: string[]
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

export interface SavedAsset {
  /** Repo-root-relative path, e.g. `entries/2026/09/assets/2026-09-19-143201-a1b2.png`. */
  src: string
  /** Bytes written. */
  size: number
}

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
  | 'exclude' // user correction: no task time counts between `start` and `end` (or undo of one, via `cancels`)

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
  /** exclude events: the window, its id, or the id of an exclusion this one undoes */
  start?: string
  end?: string
  id?: string
  cancels?: string
  /** Which machine's log the event came from (set when reading; never stored). '' for the pre-0.4 shared log. */
  machine?: string
}
