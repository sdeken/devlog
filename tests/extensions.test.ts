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
      machine: 'desk-1a2b',
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
      machine: 'desk-1a2b',
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

describe('trusted (unrestricted) extensions', () => {
  let root: string
  let userData: string
  let manager: ExtensionManager

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-trustrepo-'))
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-trustud-'))
    const store = new DevlogStore(root)
    await store.initLayout()
    await updateManifest(root, (m) => {
      m.extensions = { trusted: 'builtin', 'devlog-focus': 'builtin' }
    })
    manager = new ExtensionManager({
      root,
      machine: 'desk-1a2b',
      store,
      userData,
      installer: new ExtensionInstaller({
        cacheDir: path.join(userData, 'extensions'),
        builtinDir: path.resolve(__dirname, '../builtin-extensions'),
        devOverrides: async () => ({ trusted: path.join(FIXTURES, 'trusted') })
      }),
      consent: new ConsentStore(path.join(userData, 'consent.json')),
      secrets: new SecretStore(path.join(userData, 'secrets'), fakeCipher),
      hostScript: async () => hostScript,
      notify: () => undefined,
      confirm: async () => true,
      onChange: () => undefined,
      onBlockAdded: () => undefined
    })
    await manager.load()
  })

  afterEach(async () => {
    await manager.stopAll()
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(userData, { recursive: true, force: true })
  })

  it('runs only if you say you trust it, and then without the sandbox', async () => {
    const info = (await manager.list()).find((e) => e.key === 'trusted')!
    expect(info).toMatchObject({ state: 'needs-consent', permissions: { unrestricted: true } })
    await expect(manager.allow('trusted', { read: null, write: null })).rejects.toThrow(/trust/)
    expect((await manager.list()).find((e) => e.key === 'trusted')!.state).toBe('needs-consent')
    await manager.allow('trusted', { read: null, write: null, trusted: true })
    await manager.runCommand('trusted', 'probe')
    const report = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'builtin.trusted', 'report.json'), 'utf8'))
    expect(report).toEqual({ packageDir: path.join(FIXTURES, 'trusted'), readOwnManifest: 'trusted', hasPath: true })
  })

  it('a stored consent without trust does not let it run', async () => {
    const consent = new ConsentStore(path.join(userData, 'consent.json'))
    const info = (await manager.list()).find((e) => e.key === 'trusted')!
    await consent.set(root, 'builtin.trusted', { sha256: info.sha256!, grant: { read: null, write: null }, at: 't' })
    await manager.restart('trusted')
    expect((await manager.list()).find((e) => e.key === 'trusted')!.state).toBe('needs-consent')
  })

  it('devlog-focus is a built-in that asks for trust', async () => {
    const info = (await manager.list()).find((e) => e.key === 'devlog-focus')!
    expect(info).toMatchObject({ id: 'builtin.devlog-focus', source: 'builtin', state: 'needs-consent', permissions: { unrestricted: true } })
    await manager.allow('devlog-focus', { read: null, write: null, trusted: true })
    expect((await manager.list()).find((e) => e.key === 'devlog-focus')!.state).toBe('running')
    expect(await fs.readFile(path.join(root, '.gitattributes'), 'utf8')).toContain('extensions/builtin.devlog-focus/**/*.jsonl merge=union')
    expect(await manager.focusEvents('2000-01-01', '2000-01-02')).toEqual([])
  })
})

