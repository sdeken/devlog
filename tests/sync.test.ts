import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevlogStore } from '../src/main/devlog/store'
import { SyncManager, commitMessage } from '../src/main/devlog/sync'

let tmp: string
let root: string
let bare: string
const author = { authorName: 'Test User', authorEmail: 'test@example.com' }

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-sync-'))
  root = path.join(tmp, 'work')
  bare = path.join(tmp, 'remote.git')
  await fs.mkdir(root)
  await simpleGit().init(true, [bare, '--initial-branch=main'])
  await simpleGit({ baseDir: root }).init(['--initial-branch=main'])
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function makeStore(): Promise<DevlogStore> {
  const store = new DevlogStore(root)
  await store.initLayout()
  await SyncManager.initRepo(root, author)
  return store
}

describe('SyncManager', () => {
  it('detects git', async () => {
    expect(await SyncManager.gitVersion()).toMatch(/^\d+\.\d+/)
    expect(await SyncManager.isRepo(root)).toBe(true)
    expect(await SyncManager.isRepo(tmp)).toBe(false)
  })

  it('makes an initial commit and reports a clean status', async () => {
    await makeStore()
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: false, pullOnStart: false, ...author })
    await sync.start()
    expect(sync.getStatus().state).toBe('clean')
    expect(sync.getStatus().hasRemote).toBe(false)
    sync.stop()
  })

  it('commits local changes without a remote', async () => {
    const store = await makeStore()
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: true, pullOnStart: false, ...author })
    await sync.start()
    await store.addEntry('hello world')
    const res = await sync.syncNow('manual')
    expect(res.committed).toBe(true)
    expect(res.pushed).toBe(false)
    expect(res.error).toBeUndefined()
    const log = await simpleGit({ baseDir: root }).log()
    expect(log.total).toBe(2)
    expect(log.latest?.message).toMatch(/^devlog: \d{4}-\d{2}-\d{2}$/)
    expect(log.latest?.author_name).toBe('Test User')
    expect(sync.getStatus()).toMatchObject({ state: 'clean', dirtyFiles: 0 })
    sync.stop()
  })

  it('pushes to a remote and sets upstream', async () => {
    const store = await makeStore()
    await simpleGit({ baseDir: root }).addRemote('origin', bare)
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: true, pullOnStart: false, ...author })
    await sync.start()
    await store.addEntry('pushed entry')
    const res = await sync.syncNow('manual')
    expect(res.error).toBeUndefined()
    expect(res).toMatchObject({ committed: true, pushed: true })
    const remoteLog = await simpleGit({ baseDir: bare }).log()
    expect(remoteLog.total).toBe(2)
    const st = sync.getStatus()
    expect(st).toMatchObject({ state: 'clean', hasRemote: true, ahead: 0, behind: 0, branch: 'main' })
    expect(st.lastPushAt).toBeTruthy()
    sync.stop()
  })

  it('pulls entries written from another clone before pushing', async () => {
    const store = await makeStore()
    await simpleGit({ baseDir: root }).addRemote('origin', bare)
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: true, pullOnStart: false, ...author })
    await sync.start()
    await sync.syncNow('manual') // establish upstream

    // Second machine.
    const other = path.join(tmp, 'other')
    await simpleGit().clone(bare, other)
    const otherStore = new DevlogStore(other)
    await otherStore.addEntry('from laptop', {}, new Date(2026, 0, 2, 9))
    const og = simpleGit({ baseDir: other, config: ['user.name=Other', 'user.email=o@example.com'] })
    await og.add('-A')
    await og.commit('laptop entry')
    await og.push('origin', 'main')

    // First machine writes something else, then syncs.
    await store.addEntry('from desktop', {}, new Date(2026, 0, 3, 9))
    let remoteChanges = false
    sync.on('remote-changes', () => (remoteChanges = true))
    const res = await sync.syncNow('manual')
    expect(res.error).toBeUndefined()
    expect(res).toMatchObject({ committed: true, pulled: true, pushed: true, remoteChanges: true })
    expect(remoteChanges).toBe(true)
    expect((await store.listDays()).map((d) => d.date)).toEqual(['2026-01-03', '2026-01-02'])
    // initial commit + laptop entry + desktop entry, linear history after the rebase
    const remoteLog = await simpleGit({ baseDir: bare }).log()
    expect(remoteLog.total).toBe(3)
    expect(remoteLog.all.map((c) => c.message)).toEqual(['devlog: 2026-01-03', 'laptop entry', 'Initialise devlog'])
    sync.stop()
  })

  it('surfaces push failures as an error state and recovers on the next run', async () => {
    const store = await makeStore()
    await simpleGit({ baseDir: root }).addRemote('origin', path.join(tmp, 'does-not-exist.git'))
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: true, pullOnStart: false, ...author })
    await sync.start()
    await store.addEntry('will fail to push')
    const res = await sync.syncNow('manual')
    expect(res.committed).toBe(true)
    expect(res.pushed).toBe(false)
    expect(res.error).toMatch(/Fetch failed/)
    expect(sync.getStatus().state).toBe('error')

    await simpleGit({ baseDir: root }).remote(['set-url', 'origin', bare])
    const res2 = await sync.syncNow('manual')
    expect(res2.error).toBeUndefined()
    expect(res2.pushed).toBe(true)
    expect(sync.getStatus().state).toBe('clean')
    sync.stop()
  })

  it('commits after the debounce period following a change', async () => {
    const store = await makeStore()
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 1, autoPush: false, pullOnStart: false, ...author })
    await sync.start()
    store.on('change', () => sync.noteChange())
    await store.addEntry('debounced')
    expect(sync.getStatus().state).toBe('dirty')
    const synced = new Promise<void>((resolve) => sync.once('synced', () => resolve()))
    await synced
    expect(sync.getStatus().state).toBe('clean')
    expect((await simpleGit({ baseDir: root }).log()).total).toBe(2)
    sync.stop()
  })

  it('serialises overlapping sync requests', async () => {
    const store = await makeStore()
    const sync = new SyncManager(root, { intervalMinutes: 60, debounceSeconds: 60, autoPush: false, pullOnStart: false, ...author })
    await sync.start()
    await store.addEntry('one')
    const [a, b, c] = await Promise.all([sync.syncNow('manual'), sync.syncNow('interval'), sync.syncNow('debounce')])
    expect([a, b, c].filter((r) => r.committed)).toHaveLength(1)
    expect((await simpleGit({ baseDir: root }).log()).total).toBe(2)
    sync.stop()
  })
})

describe('commitMessage', () => {
  it('names the day when a single day file changed', () => {
    expect(commitMessage(['entries/2026/09/2026-09-19.md', 'entries/2026/09/assets/x.png'], 'interval')).toMatch(
      /^devlog: 2026-09-19\n\nSynced .* \(interval\)\.\n\n- entries/
    )
  })
  it('names a range when several days changed', () => {
    expect(commitMessage(['entries/2026/09/2026-09-18.md', 'entries/2026/09/2026-09-19.md'], 'manual')).toMatch(/^devlog: 2026-09-18…2026-09-19/)
  })
})
