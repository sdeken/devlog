import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { IPC, type MenuCommand } from '@shared/ipc'
import type { AttachedImage, Entry, RepoInfo, Settings, SyncStatus, TrackerStatus } from '@shared/types'
import { JOURNAL_PAGE_ID } from '@shared/pages'
import { localDate, parseDurationMarker } from '@shared/entries'
import { DevlogStore } from './devlog/store'
import { ActivityLog } from './activity/log'
import { Tracker } from './activity/tracker'
import { CommitWatcher, commitMarkdown, type CommitInfo } from './activity/commits'
import { TRAY_ICON_PNG_BASE64 } from './tray-icon'
import { SyncManager, type SyncOptions } from './devlog/sync'
import { SettingsStore } from './settings'
import { installAssetHandler, registerAssetScheme } from './protocol'
import { buildMenu } from './menu'
import { registerIpc } from './ipc'

// Packaged macOS apps inherit a minimal PATH; make sure git from Homebrew etc. is found.
if (process.platform === 'darwin') {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), ...extra])].filter(Boolean).join(':')
}

// git must never block waiting for a password on a terminal we do not have.
process.env.GIT_TERMINAL_PROMPT ??= '0'

registerAssetScheme()

// Lets tests and multiple profiles run side by side without touching the real settings.
if (process.env.DEVLOG_USER_DATA) app.setPath('userData', process.env.DEVLOG_USER_DATA)

const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))
let mainWindow: BrowserWindow | null = null
let store: DevlogStore | null = null
let sync: SyncManager | null = null
let tracker: Tracker | null = null
let commits: CommitWatcher | null = null
let tray: Tray | null = null
let quitting = false

const activityLog = new ActivityLog(() => {
  const s = settings.get()
  return s.activityInRepo && store ? store.root : app.getPath('userData')
})

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif'
}

function send(channel: string, payload?: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function syncOptionsFrom(s: Settings): SyncOptions {
  return {
    intervalMinutes: s.syncIntervalMinutes,
    debounceSeconds: s.commitDebounceSeconds,
    autoPush: s.autoPush,
    pullOnStart: s.pullOnStart,
    authorName: s.authorName,
    authorEmail: s.authorEmail
  }
}

export async function closeRepo(): Promise<void> {
  if (tracker) {
    await tracker.stop()
    tracker.removeAllListeners()
    tracker = null
  }
  if (commits) {
    commits.stop()
    commits.removeAllListeners()
    commits = null
  }
  if (sync) {
    sync.stop()
    await sync.idle()
    sync.removeAllListeners()
  }
  store?.removeAllListeners()
  sync = null
  store = null
}

/** Open (or create) a devlog at `root` and start syncing it. */
export async function openRepo(root: string, { create = false } = {}): Promise<RepoInfo> {
  await closeRepo()
  const stat = await fs.stat(root).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${root}`)

  const gitVersion = await SyncManager.gitVersion()
  if (!gitVersion) throw new Error('git was not found on this machine. Install git and restart Devlog.')

  const s = settings.get()
  const nextStore = new DevlogStore(root)
  const isRepo = await SyncManager.isRepo(root)
  if (!isRepo && !create) {
    throw new Error('That folder is not a git repository. Use "Create a new devlog" to initialise one.')
  }
  await nextStore.initLayout()
  if (!isRepo || create) await SyncManager.initRepo(root, syncOptionsFrom(s))

  const nextSync = new SyncManager(root, syncOptionsFrom(s))
  nextSync.on('status', (status: SyncStatus) => send(IPC.evSyncStatus, status))
  nextSync.on('remote-changes', () => send(IPC.evEntriesChanged))
  nextStore.on('change', () => nextSync.noteChange())

  store = nextStore
  sync = nextSync
  await settings.set({ repoPath: root })
  await nextSync.start()

  // Activity tracking and commit capture live alongside the open repo.
  const nextTracker = new Tracker(activityLog, path.join(app.getPath('userData'), 'tracker-state.json'), settings.get())
  nextTracker.on('status', (st: TrackerStatus) => {
    send(IPC.evTrackerStatus, st)
    updateTray(st)
  })
  tracker = nextTracker
  await nextTracker.start()

  const nextCommits = new CommitWatcher((r) => path.resolve(r) === path.resolve(root))
  nextCommits.on('commit', (pageId: string, info: CommitInfo) => void onCommit(pageId, info))
  commits = nextCommits
  await refreshCommitWatchers()

  const info = await repoInfo()
  send(IPC.evRepoChanged, info)
  return info!
}

async function refreshCommitWatchers(): Promise<void> {
  if (!store || !commits) return
  if (!settings.get().captureCommits) {
    await commits.setRepos([])
    return
  }
  const pages = await store.listPages()
  const list: Array<{ pageId: string; path: string }> = []
  for (const p of pages) for (const r of p.repos) list.push({ pageId: p.id, path: r })
  await commits.setRepos(list)
}

/** A commit landed in a page's repository: add it as a read-only note. */
async function onCommit(pageId: string, info: CommitInfo): Promise<void> {
  if (!store) return
  try {
    const { date } = await store.addEntry(
      pageId,
      commitMarkdown(info),
      { date: localDate(new Date()) },
      new Date(),
      { kind: 'commit', meta: { repo: info.repoPath, hash: info.hash, branch: info.branch ?? '', author: info.author } }
    )
    send(IPC.evEntriesChanged, { pageId, date })
  } catch (err) {
    console.error('failed to record commit', err)
  }
}

/** A user note was posted: pages other than the journal become the active task. */
async function onEntryAdded(pageId: string, entry: Entry): Promise<void> {
  if (!tracker) return
  if (pageId === JOURNAL_PAGE_ID) return
  if (entry.kind && entry.kind !== 'note') return
  // A note with an explicit duration records the past; it does not start a task.
  if (parseDurationMarker(entry.markdown) !== null) return
  await tracker.setTask(pageId, entry.id)
}

function updateTray(st: TrackerStatus | null): void {
  if (!tray) return
  const label = !st || !st.tracking ? 'Devlog' : st.activePageId ? `Devlog · ${st.activePageId}${st.paused ? ' (paused)' : ''}` : 'Devlog · no active task'
  tray.setToolTip(label)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: label, enabled: false },
      { type: 'separator' },
      { label: 'Open Devlog', click: () => showWindow() },
      { label: 'Stop Active Task', enabled: !!st?.activePageId, click: () => void tracker?.setTask(null) },
      { label: 'Sync Now', click: () => void sync?.syncNow('manual') },
      { type: 'separator' },
      { label: 'Quit Devlog', click: () => quitApp() }
    ])
  )
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function quitApp(): void {
  quitting = true
  app.quit()
}

function createTray(): void {
  if (tray) return
  try {
    const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`)
    tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 16, height: 16 }) : icon)
    tray.on('click', () => showWindow())
    tray.on('double-click', () => showWindow())
    updateTray(tracker?.getStatus() ?? null)
  } catch (err) {
    console.error('tray unavailable', err)
  }
}

