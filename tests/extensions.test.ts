import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DevlogStore, readLockFile, updateManifest } from '@devlog/core/node'
import { ExtensionInstaller, sha256 } from '../src/main/extensions/install'
import { ConsentStore, SecretStore, type Cipher } from '../src/main/extensions/localState'
import { ExtensionManager } from '../src/main/extensions/manager'

const FIXTURES = path.resolve(__dirname, 'fixtures/extensions')
let hostScript: string
let work: string

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-exthost-'))
  hostScript = path.join(work, 'extensionHost.js')
  await build({
    entryPoints: [path.resolve(__dirname, '../src/main/extensions/hostProcess.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: hostScript,
    logLevel: 'silent'
  })
}, 60_000)

afterAll(async () => {
  await fs.rm(work, { recursive: true, force: true })
})

/** Reversible, not secure: stands in for the OS keychain. */
const fakeCipher: Cipher = {
  available: () => true,
  encrypt: (s) => Buffer.from(`enc:${s}`),
  decrypt: (b) => b.toString().replace(/^enc:/, '')
}

describe('extensions in the app', () => {
  let root: string
  let userData: string
  let store: DevlogStore
  let manager: ExtensionManager
  let notices: string[]
  let ids: Record<string, string>

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-extrepo-'))
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-extud-'))
    store = new DevlogStore(root)
    await store.initLayout()
    const acme = await store.createCanvas({ title: 'Acme' })
    const web = await store.createCanvas({ title: 'Web', parentId: acme.id })
    const globex = await store.createCanvas({ title: 'Globex' })
    await store.updateCanvas(acme.id, { fields: { 'ext.builtin.probe.code': 'ACME-1' } })
    for (const c of [acme, web, globex]) await store.addEntry(c.id, `needle in ${c.title}`)
    await store.addEntry('journal', 'needle in the journal')
    ids = { acme: acme.id, web: web.id, globex: globex.id }
    await updateManifest(root, (m) => {
      m.extensions = { probe: 'builtin' }
      m.settings = { 'builtin.probe': { greeting: 'Howdy' } }
    })
    notices = []
    manager = new ExtensionManager({
      root,
      store,
      userData,
      installer: new ExtensionInstaller({ cacheDir: path.join(userData, 'extensions'), builtinDir: FIXTURES, devOverrides: async () => ({}) }),
      consent: new ConsentStore(path.join(userData, 'consent.json')),
      secrets: new SecretStore(path.join(userData, 'secrets'), fakeCipher),
      hostScript: async () => hostScript,
      notify: (t) => notices.push(t),
      confirm: async () => true,
      onChange: () => undefined,
      onBlockAdded: () => undefined
    })
  })

  afterEach(async () => {
    await manager.stopAll()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(userData, { recursive: true, force: true })
  })

  const probe = async (): Promise<Record<string, any>> => {
    await manager.runCommand('probe', 'probe')
    return JSON.parse(await fs.readFile(path.join(root, 'extensions/builtin.probe/probe.json'), 'utf8'))
  }

  it('installs, then waits for consent before running anything', async () => {
    await manager.load()
    const [info] = await manager.list()
    expect(info).toMatchObject({ key: 'probe', id: 'builtin.probe', source: 'builtin', state: 'needs-consent', grant: null, displayName: 'Probe' })
    expect(info.commands.map((c) => [c.id, c.ready])).toEqual([
      ['probe', false],
      ['hello', false]
    ])
    await expect(manager.runCommand('probe', 'probe')).rejects.toThrow(/not running/)
    expect(await fs.readFile(path.join(root, '.gitattributes'), 'utf8')).toContain('extensions/builtin.probe/log/*.jsonl merge=union')
  })

  it('runs in a sandbox: no files, no processes, no workers, no packages, no inherited environment', async () => {
    await manager.load()
    await manager.allow('probe', { read: { all: true }, write: null })
    expect((await manager.list())[0]).toMatchObject({ state: 'running' })
    const r = await probe()
    expect(r.id).toBe('builtin.probe')
    expect(r.readFile).toEqual({ ok: false, error: 'ERR_ACCESS_DENIED' })
    expect(r.readDir).toEqual({ ok: false, error: 'ERR_ACCESS_DENIED' })
    expect(r.writeFile).toEqual({ ok: false, error: 'ERR_ACCESS_DENIED' })
    expect(r.spawn).toEqual({ ok: false, error: 'ERR_ACCESS_DENIED' })
    expect(r.worker).toEqual({ ok: false, error: 'ERR_ACCESS_DENIED' })
    expect(r.requirePackage.ok).toBe(false)
    expect(r.env.filter((k: string) => !['TZ', 'LANG', 'LC_ALL'].includes(k))).toEqual(['ELECTRON_RUN_AS_NODE'])
    expect(r.escapeFiles.ok).toBe(false)
    await expect(fs.stat(path.join(root, 'escape.txt'))).rejects.toThrow()
  })

  it('sees and writes only what was granted', async () => {
    await manager.load()
    await manager.allow('probe', { read: { canvases: [ids.acme] }, write: { canvases: [ids.web] } })
    const r = await probe()
    expect(r.canvases.map((c: { title: string }) => c.title).sort()).toEqual(['Acme', 'Web'])
    expect(r.canvases.find((c: { title: string }) => c.title === 'Acme').fields).toEqual({ code: 'ACME-1' })
    expect(r['field:Web']).toBe('ACME-1') // inherited from Acme
    expect(r['days:Acme'].ok).toBe(true)
    expect(r['add:Acme']).toEqual({ ok: false, error: 'No write access to that canvas' })
    expect(r['add:Web']).toEqual({ ok: true, value: { ext: 'builtin.probe', probe: '1' } })
    expect(r['field:Globex']).toBeUndefined()
    expect(r.search.sort()).toEqual([ids.acme, ids.web].sort())
    // The block it wrote is in the day file, marked as its own.
    const today = (await store.listDays(ids.web)).at(-1)!.date
    expect((await store.readDay(ids.web, today)).entries.at(-1)).toMatchObject({ markdown: 'Probe was here (Web)', meta: { ext: 'builtin.probe', probe: '1' } })
    await expect(store.updateEntry(ids.web, today, (await store.readDay(ids.web, today)).entries.at(-1)!.id, 'x')).rejects.toThrow(/read-only/)
  })

  it('without a read grant it sees nothing', async () => {
    await manager.load()
    await manager.allow('probe', { read: null, write: null })
    const r = await probe()
    expect(r.canvases).toEqual([])
    expect(r.search).toEqual([])
  })

  it('keeps its own files, settings, secrets, and hears about pauses', async () => {
    await manager.load()
    await manager.allow('probe', { read: null, write: null })
    await manager.runCommand('probe', 'hello')
    await manager.runCommand('probe', 'hello')
    expect(notices).toEqual(['Probe: Howdy #1', 'Probe: Howdy #2'])
    expect(await fs.readFile(path.join(root, 'extensions/builtin.probe/log/hello.jsonl'), 'utf8')).toBe('{"n":1}\n{"n":2}\n')
    const localDir = path.join(userData, 'extension-data', 'builtin.probe')
    const [devlogFolder] = await fs.readdir(localDir)
    expect(await fs.readFile(path.join(localDir, devlogFolder, 'count'), 'utf8')).toBe('2')

    await manager.setSettings('probe', { greeting: 'Hi', undeclared: 'dropped' })
    await manager.setSecret('probe', 'token', 's3cret')
    expect((await manager.list())[0].secrets).toEqual([{ key: 'token', label: 'Token', set: true }])
    expect(await fs.readFile(path.join(userData, 'secrets', 'builtin.probe.json'), 'utf8')).not.toContain('s3cret')
    manager.activity({ t: new Date().toISOString(), type: 'lock' })
    await new Promise((r) => setTimeout(r, 200))
    const r = await probe()
    expect(r.settings).toEqual({ greeting: 'Hi' })
    expect(r.secretBefore).toEqual({ ok: true, value: 's3cret' })
    expect(r.notices.map((n: { type: string; reason?: string }) => [n.type, n.reason])).toEqual([['pause', 'locked']])
  })

  it('asks again when its code changes, and stops when consent is withdrawn', async () => {
    await manager.load()
    await manager.allow('probe', { read: { all: true }, write: null })
    const consent = new ConsentStore(path.join(userData, 'consent.json'))
    const c = await consent.get(root, 'builtin.probe')
    await consent.set(root, 'builtin.probe', { ...c!, sha256: 'an older build' })
    await manager.restart('probe')
    expect((await manager.list())[0]).toMatchObject({ state: 'needs-consent', changedSinceConsent: true })
    await manager.allow('probe', { read: { all: true }, write: null })
    expect((await manager.list())[0].state).toBe('running')
    await manager.revoke('probe')
    expect((await manager.list())[0]).toMatchObject({ state: 'needs-consent', grant: null })
    await expect(manager.runCommand('probe', 'probe')).rejects.toThrow(/not running/)
  })

  it('reports an extension that fails to start', async () => {
    const bad = path.join(work, 'bad')
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(bad, 'devlog-extension.json'), JSON.stringify({ name: 'bad', version: '1.0.0', api: '^1.0.0', main: 'main.js' }))
    await fs.writeFile(path.join(bad, 'main.js'), 'exports.activate = () => { throw new Error("boom") }')
    const m = new ExtensionManager({
      ...(manager as unknown as { deps: ConstructorParameters<typeof ExtensionManager>[0] }).deps,
      installer: new ExtensionInstaller({ cacheDir: path.join(userData, 'extensions'), builtinDir: FIXTURES, devOverrides: async () => ({ bad }) })
    })
    await updateManifest(root, (mf) => {
      mf.extensions = { bad: 'builtin' }
    })
    await m.load()
    await m.allow('bad', { read: null, write: null })
    const [info] = await m.list()
    expect(info.state).toBe('failed')
    expect(info.error).toMatch(/boom/)
    await m.stopAll()
  })
})

