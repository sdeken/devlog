/**
 * SyncManager: keeps a devlog repository committed and pushed.
 *
 *  - A debounce timer commits shortly after the last edit.
 *  - An interval timer commits + pushes on a regular cadence regardless.
 *  - `syncNow()` can be called on demand (menu, status bar, app quit).
 *
 * All git work is serialised through a single promise chain so runs never
 * overlap. Failures are surfaced through the status object and retried on the
 * next tick; they never throw out of the timers.
 */
import { EventEmitter } from 'node:events'
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git'
import type { SyncStatus } from '../types'

export interface SyncOptions {
  intervalMinutes: number
  debounceSeconds: number
  autoPush: boolean
  pullOnStart: boolean
  authorName?: string
  authorEmail?: string
  /**
   * Path prefixes whose changes are committed with every sync but do not count
   * as unsaved work in the status (the activity log, appended every few minutes).
   */
  quietPaths?: string[]
}

export interface SyncResult {
  committed: boolean
  pushed: boolean
  pulled: boolean
  /** True if the working tree changed because of a pull. */
  remoteChanges: boolean
  error?: string
}

export type SyncReason = 'interval' | 'debounce' | 'manual' | 'startup' | 'quit'

const DEFAULT_STATUS: SyncStatus = {
  state: 'idle',
  dirtyFiles: 0,
  hasRemote: false,
  remoteUrl: null,
  branch: null,
  ahead: 0,
  behind: 0,
  lastCommitAt: null,
  lastPushAt: null,
  lastPullAt: null,
  lastError: null,
  nextSyncAt: null
}

