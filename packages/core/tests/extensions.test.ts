import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  describeScope,
  NODE_TYPE_RE,
  nodeTypeName,
  extensionId,
  fieldProblem,
  inheritedField,
  newestMatching,
  parseCanvasFile,
  parseExtensionEntry,
  parseExtensionManifest,
  sanitizeGrant,
  satisfies,
  scopeCanvasIds,
  serializeCanvasFile,
  visibleCanvases
} from '../src/index'
import { DevlogStore, ExtensionFileStore, ensureExtensionAttributes, readLockFile, readManifest, updateManifest, writeLockFile } from '../src/node'
import type { CanvasMeta } from '../src/types'

const canvas = (id: string, parentId: string | null = null, title = id): CanvasMeta => ({
  id,
  title,
  parentId,
  task: false,
  createdAt: '',
  updatedAt: '',
  repos: [],
  archived: false,
  hasSurface: false
})

describe('extension manifests', () => {
  const good = {
    name: 'devlog-jira',
    displayName: 'Jira time export',
    version: '1.2.0',
    api: '^1.0.0',
    main: 'main.js',
    contributes: {
      canvasFields: [{ key: 'issue', label: 'Jira issue', placeholder: 'ACME-123' }],
      settings: [{ key: 'baseurl', label: 'Jira URL' }],
      secrets: [{ key: 'token', label: 'API token' }],
      commands: [{ id: 'send', label: 'Send worklogs' }],
      destinations: [{ id: 'jira', label: 'Jira worklogs' }]
    },
    permissions: { read: true, network: ['*.atlassian.net'] },
    appendOnly: ['**/*.jsonl']
  }

  it('reads a valid manifest and fills in defaults', () => {
    const m = parseExtensionManifest(good)
    expect(m).toMatchObject({ name: 'devlog-jira', api: '^1.0.0', permissions: { read: true, network: ['*.atlassian.net'] }, appendOnly: ['**/*.jsonl'] })
    expect(m.contributes.commands).toEqual([{ id: 'send', label: 'Send worklogs' }])
    expect(m.contributes.destinations).toEqual([{ id: 'jira', label: 'Jira worklogs' }])
    expect(parseExtensionManifest({ name: 'x', version: '0.1.0', api: '1.x' })).toMatchObject({ displayName: 'x', contributes: { canvasFields: [], settings: [], secrets: [], commands: [], destinations: [] }, permissions: {} })
  })

  it('lists every problem with a bad one', () => {
    expect(() => parseExtensionManifest({ name: 'Bad Name', version: 'one', api: 'whenever', main: '../escape.js', appendOnly: ['/etc/*'] })).toThrow(
      /"name".*"version".*"api".*"main".*"appendOnly"/
    )
    expect(() => parseExtensionManifest([])).toThrow(/not a JSON object/)
    expect(() => parseExtensionManifest({ ...good, contributes: { canvasFields: [{ key: 'Issue Key' }] } })).toThrow(/key/)
  })
})

