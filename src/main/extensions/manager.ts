/**
 * ExtensionManager: the extensions of one open devlog. Reads `devlog.json`
 * and `devlog.lock.json`, installs what they name, asks before running
 * anything (per build, per devlog), runs each allowed extension in its own
 * sandboxed process, and answers its API calls, filtered by what you
 * granted it. See docs/EXTENSIONS.md.
 */
import path from 'node:path'
import {
  EXTENSION_API_VERSION,
  EXTENSIONS_DIR,
  extensionId,
  canvasLabel,
  fieldProblem,
  inheritedField,
  MANAGED_FIELD,
  TIMESHEETS_MANAGED,
  nodeTypeName,
  sanitizeTimesheet,
  parseExtensionEntry,
  topLevelCanvasId,
  scopeCanvasIds,
  visibleCanvases,
  type CanvasInput,
  type CanvasMeta,
  type Entry,
  type Grant
} from '@devlog/core'
import {
  ExtensionFileStore,
  ensureExtensionAttributes,
  readLockFile,
  readManifest,
  updateManifest,
  writeLockFile,
  type DevlogStore,
  type LockFile
} from '@devlog/core/node'
import type { ActivityNotice, CommandContext, DestinationLine, DestinationSheet, ExtensionBlock, ExtensionCanvas, PickItem, SendResult } from '@devlog/extension-api'
import type { ActivityEvent } from '@shared/types'
import type { ExtensionAppState, ExtensionInfo, ExtensionState, ExtensionUpdateReport } from '@shared/extensions'
import { ExtensionHost } from './host'
import { readMainCode, type ExtensionInstaller, type InstalledExtension } from './install'
import { devlogKey, type ConsentStore, type SecretStore } from './localState'

export interface ManagerDeps {
  root: string
  /** This machine's activity folder name, given to extensions as `ctx.machine`. */
  machine: string
  store: DevlogStore
  userData: string
  installer: ExtensionInstaller
  consent: ConsentStore
  secrets: SecretStore
  /** The host script, somewhere the extension process may read it. */
  hostScript: () => Promise<string>
  notify: (text: string) => void
  confirm: (title: string, message: string) => Promise<boolean>
  /** The list of extensions (or their state) changed. */
  onChange: () => void
  /** An extension wrote a block. */
  onBlockAdded: (canvasId: string, date: string) => void
  /** An extension sent a message to its view (every open copy). */
  onViewMessage?: (key: string, viewId: string, message: unknown) => void
  /** An extension made or changed a canvas. */
  onCanvasesChanged?: () => void
  /** What extensions ask of the app around them changed (tray label, keep running, idle, highlight): see `appState()`. */
  onAppState?: () => void
  /** Show a quick pick; the chosen id, or null. */
  pick?: (title: string, items: PickItem[], placeholder?: string) => Promise<string | null>
  /** Show a canvas, a block's page, or an extension's page (`page`: "<key>/<view id>"). */
  open?: (target: { canvasId?: string; date?: string; blockId?: string; page?: string }) => void
  /** What the app recorded (its log, and what extensions provide), with canvas aliases resolved. */
  activity?: (fromDate: string, toDate: string) => Promise<ActivityEvent[]>
}



interface Rec {
  key: string
  spec: string
  id: string
  installed: InstalledExtension | null
  host: ExtensionHost | null
  state: ExtensionState
  error: string | null
  grant: Grant | null
  changedSinceConsent: boolean
  activity: boolean
  /** Provides focus events for the app's views. */
  providesFocus: boolean
  /** Provides time-tracking events (1.6). */
  providesActivity: boolean
  /** Listens for posted blocks (1.6). */
  blocks: boolean
  idleMinutes: number
  trayLabel: string | null
  keepRunning: boolean
  highlight: string | null
  /** Destinations it registered (of those it declared). */
  destinations: Set<string>
  /** Views whose calls it answers. */
  viewHandlers: Set<string>
  files: { repo: ExtensionFileStore; local: ExtensionFileStore } | null
  secretSet: Set<string>
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/

/**
 * Where a view's page is served: devlog-ext://<the devlog.json key, as hex>/<file>
 * (hex because URL hosts are lower-cased and cannot hold "/").
 */
export const VIEW_SCHEME = 'devlog-ext'
export function viewUrl(key: string, entry: string): string {
  return `${VIEW_SCHEME}://${Buffer.from(key, 'utf8').toString('hex')}/${entry.split('/').map(encodeURIComponent).join('/')}`
}
/** The devlog.json key back from a view URL's host. */
export function viewKey(host: string): string | null {
  return /^[0-9a-f]+$/.test(host) && host.length % 2 === 0 ? Buffer.from(host, 'hex').toString('utf8') : null
}

export class ExtensionManager {
  private readonly recs = new Map<string, Rec>()
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: ManagerDeps) {}

  /** Run lifecycle changes one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => undefined)
    return run
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** (Re)read devlog.json and bring the running set in line with it. */
  load(): Promise<void> {
    return this.serial(async () => {
      if (this.stopped) return
      const manifest = await readManifest(this.deps.root)
      const wanted = Object.entries(manifest.extensions ?? {}).filter(([, v]) => typeof v === 'string') as Array<[string, string]>
      for (const key of [...this.recs.keys()]) {
        if (!wanted.some(([k]) => k === key)) await this.drop(key)
      }
      const lock = await readLockFile(this.deps.root)
      let lockChanged = false
      for (const [key, spec] of wanted) {
        const cur = this.recs.get(key)
        if (cur && cur.spec === spec && (cur.state === 'running' || cur.state === 'needs-consent')) continue
        if (cur) await this.drop(key)
        lockChanged = (await this.installAndStart(key, spec, lock)) || lockChanged
      }
      for (const key of Object.keys(lock.extensions)) {
        if (!wanted.some(([k]) => k === key)) {
          delete lock.extensions[key]
          lockChanged = true
        }
      }
      if (lockChanged) await writeLockFile(this.deps.root, lock)
      this.deps.onChange()
    })
  }