describe('devlog-jira: sending a timesheet as worklogs', () => {
  let root: string
  let userData: string
  let store: DevlogStore
  let manager: ExtensionManager
  let server: import('node:http').Server
  let requests: Array<{ method: string; url: string; auth: string; body: any }>
  let notices: string[]
  let ids: Record<string, string>
  const week = '2026-09-21'

  beforeEach(async () => {
    const http = await import('node:http')
    requests = []
    let nextWorklog = 100
    server = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        requests.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), body: data ? JSON.parse(data) : null })
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/rest/api/2/myself') return res.end(JSON.stringify({ displayName: 'Test User' }))
        if (req.method === 'POST' && /\/worklog$/.test(req.url!)) {
          res.statusCode = 201
          return res.end(JSON.stringify({ id: String(nextWorklog++) }))
        }
        if (req.method === 'PUT') return res.end(JSON.stringify({ id: req.url!.split('/').pop() }))
        if (req.method === 'DELETE') {
          res.statusCode = 204
          return res.end()
        }
        res.statusCode = 404
        res.end(JSON.stringify({ errorMessages: ['nope'] }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as import('node:net').AddressInfo).port

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-jirarepo-'))
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-jiraud-'))
    store = new DevlogStore(root)
    await store.initLayout()
    const acme = await store.createCanvas({ title: 'Acme' })
    const fix = await store.createCanvas({ title: 'Fix login', parentId: acme.id, task: true })
    const globex = await store.createCanvas({ title: 'Globex' })
    await store.updateCanvas(acme.id, { fields: { 'ext.builtin.devlog-jira.issue': 'ACME-1' } })
    await store.updateCanvas(fix.id, { fields: { 'ext.builtin.devlog-jira.issue': 'acme-7' } })
    ids = { acme: acme.id, fix: fix.id, globex: globex.id }
    await updateManifest(root, (m) => {
      m.extensions = { 'devlog-jira': 'builtin' }
    })
    notices = []
    manager = new ExtensionManager({
      root,
      machine: 'desk-1a2b',
      store,
      userData,
      installer: new ExtensionInstaller({ cacheDir: path.join(userData, 'extensions'), builtinDir: path.resolve(__dirname, '../builtin-extensions'), devOverrides: async () => ({}) }),
      consent: new ConsentStore(path.join(userData, 'consent.json')),
      secrets: new SecretStore(path.join(userData, 'secrets'), fakeCipher),
      hostScript: async () => hostScript,
      notify: (t) => notices.push(t),
      confirm: async () => true,
      onChange: () => undefined,
      onBlockAdded: () => undefined
    })
    await manager.load()
    await manager.allow('devlog-jira', { read: null, write: null })
    await manager.setSettings('devlog-jira', { baseurl: `http://127.0.0.1:${port}`, email: 'me@example.com' })
    await manager.setSecret('devlog-jira', 'token', 't0ken')
    // Registration is asynchronous; wait until the destination is ready.
    for (let i = 0; i < 50 && !(await manager.list())[0].destinations[0]?.ready; i++) await new Promise((r) => setTimeout(r, 20))
  })

  afterEach(async () => {
    await manager.stopAll()
    await new Promise((r) => server.close(r))
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(userData, { recursive: true, force: true })
  })

  const entry = (id: string, canvasId: string, h: number, minutes: number, note?: string) => ({
    id,
    date: '2026-09-22',
    start: new Date(2026, 8, 22, h).toISOString(),
    minutes,
    canvasId,
    worked: minutes,
    source: 'tracked' as const,
    ...(note ? { note } : {})
  })

  it('previews, refuses a draft, sends only what changed, and keeps a record', async () => {
    expect((await manager.list())[0].destinations).toEqual([{ id: 'worklogs', label: 'Jira', ready: true }])
    expect(await manager.runCommand('devlog-jira', 'check')).toBe('Connected to Jira as Test User')
    expect((await manager.list())[0]).toMatchObject({ check: 'check', missing: [] })
    await expect(manager.setSettings('devlog-jira', { baseurl: 'not a url' })).rejects.toThrow(/Jira address/)

    const entries = [entry('e1', ids.fix, 9, 60, 'login redirect'), entry('e2', ids.acme, 10, 30), entry('e3', ids.globex, 11, 15)]
    await store.saveTimesheet({ week, status: 'draft', entries })
    const preview = await manager.destinationPreview('devlog-jira', 'worklogs', week)
    expect(preview.map((l) => [l.id, l.action, l.target])).toEqual([
      ['e1', 'create', 'ACME-7'],
      ['e2', 'create', 'ACME-1'],
      ['e3', 'skip', '']
    ])
    expect(preview[2].reason).toMatch(/No Jira issue/)
    await expect(manager.destinationSend('devlog-jira', 'worklogs', week)).rejects.toThrow(/final/)

    await store.saveTimesheet({ week, status: 'final', entries })
    const first = await manager.destinationSend('devlog-jira', 'worklogs', week)
    expect(first).toMatchObject({ done: ['e1', 'e2'], failed: [], summary: '2 worklogs created (1:30 on 2 issues)' })
    const posts = requests.filter((r) => r.method === 'POST')
    expect(posts.map((r) => r.url)).toEqual(['/rest/api/2/issue/ACME-7/worklog', '/rest/api/2/issue/ACME-1/worklog'])
    expect(posts[0].auth).toBe(`Basic ${Buffer.from('me@example.com:t0ken').toString('base64')}`)
    expect(posts[0].body).toMatchObject({ timeSpentSeconds: 3600, comment: 'login redirect' })
    expect(posts[0].body.started).toMatch(/^2026-09-22T09:00:00\.000[+-]\d{4}$/)

    // The record, under the week's timesheet.
    const canvas = (await store.timesheetsCanvas())!
    const day = await store.readDay(canvas.id, week)
    const sheetBlock = day.entries.find((e) => e.kind === 'timesheet')!
    expect(day.entries.find((e) => e.parentId === sheetBlock.id)).toMatchObject({ markdown: 'Sent to Jira: 2 worklogs created (1:30 on 2 issues).', meta: { ext: 'builtin.devlog-jira', destination: 'worklogs' } })
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'extensions/builtin.devlog-jira/sent', `${week}.json`), 'utf8'))
    expect(Object.keys(ledger)).toEqual(['e1', 'e2'])

    // Nothing changed: nothing sent.
    expect((await manager.destinationPreview('devlog-jira', 'worklogs', week)).map((l) => l.action)).toEqual(['unchanged', 'unchanged', 'skip'])
    requests = []
    expect((await manager.destinationSend('devlog-jira', 'worklogs', week)).summary).toBe('2 unchanged (1:30 on 2 issues)')
    expect(requests).toEqual([])

    // Shorter e1, e2 moved to a canvas with no issue: one update, one delete.
    await store.saveTimesheet({ week, status: 'final', entries: [entry('e1', ids.fix, 9, 45, 'login redirect'), entry('e2', ids.globex, 10, 30), entry('e3', ids.globex, 11, 15)] })
    expect((await manager.destinationPreview('devlog-jira', 'worklogs', week)).map((l) => [l.id, l.action])).toEqual([
      ['e1', 'update'],
      ['e2:old', 'delete'],
      ['e2', 'skip'],
      ['e3', 'skip']
    ])
    const third = await manager.destinationSend('devlog-jira', 'worklogs', week)
    expect(third.summary).toBe('1 updated, 1 deleted (0:45 on 1 issue)')
    expect(requests.map((r) => [r.method, r.url])).toEqual([
      ['PUT', '/rest/api/2/issue/ACME-7/worklog/100'],
      ['DELETE', '/rest/api/2/issue/ACME-1/worklog/101']
    ])
    expect(requests[0].body.timeSpentSeconds).toBe(2700)
  })

  it('says what is missing before it can send', async () => {
    await manager.setSettings('devlog-jira', {})
    expect((await manager.list())[0].missing).toEqual(['Jira address'])
    await manager.setSecret('devlog-jira', 'token', null)
    expect((await manager.list())[0].missing).toEqual(['Jira address', 'API token'])
    await store.saveTimesheet({ week, status: 'final', entries: [entry('e1', ids.fix, 9, 60)] })
    const r = await manager.destinationSend('devlog-jira', 'worklogs', week).catch((e: Error) => e)
    expect(String(r)).toMatch(/Set the Jira URL/)
  })
})

