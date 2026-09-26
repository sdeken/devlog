/**
 * ExtensionHost: runs one extension in its own process and relays its API
 * calls. The process is the Devlog binary in Node mode
 * (ELECTRON_RUN_AS_NODE; Electron's utilityProcess ignores --permission)
 * started with Node's permission model: it may read only the host script,
 * and may not write files, start processes, use workers or load addons.
 * The extension's code arrives over IPC, so it needs no file access at all.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { CallMessage, ExtensionSideMethod, FromExtension, ToExtension } from '@devlog/extension-api/protocol'

export interface HostOptions {
  id: string
  /** Path to the self-contained host script (extensionHost.js), outside any archive. */
  hostScript: string
  code: string
  filename: string
  apiVersion: string
  machine: string
  settings: Record<string, string>
  /**
   * Run without the permission model (an extension that asked to, and that
   * you said you trust). It then also gets the app's environment and its
   * package folder.
   */
  unrestricted?: { packageDir: string }
  /** Handles the extension's API calls. */
  handle: (method: string, args: unknown[]) => Promise<unknown>
  /** Heap limit in MB. */
  maxMemoryMb?: number
}

/** Environment variables passed through: enough for the network stack, nothing that could hold a secret. */
const ENV_KEEP = ['SystemRoot', 'SYSTEMROOT', 'windir', 'TZ', 'LANG', 'LC_ALL']

export class ExtensionHost extends EventEmitter {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  commands: string[] = []
  state: 'starting' | 'running' | 'failed' | 'stopped' = 'stopped'
  error: string | null = null

  constructor(private readonly opts: HostOptions) {
    super()
  }

  /** Start the process and activate the extension. Resolves once `activate` has returned. */
  start(): Promise<void> {
    const free = this.opts.unrestricted
    const env: NodeJS.ProcessEnv = free ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ELECTRON_RUN_AS_NODE: '1' }
    if (!free) for (const k of ENV_KEEP) if (process.env[k]) env[k] = process.env[k]
    this.state = 'starting'
    this.error = null
    const child = fork(this.opts.hostScript, [], {
      execPath: process.execPath,
      execArgv: [...(free ? [] : ['--permission', `--allow-fs-read=${this.opts.hostScript}`]), `--max-old-space-size=${this.opts.maxMemoryMb ?? 256}`],
      env,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    this.child = child
    const prefix = `[ext ${this.opts.id}]`
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `${prefix} `)))
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(d.toString().replace(/^(?=.)/gm, `${prefix} `)))

    return new Promise((resolve, reject) => {
      const startTimer = setTimeout(() => {
        this.fail('Did not start within 30 seconds')
        reject(new Error(this.error ?? 'Did not start'))
      }, 30_000)
      child.on('message', (msg: FromExtension) => {
        switch (msg.t) {
          case 'ready':
            clearTimeout(startTimer)
            this.commands = msg.commands
            this.state = 'running'
            this.emit('state')
            resolve()
            break
          case 'failed':
            clearTimeout(startTimer)
            this.fail(msg.error)
            reject(new Error(msg.error))
            break
          case 'registered':
            if (!this.commands.includes(msg.command)) this.commands.push(msg.command)
            break
          case 'call':
            void this.answer(msg)
            break
          case 'res': {
            const p = this.pending.get(msg.id)
            if (!p) break
            this.pending.delete(msg.id)
            clearTimeout(p.timer)
            if (msg.ok) p.resolve(msg.value)
            else p.reject(new Error(msg.error ?? 'Failed'))
            break
          }
        }
      })
      child.on('exit', (code, signal) => {
        clearTimeout(startTimer)
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          p.reject(new Error('The extension stopped'))
        }
        this.pending.clear()
        if (this.state === 'starting' || this.state === 'running') {
          this.fail(`Stopped unexpectedly (${signal ?? `exit code ${code}`})`)
          reject(new Error(this.error ?? 'Stopped'))
        }
        this.child = null
        this.emit('exit')
      })
      child.on('error', (err) => {
        clearTimeout(startTimer)
        this.fail(err.message)
        reject(err)
      })
      this.post({ t: 'init', id: this.opts.id, apiVersion: this.opts.apiVersion, machine: this.opts.machine, packageDir: free?.packageDir ?? null, code: this.opts.code, filename: this.opts.filename, settings: this.opts.settings })
    })
  }

  private fail(error: string): void {
    this.state = 'failed'
    this.error = error
    this.emit('state')
    this.child?.kill()
  }

  private post(msg: ToExtension): void {
    if (this.child?.connected) this.child.send(msg)
  }

  private async answer(msg: CallMessage): Promise<void> {
    try {
      const value = await this.opts.handle(msg.method, Array.isArray(msg.args) ? msg.args : [])
      this.post({ t: 'res', id: msg.id, ok: true, value: value ?? null })
    } catch (err) {
      this.post({ t: 'res', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Call into the extension (run a command, deliver a notice). */
  call(method: ExtensionSideMethod, args: unknown[], timeoutMs = 5 * 60_000): Promise<unknown> {
    if (this.state !== 'running' || !this.child) return Promise.reject(new Error('The extension is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The extension did not answer in time'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.post({ t: 'call', id, method, args })
    })
  }

  updateSettings(settings: Record<string, string>): void {
    this.post({ t: 'settings', settings })
  }

  /** Ask the extension to deactivate, then make sure the process is gone. */
  async stop(): Promise<void> {
    const child = this.child
    this.state = 'stopped'
    if (!child) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.post({ t: 'stop' })
    })
    this.emit('state')
  }
}
