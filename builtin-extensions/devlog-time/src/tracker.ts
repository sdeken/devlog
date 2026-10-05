/**
 * The clock: one active task at a time, paused while the machine is locked,
 * idle or asleep. Every change is appended to a JSON-lines file per machine
 * and day, in the extension's own folder of the devlog (or on this machine
 * only, if you choose), and handed to the app's views as time events:
 *
 *   extensions/builtin.devlog-time/<machine>/YYYY/MM/YYYY-MM-DD.jsonl
 *   {"t":"2026-09-29T09:14:03.120Z","type":"task","canvasId":"k2x9…","blockId":"a1b2"}
 *
 * Only what the clock does is written here: start, task, stop and
 * heartbeats, and your corrections (`assign`: "14:00–15:00 was this task",
 * or not worked), filed on the day they correct. Locks, idle and sleep are
 * the app's to record (they are the machine's state, not the clock's); the
 * app's views put the two together.
 */
import type { ActivityNotice, DevlogContext, ExtensionCanvas, ExtensionFiles, TimeEvent } from '@devlog/extension-api'

export const TASK_TYPE_ID = 'task'
/** How often a running clock says it is still running (the app's views count up to the last one when a log just ends). */
export const HEARTBEAT_MS = 5 * 60_000

const FILE_RE = /^([^/]+)\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.jsonl$/
const pad = (n: number): string => String(n).padStart(2, '0')
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export interface ClockStatus {
  /** The active task, or null when the clock is stopped. */
  active: string | null
  /** "Client / Project / Task". */
  label: string | null
  /** When time last started accruing (null while stopped or paused). */
  since: string | null
  paused: ActivityNotice['reason'] | null
}

interface SavedState {
  active: string | null
}

type Kind = TimeEvent['type']

/** One correction, as the timesheet lists them. */
export interface Correction {
  id: string
  start: string
  end: string
  canvasId: string | null
  at: string
}

const MAX_WINDOW_MS = 24 * 3600_000

export class Clock {
  private active: string | null = null
  private since: string | null = null
  private paused: ActivityNotice['reason'] | null = null
  private canvases: ExtensionCanvas[] = []
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private writes: Promise<unknown> = Promise.resolve()
  private listeners: Array<(st: ClockStatus) => void> = []
  readonly taskType: string

  constructor(
    private readonly ctx: DevlogContext,
    private readonly now: () => Date = () => new Date()
  ) {
    this.taskType = `${ctx.id}/${TASK_TYPE_ID}`
  }

  /** Where the events go: the devlog (synced), or this machine only. */
  private get store(): ExtensionFiles {
    return this.ctx.settings.get('in_repo') === 'false' ? this.ctx.files.local : this.ctx.files.repo
  }

  onChange(cb: (st: ClockStatus) => void): void {
    this.listeners.push(cb)
  }

  status(): ClockStatus {
    return { active: this.active, label: this.active ? this.label(this.active) : null, since: this.since, paused: this.paused }
  }

  /** "Client / Project / Task" for a canvas. */
  label(canvasId: string): string {
    const byId = new Map(this.canvases.map((c) => [c.id, c]))
    const parts: string[] = []
    const seen = new Set<string>()
    for (let c = byId.get(canvasId); c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
      seen.add(c.id)
      parts.unshift(c.title)
    }
    return parts.join(' / ') || canvasId
  }

  isTask(canvasId: string): boolean {
    return this.canvases.some((c) => c.id === canvasId && c.type === this.taskType && !c.archived)
  }

  /** Tasks that can be started, as the picker lists them (the canvas given, and what is inside it, first). */
  tasks(near?: string): Array<{ id: string; title: string; label: string; path: string }> {
    const rank = (c: ExtensionCanvas): number => (c.id === near ? 2 : c.parentId && c.parentId === near ? 1 : 0)
    return this.canvases
      .filter((c) => c.type === this.taskType && !c.archived)
      .map((c) => ({ c, label: this.label(c.id) }))
      .sort((a, b) => rank(b.c) - rank(a.c) || a.label.localeCompare(b.label))
      .map(({ c, label }) => ({ id: c.id, title: c.title, label, path: label.split(' / ').slice(0, -1).join(' / ') }))
  }

  async refreshCanvases(): Promise<ExtensionCanvas[]> {
    this.canvases = await this.ctx.devlog.canvases()
    return this.canvases
  }

