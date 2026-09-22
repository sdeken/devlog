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
  PromoteResult,
  RepoInfo,
  SavedAsset,
  SearchResult,
  Settings,
  SyncStatus,
  Timeline,
  TrackerStatus,
  UpdateStatus
} from '../shared/types'

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
    add: (canvasId: string, markdown: string, position?: EntryPosition, opts?: { task?: boolean }): Promise<{ date: string; entry: Entry; canvas?: CanvasMeta }> =>
      ipcRenderer.invoke(IPC.entryAdd, canvasId, markdown, position, opts),
    update: (canvasId: string, date: string, id: string, markdown: string): Promise<Entry> =>
      ipcRenderer.invoke(IPC.entryUpdate, canvasId, date, id, markdown),
    remove: (canvasId: string, date: string, id: string): Promise<number> => ipcRenderer.invoke(IPC.entryDelete, canvasId, date, id),
    move: (fromCanvasId: string, date: string, id: string, toCanvasId: string): Promise<{ date: string; entry: Entry }> =>
      ipcRenderer.invoke(IPC.entryMove, fromCanvasId, date, id, toCanvasId),
    /** Collapse a block into a stub (or bring it back). */
    setHidden: (canvasId: string, date: string, id: string, hidden: boolean): Promise<Entry> => ipcRenderer.invoke(IPC.entryHide, canvasId, date, id, hidden),
    /** Move a top-level block (with its thread) within its day. */
    reorder: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }): Promise<Day> =>
      ipcRenderer.invoke(IPC.entryReorder, canvasId, date, id, position),
    /** Turn an existing block into a task canvas beneath its canvas. */
    promote: (canvasId: string, date: string, id: string): Promise<PromoteResult> => ipcRenderer.invoke(IPC.entryPromote, canvasId, date, id),
    search: (query: string): Promise<SearchResult> => ipcRenderer.invoke(IPC.entrySearch, query),
    onChanged: (cb: () => void): Unsubscribe => on(IPC.evEntriesChanged, cb)
  },
  assets: {
    save: (canvasId: string, date: string, bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.assetSave, canvasId, date, bytes, mime, name)
  },
  activity: {
    range: (fromDate: string, toDate: string): Promise<ActivityEvent[]> => ipcRenderer.invoke(IPC.activityRange, fromDate, toDate)
  },
  tracker: {
    status: (): Promise<TrackerStatus | null> => ipcRenderer.invoke(IPC.trackerStatus),
    setTask: (canvasId: string | null): Promise<void> => ipcRenderer.invoke(IPC.trackerSetTask, canvasId),
    onStatus: (cb: (status: TrackerStatus) => void): Unsubscribe => on(IPC.evTrackerStatus, cb)
  },
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateStatus),
    check: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheck),
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
