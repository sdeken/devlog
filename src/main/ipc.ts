import { BrowserWindow, Menu, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { ActivityEvent, CanvasInput, Entry, EntryPosition, RepoInfo, Settings, UpdateStatus } from '@shared/types'
import { checklistItems, isManagedCanvas } from '@devlog/core'
import type { DevlogStore } from '@devlog/core/node'
import type { SyncManager } from '@devlog/core/node'
import type { SettingsStore } from './settings'
import type { ExtensionManager } from './extensions/manager'
import type { CommandContext } from '@devlog/extension-api'
import { sanitizeGrant } from '@devlog/core'
import { randomUUID } from 'node:crypto'
import { inspectWorkingCopy } from './workingCopy'

export interface IpcDeps {
  settings: SettingsStore
  getExtensions: () => ExtensionManager | null
  /** A GitHub token for installing extensions from private repositories (kept in the OS keychain). */
  githubToken: { has: () => Promise<boolean>; set: (token: string | null) => Promise<void> }
  /** Extensions shipped with the app. */
  builtinExtensions: () => Promise<Array<{ name: string; displayName: string; description?: string }>>
  getStore: () => DevlogStore | null
  getSync: () => SyncManager | null
  openRepo: (root: string, opts?: { create?: boolean }) => Promise<RepoInfo>
  closeRepo: () => Promise<void>
  repoInfo: () => Promise<RepoInfo | null>
  chooseDirectory: () => Promise<string | null>
  onSettingsChanged: (s: Settings) => void
  /** A user block was added (extensions hear of it). */
  onEntryAdded: (canvasId: string, date: string, entry: Entry) => Promise<void>
  /** The renderer answered an extension's quick pick. */
  answerPick: (id: number, choice: string | null) => void
  onCanvasesChanged: () => Promise<void>
  activityRange: (fromDate: string, toDate: string) => Promise<ActivityEvent[]>
  /** Append a user correction to the activity log (filed on the day it applies to). */
  activityAppend: (ev: ActivityEvent) => Promise<void>
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

  // Extensions
  const ext = (): ExtensionManager => {
    const m = deps.getExtensions()
    if (!m) throw new Error('No devlog is open')
    return m
  }
  /** devlog.json or the lockfile changed: let sync commit it. */
  const touched = <T>(p: Promise<T>): Promise<T> => p.finally(() => deps.getSync()?.noteChange())
  ipcMain.handle(IPC.extList, () => deps.getExtensions()?.list() ?? [])
  ipcMain.handle(IPC.extAdd, (_e, key: string, spec: string) => touched(ext().add(String(key).trim(), String(spec).trim())))
  ipcMain.handle(IPC.extRemove, (_e, key: string) => touched(ext().remove(String(key))))
  ipcMain.handle(IPC.extAllow, (_e, key: string, grant: unknown) => ext().allow(String(key), sanitizeGrant(grant)))
  ipcMain.handle(IPC.extRevoke, (_e, key: string) => ext().revoke(String(key)))
  ipcMain.handle(IPC.extRestart, (_e, key: string) => ext().restart(String(key)))
  ipcMain.handle(IPC.extUpdate, () => touched(ext().update()))
  ipcMain.handle(IPC.extSetSettings, (_e, key: string, values: Record<string, string>) => touched(ext().setSettings(String(key), values && typeof values === 'object' ? values : {})))
  ipcMain.handle(IPC.extSetSecret, (_e, key: string, secretKey: string, value: string | null) => ext().setSecret(String(key), String(secretKey), typeof value === 'string' ? value : null))
  ipcMain.handle(IPC.extRun, (_e, key: string, commandId: string, context?: CommandContext) => ext().runCommand(String(key), String(commandId), context ?? { source: 'switcher' }))
  ipcMain.handle(IPC.extAppState, () => deps.getExtensions()?.appState() ?? { trayLabel: null, keepRunning: false, idleMinutes: 0, highlighted: [], providesTime: false })
  ipcMain.handle(IPC.extAnswerPick, (_e, id: number, choice: string | null) => deps.answerPick(Number(id), typeof choice === 'string' ? choice : null))
  ipcMain.handle(IPC.extViewCall, (_e, key: string, viewId: string, method: string, args: unknown[]) => ext().viewCall(String(key), String(viewId), String(method), Array.isArray(args) ? args : []))
  ipcMain.handle(IPC.extBuiltins, () => deps.builtinExtensions())
  ipcMain.handle(IPC.extGithubToken, async (_e, token?: string | null) => {
    if (token !== undefined) await deps.githubToken.set(typeof token === 'string' && token.trim() ? token.trim() : null)
    return deps.githubToken.has()
  })

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
    await deps.onCanvasesChanged()
    return canvas
  })
  ipcMain.handle(IPC.canvasArchive, async (_e, id: string, archived: boolean) => {
    const changed = await requireStore(deps).setCanvasArchived(id, archived)
    await deps.onCanvasesChanged()
    return changed
  })
  ipcMain.handle(IPC.canvasDelete, async (_e, id: string) => {
    const store = requireStore(deps)
    const n = await store.deleteCanvas(id)
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
  ipcMain.handle(IPC.rangeGet, async (_e, fromDate: string, toDate: string) => {
    // What was written, for the review and timeline: not what extensions keep in canvases of their own.
    const store = requireStore(deps)
    const [range, canvases] = await Promise.all([store.getRange(fromDate, toDate), store.listCanvases()])
    const kept = new Set(canvases.filter(isManagedCanvas).map((c) => c.id))
    return kept.size ? range.filter((d) => !kept.has(d.canvasId)) : range
  })
  ipcMain.handle(IPC.entryAdd, async (_e, canvasId: string, text: string, position?: EntryPosition) => {
    const store = requireStore(deps)
    // A checklist ("[ ] …" on every line) posts one todo per line.
    const checklist = !position?.afterId && !position?.beforeId ? checklistItems(text) : null
    if (checklist) {
      const { date, entries } = await store.addTodos(canvasId, checklist.map((c) => c.text), { date: position?.date, parentId: position?.parentId }, new Date(), {
        done: checklist.map((c) => c.done)
      })
      for (const e of entries) await deps.onEntryAdded(canvasId, date, e)
      return { date, entry: entries[0], count: entries.length }
    }
    const result = await store.addEntry(canvasId, text, position ?? {})
    await deps.onEntryAdded(canvasId, result.date, result.entry)
    return result
  })
  // Todos: blocks with kind=todo, anywhere in the streams
  ipcMain.handle(IPC.todosList, (_e, opts?: { doneSince?: string }) => requireStore(deps).listTodos({ doneSince: typeof opts?.doneSince === 'string' ? opts.doneSince : undefined }))
  ipcMain.handle(IPC.todosAdd, (_e, canvasId: string, texts: string[], position?: { date?: string; parentId?: string }) =>
    requireStore(deps).addTodos(canvasId, Array.isArray(texts) ? texts.map(String) : [], { date: position?.date, parentId: position?.parentId })
  )
  ipcMain.handle(IPC.todoSetDone, (_e, canvasId: string, date: string, id: string, done: boolean) => requireStore(deps).setTodoDone(canvasId, date, id, Boolean(done)))
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
  // To another canvas (a canvas id), or inside / beside a block ({ canvasId, date, parentId | afterId }).
  ipcMain.handle(IPC.entryMove, (_e, fromCanvasId: string, date: string, id: string, to: string | { canvasId: string; date?: string; parentId?: string; afterId?: string }) =>
    typeof to === 'string'
      ? requireStore(deps).moveEntry(fromCanvasId, date, id, to)
      : requireStore(deps).moveBlock({ canvasId: fromCanvasId, date, id }, { canvasId: String(to.canvasId), date: to.date, parentId: to.parentId, afterId: to.afterId })
  )
  ipcMain.handle(IPC.entrySearch, async (_e, query: string) => {
    // Canvases an extension keeps (the Timesheets canvas) are its storage, not part of the notebook.
    const store = requireStore(deps)
    const [result, canvases] = await Promise.all([store.search(query), store.listCanvases()])
    const kept = new Set(canvases.filter(isManagedCanvas).map((c) => c.id))
    if (kept.size === 0) return result
    return { blocks: result.blocks.filter((h) => !kept.has(h.canvasId)), surfaces: result.surfaces.filter((h) => !kept.has(h.canvasId)) }
  })
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

