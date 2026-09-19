import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { ActivityEvent, Entry, EntryPosition, PageInput, RepoInfo, Settings, TrackerStatus } from '@shared/types'
import type { DevlogStore } from './devlog/store'
import type { SyncManager } from './devlog/sync'
import type { SettingsStore } from './settings'
import { simpleGit } from 'simple-git'

export interface IpcDeps {
  settings: SettingsStore
  getStore: () => DevlogStore | null
  getSync: () => SyncManager | null
  openRepo: (root: string, opts?: { create?: boolean }) => Promise<RepoInfo>
  closeRepo: () => Promise<void>
  repoInfo: () => Promise<RepoInfo | null>
  chooseDirectory: () => Promise<string | null>
  onSettingsChanged: (s: Settings) => void
  /** A user note was added; lets the tracker switch the active task. */
  onEntryAdded: (pageId: string, entry: Entry) => Promise<void>
  onPagesChanged: () => Promise<void>
  activityRange: (fromDate: string, toDate: string) => Promise<ActivityEvent[]>
  trackerStatus: () => TrackerStatus | null
  trackerSetTask: (pageId: string | null) => Promise<void>
}

function requireStore(deps: IpcDeps): DevlogStore {
  const s = deps.getStore()
  if (!s) throw new Error('No devlog is open')
  return s
}

