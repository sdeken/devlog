/**
 * The messages between an extension's view (a page in a sandboxed frame) and
 * the Devlog window that shows it, sent with `postMessage`. Every message
 * carries `devlog: 1`. `@devlog/ui` wraps these; a plain page can send them
 * itself (`window.parent.postMessage({ devlog: 1, … }, '*')`).
 */

/** From the page to the app. */
export type ViewToApp =
  /** The page is listening; the app answers with `theme` (and sends it again when it changes). */
  | { devlog: 1; type: 'ready' }
  /** Ask the extension (its `views.handle` handler); answered by `reply` with the same id. */
  | { devlog: 1; type: 'call'; id: number; method: string; args: unknown[] }
  /** The size the page would like: status bar items get their height and may not get the width. */
  | { devlog: 1; type: 'resize'; width?: number; height?: number }
  /** Open one of the extension's popover views, anchored to this one. */
  | { devlog: 1; type: 'popover'; view: string; width?: number; height?: number }
  /** Close this view (a popover). */
  | { devlog: 1; type: 'close' }
  /** Show a canvas, or a block's page, in the app. */
  | { devlog: 1; type: 'open'; canvasId: string; date?: string; blockId?: string }
  /** Run one of the extension's commands. */
  | { devlog: 1; type: 'command'; command: string }

/** From the app to the page. */
export type AppToView =
  /** The app's colours as CSS custom properties (`--bg`, `--fg`, `--accent`, …), and whether it is dark. */
  | { devlog: 1; type: 'theme'; vars: Record<string, string>; dark: boolean }
  | { devlog: 1; type: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  /** Something the extension sent with `views.post`. */
  | { devlog: 1; type: 'message'; data: unknown }
