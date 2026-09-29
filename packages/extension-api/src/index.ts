/**
 * @devlog/extension-api: what a Devlog extension sees.
 *
 * An extension is a bundled `main.js` exporting `activate(ctx)`. It runs in
 * its own process with no file-system access, no child processes and no
 * native code; everything it can do goes through `ctx`. See
 * docs/EXTENSIONS.md in the Devlog repository.
 *
 * ```js
 * exports.activate = async (ctx) => {
 *   ctx.commands.register('hello', async () => {
 *     const n = Number((await ctx.files.local.readText('count')) ?? 0) + 1
 *     await ctx.files.local.write('count', String(n))
 *     ctx.ui.notify(`Hello #${n}`)
 *   })
 * }
 * ```
 */

/** The API version this package describes. Declare a matching range as `api` in devlog-extension.json. */
export const API_VERSION = '1.7.0'

export interface ExtensionCanvas {
  id: string
  title: string
  parentId: string | null
  task: boolean
  /** Its node type ("<extension id>/<type id>"), if it has one (1.6). */
  type?: string
  archived: boolean
  /** This extension's own canvas fields set on this canvas (keys as declared in `contributes.canvasFields`). */
  fields: Record<string, string>
}

export interface ExtensionBlock {
  id: string
  createdAt: string
  updatedAt?: string
  markdown: string
  parentId?: string
  kind?: string
  hidden?: boolean
  meta?: Record<string, string>
}

/** A todo (a block with `kind: 'todo'`; `meta.done` is set once ticked off) and where it lives. */
export interface ExtensionTodo {
  canvasId: string
  /** The day file it lives in. */
  date: string
  block: ExtensionBlock
  /** The blocks it sits inside, outermost first. */
  trail: Array<{ id: string; title: string }>
}

/** Where a new block goes (1.4): the end of today by default, or inside a block (its day file's date and id). */
export interface AddBlockOptions {
  meta?: Record<string, string>
  /** Add it inside this block (1.4). Needs `date`: the day file the block lives in. */
  parentId?: string
  date?: string
  /** Add it as a todo (1.4). */
  todo?: boolean
  /** On a canvas it keeps (`managedCanvas`, 1.7): the block's kind (not todo, task, commit or done), and the day file (`date`) even outside a block. */
  kind?: string
}

/**
 * Something the app recorded (1.7): its own log (locks, idle, sleep, git
 * events, corrections) merged with what extensions provide (time, focus).
 * Canvases it may not read show as none.
 */
export interface ActivityRecord {
  t: string
  type: 'start' | 'stop' | 'heartbeat' | 'lock' | 'unlock' | 'idle' | 'active' | 'suspend' | 'resume' | 'task' | 'focus' | 'git' | 'exclude'
  canvasId?: string | null
  entryId?: string
  /** focus: the app and window title (only with read access to the whole devlog). */
  app?: string
  title?: string
  /** git */
  repo?: string
  action?: string
  branch?: string
  from?: string
  detail?: string
  /** exclude (a correction): no task time between start and end; or undoes the one it `cancels`. */
  start?: string
  end?: string
  id?: string
  cancels?: string
  machine?: string
}

/** A day file's blocks (1.7). */
export interface ExtensionDayBlocks {
  canvasId: string
  date: string
  blocks: ExtensionBlock[]
}

/** A destination some extension registered (1.7). */
export interface DestinationInfo {
  /** The extension's devlog.json key. */
  extension: string
  /** Its display name. */
  from: string
  id: string
  label: string
}

/** A week's timesheet handed to another extension's destination (1.7): what `DestinationSheet` is built from. */
export interface SheetToSend {
  week: string
  status: 'draft' | 'final'
  entries: Array<{ id: string; date: string; start: string; minutes: number; canvasId: string; note?: string; worked?: number; source?: string }>
}

export interface ExtensionSearchResult {
  blocks: Array<{ canvasId: string; date: string; block: ExtensionBlock }>
}

