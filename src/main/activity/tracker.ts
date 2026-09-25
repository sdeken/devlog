/**
 * Tracker: keeps the "one active task at a time" state and records what the
 * machine is doing around it (lock/unlock, idle, sleep, foreground window),
 * so the review can turn notes into time.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { powerMonitor } from 'electron'
import { HEARTBEAT_MS } from '@shared/activity'
import type { ActivityEvent, Settings, TrackerStatus } from '@shared/types'
import { ActivityLog } from '@devlog/core/node'
import { ForegroundWatcher } from './foreground'

interface PersistedState {
  activeCanvasId: string | null
}

export class Tracker extends EventEmitter {
  private status: TrackerStatus = {
    tracking: false,
    activeCanvasId: null,
    since: null,
    paused: false,
    pausedReason: null,
    focusAvailable: false,
    lastFocus: null
  }
  private foreground = new ForegroundWatcher()
  private heartbeat: NodeJS.Timeout | null = null
  private idlePoll: NodeJS.Timeout | null = null
  private idle = false
  /** Every reason the clock is currently paused; time accrues only when empty. */
  private pauses = new Set<'locked' | 'idle' | 'suspended'>()
  private running = false
  private settings: Settings

  constructor(
    private readonly log: ActivityLog,
    private readonly stateFile: string,
    settings: Settings
  ) {
    super()
    this.settings = settings
  }

  getStatus(): TrackerStatus {
    return { ...this.status }
  }

  /**
   * Start recording. Restores the persisted active task, passed through
   * `resolve` (which maps ids renamed by a storage migration, or drops ones
   * that no longer exist).
   */
  async start(resolve?: (canvasId: string) => Promise<string | null>): Promise<void> {
    if (this.running) return
    this.running = true
    this.pauses.clear()
    this.idle = false
    const persisted = await this.loadState()
    let active = persisted.activeCanvasId
    if (active && resolve) {
      const next = await resolve(active).catch(() => active)
      if (next !== active) {
        active = next
        await this.saveState({ activeCanvasId: active })
      }
    }
    this.status.activeCanvasId = active
    this.status.tracking = this.settings.trackingEnabled
    if (!this.settings.trackingEnabled) {
      this.emitStatus()
      return
    }
    await this.record({ type: 'start', canvasId: this.status.activeCanvasId })
    this.status.since = this.status.activeCanvasId ? new Date().toISOString() : null

    powerMonitor.on('lock-screen', this.onLock)
    powerMonitor.on('unlock-screen', this.onUnlock)
    powerMonitor.on('suspend', this.onSuspend)
    powerMonitor.on('resume', this.onResume)
    powerMonitor.on('shutdown', this.onShutdown)

    this.heartbeat = setInterval(() => void this.record({ type: 'heartbeat' }), HEARTBEAT_MS)
    this.heartbeat.unref?.()
    this.idlePoll = setInterval(() => this.pollIdle(), 15_000)
    this.idlePoll.unref?.()

    if (this.settings.trackFocus) this.startFocus()
    this.emitStatus()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    powerMonitor.off('lock-screen', this.onLock)
    powerMonitor.off('unlock-screen', this.onUnlock)
    powerMonitor.off('suspend', this.onSuspend)
    powerMonitor.off('resume', this.onResume)
    powerMonitor.off('shutdown', this.onShutdown)
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.idlePoll) clearInterval(this.idlePoll)
    this.heartbeat = null
    this.idlePoll = null
    this.foreground.stop()
    this.foreground.removeAllListeners()
    if (this.status.tracking) await this.record({ type: 'stop' })
    this.status.tracking = false
    this.status.since = null
    this.emitStatus()
  }

  async updateSettings(next: Settings): Promise<void> {
    const prev = this.settings
    this.settings = next
    if (!this.running) return
    if (prev.trackingEnabled !== next.trackingEnabled) {
      await this.stop()
      await this.start()
      return
    }
    if (prev.trackFocus !== next.trackFocus) {
      if (next.trackFocus) this.startFocus()
      else {
        this.foreground.stop()
        this.foreground.removeAllListeners()
        this.status.focusAvailable = false
        this.emitStatus()
      }
    }
  }

  /**
   * Make `canvasId` the active task (null stops the clock).
   * Returns true if the task changed.
   */
  async setTask(canvasId: string | null, entryId?: string): Promise<boolean> {
    const changed = canvasId !== this.status.activeCanvasId
    this.status.activeCanvasId = canvasId
    await this.saveState({ activeCanvasId: canvasId })
    if (this.status.tracking) {
      await this.record({ type: 'task', canvasId, entryId })
      this.status.since = canvasId && !this.status.paused ? new Date().toISOString() : null
    }
    this.emitStatus()
    return changed
  }

  // -------------------------------------------------------------------------

  private startFocus(): void {
    this.foreground.removeAllListeners()
    this.foreground.on('change', (info: { app: string; title: string }) => {
      this.status.lastFocus = info
      this.status.focusAvailable = true
      void this.record({ type: 'focus', app: info.app, title: info.title })
      this.emitStatus()
    })
    this.foreground.start()
    this.status.focusAvailable = this.foreground.available
  }

  private pollIdle(): void {
    const threshold = Math.max(0, this.settings.idleMinutes) * 60
    let state: string
    try {
      // With idle detection off, a huge threshold still reports "locked".
      state = powerMonitor.getSystemIdleState(threshold || 7 * 24 * 3600)
    } catch {
      return
    }
    // Backstop for a missed lock-screen/unlock-screen event. Windows and macOS
    // report "locked" here; elsewhere the state never says so, so skip.
    if (process.platform === 'win32' || process.platform === 'darwin') {
      if (state === 'locked' && !this.pauses.has('locked')) {
        this.pause('locked')
        return
      }
      if (state !== 'locked' && state !== 'unknown' && this.pauses.has('locked')) this.resume('locked')
    }
    if (threshold === 0) return
    if (state === 'idle' && !this.idle) {
      this.idle = true
      this.pause('idle')
    } else if (state === 'active' && this.idle) {
      this.idle = false
      this.resume('idle')
    }
  }

  private onLock = (): void => this.pause('locked')
  private onUnlock = (): void => this.resume('locked')
  private onSuspend = (): void => this.pause('suspended')
  private onResume = (): void => this.resume('suspended')
  private onShutdown = (): void => {
    void this.record({ type: 'stop' })
  }

  private pause(reason: 'locked' | 'idle' | 'suspended'): void {
    const type = reason === 'locked' ? 'lock' : reason === 'idle' ? 'idle' : 'suspend'
    if (this.pauses.has(reason)) return
    void this.record({ type })
    this.pauses.add(reason)
    if (!this.status.paused) {
      this.status.paused = true
      this.status.pausedReason = reason
    }
    this.emitStatus()
  }

  /**
   * Clear one reason for pausing. Unlocking clears them all (the user is
   * back); waking from sleep or input after idle clears only its own, so a
   * machine that wakes while still locked stays paused.
   */
  private resume(reason: 'locked' | 'idle' | 'suspended'): void {
    const type = reason === 'locked' ? 'unlock' : reason === 'idle' ? 'active' : 'resume'
    void this.record({ type })
    if (reason === 'locked') {
      this.pauses.clear()
      this.idle = false
    } else this.pauses.delete(reason)
    if (this.status.paused && this.pauses.size === 0) {
      this.status.paused = false
      this.status.pausedReason = null
      this.status.since = this.status.activeCanvasId ? new Date().toISOString() : null
    } else if (this.status.paused) {
      this.status.pausedReason = this.pauses.has('locked') ? 'locked' : this.pauses.has('suspended') ? 'suspended' : 'idle'
    }
    this.emitStatus()
  }

  private async record(ev: Omit<ActivityEvent, 't'>): Promise<void> {
    if (!this.status.tracking && ev.type !== 'start') return
    try {
      await this.log.append({ t: new Date().toISOString(), ...ev })
    } catch (err) {
      console.error('activity log write failed', err)
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  private async loadState(): Promise<PersistedState> {
    try {
      const raw = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as Partial<PersistedState> & { activePageId?: string }
      const id = typeof raw.activeCanvasId === 'string' ? raw.activeCanvasId : typeof raw.activePageId === 'string' ? raw.activePageId : null
      return { activeCanvasId: id }
    } catch {
      return { activeCanvasId: null }
    }
  }

  private async saveState(state: PersistedState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true })
    await fs.writeFile(this.stateFile, JSON.stringify(state))
  }
}