export function registerIpc(deps: IpcDeps): void {
  const { settings } = deps

  ipcMain.handle(IPC.settingsGet, () => settings.get())
  ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<Settings>) => {
    // repoPath is managed through repo:open / repo:create.
    const { repoPath: _ignored, ...rest } = patch
    const next = await settings.set(rest)
    deps.onSettingsChanged(next)
    return next
  })

  ipcMain.handle(IPC.repoInfo, () => deps.repoInfo())
  ipcMain.handle(IPC.repoChooseDirectory, () => deps.chooseDirectory())
  ipcMain.handle(IPC.repoOpen, (_e, root: string) => deps.openRepo(root))
  ipcMain.handle(IPC.repoCreate, async (_e, root: string, remoteUrl?: string) => {
    const info = await deps.openRepo(root, { create: true })
    if (remoteUrl && remoteUrl.trim()) {
      await setRemote(root, remoteUrl.trim())
      const sync = deps.getSync()
      if (sync) await sync.syncNow('manual')
    }
    return deps.repoInfo()
  })
  ipcMain.handle(IPC.repoSetRemote, async (_e, remoteUrl: string) => {
    const store = requireStore(deps)
    await setRemote(store.root, remoteUrl.trim())
    const sync = deps.getSync()
    if (sync) await sync.syncNow('manual')
    return deps.repoInfo()
  })
  ipcMain.handle(IPC.repoRevealInFinder, () => {
    const store = deps.getStore()
    if (store) shell.openPath(store.root)
  })
  ipcMain.handle(IPC.repoClose, async () => {
    await deps.closeRepo()
    await settings.set({ repoPath: null })
  })

  ipcMain.handle(IPC.pagesList, () => requireStore(deps).listPages())
  ipcMain.handle(IPC.pageCreate, async (_e, input: PageInput) => {
    const page = await requireStore(deps).createPage(input)
    await deps.onPagesChanged()
    return page
  })
  ipcMain.handle(IPC.pageUpdate, async (_e, pageId: string, patch: Partial<PageInput>) => {
    const page = await requireStore(deps).updatePage(pageId, patch)
    await deps.onPagesChanged()
    return page
  })
  ipcMain.handle(IPC.pageArchive, async (_e, pageId: string, archived: boolean) => {
    const page = await requireStore(deps).setPageArchived(pageId, archived)
    if (archived && deps.trackerStatus()?.activePageId === pageId) await deps.trackerSetTask(null)
    await deps.onPagesChanged()
    return page
  })
  ipcMain.handle(IPC.categoryArchive, async (_e, path: string[], archived: boolean) => {
    const result = await requireStore(deps).setCategoryArchived(path, archived)
    const active = deps.trackerStatus()?.activePageId
    if (archived && active) {
      const page = await requireStore(deps).readPage(active).catch(() => null)
      if (page?.archived) await deps.trackerSetTask(null)
    }
    await deps.onPagesChanged()
    return result
  })
  ipcMain.handle(IPC.wikisList, () => requireStore(deps).listWikis())
  ipcMain.handle(IPC.wikiGet, (_e, path: string[]) => requireStore(deps).readWiki(path))
  ipcMain.handle(IPC.wikiSet, (_e, path: string[], markdown: string) => requireStore(deps).writeWiki(path, markdown))
  ipcMain.handle(IPC.wikiAssetSave, (_e, path: string[], bytes: Uint8Array | ArrayBuffer, mime: string, name?: string) =>
    requireStore(deps).saveWikiAsset(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime, name)
  )
  ipcMain.handle(IPC.pageDelete, async (_e, pageId: string) => {
    const n = await requireStore(deps).deletePage(pageId)
    await deps.onPagesChanged()
    return n
  })

  ipcMain.handle(IPC.daysList, (_e, pageId: string) => requireStore(deps).listDays(pageId))
  ipcMain.handle(IPC.dayGet, (_e, pageId: string, date: string) => requireStore(deps).readDay(pageId, date))
  ipcMain.handle(IPC.timelineGet, (_e, pageId: string, opts?: { beforeDate?: string; days?: number }) =>
    requireStore(deps).getTimeline(pageId, opts ?? {})
  )
  ipcMain.handle(IPC.rangeGet, (_e, fromDate: string, toDate: string) => requireStore(deps).getRange(fromDate, toDate))
  ipcMain.handle(IPC.entryAdd, async (_e, pageId: string, markdown: string, position?: EntryPosition) => {
    const result = await requireStore(deps).addEntry(pageId, markdown, position ?? {})
    await deps.onEntryAdded(pageId, result.entry)
    return result
  })
  ipcMain.handle(IPC.entryUpdate, (_e, pageId: string, date: string, id: string, markdown: string) =>
    requireStore(deps).updateEntry(pageId, date, id, markdown)
  )
  ipcMain.handle(IPC.entryDelete, (_e, pageId: string, date: string, id: string) => requireStore(deps).deleteEntry(pageId, date, id))
  ipcMain.handle(IPC.entryMove, (_e, fromPageId: string, date: string, id: string, toPageId: string) =>
    requireStore(deps).moveEntry(fromPageId, date, id, toPageId)
  )
  ipcMain.handle(IPC.entrySearch, (_e, query: string) => requireStore(deps).search(query))
  ipcMain.handle(
    IPC.assetSave,
    (_e, pageId: string, date: string, bytes: Uint8Array | ArrayBuffer, mime: string, name?: string) =>
      requireStore(deps).saveAsset(pageId, date, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime, name)
  )

  ipcMain.handle(IPC.activityRange, (_e, fromDate: string, toDate: string) => deps.activityRange(fromDate, toDate))
  ipcMain.handle(IPC.trackerStatus, () => deps.trackerStatus())
  ipcMain.handle(IPC.trackerSetTask, (_e, pageId: string | null) => deps.trackerSetTask(pageId))

  ipcMain.handle(IPC.syncNow, () => deps.getSync()?.syncNow('manual') ?? null)
  ipcMain.handle(IPC.syncStatus, () => deps.getSync()?.getStatus() ?? null)

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url)
    return undefined
  })
}

async function setRemote(root: string, url: string): Promise<void> {
  const git = simpleGit({ baseDir: root })
  const remotes = await git.getRemotes()
  if (!url) {
    if (remotes.some((r) => r.name === 'origin')) await git.removeRemote('origin')
    return
  }
  if (remotes.some((r) => r.name === 'origin')) await git.remote(['set-url', 'origin', url])
  else await git.addRemote('origin', url)
}
