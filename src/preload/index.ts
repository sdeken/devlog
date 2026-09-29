import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MenuCommand } from '../shared/ipc'
import type {
  ActivityEvent,
  AttachedImage,
  Canvas,
  CanvasInput,
  CanvasMeta,
  Day,
  DaySummary,
  Entry,
  EntryPosition,
  TodoRef,
  RepoInfo,
  SavedAsset,
  SearchResult,
  Settings,
  SyncStatus,
  Timeline,
  UpdateStatus
} from '../shared/types'
import type { ExtensionAppState, ExtensionInfo, ExtensionPickRequest, ExtensionUpdateReport } from '../shared/extensions'
import type { Grant, Timesheet } from '@devlog/core'
import type { CommandContext, DestinationLine, SendResult } from '@devlog/extension-api'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch)
  },
  repo: {
    info: (): Promise<RepoInfo | null> => ipcRenderer.invoke(IPC.repoInfo),
    chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.repoChooseDirectory),
    /** Is this folder a git working copy? Resolves subfolders to the repository root. */
    /** Import your own commits from the last `days` days of a repository linked to the canvas. Resolves to how many were added. */
    importHistory: (canvasId: string, repoPath: string, days: number): Promise<number> => ipcRenderer.invoke(IPC.repoImportHistory, canvasId, repoPath, days),
    inspectWorkingCopy: (dir: string): Promise<{ ok: true; root: string } | { ok: false; error: string }> => ipcRenderer.invoke(IPC.repoInspectWorkingCopy, dir),
    open: (root: string): Promise<RepoInfo> => ipcRenderer.invoke(IPC.repoOpen, root),
    create: (root: string, remoteUrl?: string): Promise<RepoInfo> => ipcRenderer.invoke(IPC.repoCreate, root, remoteUrl),
    setRemote: (url: string): Promise<RepoInfo | null> => ipcRenderer.invoke(IPC.repoSetRemote, url),
    reveal: (): Promise<void> => ipcRenderer.invoke(IPC.repoRevealInFinder),
    close: (): Promise<void> => ipcRenderer.invoke(IPC.repoClose),
    onChanged: (cb: (info: RepoInfo | null) => void): Unsubscribe => on(IPC.evRepoChanged, cb)
  },
  canvases: {
    list: (): Promise<CanvasMeta[]> => ipcRenderer.invoke(IPC.canvasesList),
    get: (id: string): Promise<Canvas> => ipcRenderer.invoke(IPC.canvasGet, id),
    create: (input: CanvasInput): Promise<CanvasMeta> => ipcRenderer.invoke(IPC.canvasCreate, input),
    update: (id: string, patch: Partial<CanvasInput>): Promise<CanvasMeta> => ipcRenderer.invoke(IPC.canvasUpdate, id, patch),
    remove: (id: string): Promise<number> => ipcRenderer.invoke(IPC.canvasDelete, id),
    /** Archive or restore a canvas and everything beneath it; returns the ids that changed. */
    archive: (id: string, archived: boolean): Promise<string[]> => ipcRenderer.invoke(IPC.canvasArchive, id, archived),
    setSurface: (id: string, markdown: string): Promise<Canvas> => ipcRenderer.invoke(IPC.surfaceSet, id, markdown),
    saveSurfaceAsset: (id: string, bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.surfaceAssetSave, id, bytes, mime, name)
  },
  blocks: {
    listDays: (canvasId: string): Promise<DaySummary[]> => ipcRenderer.invoke(IPC.daysList, canvasId),
    getDay: (canvasId: string, date: string): Promise<Day> => ipcRenderer.invoke(IPC.dayGet, canvasId, date),
    timeline: (canvasId: string, opts?: { beforeDate?: string; days?: number }): Promise<Timeline> =>
      ipcRenderer.invoke(IPC.timelineGet, canvasId, opts),
    range: (fromDate: string, toDate: string): Promise<Array<{ canvasId: string; day: Day }>> =>
      ipcRenderer.invoke(IPC.rangeGet, fromDate, toDate),
    /** Post a block. `task: true` (or `#task` on the first line) also turns it into a task and starts the clock. */
    add: (canvasId: string, markdown: string, position?: EntryPosition): Promise<{ date: string; entry: Entry; count?: number }> => ipcRenderer.invoke(IPC.entryAdd, canvasId, markdown, position),
    update: (canvasId: string, date: string, id: string, markdown: string): Promise<Entry> =>
      ipcRenderer.invoke(IPC.entryUpdate, canvasId, date, id, markdown),
    remove: (canvasId: string, date: string, id: string): Promise<number> => ipcRenderer.invoke(IPC.entryDelete, canvasId, date, id),
    /** Move a block (with what is inside it) to another canvas, or inside / beside a block. */
    move: (
      fromCanvasId: string,
      date: string,
      id: string,
      to: string | { canvasId: string; date?: string; parentId?: string; afterId?: string }
    ): Promise<{ date: string; entry: Entry }> => ipcRenderer.invoke(IPC.entryMove, fromCanvasId, date, id, to),
    /** Collapse a block into a stub (or bring it back). */
    setHidden: (canvasId: string, date: string, id: string, hidden: boolean): Promise<Entry> => ipcRenderer.invoke(IPC.entryHide, canvasId, date, id, hidden),
    /** Move a top-level block (with its thread) within its day. */
    reorder: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }): Promise<Day> =>
      ipcRenderer.invoke(IPC.entryReorder, canvasId, date, id, position),
    search: (query: string): Promise<SearchResult> => ipcRenderer.invoke(IPC.entrySearch, query),
    onChanged: (cb: () => void): Unsubscribe => on(IPC.evEntriesChanged, cb)
  },
  timesheets: {
    /** The saved timesheet for the week starting on `week` (a Monday), or null. */
    get: (week: string): Promise<Timesheet | null> => ipcRenderer.invoke(IPC.timesheetGet, week),
    /** Save (the first save creates the week's block in the Timesheets canvas). */
    save: (sheet: Timesheet): Promise<Timesheet> => ipcRenderer.invoke(IPC.timesheetSave, sheet)
  },
  extensions: {
    /** Extensions of the open devlog, with their state. */
    list: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke(IPC.extList),
    /** Add to devlog.json: `owner/repo` + version range, a name + https URL, or a name + "builtin". */
    add: (key: string, spec: string): Promise<void> => ipcRenderer.invoke(IPC.extAdd, key, spec),
    remove: (key: string): Promise<void> => ipcRenderer.invoke(IPC.extRemove, key),
    allow: (key: string, grant: Grant): Promise<void> => ipcRenderer.invoke(IPC.extAllow, key, grant),
    revoke: (key: string): Promise<void> => ipcRenderer.invoke(IPC.extRevoke, key),
    restart: (key: string): Promise<void> => ipcRenderer.invoke(IPC.extRestart, key),
    update: (): Promise<ExtensionUpdateReport> => ipcRenderer.invoke(IPC.extUpdate),
    setSettings: (key: string, values: Record<string, string>): Promise<void> => ipcRenderer.invoke(IPC.extSetSettings, key, values),
    setSecret: (key: string, secretKey: string, value: string | null): Promise<void> => ipcRenderer.invoke(IPC.extSetSecret, key, secretKey, value),
    /** Run a command; resolves to the text it returns, if any (a check's result). */
    run: (key: string, commandId: string, context?: CommandContext): Promise<string | null> => ipcRenderer.invoke(IPC.extRun, key, commandId, context),
    /** What extensions ask of the app (tray label, highlighted canvases…) (1.6). */
    appState: (): Promise<ExtensionAppState> => ipcRenderer.invoke(IPC.extAppState),
    onAppState: (cb: (st: ExtensionAppState) => void): Unsubscribe => on(IPC.evExtAppState, cb),
    /** An extension asks the user to pick from a list (1.6). */
    onPick: (cb: (req: ExtensionPickRequest) => void): Unsubscribe => on(IPC.evExtPick, cb),
    answerPick: (id: number, choice: string | null): Promise<void> => ipcRenderer.invoke(IPC.extAnswerPick, id, choice),
    /** An extension asks to show a canvas or a block's page (1.6). */
    onOpen: (cb: (target: { canvasId: string; date?: string; blockId?: string }) => void): Unsubscribe => on(IPC.evExtOpen, cb),
    /** A call from an extension view's page to its extension (1.5). */
    viewCall: (key: string, viewId: string, method: string, args: unknown[]): Promise<unknown> => ipcRenderer.invoke(IPC.extViewCall, key, viewId, method, args),
    /** Messages an extension posts to its views. */
    onViewMessage: (cb: (key: string, viewId: string, message: unknown) => void): (() => void) => {
      const h = (_e: unknown, key: string, viewId: string, message: unknown): void => cb(key, viewId, message)
      ipcRenderer.on(IPC.evExtViewMessage, h)
      return () => ipcRenderer.removeListener(IPC.evExtViewMessage, h)
    },
    /** Whether a GitHub token is stored; pass a token (or null) to set (or clear) it. */
    githubToken: (token?: string | null): Promise<boolean> => ipcRenderer.invoke(IPC.extGithubToken, token),
    /** Extensions that ship with Devlog (add one with its name and "builtin"). */
    builtins: (): Promise<Array<{ name: string; displayName: string; description?: string }>> => ipcRenderer.invoke(IPC.extBuiltins),
    /** What sending the week's saved timesheet to an extension's destination would do. */
    previewSend: (key: string, destination: string, week: string): Promise<DestinationLine[]> => ipcRenderer.invoke(IPC.extDestPreview, key, destination, week),
    /** Send a final timesheet; recorded under it in the Timesheets canvas. */
    send: (key: string, destination: string, week: string): Promise<SendResult> => ipcRenderer.invoke(IPC.extDestSend, key, destination, week),
    onChanged: (cb: () => void): Unsubscribe => on(IPC.evExtensionsChanged, cb),
    onNotify: (cb: (text: string) => void): Unsubscribe => on(IPC.evNotify, cb)
  },
  todos: {
    /** Every open todo (and those ticked off since `doneSince`), with where each lives. */
    list: (opts?: { doneSince?: string }): Promise<TodoRef[]> => ipcRenderer.invoke(IPC.todosList, opts ?? {}),
    /** One todo block per line: at the end of today on the canvas, or inside a block. */
    add: (canvasId: string, texts: string[], position?: { date?: string; parentId?: string }): Promise<{ date: string; entries: Entry[] }> =>
      ipcRenderer.invoke(IPC.todosAdd, canvasId, texts, position ?? {}),
    setDone: (canvasId: string, date: string, id: string, done: boolean): Promise<Entry> => ipcRenderer.invoke(IPC.todoSetDone, canvasId, date, id, done)
  },
  assets: {
    save: (canvasId: string, date: string, bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.assetSave, canvasId, date, bytes, mime, name)
  },
  activity: {
    range: (fromDate: string, toDate: string): Promise<ActivityEvent[]> => ipcRenderer.invoke(IPC.activityRange, fromDate, toDate),
    /** Remove task time between two ISO instants; returns the correction's id. */
    exclude: (start: string, end: string): Promise<string> => ipcRenderer.invoke(IPC.activityExclude, start, end),
    /** Undo a removal. `start` files the undo on the same day as the removal. */
    restore: (id: string, start: string): Promise<void> => ipcRenderer.invoke(IPC.activityRestore, id, start)
  },
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateStatus),
    check: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
    /** Restart into the downloaded update now (or as soon as it finishes downloading). */
    installNow: (): Promise<void> => ipcRenderer.invoke(IPC.updateInstall),
    onStatus: (cb: (status: UpdateStatus) => void): Unsubscribe => on(IPC.evUpdateStatus, cb),
    /** Tell main an editor holds unsaved text so an update restart waits. */
    setEditorBusy: (busy: boolean): void => ipcRenderer.send(IPC.editorBusy, busy)
  },
  sync: {
    now: (): Promise<unknown> => ipcRenderer.invoke(IPC.syncNow),
    status: (): Promise<SyncStatus | null> => ipcRenderer.invoke(IPC.syncStatus),
    onStatus: (cb: (status: SyncStatus) => void): Unsubscribe => on(IPC.evSyncStatus, cb)
  },
  shell: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url)
  },
  window: {
    /** Pop the application menu up (the hamburger button). */
    menu: (x?: number, y?: number): Promise<void> => ipcRenderer.invoke(IPC.menuPopup, x, y),
    control: (action: 'minimize' | 'maximize' | 'close'): Promise<void> => ipcRenderer.invoke(IPC.windowControl, action)
  },
  onMenu: (cb: (cmd: MenuCommand) => void): Unsubscribe => on(IPC.evMenu, cb),
  onAttachImages: (cb: (images: AttachedImage[]) => void): Unsubscribe => on(IPC.evAttachImages, cb),
  platform: process.platform
}

export type DevlogApi = typeof api

contextBridge.exposeInMainWorld('devlog', api)
