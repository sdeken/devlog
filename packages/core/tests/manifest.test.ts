import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DevlogStore, assertSupportedFormat, readStorageFormat } from '../src/node'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-manifest-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the storage format check', () => {
  it('accepts a new devlog, stamped at format 3', async () => {
    await new DevlogStore(root).initLayout()
    expect(await readStorageFormat(root)).toBe(3)
    await expect(assertSupportedFormat(root)).resolves.toBeUndefined()
  })

  it('refuses a devlog from before format 3 and points at Devlog 0.5', async () => {
    await fs.mkdir(path.join(root, 'canvases/acme'), { recursive: true })
    await fs.writeFile(path.join(root, 'canvases/acme/canvas.md'), '---\ntitle: Acme\n---\n')
    await new DevlogStore(root).initLayout() // never stamps a devlog that has content
    expect(await readStorageFormat(root)).toBeNull()
    await expect(assertSupportedFormat(root)).rejects.toThrow(/Devlog 0\.5/)
    await fs.writeFile(path.join(root, 'devlog.json'), '{ "format": 2 }\n')
    await expect(assertSupportedFormat(root)).rejects.toThrow(/older storage format \(2\)/)
  })

  it('refuses a devlog written by a newer Devlog', async () => {
    await fs.writeFile(path.join(root, 'devlog.json'), '{ "format": 4 }\n')
    await expect(assertSupportedFormat(root)).rejects.toThrow(/newer/)
  })
})
