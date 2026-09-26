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
export const API_VERSION = '1.1.0'

export interface ExtensionCanvas {
  id: string
  title: string
  parentId: string | null
  task: boolean
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

export interface ExtensionSearchResult {
  blocks: Array<{ canvasId: string; date: string; block: ExtensionBlock }>
}

export interface ActivityNotice {
  /** When it happened (ISO). */
  t: string
  /** `pause`: locked, idle or asleep; `resume`: back; `task`: the active task changed. */
  type: 'pause' | 'resume' | 'task'
  reason?: 'locked' | 'idle' | 'suspended'
  /** For `task`: the new active task (null when the clock stopped), if the extension can see it. */
  canvasId?: string | null
}

/** The window in front, as the app's platform helper reports it. */
export interface ForegroundWindow {
  /** When it came to the front (ISO). */
  t: string
  /** Process / application name. */
  app: string
  /** Window title (for browsers, the active tab). */
  title: string
}

/** A focus change for the app's timeline, review and summary. */
export interface FocusEvent {
  t: string
  app: string
  title: string
  /** The machine folder it was recorded on (`ctx.machine` there). */
  machine: string
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
    /** Add a block to today's stream on a canvas (needs write access). It is marked as this extension's and read-only. */
    addBlock(canvasId: string, markdown: string, opts?: { meta?: Record<string, string> }): Promise<{ date: string; block: ExtensionBlock }>
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
  /** Pause/resume and task changes, as they happen. */
  activity: { on(cb: (notice: ActivityNotice) => void): void }
  ui: {
    notify(message: string): void
    confirm(message: string): Promise<boolean>
  }
  /** Commands appear in the quick switcher (declared in `contributes.commands`). */
  commands: { register(id: string, run: () => void | Promise<void>): void }
  /** What the app can observe for you, with your permission. (1.1) */
  system: {
    /**
     * Foreground-window changes (needs `permissions.foregroundWindow`, and
     * the user's consent). Nothing is delivered while the machine is locked
     * or asleep.
     */
    onForegroundWindow(cb: (w: ForegroundWindow) => void): void
  }
  /** Data the app draws in its own views. (1.1) */
  provide: {
    /** Focus changes between two local dates (inclusive), for the timeline, review and summary. */
    focus(fn: (fromDate: string, toDate: string) => Promise<FocusEvent[]>): void
  }
}

export interface ExtensionModule {
  activate(ctx: DevlogContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