  /** Start: restore the task that was active when the app last closed (if it still exists). */
  async start(): Promise<void> {
    await this.refreshCanvases()
    const saved = await this.loadState()
    this.active = saved.active && this.isTask(saved.active) ? saved.active : null
    if (this.active !== saved.active) await this.saveState()
    await this.record('start', { canvasId: this.active })
    this.since = this.active && !this.paused ? this.now().toISOString() : null
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS)
    ;(this.heartbeat as { unref?: () => void }).unref?.()
    this.emit()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    await this.record('stop', {})
    await this.writes
  }

  /** Make a task active (null stops the clock). */
  async setTask(canvasId: string | null, blockId?: string): Promise<void> {
    if (canvasId) {
      await this.refreshCanvases()
      if (!this.isTask(canvasId)) throw new Error('That is not a task')
    }
    this.active = canvasId
    await this.saveState()
    await this.record('task', { canvasId, ...(blockId ? { blockId } : {}) })
    this.since = canvasId && !this.paused ? this.now().toISOString() : null
    this.emit()
  }

  /** The machine was locked, went idle or to sleep (the app says so), or is back. */
  notice(n: ActivityNotice): void {
    if (n.type === 'pause') {
      this.paused = n.reason ?? 'locked'
      this.since = null
    } else if (n.type === 'resume') {
      this.paused = null
      this.since = this.active ? n.t : null
    } else return
    this.emit()
  }

  /** Still running: a heartbeat (only while time accrues), and a check that the task still exists. */
  private async beat(): Promise<void> {
    if (this.paused) return
    await this.record('heartbeat', {})
    if (this.active) {
      await this.refreshCanvases().catch(() => undefined)
      if (!this.isTask(this.active)) await this.setTask(null)
    }
  }

  /**
   * Say what a stretch of time was: `canvasId` (any canvas), or null for
   * not worked. It replaces whatever was tracked in the window, in every
   * view, and leaves the clock alone: time after the window keeps counting.
   */
  async assign(start: string, end: string, canvasId: string | null): Promise<Correction> {
    const s = Date.parse(start)
    const e = Date.parse(end)
    if (Number.isNaN(s) || Number.isNaN(e)) throw new Error('Give a start and an end')
    if (e <= s) throw new Error('The end must be after the start')
    if (e - s > MAX_WINDOW_MS) throw new Error('Correct at most a day at a time')
    if (canvasId !== null) {
      await this.refreshCanvases()
      if (!this.canvases.some((c) => c.id === canvasId)) throw new Error('That canvas does not exist')
    }
    const at = this.now().toISOString()
    const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const c: Correction = { id, start: new Date(s).toISOString(), end: new Date(e).toISOString(), canvasId, at }
    await this.record('assign', { canvasId, start: c.start, end: c.end, id, at }, c.start)
    return c
  }

  /** Undo a correction (its window is needed to file the undo beside it). */
  async unassign(id: string, start: string): Promise<void> {
    if (!/^[a-z0-9]{1,40}$/.test(id) || Number.isNaN(Date.parse(start))) throw new Error('No such correction')
    await this.record('assign', { cancels: id, at: this.now().toISOString() }, new Date(start).toISOString())
  }

  private async record(type: Kind, fields: Partial<Omit<TimeEvent, 't' | 'type' | 'machine'>>, when?: string): Promise<void> {
    const t = when ?? this.now().toISOString()
    const line = `${JSON.stringify({ t, type, ...fields })}\n`
    const date = localDate(new Date(t))
    const file = `${this.ctx.machine}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jsonl`
    const store = this.store
    const write = this.writes.then(() => store.append(file, line))
    this.writes = write.catch(() => undefined)
    await write
  }

  /** Every machine's events between two local dates (inclusive). */
  async events(fromDate: string, toDate: string): Promise<TimeEvent[]> {
    await this.writes
    const out: TimeEvent[] = []
    const store = this.store
    for (const f of await store.list()) {
      const m = FILE_RE.exec(f.path)
      if (!m || m[4] < fromDate || m[4] > toDate) continue
      const text = (await store.readText(f.path)) ?? ''
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as Partial<TimeEvent>
          if (typeof o.t !== 'string' || !['start', 'task', 'stop', 'heartbeat', 'assign'].includes(String(o.type))) continue
          const ev: TimeEvent = { t: o.t, type: o.type as Kind, ...(o.canvasId !== undefined ? { canvasId: o.canvasId } : {}), ...(o.blockId ? { blockId: o.blockId } : {}), machine: m[1] }
          for (const k of ['start', 'end', 'id', 'at', 'cancels'] as const) if (typeof o[k] === 'string') ev[k] = o[k]
          out.push(ev)
        } catch {
          // A torn last line (a crash mid-write): skip it.
        }
      }
    }
    return out.sort((a, b) => a.t.localeCompare(b.t))
  }

  private emit(): void {
    const st = this.status()
    for (const cb of this.listeners) cb(st)
  }

  private async loadState(): Promise<SavedState> {
    try {
      const raw = JSON.parse((await this.ctx.files.local.readText('state.json')) ?? '{}') as Partial<SavedState>
      return { active: typeof raw.active === 'string' ? raw.active : null }
    } catch {
      return { active: null }
    }
  }

  private async saveState(): Promise<void> {
    await this.ctx.files.local.write('state.json', JSON.stringify({ active: this.active }))
  }
}