export async function repoInfo(): Promise<RepoInfo | null> {
  if (!store || !sync) return null
  const st = sync.getStatus()
  return { path: store.root, remoteUrl: st.remoteUrl, branch: st.branch }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Devlog',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#1a1d21',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? process.env.ELECTRON_RENDERER_URL! : 'file://'
    if (!url.startsWith(allowed)) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // Closing the window keeps tracking in the tray; quitting is explicit.
  win.on('close', (event) => {
    if (quitting || !settings.get().trackingEnabled || !tray) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.sdeken.devlog')
    await settings.load()
    installAssetHandler(() => store)

    registerIpc({
      settings,
      getStore: () => store,
      getSync: () => sync,
      openRepo,
      closeRepo,
      repoInfo,
      chooseDirectory: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Choose devlog folder',
          properties: ['openDirectory', 'createDirectory']
        }
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
        return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
      },
      onSettingsChanged: (s) => {
        sync?.updateOptions(syncOptionsFrom(s))
        void tracker?.updateSettings(s)
        void refreshCommitWatchers()
      },
      onEntryAdded,
      onPagesChanged: refreshCommitWatchers,
      activityRange: (from, to) => activityLog.read(from, to),
      trackerStatus: () => tracker?.getStatus() ?? null,
      trackerSetTask: async (pageId) => {
        await tracker?.setTask(pageId)
      }
    })

    const menuCmd = (cmd: MenuCommand) => () => send(IPC.evMenu, cmd)
    buildMenu(() => mainWindow, {
      syncNow: () => void sync?.syncNow('manual'),
      openRepo: async () => {
        const opts: Electron.OpenDialogOptions = { title: 'Open devlog repository', properties: ['openDirectory'] }
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
        if (!res.canceled && res.filePaths[0]) {
          try {
            await openRepo(res.filePaths[0])
          } catch (err) {
            dialog.showErrorBox('Could not open devlog', err instanceof Error ? err.message : String(err))
          }
        }
      },
      openSettings: menuCmd('openSettings'),
      focusComposer: menuCmd('focusComposer'),
      search: menuCmd('search'),
      newPage: menuCmd('newPage'),
      review: menuCmd('review'),
      timeline: menuCmd('timeline'),
      stopTask: () => void tracker?.setTask(null),
      quit: quitApp,
      attachImage: async () => {
        const opts: Electron.OpenDialogOptions = {
          title: 'Attach image',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] }]
        }
        const res = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts)
        if (res.canceled || res.filePaths.length === 0) return
        const images: AttachedImage[] = []
        for (const file of res.filePaths) {
          const ext = path.extname(file).slice(1).toLowerCase()
          const mime = MIME_BY_EXT[ext]
          if (!mime) continue
          images.push({ name: path.basename(file), mime, bytes: new Uint8Array(await fs.readFile(file)) })
        }
        if (images.length) send(IPC.evAttachImages, images)
      }
    })

    mainWindow = createWindow()
    createTray()

    const s = settings.get()
    if (s.repoPath) {
      try {
        await openRepo(s.repoPath)
      } catch (err) {
        console.error('Failed to reopen devlog:', err)
        await settings.set({ repoPath: null })
        send(IPC.evRepoChanged, null)
      }
    }

  })

  app.on('window-all-closed', () => {
    // With a tray the app lives on to keep tracking; without one, quit as usual.
    if (process.platform !== 'darwin' && !tray) app.quit()
  })

  app.on('activate', () => showWindow())

  // Commit (and push) any pending changes before the process exits.
  let quitHandled = false
  app.on('before-quit', (event) => {
    quitting = true
    if (quitHandled) return
    quitHandled = true
    event.preventDefault()
    const work = (async () => {
      await tracker?.stop().catch(() => undefined)
      commits?.stop()
      if (sync && settings.get().commitOnQuit) await sync.syncNow('quit')
    })()
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 20_000))
    Promise.race([work.then(() => undefined), timeout])
      .catch(() => undefined)
      .finally(() => app.quit())
  })
}