  /** Install one entry (recording it in `lock`) and start it if allowed. Returns whether `lock` changed. */
  private async installAndStart(key: string, spec: string, lock: LockFile, fresh = false): Promise<boolean> {
    let id = key
    try {
      id = extensionId(parseExtensionEntry(key, spec))
    } catch {
      /* reported below */
    }
    const rec: Rec = {
      key,
      spec,
      id,
      installed: null,
      host: null,
      state: 'installing',
      error: null,
      grant: null,
      changedSinceConsent: false,
      activity: false,
      providesFocus: false,
      providesActivity: false,
      blocks: false,
      idleMinutes: 0,
      trayLabel: null,
      keepRunning: false,
      highlight: null,
      destinations: new Set(),
      viewHandlers: new Set(),
      files: null,
      secretSet: new Set()
    }
    this.recs.set(key, rec)
    this.deps.onChange()
    let changed = false
    try {
      const installed = await this.deps.installer.install(key, spec, lock.extensions[key], { fresh })
      rec.installed = installed
      rec.id = installed.id
      if (!installed.dev && installed.source.kind !== 'builtin') {
        const prev = lock.extensions[key]
        const next = { id: installed.id, spec, version: installed.version, url: installed.url, sha256: installed.sha256 }
        if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
          lock.extensions[key] = next
          changed = true
        }
      }
      await ensureExtensionAttributes(this.deps.root, installed.id, installed.manifest.appendOnly)
      for (const s of installed.manifest.contributes.secrets) if (await this.deps.secrets.has(installed.id, s.key)) rec.secretSet.add(s.key)
    } catch (err) {
      rec.state = 'error'
      rec.error = err instanceof Error ? err.message : String(err)
      return changed
    }
    await this.startIfAllowed(rec)
    return changed
  }

  private async startIfAllowed(rec: Rec): Promise<void> {
    const ext = rec.installed
    if (!ext) return
    let consent = await this.deps.consent.get(this.deps.root, ext.id)
    // A built-in comes with the app you updated: once allowed, a new build keeps its grant (asking to run unrestricted still needs your trust).
    if (consent && consent.sha256 !== ext.sha256 && ext.source.kind === 'builtin' && !ext.dev) {
      consent = { ...consent, sha256: ext.sha256, at: new Date().toISOString() }
      await this.deps.consent.set(this.deps.root, ext.id, consent)
    }
    if (!consent || consent.sha256 !== ext.sha256 || (ext.manifest.permissions.unrestricted && !consent.grant.trusted)) {
      rec.state = 'needs-consent'
      rec.grant = null
      rec.changedSinceConsent = Boolean(consent)
      this.deps.onChange()
      return
    }
    rec.grant = consent.grant
    rec.changedSinceConsent = false
    await this.startHost(rec)
  }

  private async startHost(rec: Rec): Promise<void> {
    const ext = rec.installed!
    rec.files = {
      repo: new ExtensionFileStore(path.join(this.deps.root, EXTENSIONS_DIR, ext.id), { anchor: this.deps.root }),
      local: new ExtensionFileStore(path.join(this.deps.userData, 'extension-data', ext.id, devlogKey(this.deps.root)), { anchor: this.deps.userData })
    }
    const code = await readMainCode(ext).catch((err: unknown) => {
      rec.state = 'error'
      rec.error = `Could not read ${ext.manifest.main}: ${err instanceof Error ? err.message : String(err)}`
      return null
    })
    if (code === null) {
      if (!ext.manifest.main) rec.state = 'running' // declarations only (fields, settings): nothing to run
      this.deps.onChange()
      return
    }
    const host = new ExtensionHost({
      id: ext.id,
      hostScript: await this.deps.hostScript(),
      code,
      filename: `devlog-extension://${ext.id}/${ext.manifest.main}`,
      apiVersion: EXTENSION_API_VERSION,
      machine: this.deps.machine,
      ...(ext.manifest.permissions.unrestricted && rec.grant?.trusted ? { unrestricted: { packageDir: ext.dir } } : {}),
      settings: await this.settingValues(ext.id),
      handle: (method, args) => this.handle(rec, method, args)
    })
    rec.host = host
    this.resetRuntime(rec)
    rec.state = 'starting'
    rec.error = null
    this.deps.onChange()
    host.on('exit', () => {
      if (rec.host !== host) return
      if (rec.state === 'running' || rec.state === 'starting') {
        rec.state = 'failed'
        rec.error = host.error ?? 'Stopped'
      }
      rec.host = null
      this.deps.onChange()
    })
    try {
      await host.start()
      if (rec.host === host) rec.state = 'running'
    } catch (err) {
      if (rec.host === host) {
        rec.state = 'failed'
        rec.error = err instanceof Error ? err.message : String(err)
        rec.host = null
      }
    }
    this.deps.onChange()
  }

  private async stopHost(rec: Rec): Promise<void> {
    const host = rec.host
    rec.host = null
    this.resetRuntime(rec)
    if (host) await host.stop().catch(() => undefined)
  }

  /** Forget what a (re)started or stopped process registered. */
  private resetRuntime(rec: Rec): void {
    const hadState = rec.trayLabel !== null || rec.keepRunning || rec.idleMinutes > 0 || rec.highlight !== null || rec.providesActivity
    rec.activity = false
    rec.providesFocus = false
    rec.providesActivity = false
    rec.blocks = false
    rec.idleMinutes = 0
    rec.trayLabel = null
    rec.keepRunning = false
    rec.highlight = null
    rec.destinations = new Set()
    rec.viewHandlers = new Set()
    if (hadState) this.deps.onAppState?.()
  }

  appState(): ExtensionAppState {
    const running = [...this.recs.values()].filter((r) => r.host)
    const idle = running.map((r) => r.idleMinutes).filter((m) => m > 0)
    return {
      trayLabel: running.find((r) => r.trayLabel)?.trayLabel ?? null,
      keepRunning: running.some((r) => r.keepRunning),
      idleMinutes: idle.length ? Math.min(...idle) : 0,
      highlighted: running.flatMap((r) => (r.highlight ? [r.highlight] : [])),
      providesTime: running.some((r) => r.providesActivity)
    }
  }

  // -------------------------------------------------------------------------
  // Machine state and focus providers
  // -------------------------------------------------------------------------

  /** Locked, idle or asleep (from the OS), passed on to extensions as pause/resume. */
  private readonly pausedBy = new Set<'locked' | 'idle' | 'suspended'>()

  /** The machine was locked/unlocked, went idle/came back, or went to sleep/woke (from the OS, whether or not time is tracked). */
  setSystemState(state: 'locked' | 'idle' | 'asleep', on: boolean): void {
    const reason = state === 'asleep' ? 'suspended' : state
    const t = new Date().toISOString()
    if (on) {
      if (this.pausedBy.has(reason)) return
      const first = this.pausedBy.size === 0
      this.pausedBy.add(reason)
      if (first) this.notify({ t, type: 'pause', reason })
    } else {
      if (!this.pausedBy.has(reason)) return
      if (reason === 'locked') this.pausedBy.clear() // unlocking means someone is back
      else this.pausedBy.delete(reason)
      if (this.pausedBy.size === 0) this.notify({ t, type: 'resume' })
    }
  }

  /** Whether the machine is locked, idle or asleep right now. */
  isPaused(): boolean {
    return this.pausedBy.size > 0
  }

  /**
   * Focus events from extensions that provide them, for the timeline,
   * review and summary (merged with the core activity log by the caller).
   */
  async focusEvents(fromDate: string, toDate: string): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = []
    for (const rec of this.recs.values()) {
      if (!rec.host || !rec.providesFocus) continue
      let list: unknown
      try {
        list = await rec.host.call('provide.focus', [fromDate, toDate], 20_000)
      } catch (err) {
        console.error(`${rec.id}: focus provider failed`, err)
        continue
      }
      if (!Array.isArray(list)) continue
      for (const raw of list.slice(0, 500_000) as Array<Record<string, unknown>>) {
        if (!raw || typeof raw.t !== 'string' || Number.isNaN(Date.parse(raw.t))) continue
        out.push({
          t: raw.t,
          type: 'focus',
          app: typeof raw.app === 'string' ? raw.app.slice(0, 200) : '',
          title: typeof raw.title === 'string' ? raw.title.slice(0, 1000) : '',
          machine: typeof raw.machine === 'string' ? raw.machine : this.deps.machine
        })
      }
    }
    return out
  }

  private async drop(key: string): Promise<void> {
    const rec = this.recs.get(key)
    if (!rec) return
    await this.stopHost(rec)
    this.recs.delete(key)
  }

  async stopAll(): Promise<void> {
    this.stopped = true
    await this.serial(async () => {
      for (const key of [...this.recs.keys()]) await this.drop(key)
    })
  }

  // -------------------------------------------------------------------------
  // What the renderer asks for
  // -------------------------------------------------------------------------

  async list(): Promise<ExtensionInfo[]> {
    const out: ExtensionInfo[] = []
    for (const rec of this.recs.values()) {
      const ext = rec.installed
      const m = ext?.manifest
      out.push({
        key: rec.key,
        spec: rec.spec,
        id: rec.id,
        source: ext?.dev ? 'dev' : (ext?.source.kind ?? 'url'),
        displayName: m?.displayName ?? rec.key,
        ...(m?.description ? { description: m.description } : {}),
        version: ext?.version ?? null,
        sha256: ext?.sha256 ?? null,
        state: rec.state,
        error: rec.error,
        permissions: m?.permissions ?? {},
        grant: rec.grant,
        changedSinceConsent: rec.changedSinceConsent,
        canvasFields: m?.contributes.canvasFields ?? [],
        settings: m?.contributes.settings ?? [],
        settingValues: ext ? await this.settingValues(ext.id) : {},
        secrets: (m?.contributes.secrets ?? []).map((s) => ({ ...s, set: rec.secretSet.has(s.key) })),
        commands: (m?.contributes.commands ?? []).map((c) => ({ ...c, ...(c.nodeType ? { nodeType: fullType(rec.id, c.nodeType) } : {}), ready: Boolean(rec.host?.commands.includes(c.id)) })),
        destinations: (m?.contributes.destinations ?? []).map((d) => ({ ...d, ready: Boolean(rec.host && rec.destinations.has(d.id)) })),
        views: rec.state === 'running' ? (m?.contributes.views ?? []).map((v) => ({ ...v, ...(v.nodeType ? { nodeType: fullType(rec.id, v.nodeType) } : {}), url: viewUrl(rec.key, v.entry) })) : [],
        nodeTypes: rec.grant ? (m?.contributes.nodeTypes ?? []) : [],
        ...(m?.contributes.check ? { check: m.contributes.check } : {}),
        missing: m ? await this.missing(rec) : []
      })
    }
    return out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  /** Add an extension to devlog.json (it is installed, then waits for your consent). */
  async add(key: string, spec: string): Promise<void> {
    parseExtensionEntry(key, spec) // validate before writing anything
    await updateManifest(this.deps.root, (m) => {
      m.extensions = { ...(m.extensions ?? {}), [key]: spec }
    })
    await this.load()
    const rec = this.recs.get(key)
    if (rec?.state === 'error') throw new Error(rec.error ?? 'Could not install')
  }

  async remove(key: string): Promise<void> {
    const id = this.recs.get(key)?.id
    await updateManifest(this.deps.root, (m) => {
      const next = { ...(m.extensions ?? {}) }
      delete next[key]
      m.extensions = next
    })
    await this.load()
    if (id) await this.deps.consent.set(this.deps.root, id, null)
  }

  /** Allow (or re-allow with different scopes) and start. */
  allow(key: string, grant: Grant): Promise<void> {
    return this.serial(async () => {
      const rec = this.need(key)
      if (!rec.installed) throw new Error('Not installed')
      const perms = rec.installed.manifest.permissions
      if (perms.unrestricted && !grant.trusted) throw new Error(`${rec.installed.manifest.displayName} runs unrestricted; it can only run if you say you trust it`)
      const g: Grant = {
        read: perms.read ? grant.read : null,
        write: perms.write ? grant.write : null,
        ...(perms.unrestricted ? { trusted: true } : {})
      }
      await this.deps.consent.set(this.deps.root, rec.id, { sha256: rec.installed.sha256, grant: g, at: new Date().toISOString() })
      await this.stopHost(rec)
      await this.startIfAllowed(rec)
    })
  }

  /** Withdraw consent: the extension stops and asks again next time. */
  revoke(key: string): Promise<void> {
    return this.serial(async () => {
      const rec = this.need(key)
      await this.deps.consent.set(this.deps.root, rec.id, null)
      await this.stopHost(rec)
      await this.startIfAllowed(rec)
    })
  }

  /** Start a stopped (failed) extension again. */
  restart(key: string): Promise<void> {
    return this.serial(async () => {
      const rec = this.need(key)
      await this.stopHost(rec)
      await this.startIfAllowed(rec)
    })
  }

  /** Re-check every version range; download what changed and pin it. Changed code asks for consent again. */
  update(): Promise<ExtensionUpdateReport> {
    return this.serial(async () => {
      const report: ExtensionUpdateReport = { updated: [], unchanged: [], errors: [] }
      const lock = await readLockFile(this.deps.root)
      let changed = false
      for (const rec of [...this.recs.values()]) {
        const before = rec.installed?.sha256 ?? null
        const beforeVersion = rec.installed?.version ?? null
        if (rec.installed?.dev || rec.installed?.source.kind === 'builtin') {
          report.unchanged.push(rec.key)
          continue
        }
        await this.stopHost(rec)
        changed = (await this.installAndStart(rec.key, rec.spec, lock, true)) || changed
        const now = this.recs.get(rec.key)
        if (now?.state === 'error') report.errors.push({ key: rec.key, error: now.error ?? 'Failed' })
        else if (now?.installed && now.installed.sha256 !== before) report.updated.push({ key: rec.key, from: beforeVersion, to: now.installed.version })
        else report.unchanged.push(rec.key)
      }
      if (changed) await writeLockFile(this.deps.root, lock)
      this.deps.onChange()
      return report
    })
  }

  async setSettings(key: string, values: Record<string, string>): Promise<void> {
    const rec = this.need(key)
    const declared = rec.installed?.manifest.contributes.settings ?? []
    const clean: Record<string, string> = {}
    const problems: string[] = []
    for (const field of declared) {
      const v = typeof values[field.key] === 'string' ? values[field.key].trim() : ''
      // Required fields may be left empty while setting up; the card says what is missing.
      const problem = v ? fieldProblem(field, v) : null
      if (problem) problems.push(problem)
      else if (v) clean[field.key] = v
    }
    if (problems.length) throw new Error(problems.join('; '))
    await updateManifest(this.deps.root, (m) => {
      const all = { ...(m.settings ?? {}) }
      if (Object.keys(clean).length) all[rec.id] = clean
      else delete all[rec.id]
      m.settings = all
    })
    rec.host?.updateSettings(clean)
    this.deps.onChange()
  }

  async setSecret(key: string, secretKey: string, value: string | null): Promise<void> {
    const rec = this.need(key)
    if (!KEY_RE.test(secretKey)) throw new Error('Bad secret name')
    await this.deps.secrets.set(rec.id, secretKey, value && value.length ? value : null)
    if (value) rec.secretSet.add(secretKey)
    else rec.secretSet.delete(secretKey)
    this.deps.onChange()
  }

  /** Run a command; a string it returns (a check's result, say) is passed back. */
  async runCommand(key: string, commandId: string, context: CommandContext = { source: 'switcher' }): Promise<string | null> {
    const rec = this.need(key)
    if (!rec.host) throw new Error(`${rec.installed?.manifest.displayName ?? key} is not running`)
    const value = await rec.host.call('command.run', [commandId, await this.contextFor(rec, context)], 10 * 60_000)
    return typeof value === 'string' ? value.slice(0, 500) : null
  }

  /** A command's context as the extension may see it: canvases outside its grant are left out. */
  private async contextFor(rec: Rec, context: CommandContext): Promise<CommandContext> {
    const sources: CommandContext['source'][] = ['switcher', 'keybinding', 'menu', 'post', 'view', 'tray']
    const out: CommandContext = { source: sources.includes(context?.source) ? context.source : 'switcher' }
    if (typeof context?.canvasId !== 'string') return out
    const all = await this.deps.store.listCanvases()
    const visible = new Set(visibleCanvases(all, rec.grant ?? { read: null, write: null }).map((c) => c.id))
    if (!visible.has(context.canvasId)) return out
    out.canvasId = context.canvasId
    const readable = scopeCanvasIds(all, rec.grant?.read ?? null)
    if (typeof context.blockId === 'string' && typeof context.date === 'string' && readable.has(context.canvasId)) {
      out.date = context.date
      out.blockId = context.blockId
    }
    return out
  }

  /** Someone posted a block in the app: tell extensions that listen and may read it (1.6). */
  async blockAdded(canvasId: string, date: string, entry: Entry): Promise<void> {
    const listening = [...this.recs.values()].filter((r) => r.host && r.blocks)
    if (!listening.length) return
    const all = await this.deps.store.listCanvases()
    for (const rec of listening) {
      if (!scopeCanvasIds(all, rec.grant?.read ?? null).has(canvasId)) continue
      void rec.host?.call('block.added', [{ canvasId, date, block: toBlock(entry) }], 10_000).catch(() => undefined)
    }
  }

  /** Time-tracking events from extensions that provide them (1.6), for the app's views. */
  async activityEvents(fromDate: string, toDate: string): Promise<ActivityEvent[]> {
    const out: ActivityEvent[] = []
    const types = new Set(['start', 'task', 'stop', 'heartbeat', 'assign'])
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 200 ? v : undefined)
    for (const rec of this.recs.values()) {
      if (!rec.host || !rec.providesActivity) continue
      let list: unknown
      try {
        list = await rec.host.call('provide.activity', [fromDate, toDate], 20_000)
      } catch (err) {
        console.error(`${rec.id}: activity provider failed`, err)
        continue
      }
      if (!Array.isArray(list)) continue
      for (const raw of list.slice(0, 500_000) as Array<Record<string, unknown>>) {
        if (!raw || typeof raw.t !== 'string' || Number.isNaN(Date.parse(raw.t)) || !types.has(String(raw.type))) continue
        const ev = { t: raw.t, type: raw.type, machine: typeof raw.machine === 'string' ? raw.machine : this.deps.machine } as ActivityEvent
        if (raw.type === 'task' || raw.type === 'start') ev.canvasId = typeof raw.canvasId === 'string' ? raw.canvasId : null
        if (typeof raw.blockId === 'string') ev.entryId = raw.blockId
        if (raw.type === 'assign') {
          // A correction (1.8): a window and the canvas it was, or an undo.
          ev.canvasId = typeof raw.canvasId === 'string' ? raw.canvasId : null
          for (const k of ['start', 'end', 'id', 'at', 'cancels'] as const) {
            const v = str(raw[k])
            if (v !== undefined) ev[k] = v
          }
          if (!ev.id && !ev.cancels) continue
        }
        out.push(ev)
      }
    }
    return out.sort((a, b) => a.t.localeCompare(b.t))
  }

  /** Whether some running extension provides time-tracking events. */
  providesActivity(): boolean {
    return [...this.recs.values()].some((r) => r.host && r.providesActivity)
  }

  private notify(notice: ActivityNotice): void {
    for (const rec of this.recs.values()) {
      if (!rec.activity || !rec.host) continue
      let n = notice
      if (n.type === 'task' && n.canvasId) {
        // Only name a task it is allowed to see.
        const visible = this.visibleIdsSync(rec)
        if (!visible?.has(n.canvasId)) n = { ...n, canvasId: undefined }
      }
      void rec.host.call('activity.notice', [n], 10_000).catch(() => undefined)
    }
  }

  private visibleCache = new Map<string, Set<string>>()
  private visibleIdsSync(rec: Rec): Set<string> | undefined {
    return this.visibleCache.get(rec.key)
  }

  // -------------------------------------------------------------------------
  // Destinations: sending a finished timesheet
  // -------------------------------------------------------------------------

  /** A week's timesheet as a destination sees it: labels, and its own canvas fields (inherited). */
  private async destinationSheet(rec: Rec, input: unknown): Promise<DestinationSheet> {
    const sheet = sanitizeTimesheet(input)
    const all = await this.deps.store.listCanvases()
    const keys = rec.installed?.manifest.contributes.canvasFields.map((f) => f.key) ?? []
    return {
      week: sheet.week,
      status: sheet.status,
      entries: sheet.entries.map((e) => {
        const fields: Record<string, string> = {}
        for (const k of keys) {
          const v = inheritedField(all, e.canvasId, `ext.${rec.id}.${k}`)
          if (v) fields[k] = v.value
        }
        const client = topLevelCanvasId(all, e.canvasId)
        return {
          id: e.id,
          date: e.date,
          start: e.start,
          minutes: e.minutes,
          ...(e.note ? { note: e.note } : {}),
          canvasId: e.canvasId,
          task: canvasLabel(all, e.canvasId),
          client: all.find((c) => c.id === client)?.title ?? client,
          fields
        }
      })
    }
  }

  private destinationHost(key: string, destId: string): { rec: Rec; host: ExtensionHost } {
    const rec = this.need(key)
    if (!rec.host || !rec.destinations.has(destId)) throw new Error(`${rec.installed?.manifest.displayName ?? key} is not ready to send`)
    return { rec, host: rec.host }
  }

  /**
   * The folder a running extension's views are served from, or null (not
   * installed, not allowed, or stopped: its pages do not load).
   */
  viewRoot(key: string): string | null {
    const rec = this.recs.get(key)
    return rec?.installed && rec.state === 'running' && rec.installed.manifest.contributes.views.length ? rec.installed.dir : null
  }

  /** A call from a view's page to the extension that owns it. */
  async viewCall(key: string, viewId: string, method: string, args: unknown[]): Promise<unknown> {
    const rec = this.recs.get(key)
    if (!rec?.host || rec.state !== 'running') throw new Error('That extension is not running')
    if (!rec.viewHandlers.has(viewId)) throw new Error(`The view "${viewId}" has no handler yet`)
    return rec.host.call('view.call', [viewId, String(method), Array.isArray(args) ? args : []], 60_000)
  }

  /** What sending a week's timesheet to a destination would do. */
  async destinationPreview(key: string, destId: string, sheet: unknown): Promise<DestinationLine[]> {
    const { rec, host } = this.destinationHost(key, destId)
    const lines = await host.call('destination.preview', [destId, await this.destinationSheet(rec, sheet)], 120_000)
    if (!Array.isArray(lines)) throw new Error('The extension returned no preview')
    const actions = new Set(['create', 'update', 'delete', 'unchanged', 'skip'])
    return (lines as DestinationLine[])
      .filter((l) => l && typeof l.id === 'string' && actions.has(l.action))
      .map((l) => ({
        id: l.id,
        entryIds: Array.isArray(l.entryIds) ? l.entryIds.map(String) : [],
        date: String(l.date ?? ''),
        ...(l.start ? { start: String(l.start) } : {}),
        minutes: Number(l.minutes) || 0,
        target: String(l.target ?? ''),
        ...(l.description ? { description: String(l.description).slice(0, 500) } : {}),
        action: l.action,
        ...(l.reason ? { reason: String(l.reason).slice(0, 300) } : {})
      }))
  }

  /** Send a final timesheet through a destination; the sender keeps the record. */
  async destinationSend(key: string, destId: string, input: unknown): Promise<SendResult> {
    const { rec, host } = this.destinationHost(key, destId)
    const sheet = await this.destinationSheet(rec, input)
    if (sheet.status !== 'final') throw new Error('Mark the timesheet final before sending it')
    const raw = (await host.call('destination.send', [destId, sheet], 10 * 60_000)) as Partial<SendResult> | null
    return {
      done: Array.isArray(raw?.done) ? raw.done.map(String) : [],
      failed: Array.isArray(raw?.failed) ? raw.failed.map((f) => ({ lineId: String(f?.lineId ?? ''), error: String(f?.error ?? 'Failed').slice(0, 500) })) : [],
      summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 500) : 'Sent'
    }
  }

  /** Destinations running extensions registered (1.7). */
  destinationsList(): Array<{ extension: string; from: string; id: string; label: string }> {
    return [...this.recs.values()].flatMap((r) =>
      r.host && r.installed
        ? r.installed.manifest.contributes.destinations.filter((d) => r.destinations.has(d.id)).map((d) => ({ extension: r.key, from: r.installed!.manifest.displayName, id: d.id, label: d.label }))
        : []
    )
  }

  /** The `devlog.managed` value for an extension's kept canvas (the Timesheets canvas the app made before 0.18 is devlog-time's). */
  private managedOwner(extId: string, key: string): string {
    return extId === 'builtin.devlog-time' && key === 'timesheets' ? TIMESHEETS_MANAGED : `${extId}/${key}`
  }

  /** Whether a canvas is one this extension keeps. */
  private keeps(extId: string, c: CanvasMeta | undefined): boolean {
    const owner = c?.fields?.[MANAGED_FIELD]
    return Boolean(owner && (owner.startsWith(`${extId}/`) || (extId === 'builtin.devlog-time' && owner === TIMESHEETS_MANAGED)))
  }

  /** Labels of required settings and secrets that are not set yet. */
  private async missing(rec: Rec): Promise<string[]> {
    const m = rec.installed?.manifest
    if (!m) return []
    const values = await this.settingValues(rec.id)
    return [
      ...m.contributes.settings.filter((f) => f.required && !values[f.key]).map((f) => f.label),
      ...m.contributes.secrets.filter((f) => f.required && !rec.secretSet.has(f.key)).map((f) => f.label)
    ]
  }

  private toCanvas(c: CanvasMeta, fieldPrefix: string): ExtensionCanvas {
    return {
      id: c.id,
      title: c.title,
      parentId: c.parentId,
      task: c.task,
      ...(c.type ? { type: c.type } : {}),
      archived: c.archived,
      fields: Object.fromEntries(Object.entries(c.fields ?? {}).flatMap(([k, v]) => (k.startsWith(fieldPrefix) ? [[k.slice(fieldPrefix.length), v]] : [])))
    }
  }

  /** One of the extension's own node types, as a full name (it may give the manifest id or the full name). */
  private ownType(ext: InstalledExtension, raw: unknown): string {
    const name = typeof raw === 'string' ? raw : ''
    const local = name.startsWith(`${ext.id}/`) ? name.slice(ext.id.length + 1) : name
    if (!ext.manifest.contributes.nodeTypes.some((t) => t.id === local)) throw new Error(`"${name}" is not one of its node types (contributes.nodeTypes)`)
    return nodeTypeName(ext.id, local)
  }

  private need(key: string): Rec {
    const rec = this.recs.get(key)
    if (!rec) throw new Error(`No extension ${key}`)
    return rec
  }

  private async settingValues(id: string): Promise<Record<string, string>> {
    const m = await readManifest(this.deps.root)
    const s = m.settings?.[id]
    const out: Record<string, string> = {}
    if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (typeof v === 'string') out[k] = v
    return out
  }

  // -------------------------------------------------------------------------
  // The extension API, as seen from the app
  // -------------------------------------------------------------------------

  private async handle(rec: Rec, method: string, args: unknown[]): Promise<unknown> {
    const ext = rec.installed
    if (!ext || !rec.files) throw new Error('Not running')
    const grant = rec.grant ?? { read: null, write: null }
    const str = (i: number, what: string): string => {
      const v = args[i]
      if (typeof v !== 'string') throw new Error(`${method}: ${what} must be a string`)
      return v
    }
    const canvases = async (): Promise<CanvasMeta[]> => (await this.deps.store.listCanvases()).filter((c) => c.id !== 'journal')
    // Canvases it keeps (1.7) are its own whatever it was granted.
    const kept = async (canvasId: string): Promise<boolean> => this.keeps(ext.id, (await canvases()).find((c) => c.id === canvasId))
    const canRead = async (canvasId: string): Promise<boolean> => scopeCanvasIds(await canvases(), grant.read).has(canvasId) || (await kept(canvasId))
    const canWrite = async (canvasId: string): Promise<boolean> => scopeCanvasIds(await canvases(), grant.write).has(canvasId) || (await kept(canvasId))
    const dateArg = (i: number): string => {
      const v = str(i, 'date')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${method}: not a date: ${v}`)
      return v
    }
    const span = (from: string, to: string): void => {
      if (to < from) throw new Error(`${method}: the range ends before it starts`)
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) throw new Error(`${method}: at most 400 days at a time`)
    }
    const fieldPrefix = `ext.${ext.id}.`
    const writesEverywhere = Boolean(grant.write && 'all' in grant.write && grant.write.all)

    switch (method) {
      case 'devlog.canvases': {
        const all = await this.deps.store.listCanvases()
        const shown = visibleCanvases(all, grant)
        const visible = [...shown, ...all.filter((c) => this.keeps(ext.id, c) && !shown.includes(c))]
        this.visibleCache.set(rec.key, new Set(visible.map((c) => c.id)))
        return visible.map((c) => this.toCanvas(c, fieldPrefix))
      }
      case 'devlog.field': {
        const canvasId = str(0, 'canvasId')
        const key = str(1, 'key').toLowerCase()
        const all = await this.deps.store.listCanvases()
        if (!visibleCanvases(all, grant).some((c) => c.id === canvasId)) throw new Error('No access to that canvas')
        return inheritedField(all, canvasId, `${fieldPrefix}${key}`)?.value ?? null
      }
      case 'devlog.days': {
        const canvasId = str(0, 'canvasId')
        if (!(await canRead(canvasId))) throw new Error('No read access to that canvas')
        return (await this.deps.store.listDays(canvasId)).map((d) => d.date)
      }
      case 'devlog.blocks': {
        const canvasId = str(0, 'canvasId')
        const date = str(1, 'date')
        if (!(await canRead(canvasId))) throw new Error('No read access to that canvas')
        return (await this.deps.store.readDay(canvasId, date)).entries.map(toBlock)
      }
      case 'devlog.search': {
        if (!grant.read) return { blocks: [] }
        const query = str(0, 'query')
        const readable = scopeCanvasIds(await canvases(), grant.read)
        const res = await this.deps.store.search(query)
        return { blocks: res.blocks.filter((h) => readable.has(h.canvasId)).map((h) => ({ canvasId: h.canvasId, date: h.date, block: toBlock(h.entry) })) }
      }
      case 'devlog.addBlock': {
        const canvasId = str(0, 'canvasId')
        const markdown = str(1, 'markdown')
        const opts = (args[2] ?? {}) as { meta?: Record<string, string>; parentId?: unknown; date?: unknown; todo?: unknown; kind?: unknown }
        if (!(await canWrite(canvasId))) throw new Error('No write access to that canvas')
        const own = await kept(canvasId)
        const parentId = typeof opts.parentId === 'string' ? opts.parentId : undefined
        const at = typeof opts.date === 'string' ? opts.date : undefined
        if (parentId && !at) throw new Error('devlog.addBlock: a block added inside another needs that block\'s date')
        let kind: string | undefined
        if (opts.kind !== undefined) {
          if (!own) throw new Error('devlog.addBlock: a kind only on a canvas it keeps')
          if (typeof opts.kind !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(opts.kind) || ['note', 'todo', 'task', 'commit', 'done'].includes(opts.kind)) throw new Error(`devlog.addBlock: not a kind it may use: ${String(opts.kind)}`)
          kind = opts.kind
        }
        const { date, entry } = await this.deps.store.addExtensionBlock(canvasId, ext.id, markdown, opts.meta ?? {}, new Date(), {
          ...(parentId || own ? { parentId, date: at } : {}),
          todo: opts.todo === true,
          ...(kind ? { kind } : {}),
          anyDate: own
        })
        this.deps.onBlockAdded(canvasId, date)
        return { date, block: toBlock(entry) }
      }
      case 'devlog.todos': {
        if (!grant.read) return []
        const opts = (args[0] ?? {}) as { doneSince?: unknown }
        const readable = scopeCanvasIds(await canvases(), grant.read)
        const todos = await this.deps.store.listTodos({ doneSince: typeof opts.doneSince === 'string' ? opts.doneSince : undefined })
        return todos
          .filter((t) => readable.has(t.canvasId))
          .map((t) => ({ canvasId: t.canvasId, date: t.date, block: toBlock(t.entry), trail: t.trail.map(({ id, title }) => ({ id, title })) }))
      }
      case 'devlog.createCanvas': {
        const input = (args[0] ?? {}) as { title?: unknown; parentId?: unknown; type?: unknown }
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        if (!title) throw new Error('devlog.createCanvas: give it a title')
        const parentId = typeof input.parentId === 'string' && input.parentId ? input.parentId : null
        if (parentId ? !(await canWrite(parentId)) : !writesEverywhere) throw new Error(parentId ? 'No write access to that canvas' : 'Only an extension that may write everywhere can make a top-level canvas')
        const type = input.type === undefined || input.type === null ? null : this.ownType(ext, input.type)
        const canvas = await this.deps.store.createCanvas({ title, parentId, ...(type ? { type } : {}) })
        this.deps.onCanvasesChanged?.()
        return this.toCanvas(canvas, fieldPrefix)
      }
      case 'devlog.updateCanvas': {
        const canvasId = str(0, 'canvasId')
        const patch = (args[1] ?? {}) as { title?: unknown; parentId?: unknown; type?: unknown; archived?: unknown }
        if (!(await canWrite(canvasId))) throw new Error('No write access to that canvas')
        const cur = await this.deps.store.readCanvas(canvasId)
        const next: Partial<CanvasInput> & { archived?: boolean } = {}
        if (typeof patch.title === 'string') next.title = patch.title
        if (patch.parentId !== undefined) {
          const p = typeof patch.parentId === 'string' && patch.parentId ? patch.parentId : null
          if (p ? !(await canWrite(p)) : !writesEverywhere) throw new Error('No write access to where it would go')
          next.parentId = p
        }
        if (patch.type !== undefined) {
          // It may set its own types, and clear only its own.
          if (cur.type && !cur.type.startsWith(`${ext.id}/`)) throw new Error('That canvas has another extension\'s type')
          next.type = patch.type === null ? null : this.ownType(ext, patch.type)
        }
        let canvas: CanvasMeta = Object.keys(next).length ? await this.deps.store.updateCanvas(canvasId, next) : cur
        if (typeof patch.archived === 'boolean' && patch.archived !== canvas.archived) {
          await this.deps.store.setCanvasArchived(canvasId, patch.archived)
          canvas = await this.deps.store.readCanvas(canvasId)
        }
        this.deps.onCanvasesChanged?.()
        return this.toCanvas(canvas, fieldPrefix)
      }
      case 'devlog.editBlock': {
        const canvasId = str(0, 'canvasId')
        if (!(await canWrite(canvasId))) throw new Error('No write access to that canvas')
        const entry = await this.deps.store.updateExtensionBlock(canvasId, str(1, 'date'), str(2, 'blockId'), ext.id, str(3, 'markdown'), new Date(), { any: await kept(canvasId) })
        this.deps.onBlockAdded(canvasId, str(1, 'date'))
        return toBlock(entry)
      }
      case 'devlog.promote': {
        const canvasId = str(0, 'canvasId')
        const date = str(1, 'date')
        const opts = (args[3] ?? {}) as { type?: unknown }
        if (!(await canWrite(canvasId))) throw new Error('No write access to that canvas')
        const type = this.ownType(ext, opts.type)
        const result = await this.deps.store.promoteBlock(canvasId, date, str(2, 'blockId'), type)
        this.deps.onCanvasesChanged?.()
        this.deps.onBlockAdded(canvasId, date)
        return { canvas: this.toCanvas(result.canvas, fieldPrefix), block: toBlock(result.entry) }
      }
      case 'devlog.activity': {
        if (!grant.read) throw new Error('No read access')
        const from = dateArg(0)
        const to = dateArg(1)
        span(from, to)
        const all = await this.deps.store.listCanvases()
        const readable = scopeCanvasIds(all, grant.read)
        const everything = 'all' in grant.read
        const events = (await this.deps.activity?.(from, to)) ?? []
        // Window titles only for an extension that may read everything; canvases it may not read show as none.
        return events.flatMap((ev) => {
          if (ev.type === 'focus' && !everything) return []
          if (ev.canvasId && !readable.has(ev.canvasId)) return ev.type === 'git' ? [] : [{ ...ev, canvasId: null }]
          return [ev]
        })
      }
      case 'devlog.range': {
        if (!grant.read) return []
        const from = dateArg(0)
        const to = dateArg(1)
        span(from, to)
        const readable = scopeCanvasIds(await canvases(), grant.read)
        return (await this.deps.store.getRange(from, to))
          .filter((d) => readable.has(d.canvasId))
          .map((d) => ({ canvasId: d.canvasId, date: d.day.date, blocks: d.day.entries.map(toBlock) }))
      }
      case 'devlog.managedCanvas': {
        const key = str(0, 'key')
        if (!KEY_RE.test(key)) throw new Error('devlog.managedCanvas: the key is lowercase letters, digits, "_" or "-"')
        const opts = (args[1] ?? {}) as { title?: unknown }
        const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim().slice(0, 200) : key
        const canvas = await this.deps.store.managedCanvas(this.managedOwner(ext.id, key), title)
        this.deps.onCanvasesChanged?.()
        return this.toCanvas(canvas!, fieldPrefix)
      }
      case 'destinations.list':
        return this.destinationsList()
      case 'destinations.preview':
      case 'destinations.send': {
        if (!ext.manifest.permissions.send) throw new Error('Sending through destinations needs "permissions": { "send": true }')
        const to = (args[0] ?? {}) as { extension?: unknown; id?: unknown }
        if (typeof to.extension !== 'string' || typeof to.id !== 'string') throw new Error(`${method}: say which destination ({ extension, id })`)
        return method === 'destinations.preview' ? this.destinationPreview(to.extension, to.id, args[1]) : this.destinationSend(to.extension, to.id, args[1])
      }
      case 'ui.openPage': {
        const viewId = str(0, 'viewId')
        if (!ext.manifest.contributes.views.some((v) => v.id === viewId && v.placement === 'page')) throw new Error(`"${viewId}" is not one of its page views`)
        this.deps.open?.({ page: `${rec.key}/${viewId}` })
        return null
      }
      case 'devlog.subscribe':
        rec.blocks = true
        return null
      case 'activity.idleAfter': {
        const m = Number(args[0])
        rec.idleMinutes = Number.isFinite(m) && m > 0 ? Math.min(24 * 60, m) : 0
        this.deps.onAppState?.()
        return null
      }
      case 'ui.pick': {
        if (!this.deps.pick) return null
        const items = (Array.isArray(args[0]) ? args[0] : []).slice(0, 5000).flatMap((it: Record<string, unknown>) =>
          it && typeof it.id === 'string' && typeof it.label === 'string' ? [{ id: it.id, label: it.label.slice(0, 300), ...(typeof it.hint === 'string' ? { hint: it.hint.slice(0, 200) } : {}) }] : []
        )
        const opts = (args[1] ?? {}) as { placeholder?: unknown }
        return this.deps.pick(ext.manifest.displayName, items, typeof opts.placeholder === 'string' ? opts.placeholder.slice(0, 200) : undefined)
      }
      case 'ui.open': {
        const t = (args[0] ?? {}) as { canvasId?: unknown; date?: unknown; blockId?: unknown }
        if (typeof t.canvasId !== 'string' || !visibleCanvases(await this.deps.store.listCanvases(), grant).some((c) => c.id === t.canvasId)) throw new Error('No access to that canvas')
        this.deps.open?.({ canvasId: t.canvasId, ...(typeof t.date === 'string' && typeof t.blockId === 'string' ? { date: t.date, blockId: t.blockId } : {}) })
        return null
      }
      case 'ui.highlight': {
        const id = typeof args[0] === 'string' ? args[0] : null
        if (id && !visibleCanvases(await this.deps.store.listCanvases(), grant).some((c) => c.id === id)) throw new Error('No access to that canvas')
        if (rec.highlight !== id) {
          rec.highlight = id
          this.deps.onAppState?.()
        }
        return null
      }
      case 'app.trayLabel': {
        const label = typeof args[0] === 'string' && args[0].trim() ? args[0].trim().slice(0, 60) : null
        if (rec.trayLabel !== label) {
          rec.trayLabel = label
          this.deps.onAppState?.()
        }
        return null
      }
      case 'app.keepRunning':
        if (rec.keepRunning !== (args[0] === true)) {
          rec.keepRunning = args[0] === true
          this.deps.onAppState?.()
        }
        return null
      case 'secrets.get':
        return this.deps.secrets.get(ext.id, checkKey(str(0, 'key')))
      case 'secrets.set': {
        const k = checkKey(str(0, 'key'))
        await this.deps.secrets.set(ext.id, k, str(1, 'value'))
        rec.secretSet.add(k)
        this.deps.onChange()
        return null
      }
      case 'secrets.delete': {
        const k = checkKey(str(0, 'key'))
        await this.deps.secrets.set(ext.id, k, null)
        rec.secretSet.delete(k)
        this.deps.onChange()
        return null
      }
      case 'files.read':
      case 'files.write':
      case 'files.append':
      case 'files.list':
      case 'files.stat':
      case 'files.remove': {
        const which = args[0]
        if (which !== 'repo' && which !== 'local') throw new Error('files: store must be "repo" or "local"')
        const files = rec.files[which]
        const p = typeof args[1] === 'string' ? args[1] : ''
        switch (method) {
          case 'files.read': {
            const b = await files.read(p)
            return b === undefined ? null : new Uint8Array(b)
          }
          case 'files.write': {
            const data = args[2]
            if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new Error('files.write: data must be a string or bytes')
            await files.write(p, data)
            return null
          }
          case 'files.append':
            await files.append(p, str(2, 'text'))
            return null
          case 'files.list':
            return files.list(p)
          case 'files.stat':
            return (await files.stat(p)) ?? null
          default:
            await files.remove(p)
            return null
        }
      }
      case 'activity.subscribe':
        rec.activity = true
        if (!this.visibleCache.has(rec.key)) this.visibleCache.set(rec.key, new Set(visibleCanvases(await this.deps.store.listCanvases(), grant).map((c) => c.id)))
        return null
      case 'ui.notify':
        this.deps.notify(`${ext.manifest.displayName}: ${str(0, 'message').slice(0, 300)}`)
        return null
      case 'ui.confirm':
        return this.deps.confirm(ext.manifest.displayName, str(0, 'message').slice(0, 1000))
      case 'destination.register': {
        const destId = str(0, 'id')
        if (!ext.manifest.contributes.destinations.some((d) => d.id === destId)) throw new Error(`Destination "${destId}" is not declared in contributes.destinations`)
        rec.destinations.add(destId)
        this.deps.onChange()
        return null
      }
      case 'views.handle': {
        const viewId = str(0, 'viewId')
        if (!ext.manifest.contributes.views.some((v) => v.id === viewId)) throw new Error(`View "${viewId}" is not declared in contributes.views`)
        rec.viewHandlers.add(viewId)
        return null
      }
      case 'views.post': {
        const viewId = str(0, 'viewId')
        if (!ext.manifest.contributes.views.some((v) => v.id === viewId)) throw new Error(`View "${viewId}" is not declared in contributes.views`)
        this.deps.onViewMessage?.(rec.key, viewId, args[1] ?? null)
        return null
      }
      case 'provide.register':
        if (args[0] === 'focus') rec.providesFocus = true
        else if (args[0] === 'activity') {
          rec.providesActivity = true
          this.deps.onAppState?.()
        }
        else throw new Error(`Cannot provide ${String(args[0])}`)
        return null
      default:
        throw new Error(`Unknown method ${method}`)
    }
  }
}

/** A node type named in a manifest: its own id, or already a full name. */
function fullType(extensionId: string, t: string): string {
  return t.includes('/') ? t : nodeTypeName(extensionId, t)
}

function checkKey(k: string): string {
  if (!KEY_RE.test(k)) throw new Error('Secret names are lowercase letters, digits, "_" or "-"')
  return k
}

function toBlock(e: Entry): ExtensionBlock {
  return {
    id: e.id,
    createdAt: e.createdAt,
    ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
    markdown: e.markdown,
    ...(e.parentId ? { parentId: e.parentId } : {}),
    ...(e.kind ? { kind: e.kind } : {}),
    ...(e.hidden ? { hidden: true } : {}),
    ...(e.meta ? { meta: { ...e.meta } } : {})
  }
}
