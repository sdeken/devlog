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
  parseExtensionEntry,
  topLevelCanvasId,
  scopeCanvasIds,
  visibleCanvases,
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
import type { ActivityNotice, DestinationLine, DestinationSheet, ExtensionBlock, ExtensionCanvas, SendResult } from '@devlog/extension-api'
import type { ActivityEvent } from '@shared/types'
import type { ExtensionInfo, ExtensionState, ExtensionUpdateReport } from '@shared/extensions'
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
  /** Destinations it registered (of those it declared). */
  destinations: Set<string>
  files: { repo: ExtensionFileStore; local: ExtensionFileStore } | null
  secretSet: Set<string>
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/

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
      destinations: new Set(),
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
    const consent = await this.deps.consent.get(this.deps.root, ext.id)
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
    rec.activity = false
    rec.providesFocus = false
    rec.destinations = new Set()
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
    rec.providesFocus = false
    rec.destinations = new Set()
    if (host) await host.stop().catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Machine state and focus providers
  // -------------------------------------------------------------------------

  /** Locked or asleep (from the OS), passed on to extensions as pause/resume. */
  private readonly pausedBy = new Set<'locked' | 'suspended'>()

  /** The machine was locked/unlocked or went to sleep/woke (from the OS, whether or not time is tracked). */
  setSystemState(state: 'locked' | 'asleep', on: boolean): void {
    const reason = state === 'locked' ? 'locked' : 'suspended'
    const t = new Date().toISOString()
    if (on) {
      if (this.pausedBy.has(reason)) return
      this.pausedBy.add(reason)
      this.notify({ t, type: 'pause', reason })
    } else {
      if (!this.pausedBy.has(reason)) return
      if (reason === 'locked') this.pausedBy.clear() // unlocking means someone is back
      else this.pausedBy.delete(reason)
      if (this.pausedBy.size === 0) this.notify({ t, type: 'resume' })
    }
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
        commands: (m?.contributes.commands ?? []).map((c) => ({ ...c, ready: Boolean(rec.host?.commands.includes(c.id)) })),
        destinations: (m?.contributes.destinations ?? []).map((d) => ({ ...d, ready: Boolean(rec.host && rec.destinations.has(d.id)) })),
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
  async runCommand(key: string, commandId: string): Promise<string | null> {
    const rec = this.need(key)
    if (!rec.host) throw new Error(`${rec.installed?.manifest.displayName ?? key} is not running`)
    const value = await rec.host.call('command.run', [commandId])
    return typeof value === 'string' ? value.slice(0, 500) : null
  }

  /** Pass pause/resume/task changes from the tracker to extensions that listen for them. */
  activity(ev: ActivityEvent): void {
    if (ev.type === 'lock' || ev.type === 'suspend') return this.setSystemState(ev.type === 'lock' ? 'locked' : 'asleep', true)
    if (ev.type === 'unlock' || ev.type === 'resume') return this.setSystemState(ev.type === 'unlock' ? 'locked' : 'asleep', false)
    if (ev.type === 'idle') this.notify({ t: ev.t, type: 'pause', reason: 'idle' })
    else if (ev.type === 'active') this.notify({ t: ev.t, type: 'resume' })
    else if (ev.type === 'task' || ev.type === 'stop') this.notify({ t: ev.t, type: 'task', canvasId: ev.type === 'task' ? (ev.canvasId ?? null) : null })
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

  /** A week's saved timesheet as the extension sees it: labels, and its own canvas fields (inherited). */
  private async destinationSheet(rec: Rec, week: string): Promise<DestinationSheet> {
    const sheet = await this.deps.store.readTimesheet(week)
    if (!sheet) throw new Error('Save the timesheet first')
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

  /** What sending the week's timesheet to a destination would do. */
  async destinationPreview(key: string, destId: string, week: string): Promise<DestinationLine[]> {
    const { rec, host } = this.destinationHost(key, destId)
    const lines = await host.call('destination.preview', [destId, await this.destinationSheet(rec, week)], 120_000)
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

  /** Send a final timesheet, and record what happened under it in the Timesheets canvas. */
  async destinationSend(key: string, destId: string, week: string): Promise<SendResult> {
    const { rec, host } = this.destinationHost(key, destId)
    const sheet = await this.destinationSheet(rec, week)
    if (sheet.status !== 'final') throw new Error('Mark the timesheet final before sending it')
    const raw = (await host.call('destination.send', [destId, sheet], 10 * 60_000)) as Partial<SendResult> | null
    const result: SendResult = {
      done: Array.isArray(raw?.done) ? raw.done.map(String) : [],
      failed: Array.isArray(raw?.failed) ? raw.failed.map((f) => ({ lineId: String(f?.lineId ?? ''), error: String(f?.error ?? 'Failed').slice(0, 500) })) : [],
      summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 500) : 'Sent'
    }
    const label = rec.installed?.manifest.contributes.destinations.find((d) => d.id === destId)?.label ?? destId
    const failed = result.failed.length ? ` ${result.failed.length} failed: ${result.failed.map((f) => f.error).join('; ')}` : ''
    await this.deps.store.addTimesheetRecord(week, rec.id, `Sent to ${label}: ${result.summary}.${failed}`, { destination: destId })
    this.deps.onBlockAdded('', week)
    return result
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
    const canRead = async (canvasId: string): Promise<boolean> => scopeCanvasIds(await canvases(), grant.read).has(canvasId)
    const canWrite = async (canvasId: string): Promise<boolean> => scopeCanvasIds(await canvases(), grant.write).has(canvasId)
    const fieldPrefix = `ext.${ext.id}.`

    switch (method) {
      case 'devlog.canvases': {
        const all = await this.deps.store.listCanvases()
        const visible = visibleCanvases(all, grant)
        this.visibleCache.set(rec.key, new Set(visible.map((c) => c.id)))
        return visible.map(
          (c): ExtensionCanvas => ({
            id: c.id,
            title: c.title,
            parentId: c.parentId,
            task: c.task,
            archived: c.archived,
            fields: Object.fromEntries(Object.entries(c.fields ?? {}).flatMap(([k, v]) => (k.startsWith(fieldPrefix) ? [[k.slice(fieldPrefix.length), v]] : [])))
          })
        )
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
        const opts = (args[2] ?? {}) as { meta?: Record<string, string>; parentId?: unknown; date?: unknown; todo?: unknown }
        if (!(await canWrite(canvasId))) throw new Error('No write access to that canvas')
        const parentId = typeof opts.parentId === 'string' ? opts.parentId : undefined
        const at = typeof opts.date === 'string' ? opts.date : undefined
        if (parentId && !at) throw new Error('devlog.addBlock: a block added inside another needs that block\'s date')
        const { date, entry } = await this.deps.store.addExtensionBlock(canvasId, ext.id, markdown, opts.meta ?? {}, new Date(), {
          ...(parentId ? { parentId, date: at } : {}),
          todo: opts.todo === true
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
      case 'provide.register':
        if (args[0] === 'focus') rec.providesFocus = true
        else throw new Error(`Cannot provide ${String(args[0])}`)
        return null
      default:
        throw new Error(`Unknown method ${method}`)
    }
  }
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
