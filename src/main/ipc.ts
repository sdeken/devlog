import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { RepoInfo, Settings } from '@shared/types'
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

  ipcMain.handle(IPC.daysList, () => requireStore(deps).listDays())
  ipcMain.handle(IPC.dayGet, (_e, date: string) => requireStore(deps).readDay(date))
  ipcMain.handle(IPC.entryAdd, (_e, markdown: string) => requireStore(deps).addEntry(markdown))
  ipcMain.handle(IPC.entryUpdate, (_e, date: string, id: string, markdown: string) =>
    requireStore(deps).updateEntry(date, id, markdown)
  )
  ipcMain.handle(IPC.entryDelete, (_e, date: string, id: string) => requireStore(deps).deleteEntry(date, id))
  ipcMain.handle(IPC.entrySearch, (_e, query: string) => requireStore(deps).search(query))
  ipcMain.handle(
    IPC.assetSave,
    (_e, date: string, bytes: Uint8Array | ArrayBuffer, mime: string, name?: string) =>
      requireStore(deps).saveAsset(date, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime, name)
  )

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