/** Where a command was run from, and what it was run on (1.6). Canvases it cannot see are left out. */
export interface CommandContext {
  source: 'switcher' | 'keybinding' | 'menu' | 'post' | 'view' | 'tray'
  /** The canvas on screen, or the one whose menu it was. */
  canvasId?: string
  /** With `blockId`: the day file the block lives in. */
  date?: string
  /** The block whose menu it was, the page on screen, or the block just posted (`post`). */
  blockId?: string
}

/** A block someone posted in the app (1.6). Only for canvases it may read. */
export interface BlockAddedEvent {
  canvasId: string
  date: string
  block: ExtensionBlock
}

/** A new canvas (1.6). `type`: one of its own node types (the id from the manifest, or the full name). */
export interface NewCanvas {
  title: string
  parentId?: string | null
  type?: string
}

export interface CanvasPatch {
  title?: string
  parentId?: string | null
  /** One of its own node types, or null to make it a plain canvas (only from one of its own types). */
  type?: string | null
  archived?: boolean
}

/** One entry of a quick pick (1.6). */
export interface PickItem {
  id: string
  label: string
  hint?: string
}

/**
 * Time-tracking events for the app's views (1.6): which canvas time goes
 * to, from when. `start`/`stop`: the clock started or stopped with the app;
 * `task`: the active canvas changed (null stops it); `heartbeat`: still
 * running (the app counts time up to the last one when the log just ends).
 */
export interface TimeEvent {
  t: string
  type: 'start' | 'task' | 'stop' | 'heartbeat'
  canvasId?: string | null
  /** The block that started it, if one did. */
  blockId?: string
  /** The machine folder it was recorded on (`ctx.machine` there). */
  machine: string
}

export interface ActivityNotice {
  /** When it happened (ISO). */
  t: string
  /** `pause`: locked, idle or asleep; `resume`: back; `task`: the app's own tracker changed task (before 1.6). */
  type: 'pause' | 'resume' | 'task'
  reason?: 'locked' | 'idle' | 'suspended'
  /** For `task`: the new active task (null when the clock stopped), if the extension can see it. */
  canvasId?: string | null
}

/** A focus change for the app's timeline, review and summary. */
export interface FocusEvent {
  t: string
  app: string
  title: string
  /** The machine folder it was recorded on (`ctx.machine` there). */
  machine: string
}

/** One timesheet entry as a destination sees it. (1.3) */
export interface DestinationEntry {
  /** Stable within the week's timesheet; use it to remember what you sent for this entry. */
  id: string
  date: string
  /** Start (ISO), on a local quarter hour. */
  start: string
  /** A multiple of 15. */
  minutes: number
  note?: string
  canvasId: string
  /** "Client / Project / Task". */
  task: string
  /** The top-level canvas's title. */
  client: string
  /** This extension's canvas fields for the entry's canvas, inherited from the nearest ancestor that sets each. */
  fields: Record<string, string>
}

/** A finished week, handed to a destination when you press Send (your consent for this week's entries). (1.3) */
export interface DestinationSheet {
  week: string
  status: 'draft' | 'final'
  entries: DestinationEntry[]
}

/** One line of what a destination would do, for the preview. (1.3) */
export interface DestinationLine {
  id: string
  /** The timesheet entries it covers. */
  entryIds: string[]
  date: string
  start?: string
  minutes: number
  /** Where it goes: an issue key, a client id… */
  target: string
  description?: string
  /** What sending does with it. `skip`: not for this destination (say why in `reason`). */
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'skip'
  reason?: string
}

export interface SendResult {
  /** Lines that went through, by line id. */
  done: string[]
  failed: Array<{ lineId: string; error: string }>
  /** A sentence for the record ("3 worklogs created, 1 updated"). */
  summary: string
}

