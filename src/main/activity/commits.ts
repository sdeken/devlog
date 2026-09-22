/**
 * CommitWatcher: watches the reflogs (`.git/logs/**`) of every repository
 * mapped to a page. New commits are reported so they can be added to the
 * page as read-only notes; branch creation, checkouts, pushes, merges,
 * rebases, pulls and stashes are reported as lightweight git events for the
 * activity log.
 */
import { EventEmitter } from 'node:events'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import type { GitAction } from '@shared/types'

export interface CommitInfo {
  repoPath: string
  repoName: string
  hash: string
  shortHash: string
  subject: string
  body: string
  author: string
  branch: string | null
  /** ISO commit time. */
  time: string
}

export interface GitEventInfo {
  repoPath: string
  repoName: string
  action: GitAction
  branch?: string
  from?: string
  detail?: string
}

export interface WatchedRepo {
  canvasId: string
  path: string
}

interface RepoState {
  canvasId: string
  root: string
  logsDir: string
  /** Byte offset read so far, per reflog file. */
  sizes: Map<string, number>
  watcher: FSWatcher | null
  seen: Set<string>
}

const REFLOG_LINE_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) .*?\t([^:]*)(?:: (.*))?$/

export class CommitWatcher extends EventEmitter {
  private repos = new Map<string, RepoState>()
  private poll: NodeJS.Timeout | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly exclude: (root: string) => boolean) {
    super()
  }

  /** Replace the watched set. Already-watched repos keep their position. */
  async setRepos(list: WatchedRepo[]): Promise<void> {
    const wanted = new Map<string, WatchedRepo>()
    for (const r of list) {
      const root = path.resolve(r.path)
      if (this.exclude(root)) continue
      wanted.set(root, { canvasId: r.canvasId, path: root })
    }
    for (const [root, state] of this.repos) {
      if (!wanted.has(root)) {
        state.watcher?.close()
        this.repos.delete(root)
      } else {
        state.canvasId = wanted.get(root)!.canvasId
      }
    }
    for (const [root, r] of wanted) {
      if (this.repos.has(root)) continue
      const logFile = await reflogPath(root)
      if (!logFile) continue
      const logsDir = path.dirname(logFile)
      const state: RepoState = { canvasId: r.canvasId, root, logsDir, sizes: new Map(), watcher: null, seen: new Set() }
      for (const f of await listLogFiles(logsDir)) state.sizes.set(f, await fileSize(f))
      this.repos.set(root, state)
      this.attach(state)
    }
    if (!this.poll) {
      this.poll = setInterval(() => void this.checkAll(), 15_000)
      this.poll.unref?.()
    }
  }

  stop(): void {
    for (const state of this.repos.values()) state.watcher?.close()
    this.repos.clear()
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  /** Force a check now (tests, manual refresh). */
  async checkAll(): Promise<void> {
    for (const state of [...this.repos.values()]) await this.check(state)
  }

  private attach(state: RepoState): void {
    try {
      state.watcher = watch(state.logsDir, { persistent: false, recursive: true }, () => void this.check(state))
      state.watcher.on('error', () => {
        state.watcher?.close()
        state.watcher = null
      })
    } catch {
      state.watcher = null
    }
  }

  private check(state: RepoState): Promise<void> {
    const run = this.queue.then(async () => {
      for (const file of await listLogFiles(state.logsDir)) {
        const size = await fileSize(file)
        const known = state.sizes.get(file)
        if (known === undefined) {
          // New reflog file: a branch was created (or first fetched). Read it from the start.
          state.sizes.set(file, 0)
        } else if (size === known) continue
        else if (size < known) {
          state.sizes.set(file, size) // rewritten by gc/expire: resync without replaying
          continue
        }
        const offset = state.sizes.get(file)!
        const handle = await fs.open(file, 'r')
        let text: string
        try {
          const buf = Buffer.alloc(size - offset)
          await handle.read(buf, 0, buf.length, offset)
          text = buf.toString('utf8')
        } finally {
          await handle.close()
        }
        state.sizes.set(file, size)
        const ref = path.relative(state.logsDir, file).split(path.sep).join('/')
        for (const line of text.split('\n')) await this.handleLine(state, ref, line.trim())
      }
    })
    this.queue = run.catch((err) => console.error('commit watcher', err))
    return this.queue as Promise<void>
  }

  /** Interpret one reflog line from `ref` (e.g. `HEAD`, `refs/heads/x`, `refs/remotes/origin/x`). */
  private async handleLine(state: RepoState, ref: string, line: string): Promise<void> {
    const m = REFLOG_LINE_RE.exec(line)
    if (!m) return
    const [, oldHash, newHash, action, message = ''] = m
    const name = path.basename(state.root)
    const event = (info: Omit<GitEventInfo, 'repoPath' | 'repoName'>): void => {
      this.emit('event', state.canvasId, { repoPath: state.root, repoName: name, ...info } satisfies GitEventInfo)
    }
    if (ref === 'HEAD') {
      if (action.startsWith('commit') || action.startsWith('cherry-pick')) {
        if (state.seen.has(newHash)) return
        state.seen.add(newHash)
        const info = await this.describe(state.root, newHash)
        if (info) this.emit('commit', state.canvasId, info)
        return
      }
      if (action === 'checkout') {
        const mv = /^moving from (.+) to (.+)$/.exec(message)
        if (mv) event({ action: 'checkout', from: mv[1], branch: mv[2] })
        return
      }
      if (action.startsWith('merge')) return event({ action: 'merge', detail: `${action.replace(/^merge\s*/, '')}${message ? `: ${message}` : ''}`.trim() })
      if (action.startsWith('rebase')) {
        if (/finish|abort/.test(action) || /^rebase \(finish\)/.test(action)) event({ action: 'rebase', detail: message })
        return
      }
      if (action.startsWith('pull')) return event({ action: 'pull', detail: message })
      if (action.startsWith('reset')) return event({ action: 'reset', detail: message })
      return
    }
    if (ref.startsWith('refs/heads/')) {
      const branch = ref.slice('refs/heads/'.length)
      if (action.startsWith('branch') && /created/i.test(message)) event({ action: 'branch', branch, detail: message })
      return
    }
    if (ref.startsWith('refs/remotes/')) {
      const rest = ref.slice('refs/remotes/'.length)
      const slash = rest.indexOf('/')
      const branch = slash >= 0 ? rest.slice(slash + 1) : rest
      if (action === 'update by push' && oldHash !== newHash) event({ action: 'push', branch })
      return
    }
    if (ref === 'refs/stash') {
      if (oldHash !== newHash) event({ action: 'stash', detail: message })
    }
  }

  private async describe(root: string, hash: string): Promise<CommitInfo | null> {
    try {
      const git = simpleGit({ baseDir: root })
      const raw = await git.raw(['show', '-s', '--format=%H%x1f%an%x1f%aI%x1f%s%x1f%b', hash])
      const [fullHash, author, time, subject, body] = raw.trim().split('\x1f')
      let branch: string | null = null
      try {
        branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim() || null
      } catch {
        /* detached */
      }
      return {
        repoPath: root,
        repoName: path.basename(root),
        hash: fullHash,
        shortHash: fullHash.slice(0, 7),
        subject: subject ?? '',
        body: (body ?? '').trim(),
        author: author ?? '',
        branch,
        time: time || new Date().toISOString()
      }
    } catch {
      return null
    }
  }
}

/** Resolve `.git/logs/HEAD`, following `.git` files used by worktrees and submodules. */
export async function reflogPath(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git')
  try {
    const st = await fs.stat(dotGit)
    let gitDir = dotGit
    if (st.isFile()) {
      const text = await fs.readFile(dotGit, 'utf8')
      const m = /gitdir:\s*(.+)/.exec(text)
      if (!m) return null
      gitDir = path.resolve(root, m[1].trim())
    }
    const logFile = path.join(gitDir, 'logs', 'HEAD')
    await fs.access(path.dirname(logFile)).catch(() => fs.mkdir(path.dirname(logFile), { recursive: true }))
    return logFile
  } catch {
    return null
  }
}

/** Every reflog file under `.git/logs`, recursively. */
async function listLogFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await walk(dir)
  return out.sort()
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size
  } catch {
    return 0
  }
}

/** Markdown body for a captured commit note. */
export function commitMarkdown(info: CommitInfo): string {
  const head = `⎇ **${info.repoName}**${info.branch ? ` \`${info.branch}\`` : ''} · \`${info.shortHash}\` — ${info.subject}`
  return info.body ? `${head}\n\n${info.body}` : head
}
