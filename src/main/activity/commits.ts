/**
 * CommitWatcher: watches the git reflog (`.git/logs/HEAD`) of every
 * repository mapped to a page and reports new commits so they can be added
 * to the page as read-only notes.
 */
import { EventEmitter } from 'node:events'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { simpleGit } from 'simple-git'

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

export interface WatchedRepo {
  pageId: string
  path: string
}

interface RepoState {
  pageId: string
  root: string
  logFile: string
  size: number
  watcher: FSWatcher | null
  seen: Set<string>
}

const REFLOG_COMMIT_RE = /^([0-9a-f]{40}) ([0-9a-f]{40}) .*?\t(commit(?: \([^)]*\))?|merge [^:]*|rebase[^:]*|cherry-pick[^:]*): (.*)$/

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
      wanted.set(root, { pageId: r.pageId, path: root })
    }
    for (const [root, state] of this.repos) {
      if (!wanted.has(root)) {
        state.watcher?.close()
        this.repos.delete(root)
      } else {
        state.pageId = wanted.get(root)!.pageId
      }
    }
    for (const [root, r] of wanted) {
      if (this.repos.has(root)) continue
      const logFile = await reflogPath(root)
      if (!logFile) continue
      const size = await fileSize(logFile)
      const state: RepoState = { pageId: r.pageId, root, logFile, size, watcher: null, seen: new Set() }
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
      state.watcher = watch(path.dirname(state.logFile), { persistent: false }, () => void this.check(state))
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
      const size = await fileSize(state.logFile)
      if (size === state.size) return
      if (size < state.size) {
        // Reflog rewritten (gc / expire): resync without replaying history.
        state.size = size
        return
      }
      const handle = await fs.open(state.logFile, 'r')
      let text: string
      try {
        const buf = Buffer.alloc(size - state.size)
        await handle.read(buf, 0, buf.length, state.size)
        text = buf.toString('utf8')
      } finally {
        await handle.close()
      }
      state.size = size
      for (const line of text.split('\n')) {
        const m = REFLOG_COMMIT_RE.exec(line.trim())
        if (!m) continue
        const [, , hash, action] = m
        if (!action.startsWith('commit') && !action.startsWith('cherry-pick')) continue
        if (state.seen.has(hash)) continue
        state.seen.add(hash)
        const info = await this.describe(state.root, hash)
        if (info) this.emit('commit', state.pageId, info)
      }
    })
    this.queue = run.catch((err) => console.error('commit watcher', err))
    return this.queue as Promise<void>
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