export interface Destination {
  /** What sending `sheet` would do, without doing it. */
  preview(sheet: DestinationSheet): Promise<DestinationLine[]>
  /** Do it. Called only for final timesheets, after the user saw the preview. */
  send(sheet: DestinationSheet): Promise<SendResult>
}

export interface ExtensionFileInfo {
  path: string
  size: number
  mtime: string
}

/** One of the extension's private folders. Paths are relative, `/`-separated, and cannot leave the folder. */
export interface ExtensionFiles {
  read(path: string): Promise<Uint8Array | undefined>
  readText(path: string): Promise<string | undefined>
  /** Replace a file, atomically. */
  write(path: string, data: string | Uint8Array): Promise<void>
  append(path: string, text: string): Promise<void>
  list(dir?: string): Promise<ExtensionFileInfo[]>
  stat(path: string): Promise<ExtensionFileInfo | undefined>
  remove(path: string): Promise<void>
}

export interface DevlogContext {
  /** This extension's id (from where it was installed, e.g. `sdeken.devlog-jira`). */
  readonly id: string
  /** The Devlog app's extension API version. */
  readonly apiVersion: string
  /** This machine's folder name in the devlog (host name plus a short id), for per-machine files. (1.1) */
  readonly machine: string
  /**
   * Where the extension's own files are unpacked, for helper scripts it
   * ships. Only for extensions that run unrestricted (you trusted them);
   * null in the sandbox, which cannot read files anyway. (1.2)
   */
  readonly packageDir: string | null

