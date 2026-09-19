import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommitWatcher, commitMarkdown, reflogPath, type CommitInfo } from '../src/main/activity/commits'

let tmp: string
let repo: string
let watcher: CommitWatcher | null = null

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-commits-'))
  repo = path.join(tmp, 'proj')
  await fs.mkdir(repo)
  const git = simpleGit({ baseDir: repo, config: ['user.name=T', 'user.email=t@e.com'] })
  await git.init(['--initial-branch=main'])
  await fs.writeFile(path.join(repo, 'a.txt'), '1')
  await git.add('-A')
  await git.commit('initial')
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('CommitWatcher', () => {
  it('finds the reflog and reports only commits made after watching starts', async () => {
    expect(await reflogPath(repo)).toBe(path.join(repo, '.git', 'logs', 'HEAD'))
    expect(await reflogPath(tmp)).toBeNull()

    const seen: Array<[string, CommitInfo]> = []
    watcher = new CommitWatcher(() => false)
    watcher.on('commit', (pageId: string, info: CommitInfo) => seen.push([pageId, info]))
    await watcher.setRepos([{ pageId: 'acme', path: repo }])
    await watcher.checkAll()
    expect(seen).toHaveLength(0) // the initial commit predates the watch

    const git = simpleGit({ baseDir: repo, config: ['user.name=T', 'user.email=t@e.com'] })
    await fs.writeFile(path.join(repo, 'a.txt'), '2')
    await git.add('-A')
    await git.commit('Fix the thing\n\nLonger explanation here.')
    await git.checkout(['-b', 'feature']) // reflog line that is not a commit
    await watcher.checkAll()
    expect(seen).toHaveLength(1)
    const [pageId, info] = seen[0]
    expect(pageId).toBe('acme')
    expect(info).toMatchObject({ repoName: 'proj', subject: 'Fix the thing', body: 'Longer explanation here.', author: 'T' })
    expect(info.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(commitMarkdown(info)).toBe(`⎇ **proj** \`feature\` · \`${info.shortHash}\` — Fix the thing\n\nLonger explanation here.`)

    await watcher.checkAll() // no duplicates
    expect(seen).toHaveLength(1)
  })

  it('skips excluded repositories', async () => {
    watcher = new CommitWatcher((root) => root === path.resolve(repo))
    await watcher.setRepos([{ pageId: 'acme', path: repo }])
    const git = simpleGit({ baseDir: repo, config: ['user.name=T', 'user.email=t@e.com'] })
    await fs.writeFile(path.join(repo, 'a.txt'), '3')
    await git.add('-A')
    await git.commit('devlog: sync')
    const seen: unknown[] = []
    watcher.on('commit', (x) => seen.push(x))
    await watcher.checkAll()
    expect(seen).toHaveLength(0)
  })
})