describe('extension settings fields', () => {
  it('reads types, options, descriptions, required marks and the check command', () => {
    const m = parseExtensionManifest({
      name: 'x',
      version: '1.0.0',
      api: '^1.0.0',
      contributes: {
        settings: [
          { key: 'url', label: 'Address', type: 'url', required: true, description: 'Where it lives' },
          { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b' }] }
        ],
        commands: [{ id: 'check', label: 'Check' }],
        check: 'check'
      }
    })
    expect(m.contributes.settings).toEqual([
      { key: 'url', label: 'Address', type: 'url', required: true, description: 'Where it lives' },
      { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'b' }] }
    ])
    expect(m.contributes.check).toBe('check')
    expect(() => parseExtensionManifest({ name: 'x', version: '1.0.0', api: '1.x', contributes: { settings: [{ key: 'a', type: 'colour' }] } })).toThrow(/unknown type/)
    expect(() => parseExtensionManifest({ name: 'x', version: '1.0.0', api: '1.x', contributes: { settings: [{ key: 'a', type: 'select' }] } })).toThrow(/no options/)
    expect(() => parseExtensionManifest({ name: 'x', version: '1.0.0', api: '1.x', contributes: { check: 'nope' } })).toThrow(/check/)
  })

  it('reads node types', () => {
    const m = parseExtensionManifest({
      name: 'x',
      version: '1.0.0',
      api: '^1.6.0',
      contributes: { nodeTypes: [{ id: 'task', label: 'Task', icon: '◉ extra', placeholder: 'What now?' }, { id: 'plain' }] }
    })
    expect(m.contributes.nodeTypes).toEqual([
      { id: 'task', label: 'Task', icon: '◉ ', placeholder: 'What now?' },
      { id: 'plain', label: 'plain' }
    ])
    expect(nodeTypeName('builtin.x', 'task')).toBe('builtin.x/task')
    expect(NODE_TYPE_RE.test(nodeTypeName('sdeken.devlog-time', 'task'))).toBe(true)
    expect(() => parseExtensionManifest({ name: 'x', version: '1.0.0', api: '1.x', contributes: { nodeTypes: [{ id: 'Bad Id' }] } })).toThrow(/nodeTypes/)
    expect(() => parseExtensionManifest({ name: 'x', version: '1.0.0', api: '1.x', contributes: { nodeTypes: [{ id: 'a' }, { id: 'a' }] } })).toThrow(/duplicate/)
  })

  it('checks values by type', () => {
    expect(fieldProblem({ key: 'u', label: 'Address', type: 'url' }, 'https://x.example')).toBeNull()
    expect(fieldProblem({ key: 'u', label: 'Address', type: 'url' }, 'x.example')).toMatch(/https/)
    expect(fieldProblem({ key: 'u', label: 'Address', type: 'url', required: true }, '')).toMatch(/required/)
    expect(fieldProblem({ key: 'e', label: 'Email', type: 'email' }, 'me@x')).toBeNull()
    expect(fieldProblem({ key: 'e', label: 'Email', type: 'email' }, 'me')).toMatch(/email/)
    expect(fieldProblem({ key: 'n', label: 'N', type: 'number' }, '7.5')).toBeNull()
    expect(fieldProblem({ key: 's', label: 'S', type: 'select', options: [{ value: 'a', label: 'A' }] }, 'b')).toMatch(/options/)
    expect(fieldProblem({ key: 't', label: 'T' }, 'anything')).toBeNull()
  })
})

describe('extension sources and ids', () => {
  it('reads GitHub, URL and built-in entries', () => {
    expect(parseExtensionEntry('sdeken/devlog-jira', '^1.2.0')).toEqual({ kind: 'github', owner: 'sdeken', repo: 'devlog-jira', range: '^1.2.0' })
    expect(parseExtensionEntry('tools', 'https://example.com/tools.devlog-ext.zip')).toEqual({ kind: 'url', name: 'tools', url: 'https://example.com/tools.devlog-ext.zip' })
    expect(parseExtensionEntry('devlog-focus', 'builtin')).toEqual({ kind: 'builtin', name: 'devlog-focus' })
    expect(() => parseExtensionEntry('sdeken/devlog-jira', 'soon')).toThrow(/version range/)
    expect(() => parseExtensionEntry('tools', 'http://insecure.example/x.zip')).toThrow()
    expect(() => parseExtensionEntry('../x', 'builtin')).toThrow()
  })

  it('derives the id from the source, so a name cannot be borrowed', () => {
    expect(extensionId(parseExtensionEntry('SDeken/Devlog-Jira', '1.0.0'))).toBe('sdeken.devlog-jira')
    expect(extensionId(parseExtensionEntry('devlog-jira', 'https://evil.example/x.zip'))).toBe('url.devlog-jira')
    expect(extensionId(parseExtensionEntry('devlog-focus', 'builtin'))).toBe('builtin.devlog-focus')
  })

  it('matches version ranges like npm does, for the common forms', () => {
    const tags = ['v0.9.0', 'v1.0.0', 'v1.2.0', 'v1.2.5', 'v1.3.0-beta.1', 'v1.3.0', 'v2.0.0', 'nightly']
    expect(newestMatching(tags, '^1.2.0')).toBe('v1.3.0')
    expect(newestMatching(tags, '~1.2.0')).toBe('v1.2.5')
    expect(newestMatching(tags, '1.2.x')).toBe('v1.2.5')
    expect(newestMatching(tags, '1.x')).toBe('v1.3.0')
    expect(newestMatching(tags, '*')).toBe('v2.0.0')
    expect(newestMatching(tags, 'latest')).toBe('v2.0.0')
    expect(newestMatching(tags, '1.3.0-beta.1')).toBe('v1.3.0-beta.1')
    expect(newestMatching(tags, '^3.0.0')).toBeNull()
    expect(satisfies('0.2.3', '^0.2.0')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false)
    expect(satisfies('1.0.0', '^1.0.0')).toBe(true)
  })
})