  /** The devlog, filtered by what you granted this extension. */
  devlog: {
    /** Canvases it may read or write, plus their ancestors (so they can be named). */
    canvases(): Promise<ExtensionCanvas[]>
    /** One of this extension's canvas fields, from the canvas or the nearest ancestor that sets it. */
    field(canvasId: string, key: string): Promise<string | null>
    /** Days that have blocks on a canvas (needs read access to it). */
    days(canvasId: string): Promise<string[]>
    /** A day's blocks on a canvas (needs read access to it). */
    blocks(canvasId: string, date: string): Promise<ExtensionBlock[]>
    /** Full-text search, limited to what it can read. */
    search(query: string): Promise<ExtensionSearchResult>
    /**
     * Add a block to a canvas (needs write access): at the end of today, or
     * inside a block (1.4); optionally as a todo (1.4). It is marked as this
     * extension's and its text is read-only in the app (a todo can still be
     * ticked off).
     */
    addBlock(canvasId: string, markdown: string, opts?: AddBlockOptions): Promise<{ date: string; block: ExtensionBlock }>
    /** Open todos (and those ticked off since `doneSince`) on the canvases it may read (1.4). */
    todos(opts?: { doneSince?: string }): Promise<ExtensionTodo[]>
    /** Make a canvas (1.6): inside one it may write to, or at the top level if it may write everywhere. */
    createCanvas(input: NewCanvas): Promise<ExtensionCanvas>
    /** Change a canvas it may write to (1.6). */
    updateCanvas(canvasId: string, patch: CanvasPatch): Promise<ExtensionCanvas>
    /** Change the text of a block it added (1.6). */
    editBlock(canvasId: string, date: string, blockId: string, markdown: string): Promise<ExtensionBlock>
    /**
     * Turn a block into a canvas of one of its node types, just inside the
     * block's canvas (1.6): what was written inside the block moves there,
     * and the block becomes the link to it. A block that already links to a
     * canvas returns that one.
     */
    promote(canvasId: string, date: string, blockId: string, opts: { type: string }): Promise<{ canvas: ExtensionCanvas; block: ExtensionBlock }>
    /** Blocks posted in the app, as they are posted (1.6). */
    onBlockAdded(cb: (ev: BlockAddedEvent) => void): void
    /** What the app recorded between two local dates, inclusive (needs read access). (1.7) */
    activity(fromDate: string, toDate: string): Promise<ActivityRecord[]>
    /** The day files with blocks written between two local dates (on canvases it may read). (1.7) */
    range(fromDate: string, toDate: string): Promise<ExtensionDayBlocks[]>
    /**
     * A canvas this extension keeps (made on first use, with `title`): it may
     * read and write every block on it whatever it was granted, add blocks of
     * its own kinds on any day, and edit any block there. (1.7)
     */
    managedCanvas(key: string, opts?: { title?: string }): Promise<ExtensionCanvas>
  }
  /** Devlog-wide settings from devlog.json (as declared in `contributes.settings`). */
  settings: {
    get(key: string): string | undefined
    onChange(cb: (settings: Record<string, string>) => void): void
  }
  /** Secrets kept in the OS keychain on this machine, never in the devlog. */
  secrets: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  /** Private folders: `repo` is synced with the devlog, `local` stays on this machine. */
  files: { repo: ExtensionFiles; local: ExtensionFiles }
  /** Pause/resume (locked, idle, asleep), as they happen. */
  activity: {
    on(cb: (notice: ActivityNotice) => void): void
    /** Count the machine idle after this many minutes without input (0: never). The app uses the shortest any extension asks for. (1.6) */
    idleAfter(minutes: number): void
  }
  ui: {
    notify(message: string): void
    confirm(message: string): Promise<boolean>
    /** A list to choose from, like the quick switcher (1.6). The chosen item's id, or null. */
    pick(items: PickItem[], opts?: { placeholder?: string }): Promise<string | null>
    /** Show a canvas, or a block's page, in the app (1.6). */
    open(target: { canvasId: string; date?: string; blockId?: string }): void
    /** Show one of its `page` views (1.7). */
    openPage(viewId: string): void
    /** Mark one canvas as this extension's current one (the running task): the sidebar highlights it (1.6). */
    highlight(canvasId: string | null): void
  }
  /** The app around the window (1.6). */
  app: {
    /** Text beside the tray icon and in its tooltip (null clears it). */
    setTrayLabel(label: string | null): void
    /** Keep the app running in the tray when its window is closed (so the extension keeps going). */
    keepRunning(on: boolean): void
  }
  /**
   * Commands appear in the quick switcher (declared in `contributes.commands`),
   * and in the menus, keybindings and note box the manifest names (1.6).
   */
  commands: { register(id: string, run: (context: CommandContext) => unknown | Promise<unknown>): void }
  /**
   * Places finished timesheets can be sent (declared in `contributes.destinations`). (1.3)
   * With `permissions.send` (1.7), it can also send through other extensions' destinations.
   */
  destinations: {
    register(id: string, destination: Destination): void
    /** Destinations registered by running extensions (1.7). */
    list(): Promise<DestinationInfo[]>
    /** What sending would do (1.7). */
    preview(to: { extension: string; id: string }, sheet: SheetToSend): Promise<DestinationLine[]>
    /** Send a final week (1.7). */
    send(to: { extension: string; id: string }, sheet: SheetToSend): Promise<SendResult>
  }
  /**
   * Views declared in `contributes.views` (1.5): pages from your package the
   * app shows in a sandboxed frame. The page talks to this process through
   * the app: its `call(method, ...args)` arrives at your handler, and `post`
   * sends a message to every open copy of the view.
   */
  views: {
    handle(viewId: string, handler: (method: string, args: unknown[]) => unknown | Promise<unknown>): void
    post(viewId: string, message: unknown): void
  }
  /** Data the app draws in its own views. (1.1) */
  provide: {
    /** Focus changes between two local dates (inclusive), for the timeline, review and summary. */
    focus(fn: (fromDate: string, toDate: string) => Promise<FocusEvent[]>): void
    /** Time-tracking events between two local dates (inclusive), for the review, summary, timeline and timesheet (1.6). */
    activity(fn: (fromDate: string, toDate: string) => Promise<TimeEvent[]>): void
  }
}

export interface ExtensionModule {
  activate(ctx: DevlogContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
