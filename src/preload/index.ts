import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MenuCommand } from '../shared/ipc'
import type { Day, DaySummary, Entry, RepoInfo, SavedAsset, SearchHit, Settings, SyncStatus } from '../shared/types'

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
  entries: {
    listDays: (): Promise<DaySummary[]> => ipcRenderer.invoke(IPC.daysList),
    getDay: (date: string): Promise<Day> => ipcRenderer.invoke(IPC.dayGet, date),
    add: (markdown: string): Promise<{ date: string; entry: Entry }> => ipcRenderer.invoke(IPC.entryAdd, markdown),
    update: (date: string, id: string, markdown: string): Promise<Entry> =>
      ipcRenderer.invoke(IPC.entryUpdate, date, id, markdown),
    remove: (date: string, id: string): Promise<void> => ipcRenderer.invoke(IPC.entryDelete, date, id),
    search: (query: string): Promise<SearchHit[]> => ipcRenderer.invoke(IPC.entrySearch, query),
    onChanged: (cb: () => void): Unsubscribe => on(IPC.evEntriesChanged, cb)
  },
  assets: {
    save: (date: string, bytes: Uint8Array, mime: string, name?: string): Promise<SavedAsset> =>
      ipcRenderer.invoke(IPC.assetSave, date, bytes, mime, name)
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
  platform: process.platform
}

export type DevlogApi = typeof api

contextBridge.exposeInMainWorld('devlog', api)