describe('grants', () => {
  const all = [canvas('acme', null, 'Acme'), canvas('web', 'acme', 'Web'), canvas('fix', 'web', 'Fix'), canvas('globex', null, 'Globex')]

  it('covers a chosen canvas and everything beneath it', () => {
    expect([...scopeCanvasIds(all, { canvases: ['web'] })].sort()).toEqual(['fix', 'web'])
    expect([...scopeCanvasIds(all, { all: true })].sort()).toEqual(['acme', 'fix', 'globex', 'journal', 'web'])
    expect([...scopeCanvasIds(all, { canvases: ['gone', 'journal'] })]).toEqual(['journal'])
    expect(scopeCanvasIds(all, null).size).toBe(0)
  })

  it('shows granted canvases and the ancestors needed to name them, nothing else', () => {
    expect(visibleCanvases(all, { read: { canvases: ['fix'] }, write: null }).map((c) => c.id)).toEqual(['acme', 'web', 'fix'])
    expect(visibleCanvases(all, { read: null, write: null })).toEqual([])
    expect(describeScope(all, { canvases: ['web', 'globex'] })).toBe('Web, Globex')
    expect(describeScope(all, { all: true })).toBe('the whole devlog')
  })

  it('sanitises stored grants', () => {
    expect(sanitizeGrant({ read: { all: true }, write: { canvases: ['a', 3] }, trusted: 'yes' })).toEqual({ read: { all: true }, write: { canvases: ['a'] } })
    expect(sanitizeGrant({ read: null, write: null, trusted: true })).toEqual({ read: null, write: null, trusted: true })
    expect(sanitizeGrant(null)).toEqual({ read: null, write: null })
  })
})

describe('canvas fields', () => {
  it('keeps unknown front-matter keys and writes them back', () => {
    const text = '---\ntitle: Acme\ncreated: t\next.sdeken.devlog-jira.issue: ACME-123\next.url.cms.client: "7731"\n---\n\nSurface\n'
    const { meta, surface } = parseCanvasFile('acme', text)
    expect(meta.fields).toEqual({ 'ext.sdeken.devlog-jira.issue': 'ACME-123', 'ext.url.cms.client': '7731' })
    const again = serializeCanvasFile(meta, surface)
    expect(again).toContain('ext.sdeken.devlog-jira.issue: ACME-123')
    expect(parseCanvasFile('acme', again).meta.fields).toEqual(meta.fields)
  })

  it('inherits a field from the nearest ancestor that sets it', () => {
    const list = [{ ...canvas('acme'), fields: { 'ext.x.client': '1' } }, { ...canvas('web', 'acme'), fields: { 'ext.x.client': '2' } }, canvas('fix', 'web'), canvas('other')]
    expect(inheritedField(list, 'fix', 'ext.x.client')).toEqual({ value: '2', from: 'web' })
    expect(inheritedField(list, 'acme', 'ext.x.client')).toEqual({ value: '1', from: 'acme' })
    expect(inheritedField(list, 'other', 'ext.x.client')).toBeNull()
  })
})