describe('the installer', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-inst-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const manifest = JSON.stringify({ name: 'jira', version: '1.3.0', api: '^1.0.0', main: 'main.js' })
  const zip = (files: Record<string, string>): Uint8Array => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))

  function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
    return (async (url: string) => {
      const route = routes[url]
      if (!route) return new Response('not found', { status: 404 })
      return route()
    }) as unknown as typeof fetch
  }

  it('picks the newest matching GitHub release, verifies and pins it', async () => {
    const bytes = zip({ 'jira/devlog-extension.json': manifest, 'jira/main.js': 'exports.activate = () => {}' })
    const releases = [
      { tag_name: 'v2.0.0', draft: false, assets: [{ name: 'jira.devlog-ext.zip', url: 'https://api.github.com/a/2', browser_download_url: 'https://github.com/dl/2' }] },
      { tag_name: 'v1.3.0', draft: false, assets: [{ name: 'jira.devlog-ext.zip', url: 'https://api.github.com/a/13', browser_download_url: 'https://github.com/dl/13' }] },
      { tag_name: 'v1.4.0', draft: true, assets: [{ name: 'jira.devlog-ext.zip', url: 'x', browser_download_url: 'x' }] },
      { tag_name: 'v1.5.0', draft: false, assets: [{ name: 'source.zip', url: 'y', browser_download_url: 'y' }] }
    ]
    let downloads = 0
    const inst = new ExtensionInstaller({
      cacheDir: path.join(dir, 'cache'),
      builtinDir: dir,
      devOverrides: async () => ({}),
      fetch: fakeFetch({
        'https://api.github.com/repos/sdeken/devlog-jira/releases?per_page=100': () => Response.json(releases),
        'https://github.com/dl/13': () => {
          downloads++
          return new Response(bytes)
        }
      })
    })
    const ext = await inst.install('sdeken/devlog-jira', '^1.0.0')
    expect(ext).toMatchObject({ id: 'sdeken.devlog-jira', version: '1.3.0', url: 'https://github.com/dl/13', sha256: sha256(bytes) })
    expect(await fs.readFile(path.join(ext.dir, 'main.js'), 'utf8')).toContain('activate')

    // With a lock entry, the cached copy is used as is.
    const lock = { id: ext.id, spec: '^1.0.0', version: ext.version, url: ext.url, sha256: ext.sha256 }
    await inst.install('sdeken/devlog-jira', '^1.0.0', lock)
    expect(downloads).toBe(1)
    // Gone from the cache: downloaded again and checked against the lock.
    await fs.rm(ext.dir, { recursive: true })
    await inst.install('sdeken/devlog-jira', '^1.0.0', lock)
    expect(downloads).toBe(2)
    await fs.rm(ext.dir, { recursive: true })
    await expect(inst.install('sdeken/devlog-jira', '^1.0.0', { ...lock, sha256: 'f'.repeat(64) })).rejects.toThrow(/does not match devlog.lock.json/)
  })

  it('refuses zips that would write outside their folder, or have no manifest', async () => {
    const inst = new ExtensionInstaller({ cacheDir: path.join(dir, 'cache'), builtinDir: dir, devOverrides: async () => ({}) })
    await expect(inst.unpack(zip({ 'devlog-extension.json': manifest, '../evil.js': 'x' }), path.join(dir, 'out'))).rejects.toThrow(/Unsafe path/)
    await expect(inst.unpack(zip({ 'readme.md': 'x' }), path.join(dir, 'out2'))).rejects.toThrow(/no devlog-extension.json/)
    await expect(inst.unpack(strToU8('not a zip'), path.join(dir, 'out3'))).rejects.toThrow(/not a zip/)
    await expect(fs.stat(path.join(dir, 'evil.js'))).rejects.toThrow()
  })

  it('refuses an extension built for another API version', async () => {
    const ext = path.join(dir, 'old')
    await fs.mkdir(ext)
    await fs.writeFile(path.join(ext, 'devlog-extension.json'), JSON.stringify({ name: 'old', version: '1.0.0', api: '^2.0.0' }))
    const inst = new ExtensionInstaller({ cacheDir: path.join(dir, 'cache'), builtinDir: dir, devOverrides: async () => ({}) })
    await expect(inst.install('old', 'builtin')).rejects.toThrow(/needs extension API \^2\.0\.0/)
  })

  it('writes the lockfile for downloaded extensions only', async () => {
    const root = path.join(dir, 'repo')
    await fs.mkdir(root)
    const store = new DevlogStore(root)
    await store.initLayout()
    await updateManifest(root, (m) => {
      m.extensions = { probe: 'builtin' }
    })
    const m = new ExtensionManager({
      root,
      store,
      userData: dir,
      installer: new ExtensionInstaller({ cacheDir: path.join(dir, 'cache'), builtinDir: FIXTURES, devOverrides: async () => ({}) }),
      consent: new ConsentStore(path.join(dir, 'consent.json')),
      secrets: new SecretStore(path.join(dir, 'secrets'), fakeCipher),
      hostScript: async () => hostScript,
      notify: () => undefined,
      confirm: async () => true,
      onChange: () => undefined,
      onBlockAdded: () => undefined
    })
    await m.load()
    expect((await readLockFile(root)).extensions).toEqual({})
    await m.stopAll()
  })
})
