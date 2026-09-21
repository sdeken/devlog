import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MenuCommand } from '../shared/ipc'
import type {
  ActivityEvent,
  AttachedImage,
  Day,
  DaySummary,
  Entry,
  EntryPosition,
  PageInput,
  PageMeta,
  RepoInfo,
  SavedAsset,
  SearchResult,
  Settings,
  SyncStatus,
  Timeline,
  TrackerStatus,
  UpdateStatus,
  Wiki,
  WikiMeta
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
  pages: {
    list: (): Promise<PageMeta[]> => ipcRenderer.invoke(IPC.pagesList),
    create: (input: PageInput): Promise<PageMeta> => ipcRenderer.invoke(IPC.pageCreate, input),
    update: (pageId: string, patch: Partial<PageInput>): Promise<PageMeta> => ipcRenderer.invoke(IPC.pageUpdate, pageId, patch),
    remove: (pageId: string): Promise<number> => ipcRenderer.invoke(IPC.pageDelete, pageId),
    archive: (pageId: string, archived: boolean): Promise<PageMeta> => ipcRenderer.invoke(IPC.pageArchive, pageId, archived)
  },
  categories: {
    archive: (path: string[], archived: boolean): Promise<{ pages: number; wikis: number }> =>
      ipcRenderer.invoke(IPC.categoryArchive, path, archived)
  },
  wiki: {
    list: (): Promise<WikiMeta[]> => ipcRenderer.invoke(IPC.wikisList),
    get: (path: string[]): Promise<Wiki> => ipcRenderer.invoke(IPC.wikiGet, path),
    set: (path: string[], markdown: string): Promise<Wiki> => ipcRenderer.invoke(IPC.wikiSet, path, markdown),
    saveAsset: (path: string[], bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.wikiAssetSave, path, bytes, mime, name)
  },
  entries: {
    listDays: (pageId: string): Promise<DaySummary[]> => ipcRenderer.invoke(IPC.daysList, pageId),
    getDay: (pageId: string, date: string): Promise<Day> => ipcRenderer.invoke(IPC.dayGet, pageId, date),
    timeline: (pageId: string, opts?: { beforeDate?: string; days?: number }): Promise<Timeline> =>
      ipcRenderer.invoke(IPC.timelineGet, pageId, opts),
    range: (fromDate: string, toDate: string): Promise<Array<{ pageId: string; day: Day }>> =>
      ipcRenderer.invoke(IPC.rangeGet, fromDate, toDate),
    add: (pageId: string, markdown: string, position?: EntryPosition): Promise<{ date: string; entry: Entry }> =>
      ipcRenderer.invoke(IPC.entryAdd, pageId, markdown, position),
    update: (pageId: string, date: string, id: string, markdown: string): Promise<Entry> =>
      ipcRenderer.invoke(IPC.entryUpdate, pageId, date, id, markdown),
    remove: (pageId: string, date: string, id: string): Promise<number> => ipcRenderer.invoke(IPC.entryDelete, pageId, date, id),
    move: (fromPageId: string, date: string, id: string, toPageId: string): Promise<{ date: string; entry: Entry }> =>
      ipcRenderer.invoke(IPC.entryMove, fromPageId, date, id, toPageId),
    search: (query: string): Promise<SearchResult> => ipcRenderer.invoke(IPC.entrySearch, query),
    onChanged: (cb: () => void): Unsubscribe => on(IPC.evEntriesChanged, cb)
  },
  assets: {
    save: (pageId: string, date: string, bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.assetSave, pageId, date, bytes, mime, name)
  },
  activity: {
    range: (fromDate: string, toDate: string): Promise<ActivityEvent[]> => ipcRenderer.invoke(IPC.activityRange, fromDate, toDate)
  },
  tracker: {
    status: (): Promise<TrackerStatus | null> => ipcRenderer.invoke(IPC.trackerStatus),
    setTask: (pageId: string | null): Promise<void> => ipcRenderer.invoke(IPC.trackerSetTask, pageId),
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
  onMenu: (cb: (cmd: MenuCommand) => void): Unsubscribe => on(IPC.evMenu, cb),
  onAttachImages: (cb: (images: AttachedImage[]) => void): Unsubscribe => on(IPC.evAttachImages, cb),
  platform: process.platform
}

export type DevlogApi = typeof api

contextBridge.exposeInMainWorld('devlog', api)