describe('on disk', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-ext-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('sets and clears canvas fields through the store', async () => {
    const store = new DevlogStore(root)
    await store.initLayout()
    const c = await store.createCanvas({ title: 'Acme' })
    await store.updateCanvas(c.id, { fields: { 'ext.sdeken.devlog-jira.issue': 'ACME-1' } })
    expect((await store.readCanvas(c.id)).fields).toEqual({ 'ext.sdeken.devlog-jira.issue': 'ACME-1' })
    await store.updateCanvas(c.id, { title: 'Acme Corp' })
    expect((await store.readCanvas(c.id)).fields).toEqual({ 'ext.sdeken.devlog-jira.issue': 'ACME-1' })
    await store.updateCanvas(c.id, { fields: { 'ext.sdeken.devlog-jira.issue': null } })
    expect((await store.readCanvas(c.id)).fields).toBeUndefined()
    await expect(store.updateCanvas(c.id, { fields: { title: 'x' } })).rejects.toThrow(/field/)
  })

  it('updates devlog.json without losing other keys, and keeps a sorted lockfile', async () => {
    await fs.writeFile(path.join(root, 'devlog.json'), '{ "format": 3, "note": "keep me" }\n')
    await Promise.all([
      updateManifest(root, (m) => {
        m.extensions = { ...(m.extensions ?? {}), 'sdeken/devlog-jira': '^1.0.0' }
      }),
      updateManifest(root, (m) => {
        m.settings = { 'sdeken.devlog-jira': { baseurl: 'https://acme.atlassian.net' } }
      })
    ])
    expect(await readManifest(root)).toEqual({
      format: 3,
      note: 'keep me',
      extensions: { 'sdeken/devlog-jira': '^1.0.0' },
      settings: { 'sdeken.devlog-jira': { baseurl: 'https://acme.atlassian.net' } }
    })
    expect(await readLockFile(root)).toEqual({ lockfileVersion: 1, extensions: {} })
    const entry = { id: 'x', spec: '1.0.0', version: '1.0.0', url: 'u', sha256: 'h' }
    await writeLockFile(root, { lockfileVersion: 1, extensions: { zed: entry, alpha: entry } })
    expect(Object.keys((await readLockFile(root)).extensions)).toEqual(['alpha', 'zed'])
  })

  it('union-merges an extension’s append-only files', async () => {
    await ensureExtensionAttributes(root, 'builtin.devlog-focus', ['**/*.jsonl'])
    await ensureExtensionAttributes(root, 'builtin.devlog-focus', ['**/*.jsonl'])
    const attrs = await fs.readFile(path.join(root, '.gitattributes'), 'utf8')
    expect(attrs.match(/extensions\/builtin\.devlog-focus\/\*\*\/\*\.jsonl merge=union/g)).toHaveLength(1)
  })

  describe('the extension file broker', () => {
    const files = (limits = {}): ExtensionFileStore => new ExtensionFileStore(path.join(root, 'extensions', 'a.b'), { anchor: root, ...limits })

    it('reads, writes, appends, lists and removes inside its folder', async () => {
      const f = files()
      expect(await f.readText('state.json')).toBeUndefined()
      await f.write('state.json', '{"n":1}')
      await f.append('logs/2026/09/2026-09-26.jsonl', '{"a":1}\n')
      await f.append('logs/2026/09/2026-09-26.jsonl', '{"a":2}\n')
      expect(await f.readText('state.json')).toBe('{"n":1}')
      expect(await f.readText('logs/2026/09/2026-09-26.jsonl')).toBe('{"a":1}\n{"a":2}\n')
      expect((await f.list()).map((x) => x.path)).toEqual(['logs/2026/09/2026-09-26.jsonl', 'state.json'])
      expect((await f.list('logs')).map((x) => x.path)).toEqual(['logs/2026/09/2026-09-26.jsonl'])
      await f.remove('state.json')
      expect(await f.stat('state.json')).toBeUndefined()
    })

    it('refuses every way out of the folder', async () => {
      const f = files()
      for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\..\\x', 'con', 'nul.txt', 'x:stream', 'trailing.', '', '.', 'a//b']) {
        await expect(f.write(bad, 'x'), bad).rejects.toThrow()
      }
      await expect(f.read('../../devlog.json')).rejects.toThrow()
      expect((await fs.readdir(root)).filter((n) => n !== 'extensions')).toEqual([])
    })

    it('does not follow links, including a linked folder committed to git', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-outside-'))
      try {
        await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
        const f = files()
        await f.write('ok.txt', 'ok')
        await fs.symlink(outside, path.join(root, 'extensions', 'a.b', 'link'))
        await expect(f.read('link/secret.txt')).rejects.toThrow(/Links/)
        await expect(f.write('link/new.txt', 'x')).rejects.toThrow(/Links/)
        expect((await f.list()).map((x) => x.path)).toEqual(['ok.txt'])

        // The extensions/ folder itself arrives as a link.
        await fs.rm(path.join(root, 'extensions'), { recursive: true })
        await fs.symlink(outside, path.join(root, 'extensions'))
        await expect(files().read('secret.txt')).rejects.toThrow(/Links/)
      } finally {
        await fs.rm(outside, { recursive: true, force: true })
      }
    })

    it('caps file and folder sizes', async () => {
      const f = files({ maxFileBytes: 10, maxTotalBytes: 25, maxFiles: 3 })
      await expect(f.write('big', 'x'.repeat(11))).rejects.toThrow(/too large/)
      await f.write('a', 'x'.repeat(10))
      await f.write('b', 'x'.repeat(10))
      await expect(f.write('c', 'x'.repeat(10))).rejects.toThrow(/full/)
      await f.write('a', 'x'.repeat(5)) // replacing frees room
      await f.write('c', 'x'.repeat(10))
      await expect(f.write('d', '')).rejects.toThrow(/Too many/)
      await expect(f.append('a', 'x'.repeat(6))).rejects.toThrow(/too large/)
    })
  })
})