describe('devlog-cms: sending a timesheet as CMS hours', () => {
  let root: string
  let userData: string
  let store: DevlogStore
  let manager: ExtensionManager
  let server: import('node:http').Server
  let updates: Array<Record<string, string>>
  let logins: number
  let ids: Record<string, string>
  const week = '2026-09-21'
  const pad = (n: number) => String(n).padStart(2, '0')
  const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const addDays = (s: string, n: number) => {
    const [y, m, d] = s.split('-').map(Number)
    return ymd(new Date(y, m - 1, d + n))
  }

  // A made-up CMS with the same page structure as the real one.
  const assignments = [
    { id: '90001', client: 'Initech', project: 'Platform', until: '2099-12-31' },
    { id: '90002', client: 'Umbrella', project: 'Support', until: '2026-09-23' }
  ]
  let hours: Map<string, { hours: number; desc: string }>
  const tsId = (a: number, date: string) => String(1000 + a * 1000 + Number(date.replace(/-/g, '')) % 1000)

  function weekPage(sunday: string) {
    const [y, m, d] = addDays(sunday, 6).split('-')
    const today = ymd(new Date())
    const rows = assignments.map((a, i) => {
      const days = [0, 1, 2, 3, 4, 5, 6].map((n) => {
        const date = addDays(sunday, n)
        const h = hours.get(tsId(i, date))?.hours ?? 0
        const text = `${pad(Math.floor(h))}.${pad(Math.round((h % 1) * 100))}`
        return date > today || date > a.until ? `<TD align="right">&nbsp;</TD>` : `<TD align="right"><A href="TPIServlet?screen=TimesheetScreen&action=retrieve&timesheet_id=${tsId(i, date)}">${text}</A></TD>`
      })
      return `<TR class="textdefault" bgcolor="#EEEEEE"><TD>${a.client}</TD><TD>${a.project} </TD>${days.join('')}<TD align="right">0.00</TD><TD><A href="TPIServlet?screen=AssignmentScreen&assignment_id=${a.id}&span=week">Week</A></TD></TR>`
    })
    return `<html><body><B>Week Ending: ${m}/${d}/${y.slice(2)}</B><TABLE><TR class="header"><TD>Client</TD><TD>Project</TD></TR>${rows.join('\n')}</TABLE></body></html>`
  }
  const loginPage = '<html><form method="POST" action="j_security_check"><input type="hidden" name="from" value=""><input name="j_username"><input type="password" name="j_password" maxlength="14"></form></html>'

  beforeEach(async () => {
    const http = await import('node:http')
    updates = []
    logins = 0
    hours = new Map([[tsId(0, '2026-09-24'), { hours: 2, desc: 'typed into CMS by hand' }], [tsId(1, '2026-09-22'), { hours: 0, desc: 'earlier words' }]])
    server = http.createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        const url = new URL(req.url!, 'http://cms')
        const authed = /JSESSIONID=auth/.test(String(req.headers.cookie ?? ''))
        res.setHeader('Content-Type', 'text/html')
        if (req.method === 'POST' && url.pathname === '/consultant/j_security_check') {
          const form = new URLSearchParams(data)
          if (form.get('j_username') === 'jdoe' && form.get('j_password') === 'hunter2') {
            logins++
            res.setHeader('Set-Cookie', 'JSESSIONID=auth42; Path=/consultant; HttpOnly')
          }
          res.statusCode = 302
          res.setHeader('Location', '/consultant/')
          return res.end()
        }
        if (url.pathname === '/consultant/') return res.end(authed ? '<html>Welcome</html>' : loginPage)
        if (url.pathname !== '/consultant/servlet/TPIServlet') {
          res.statusCode = 404
          return res.end()
        }
        if (!authed) {
          res.setHeader('Set-Cookie', 'JSESSIONID=anon7; Path=/consultant')
          return res.end(loginPage)
        }
        const p = url.searchParams
        const sundayOf = (id: string) => {
          const date = [...Array(4000)].map((_, n) => addDays('2025-01-01', n)).find((d) => [0, 1].some((a) => tsId(a, d) === id))!
          return addDays(date, -new Date(date + 'T00:00').getDay())
        }
        if (p.get('action') === 'Update') {
          const id = p.get('timesheet_id')!
          updates.push(Object.fromEntries(p))
          hours.set(id, { hours: Number(p.get('hrs_worked')), desc: p.get('work_desc') ?? '' })
          return res.end(weekPage(sundayOf(id)))
        }
        if (p.get('timesheet_id')) {
          const id = p.get('timesheet_id')!
          const h = hours.get(id) ?? { hours: 0, desc: '' }
          return res.end(`${weekPage(sundayOf(id))}<form action="TPIServlet"><input type="hidden" name="revision_ts" value="rev-${id}"><input name="hrs_worked" value="${h.hours.toFixed(2)}"><textarea name="work_desc">${h.desc}</textarea></form>`)
        }
        const [mm, dd, yy] = p.get('ref')!.split('/')
        return res.end(weekPage(`20${yy}-${mm}-${dd}`))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as import('node:net').AddressInfo).port

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-cmsrepo-'))
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-cmsud-'))
    store = new DevlogStore(root)
    await store.initLayout()
    const initech = await store.createCanvas({ title: 'Initech' })
    const api = await store.createCanvas({ title: 'API work', parentId: initech.id, task: true })
    const umbrella = await store.createCanvas({ title: 'Umbrella' })
    const globex = await store.createCanvas({ title: 'Globex' })
    await store.updateCanvas(initech.id, { fields: { 'ext.builtin.devlog-cms.assignment': '90001' } })
    await store.updateCanvas(umbrella.id, { fields: { 'ext.builtin.devlog-cms.assignment': 'support' } })
    ids = { api: api.id, umbrella: umbrella.id, globex: globex.id }
    await updateManifest(root, (m) => {
      m.extensions = { 'devlog-cms': 'builtin' }
    })
    manager = new ExtensionManager({
      root,
      machine: 'desk-1a2b',
      store,
      userData,
      installer: new ExtensionInstaller({ cacheDir: path.join(userData, 'extensions'), builtinDir: path.resolve(__dirname, '../builtin-extensions'), devOverrides: async () => ({}) }),
      consent: new ConsentStore(path.join(userData, 'consent.json')),
      secrets: new SecretStore(path.join(userData, 'secrets'), fakeCipher),
      hostScript: async () => hostScript,
      notify: () => undefined,
      confirm: async () => true,
      onChange: () => undefined,
      onBlockAdded: () => undefined
    })
    await manager.load()
    await manager.allow('devlog-cms', { read: null, write: null })
    await manager.setSettings('devlog-cms', { username: 'jdoe', baseurl: `http://127.0.0.1:${port}/consultant` })
    await manager.setSecret('devlog-cms', 'password', 'hunter2')
    for (let i = 0; i < 50 && !(await manager.list())[0].destinations[0]?.ready; i++) await new Promise((r) => setTimeout(r, 20))
  })

  afterEach(async () => {
    await manager.stopAll()
    await new Promise((r) => server.close(r))
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(userData, { recursive: true, force: true })
  })

  const entry = (id: string, canvasId: string, date: string, h: number, minutes: number, note?: string) => {
    const [y, m, d] = date.split('-').map(Number)
    return { id, date, start: new Date(y, m - 1, d, h).toISOString(), minutes, canvasId, worked: minutes, source: 'tracked' as const, ...(note ? { note } : {}) }
  }

  it('logs in, lists assignments, and sends only the days that differ', async () => {
    expect(await manager.runCommand('devlog-cms', 'check')).toBe('Logged in to CMS as jdoe: 2 assignments this week')
    expect(await manager.runCommand('devlog-cms', 'assignments')).toBe('90001: Initech / Platform · 90002: Umbrella / Support')

    const entries = [
      entry('e1', ids.api, '2026-09-22', 9, 60, 'api'),
      entry('e2', ids.api, '2026-09-22', 10, 30),
      entry('e3', ids.umbrella, '2026-09-22', 11, 45),
      entry('e4', ids.umbrella, '2026-09-25', 9, 30),
      entry('e5', ids.globex, '2026-09-22', 13, 15),
      entry('e6', ids.api, '2026-09-27', 9, 450)
    ]
    await store.saveTimesheet({ week, status: 'final', entries })
    const preview = await manager.destinationPreview('devlog-cms', 'hours', week)
    expect(preview.map((l) => [l.id, l.action, l.target])).toEqual([
      ['skip:e5', 'skip', ''],
      ['90001|2026-09-22', 'create', 'Initech / Platform'],
      ['90001|2026-09-27', 'create', 'Initech / Platform'],
      ['90002|2026-09-22', 'create', 'Umbrella / Support'],
      ['90002|2026-09-25', 'skip', 'Umbrella / Support']
    ])
    expect(preview[0].reason).toMatch(/No CMS assignment/)
    expect(preview[4].reason).toMatch(/outside its dates/)
    expect(preview[1]).toMatchObject({ entryIds: ['e1', 'e2'], minutes: 90, description: '0 → 1.5 h · api' })

    logins = 0
    const first = await manager.destinationSend('devlog-cms', 'hours', week)
    expect(first).toMatchObject({ failed: [], summary: '3 days filled in (9:45 in CMS this week)' })
    expect(logins).toBe(1) // once for the whole send, across both CMS weeks
    expect(updates.map((u) => [u.timesheet_id, u.hrs_worked, u.work_desc, u.revision_ts])).toEqual([
      [tsId(0, '2026-09-22'), '1.5', 'api', `rev-${tsId(0, '2026-09-22')}`],
      [tsId(0, '2026-09-27'), '7.5', '', `rev-${tsId(0, '2026-09-27')}`],
      [tsId(1, '2026-09-22'), '0.75', 'earlier words', `rev-${tsId(1, '2026-09-22')}`]
    ])
    // The day typed into CMS by hand is left alone.
    expect(hours.get(tsId(0, '2026-09-24'))!.hours).toBe(2)

    // Nothing changed: nothing sent.
    updates = []
    expect((await manager.destinationPreview('devlog-cms', 'hours', week)).map((l) => l.action)).toEqual(['skip', 'unchanged', 'unchanged', 'unchanged', 'skip'])
    expect((await manager.destinationSend('devlog-cms', 'hours', week)).summary).toBe('nothing to change (9:45 in CMS this week)')
    expect(updates).toEqual([])

    // More on Tuesday, nothing on Sunday any more: one changed, one cleared.
    await store.saveTimesheet({ week, status: 'final', entries: [entry('e1', ids.api, '2026-09-22', 9, 60, 'api'), entry('e2', ids.api, '2026-09-22', 10, 60), entries[2]] })
    const third = await manager.destinationSend('devlog-cms', 'hours', week)
    expect(third.summary).toBe('1 changed, 1 cleared (2:45 in CMS this week)')
    expect(updates.map((u) => [u.timesheet_id, u.hrs_worked])).toEqual([
      [tsId(0, '2026-09-22'), '2'],
      [tsId(0, '2026-09-27'), '0']
    ])
    const ledger = JSON.parse(await fs.readFile(path.join(root, 'extensions/builtin.devlog-cms/sent', `${week}.json`), 'utf8'))
    expect(Object.keys(ledger).sort()).toEqual(['90001|2026-09-22', '90002|2026-09-22'])
  })

  it('waits for days CMS has not opened yet', async () => {
    const today = ymd(new Date())
    const monday = addDays(today, 7 - ((new Date().getDay() + 6) % 7))
    await store.saveTimesheet({ week: monday, status: 'final', entries: [entry('e1', ids.api, addDays(monday, 1), 9, 60)] })
    const [line] = await manager.destinationPreview('devlog-cms', 'hours', monday)
    expect(line).toMatchObject({ action: 'skip', target: 'Initech / Platform' })
    expect(line.reason).toMatch(/on the day/)
  })

  it('says when CMS turns the login down', async () => {
    await manager.setSecret('devlog-cms', 'password', 'wrong')
    await expect(manager.runCommand('devlog-cms', 'check')).rejects.toThrow(/did not accept the username and password/)
    await manager.setSecret('devlog-cms', 'password', null)
    expect((await manager.list())[0].missing).toEqual(['CMS password'])
  })
})