export class SyncManager extends EventEmitter {
  private git: SimpleGit
  private status: SyncStatus = { ...DEFAULT_STATUS }
  private queue: Promise<unknown> = Promise.resolve()
  private intervalTimer: NodeJS.Timeout | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    readonly root: string,
    private options: SyncOptions
  ) {
    super()
    this.git = createGit(root, options)
  }

  /** Static helper: `git init` + initial commit for a brand new devlog. */
  static async initRepo(root: string, options: Pick<SyncOptions, 'authorName' | 'authorEmail'>): Promise<void> {
    const git = createGit(root, options)
    if (!(await git.checkIsRepo())) {
      await git.init()
    }
    const log = await git.log().catch(() => null)
    if (!log || log.total === 0) {
      await git.add('-A')
      await git.commit('Initialise devlog')
    }
  }

  static async isRepo(root: string): Promise<boolean> {
    try {
      return await simpleGit({ baseDir: root }).checkIsRepo()
    } catch {
      return false
    }
  }

  static async gitVersion(): Promise<string | null> {
    try {
      const v = await simpleGit().version()
      return v.installed ? `${v.major}.${v.minor}.${v.patch}` : null
    } catch {
      return null
    }
  }

  /** Point `origin` at `url` (or remove it when empty). Serialised with sync runs. */
  async setRemote(url: string): Promise<void> {
    const run = this.queue.then(async () => {
      const remotes = await this.git.getRemotes()
      const has = remotes.some((r) => r.name === 'origin')
      if (!url) {
        if (has) await this.git.removeRemote('origin')
      } else if (has) await this.git.remote(['set-url', 'origin', url])
      else await this.git.addRemote('origin', url)
      await this.refreshStatus()
    })
    this.queue = run.catch(() => undefined)
    await run
  }

  /**
   * Commit everything in the working tree with `message` (no push). Serialised
   * with sync runs. Returns false when there was nothing to commit.
   */
  async commitAll(message: string): Promise<boolean> {
    const run = this.queue.then(async () => {
      await this.git.add('-A')
      const staged = await this.git.status()
      if (staged.files.length === 0) return false
      await this.git.commit(message)
      this.setStatus({ lastCommitAt: new Date().toISOString() })
      await this.refreshStatus()
      return true
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Fetch and merge (not rebase) the remote branch. A conflicting merge is aborted and reported. */
  async mergeRemote(): Promise<{ merged: boolean; error?: string }> {
    const ref = await this.fetchRemoteRef()
    if (!ref) return { merged: false }
    return this.mergeRef(ref)
  }

  /**
   * Merge `ref` (a commit or remote-tracking branch). With `ours`, record it as
   * merged while keeping this branch's tree as is. A conflicting merge is
   * aborted and reported. Serialised with sync runs.
   */
  async mergeRef(ref: string, opts: { ours?: boolean; message?: string } = {}): Promise<{ merged: boolean; error?: string }> {
    const run = this.queue.then(async () => {
      const args = [ref, '--no-edit', '--no-ff']
      if (opts.ours) args.push('-s', 'ours')
      if (opts.message) args.push('-m', opts.message)
      try {
        await this.git.merge(args)
      } catch (err) {
        await this.git.merge(['--abort']).catch(() => undefined)
        return { merged: false, error: `Merge failed: ${shortError(err)}` }
      }
      this.setStatus({ lastPullAt: new Date().toISOString(), lastError: null })
      await this.refreshStatus()
      return { merged: true }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Fetch and return the remote-tracking ref for this branch (`origin/main`), or null without one. */
  async fetchRemoteRef(): Promise<string | null> {
    const run = this.queue.then(async () => {
      const remote = await this.primaryRemote()
      const branch = (await this.git.status()).current
      if (!remote || !branch) return null
      try {
        await this.git.fetch(remote.name)
      } catch {
        return null
      }
      return (await this.remoteBranchExists(remote.name, branch)) ? `${remote.name}/${branch}` : null
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The oldest commit reachable from `ref` that added `file`, or null. */
  async firstCommitAdding(ref: string, file: string): Promise<string | null> {
    const run = this.queue.then(async () => {
      try {
        const out = await this.git.raw(['log', '--format=%H', '--diff-filter=A', ref, '--', file])
        const all = out.trim().split('\n').filter(Boolean)
        return all.length ? all[all.length - 1] : null
      } catch {
        return null
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** The first parent of `commit`, or null for a root commit. */
  async parentOf(commit: string): Promise<string | null> {
    const run = this.queue.then(async () => {
      try {
        return (await this.git.raw(['rev-parse', '--verify', '--quiet', `${commit}^`])).trim() || null
      } catch {
        return null
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Fetch, then read `file` from the remote branch. Null when there is no
   * remote, it cannot be reached, or the file (or branch) does not exist there.
   */
  async readRemoteFile(file: string): Promise<string | null> {
    const ref = await this.fetchRemoteRef()
    if (!ref) return null
    const run = this.queue.then(async () => {
      try {
        return await this.git.show([`${ref}:${file}`])
      } catch {
        return null
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  /** True when the working tree has changes or HEAD has commits the remote branch lacks (after the last fetch). */
  async hasUnsyncedWork(): Promise<boolean> {
    const run = this.queue.then(async () => {
      const status = await this.git.status()
      if (status.files.length > 0) return true
      const remote = await this.primaryRemote()
      if (!remote || !status.current) return false
      try {
        const out = await this.git.raw(['rev-list', '--count', `${remote.name}/${status.current}..HEAD`])
        return Number(out.trim()) > 0
      } catch {
        return true // no remote branch yet: everything is unsynced
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  getStatus(): SyncStatus {
    return { ...this.status }
  }

  updateOptions(next: Partial<SyncOptions>): void {
    this.options = { ...this.options, ...next }
    this.git = createGit(this.root, this.options)
    if (!this.stopped) this.scheduleInterval()
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.refreshStatus().catch((err) => this.fail(err))
    this.scheduleInterval()
    if (this.options.pullOnStart && this.status.hasRemote) {
      void this.syncNow('startup')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.intervalTimer = null
    this.debounceTimer = null
  }

  /** Call after every local edit: commits after a quiet period. */
  noteChange(): void {
    if (this.stopped) return
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    const ms = Math.max(1, this.options.debounceSeconds) * 1000
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.syncNow('debounce')
    }, ms)
    if (this.status.state === 'clean' || this.status.state === 'idle') {
      this.setStatus({ state: 'dirty', dirtyFiles: Math.max(1, this.status.dirtyFiles) })
    }
  }

  /** Commit (and push, if configured) now. Serialised; safe to call repeatedly. */
  syncNow(reason: SyncReason = 'manual'): Promise<SyncResult> {
    const run = this.queue.then(() => this.runSync(reason))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Wait for any in-flight sync to finish. */
  async idle(): Promise<void> {
    await this.queue
  }

  // -------------------------------------------------------------------------

  private scheduleInterval(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    const ms = Math.max(1, this.options.intervalMinutes) * 60_000
    this.intervalTimer = setInterval(() => void this.syncNow('interval'), ms)
    this.intervalTimer.unref?.()
    this.setStatus({ nextSyncAt: new Date(Date.now() + ms).toISOString() })
  }

  private async runSync(reason: SyncReason): Promise<SyncResult> {
    const result: SyncResult = { committed: false, pushed: false, pulled: false, remoteChanges: false }
    try {
      const status = await this.git.status()
      const remote = await this.primaryRemote()
      const branch = status.current
      this.setStatus({
        hasRemote: remote !== null,
        remoteUrl: remote?.url ?? null,
        branch,
        dirtyFiles: this.loudFiles(status.files).length,
        ahead: status.ahead,
        behind: status.behind
      })

      // 1. Commit local changes.
      if (status.files.length > 0) {
        this.setStatus({ state: 'committing' })
        await this.git.add('-A')
        const staged = await this.git.status()
        if (staged.files.length > 0) {
          await this.git.commit(commitMessage(staged.files.map((f) => f.path), reason))
          result.committed = true
          this.setStatus({ lastCommitAt: new Date().toISOString(), dirtyFiles: 0 })
        }
      }

      // 2. Pull + push when there is a remote.
      const wantsNetwork = remote !== null && this.options.autoPush && branch
      if (wantsNetwork && (reason !== 'quit' || result.committed || status.ahead > 0)) {
        this.setStatus({ state: 'pulling' })
        const headBefore = await this.head()
        try {
          await this.git.fetch(remote.name)
        } catch (err) {
          throw new Error(`Fetch failed: ${shortError(err)}`)
        }
        const afterFetch = await this.git.status()
        if (afterFetch.behind > 0 || !afterFetch.tracking) {
          const remoteHasBranch = await this.remoteBranchExists(remote.name, branch)
          if (remoteHasBranch) {
            try {
              await this.git.pull(remote.name, branch, { '--rebase': 'true', '--autostash': null })
              result.pulled = true
              this.setStatus({ lastPullAt: new Date().toISOString() })
            } catch (err) {
              // Leave the working tree as it was rather than stuck mid-rebase.
              await this.git.rebase(['--abort']).catch(() => undefined)
              throw new Error(`Pull failed (resolve conflicts in the repo, then sync again): ${shortError(err)}`)
            }
          }
        }
        const headAfter = await this.head()
        result.remoteChanges = result.pulled && headBefore !== headAfter && (await this.treeChangedBetween(headBefore, headAfter))

        const st = await this.git.status()
        if (st.ahead > 0 || !st.tracking) {
          this.setStatus({ state: 'pushing' })
          try {
            await this.git.push(remote.name, branch, ['--set-upstream'])
            result.pushed = true
            this.setStatus({ lastPushAt: new Date().toISOString() })
          } catch (err) {
            throw new Error(`Push failed: ${shortError(err)}`)
          }
        }
      }

      await this.refreshStatus()
      this.setStatus({ lastError: null })
      if (result.remoteChanges) this.emit('remote-changes')
      this.emit('synced', result)
      return result
    } catch (err) {
      result.error = this.fail(err)
      this.emit('synced', result)
      return result
    } finally {
      if (this.intervalTimer && !this.stopped) {
        const ms = Math.max(1, this.options.intervalMinutes) * 60_000
        this.setStatus({ nextSyncAt: new Date(Date.now() + ms).toISOString() })
      }
    }
  }

  private async refreshStatus(): Promise<void> {
    const status = await this.git.status()
    const remote = await this.primaryRemote()
    const dirty = this.loudFiles(status.files).length
    this.setStatus({
      state: dirty > 0 ? 'dirty' : 'clean',
      dirtyFiles: dirty,
      hasRemote: remote !== null,
      remoteUrl: remote?.url ?? null,
      branch: status.current,
      ahead: status.ahead,
      behind: status.behind
    })
  }

  private loudFiles<T extends { path: string }>(files: T[]): T[] {
    const quiet = this.options.quietPaths ?? []
    return quiet.length ? files.filter((f) => !quiet.some((q) => f.path.startsWith(q))) : files
  }

  private async primaryRemote(): Promise<{ name: string; url: string } | null> {
    const remotes = await this.git.getRemotes(true)
    if (remotes.length === 0) return null
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0]
    return { name: origin.name, url: origin.refs.push || origin.refs.fetch }
  }

  private async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
    try {
      const out = await this.git.raw(['ls-remote', '--heads', remote, branch])
      return out.trim().length > 0
    } catch {
      return false
    }
  }

  private async head(): Promise<string | null> {
    try {
      return (await this.git.revparse(['HEAD'])).trim()
    } catch {
      return null
    }
  }

  private async treeChangedBetween(a: string | null, b: string | null): Promise<boolean> {
    if (!a || !b) return true
    try {
      const out = await this.git.diff(['--name-only', a, b])
      return out.trim().length > 0
    } catch {
      return true
    }
  }

  private fail(err: unknown): string {
    const message = shortError(err)
    this.setStatus({ state: 'error', lastError: message })
    return message
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit('status', this.getStatus())
  }
}

function createGit(root: string, options: Pick<SyncOptions, 'authorName' | 'authorEmail'>): SimpleGit {
  const config: string[] = []
  if (options.authorName) config.push(`user.name=${options.authorName}`)
  if (options.authorEmail) config.push(`user.email=${options.authorEmail}`)
  // The child process inherits process.env; the app sets GIT_TERMINAL_PROMPT=0 there so
  // git never blocks on a credential prompt. A stalled network call is killed after
  // `block` ms of silence and surfaces as an error in the status bar.
  const opts: Partial<SimpleGitOptions> = { baseDir: root, config, trimmed: false, timeout: { block: 90_000 } }
  return simpleGit(opts)
}

export function commitMessage(files: string[], reason: SyncReason): string {
  const now = new Date()
  const stamp = now.toISOString().replace('T', ' ').slice(0, 16)
  const dayFiles = files.filter((f) => /\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(-13, -3))
  const days = [...new Set(dayFiles)].sort()
  const subject =
    days.length === 1 ? `devlog: ${days[0]}` : days.length > 1 ? `devlog: ${days[0]}…${days[days.length - 1]}` : `devlog: ${stamp}`
  const body = [`Synced ${stamp} UTC (${reason}).`, '', ...files.map((f) => `- ${f}`)].join('\n')
  return `${subject}\n\n${body}`
}

function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^error:\s*/i, '').split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 400)
}
