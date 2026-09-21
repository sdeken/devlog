/**
 * Silent auto-update: check GitHub Releases on a schedule, download in the
 * background, and restart into the new version at a quiet moment. No dialogs.
 */
import { EventEmitter } from 'node:events'
import { app, powerMonitor } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { shouldInstallNow, type InstallContext } from '@shared/updates'
import type { UpdateStatus } from '@shared/types'

export interface UpdaterSignals {
  enabled: () => boolean
  windowVisible: () => boolean
  windowFocused: () => boolean
  locked: () => boolean
  syncBusy: () => boolean
  editorBusy: () => boolean
  /** Runs the normal shutdown work (stop tracker, final sync) before the restart. */
  prepareQuit: () => Promise<void>
}

const CHECK_INTERVAL_MS = 4 * 60 * 60_000
const FIRST_CHECK_DELAY_MS = 30_000
const POLICY_TICK_MS = 60_000

export class Updater extends EventEmitter {
  private status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion(), availableVersion: null, checkedAt: null, error: null }
  private checkTimer: NodeJS.Timeout | null = null
  private policyTimer: NodeJS.Timeout | null = null
  private downloadedAt = 0
  private startedAt = Date.now()
  private installing = false

  constructor(private readonly signals: UpdaterSignals) {
    super()
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = null
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking', error: null }))
    autoUpdater.on('update-available', (info: UpdateInfo) => this.set({ state: 'downloading', availableVersion: info.version }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'idle', availableVersion: null, checkedAt: new Date().toISOString() }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', progress: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.downloadedAt = Date.now()
      this.set({ state: 'downloaded', availableVersion: info.version, progress: undefined, checkedAt: new Date().toISOString() })
    })
    autoUpdater.on('error', (err) => this.set({ state: this.status.state === 'downloaded' ? 'downloaded' : 'error', error: shortError(err) }))
  }

  /** Only packaged builds can update; dev and CI runs just report the version. */
  get available(): boolean {
    return app.isPackaged
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  start(): void {
    if (!this.available) {
      this.set({ state: 'unavailable' })
      return
    }
    this.checkTimer = setTimeout(() => {
      void this.check()
      this.checkTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
      this.checkTimer.unref?.()
    }, FIRST_CHECK_DELAY_MS)
    this.checkTimer.unref?.()
    this.policyTimer = setInterval(() => void this.maybeInstall(), POLICY_TICK_MS)
    this.policyTimer.unref?.()
  }

  stop(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    if (this.policyTimer) clearInterval(this.policyTimer)
    this.checkTimer = null
    this.policyTimer = null
  }

  async check(): Promise<void> {
    if (!this.available || !this.signals.enabled() || this.installing) return
    if (this.status.state === 'downloading' || this.status.state === 'downloaded') return
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.set({ state: 'error', error: shortError(err) })
    }
  }

  /** Called once a minute; restarts into the update when the policy says it is a good moment. */
  async maybeInstall(): Promise<void> {
    if (this.installing || this.status.state !== 'downloaded') return
    let idleSeconds = 0
    try {
      idleSeconds = powerMonitor.getSystemIdleTime()
    } catch {
      /* not supported */
    }
    const ctx: InstallContext = {
      enabled: this.signals.enabled(),
      downloaded: true,
      now: Date.now(),
      startedAt: this.startedAt,
      downloadedAt: this.downloadedAt,
      windowVisible: this.signals.windowVisible(),
      windowFocused: this.signals.windowFocused(),
      idleSeconds,
      locked: this.signals.locked(),
      syncBusy: this.signals.syncBusy(),
      editorBusy: this.signals.editorBusy()
    }
    const decision = shouldInstallNow(ctx)
    if (!decision.install) return
    await this.installNow(decision.reason)
  }

  async installNow(reason: string): Promise<void> {
    if (this.installing) return
    this.installing = true
    this.set({ state: 'installing', error: null })
    console.log(`[updates] installing ${this.status.availableVersion}: ${reason}`)
    try {
      await this.signals.prepareQuit()
    } catch (err) {
      console.error('[updates] shutdown work failed, installing anyway', err)
    }
    // Silent install, relaunch the new version afterwards.
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }
}

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.split('\n')[0].slice(0, 300)
}
