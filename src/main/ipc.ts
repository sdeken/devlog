import { BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { ActivityEvent, CanvasInput, Entry, EntryPosition, RepoInfo, Settings, TrackerStatus, UpdateStatus } from '@shared/types'
import { hasTaskTag, stripTaskTag } from '@devlog/core'
import type { DevlogStore } from '@devlog/core/node'
import type { SyncManager } from '@devlog/core/node'
import type { SettingsStore } from './settings'
import { randomUUID } from 'node:crypto'
import { inspectWorkingCopy } from './workingCopy'

export interface IpcDeps {
  settings: SettingsStore
  getStore: () => DevlogStore | null
  getSync: () => SyncManager | null
  openRepo: (root: string, opts?: { create?: boolean }) => Promise<RepoInfo>
  closeRepo: () => Promise<void>
  repoInfo: () => Promise<RepoInfo | null>
  chooseDirectory: () => Promise<string | null>
  onSettingsChanged: (s: Settings) => void
  /** A user block was added; lets the tracker switch the active task. */
  onEntryAdded: (canvasId: string, entry: Entry) => Promise<void>
  onCanvasesChanged: () => Promise<void>
  activityRange: (fromDate: string, toDate: string) => Promise<ActivityEvent[]>
  /** Append a user correction to the activity log (filed on the day it applies to). */
  activityAppend: (ev: ActivityEvent) => Promise<void>
  trackerStatus: () => TrackerStatus | null
  trackerSetTask: (canvasId: string | null) => Promise<void>
  updateStatus: () => UpdateStatus
  updateCheck: () => Promise<void>
  updateInstall: () => Promise<void>
  /** Import the user's own commits from the last `days` days of a linked repository. */
  importCommitHistory: (canvasId: string, repoPath: string, days: number) => Promise<number>
  setEditorBusy: (busy: boolean) => void
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
  ipcMain.handle(IPC.repoInspectWorkingCopy, (_e, dir: string) => inspectWorkingCopy(dir, deps.getStore()?.root ?? null))
  ipcMain.handle(IPC.repoOpen, (_e, root: string) => deps.openRepo(root))
  ipcMain.handle(IPC.repoCreate, async (_e, root: string, remoteUrl?: string) => {
    const info = await deps.openRepo(root, { create: true })
    if (remoteUrl && remoteUrl.trim()) {
      const sync = deps.getSync()
      if (sync) {
        await sync.setRemote(remoteUrl.trim())
        await sync.syncNow('manual')
      }
    }
    return deps.repoInfo()
  })
  ipcMain.handle(IPC.repoSetRemote, async (_e, remoteUrl: string) => {
    requireStore(deps)
    const sync = deps.getSync()
    if (!sync) throw new Error('No devlog is open')
    await sync.setRemote(remoteUrl.trim())
    await sync.syncNow('manual')
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

  ipcMain.handle(IPC.canvasesList, () => requireStore(deps).listCanvases())
  ipcMain.handle(IPC.canvasGet, (_e, id: string) => requireStore(deps).readCanvas(id))
  ipcMain.handle(IPC.canvasCreate, async (_e, input: CanvasInput) => {
    const store = requireStore(deps)
    if (input.repos) input = { ...input, repos: await checkNewRepos(input.repos, [], store.root) }
    const canvas = await store.createCanvas(input)
    await deps.onCanvasesChanged()
    return canvas
  })
  ipcMain.handle(IPC.canvasUpdate, async (_e, id: string, patch: Partial<CanvasInput>) => {
    const store = requireStore(deps)
    if (patch.repos) {
      const existing = (await store.readCanvas(id)).repos
      patch = { ...patch, repos: await checkNewRepos(patch.repos, existing, store.root) }
    }
    const canvas = await store.updateCanvas(id, patch)
    const active = deps.trackerStatus()?.activeCanvasId
    if (active === id && patch.task === false) await deps.trackerSetTask(null)
    await deps.onCanvasesChanged()
    return canvas
  })
  ipcMain.handle(IPC.canvasArchive, async (_e, id: string, archived: boolean) => {
    const changed = await requireStore(deps).setCanvasArchived(id, archived)
    const active = deps.trackerStatus()?.activeCanvasId
    if (archived && active && changed.includes(active)) await deps.trackerSetTask(null)
    await deps.onCanvasesChanged()
    return changed
  })
  ipcMain.handle(IPC.canvasDelete, async (_e, id: string) => {
    const store = requireStore(deps)
    const n = await store.deleteCanvas(id)
    // The active task may have been the canvas or one beneath it.
    const active = deps.trackerStatus()?.activeCanvasId
    if (active && !(await store.listCanvases()).some((c) => c.id === active)) await deps.trackerSetTask(null)
    await deps.onCanvasesChanged()
    return n
  })
  ipcMain.handle(IPC.surfaceSet, (_e, id: string, markdown: string) => requireStore(deps).writeSurface(id, markdown))
  ipcMain.handle(IPC.surfaceAssetSave, (_e, id: string, bytes: Uint8Array | ArrayBuffer, mime: string, name?: string) =>
    requireStore(deps).saveSurfaceAsset(id, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime, name)
  )

  ipcMain.handle(IPC.daysList, (_e, canvasId: string) => requireStore(deps).listDays(canvasId))
  ipcMain.handle(IPC.dayGet, (_e, canvasId: string, date: string) => requireStore(deps).readDay(canvasId, date))
  ipcMain.handle(IPC.timelineGet, (_e, canvasId: string, opts?: { beforeDate?: string; days?: number }) =>
    requireStore(deps).getTimeline(canvasId, opts ?? {})
  )
  ipcMain.handle(IPC.rangeGet, (_e, fromDate: string, toDate: string) => requireStore(deps).getRange(fromDate, toDate))
  ipcMain.handle(IPC.entryAdd, async (_e, canvasId: string, markdown: string, position?: EntryPosition, opts?: { task?: boolean }) => {
    const store = requireStore(deps)
    // "#task" on the first line (or the explicit flag) posts the block and turns it into a task at once.
    const wantsTask = Boolean(opts?.task) || hasTaskTag(markdown)
    const text = wantsTask ? stripTaskTag(markdown) : markdown
    const result = await store.addEntry(canvasId, text, position ?? {})
    if (wantsTask) {
      const promoted = await store.promoteToTask(canvasId, result.date, result.entry.id)
      await deps.onCanvasesChanged()
      await deps.trackerSetTask(promoted.canvas.id)
      return { date: result.date, entry: promoted.entry, canvas: promoted.canvas }
    }
    await deps.onEntryAdded(canvasId, result.entry)
    return result
  })
  ipcMain.handle(IPC.entryPromote, async (_e, canvasId: string, date: string, id: string) => {
    const result = await requireStore(deps).promoteToTask(canvasId, date, id)
    await deps.onCanvasesChanged()
    await deps.trackerSetTask(result.canvas.id)
    return result
  })
  // Todos
  ipcMain.handle(IPC.todosList, async (_e, canvasIds: string[]) => {
    const store = requireStore(deps)
    const out: Array<{ canvasId: string; entries: Entry[] }> = []
    for (const id of canvasIds ?? []) out.push({ canvasId: id, entries: await store.readTodos(id).catch(() => []) })
    return out
  })
  ipcMain.handle(IPC.todosAdd, (_e, canvasId: string, texts: string[]) => requireStore(deps).addTodos(canvasId, Array.isArray(texts) ? texts.map(String) : []))
  ipcMain.handle(IPC.todoReply, (_e, canvasId: string, parentId: string, markdown: string) => requireStore(deps).addTodoReply(canvasId, parentId, markdown))
  ipcMain.handle(IPC.todoUpdate, (_e, canvasId: string, id: string, markdown: string) => requireStore(deps).updateTodoEntry(canvasId, id, markdown))
  ipcMain.handle(IPC.todoDelete, (_e, canvasId: string, id: string) => requireStore(deps).deleteTodoEntry(canvasId, id))
  ipcMain.handle(IPC.todoHide, (_e, canvasId: string, id: string, hidden: boolean) => requireStore(deps).setTodoEntryHidden(canvasId, id, Boolean(hidden)))
  ipcMain.handle(IPC.todoReorder, (_e, canvasId: string, id: string, position: { afterId?: string; beforeId?: string }) =>
    requireStore(deps).reorderTodo(canvasId, id, position ?? {})
  )
  ipcMain.handle(IPC.todoSetDone, (_e, canvasId: string, id: string, done: boolean) => requireStore(deps).setTodoDone(canvasId, id, Boolean(done)))
  ipcMain.handle(IPC.todoPromote, async (_e, canvasId: string, id: string) => {
    const result = await requireStore(deps).promoteTodo(canvasId, id)
    await deps.onCanvasesChanged()
    await deps.trackerSetTask(result.canvas.id)
    return result
  })
  ipcMain.handle(IPC.entryHide, (_e, canvasId: string, date: string, id: string, hidden: boolean) =>
    requireStore(deps).setEntryHidden(canvasId, date, id, Boolean(hidden))
  )
  ipcMain.handle(IPC.entryReorder, (_e, canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }) =>
    requireStore(deps).reorderEntry(canvasId, date, id, position ?? {})
  )
  ipcMain.handle(IPC.entryUpdate, (_e, canvasId: string, date: string, id: string, markdown: string) =>
    requireStore(deps).updateEntry(canvasId, date, id, markdown)
  )
  ipcMain.handle(IPC.entryDelete, (_e, canvasId: string, date: string, id: string) => requireStore(deps).deleteEntry(canvasId, date, id))
  ipcMain.handle(IPC.entryMove, (_e, fromCanvasId: string, date: string, id: string, toCanvasId: string) =>
    requireStore(deps).moveEntry(fromCanvasId, date, id, toCanvasId)
  )
  ipcMain.handle(IPC.entrySearch, (_e, query: string) => requireStore(deps).search(query))
  ipcMain.handle(
    IPC.assetSave,
    (_e, canvasId: string, date: string, bytes: Uint8Array | ArrayBuffer, mime: string, name?: string) =>
      requireStore(deps).saveAsset(canvasId, date, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), mime, name)
  )

  ipcMain.handle(IPC.activityRange, (_e, fromDate: string, toDate: string) => deps.activityRange(fromDate, toDate))
  // Time corrections: "no task time counts between start and end", and undoing one.
  ipcMain.handle(IPC.activityExclude, async (_e, start: string, end: string) => {
    const s = new Date(start)
    const e = new Date(end)
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw new Error('Choose an end time after the start time')
    const id = randomUUID()
    await deps.activityAppend({ t: s.toISOString(), type: 'exclude', id, start: s.toISOString(), end: e.toISOString() })
    return id
  })
  ipcMain.handle(IPC.activityRestore, async (_e, id: string, start: string) => {
    const s = new Date(start)
    await deps.activityAppend({ t: Number.isNaN(s.getTime()) ? new Date().toISOString() : s.toISOString(), type: 'exclude', cancels: String(id) })
  })
  ipcMain.handle(IPC.trackerStatus, () => deps.trackerStatus())
  ipcMain.handle(IPC.trackerSetTask, (_e, canvasId: string | null) => deps.trackerSetTask(canvasId))

  ipcMain.handle(IPC.updateStatus, () => deps.updateStatus())
  ipcMain.handle(IPC.updateCheck, () => deps.updateCheck())
  ipcMain.handle(IPC.updateInstall, () => deps.updateInstall())
  ipcMain.handle(IPC.repoImportHistory, async (_e, canvasId: string, repoPath: string, days: number) => {
    const canvas = await requireStore(deps).readCanvas(canvasId)
    if (!canvas.repos.includes(repoPath)) throw new Error('Link the repository to this canvas first')
    return deps.importCommitHistory(canvasId, repoPath, Math.max(1, Math.min(3650, Math.round(Number(days) || 0))))
  })
  ipcMain.on(IPC.editorBusy, (_e, busy: boolean) => deps.setEditorBusy(Boolean(busy)))

  ipcMain.handle(IPC.syncNow, () => deps.getSync()?.syncNow('manual') ?? null)
  ipcMain.handle(IPC.syncStatus, () => deps.getSync()?.getStatus() ?? null)

  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url)
    return undefined
  })

  // The application menu is hidden; the hamburger button pops it up instead.
  ipcMain.handle(IPC.menuPopup, (e, x?: number, y?: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const menu = Menu.getApplicationMenu()
    if (!win || !menu) return
    menu.popup({ window: win, x: x !== undefined ? Math.round(x) : undefined, y: y !== undefined ? Math.round(y) : undefined })
  })
  ipcMain.handle(IPC.windowControl, (e, action: 'minimize' | 'maximize' | 'close') => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize())
    else win.close()
  })
}

/** Validate repositories being added (existing entries are kept as they are, so a broken one can still be removed). */
async function checkNewRepos(repos: string[], existing: string[], devlogRoot: string): Promise<string[]> {
  const out: string[] = []
  for (const r of repos) {
    if (existing.includes(r)) {
      out.push(r)
      continue
    }
    const check = await inspectWorkingCopy(r, devlogRoot)
    if (!check.ok) throw new Error(check.error)
    if (!out.includes(check.root) && !existing.includes(check.root)) out.push(check.root)
  }
  return out
}

