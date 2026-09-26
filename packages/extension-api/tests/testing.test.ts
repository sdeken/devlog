import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExtensionModule } from '../src/index'
import { createTestContext } from '../src/testing'

// The probe fixture is the same bundle the app's own tests run in the sandbox.
const probe = createRequire(import.meta.url)(path.resolve(__dirname, '../../../tests/fixtures/extensions/probe/main.js')) as ExtensionModule

describe('the test harness', () => {
  it('runs an extension against an in-memory devlog', async () => {
    const t = createTestContext({
      id: 'builtin.probe',
      settings: { greeting: 'Hi' },
      canvases: [
        { id: 'acme', title: 'Acme', parentId: null, task: false, archived: false, fields: { code: 'ACME-1' } },
        { id: 'web', title: 'Web', parentId: 'acme', task: false, archived: false, fields: {}, days: { '2026-09-26': [{ id: 'a', createdAt: 't', markdown: 'a needle' }] } },
        { id: 'globex', title: 'Globex', parentId: null, task: false, archived: false, fields: {} }
      ],
      read: ['acme'],
      write: ['web']
    })
    await probe.activate(t.ctx)
    expect(t.commands()).toEqual(['hello', 'probe'])
    await t.run('hello')
    await t.run('hello')
    expect(t.notifications).toEqual(['Hi #1', 'Hi #2'])
    expect(new TextDecoder().decode(t.files.repo.get('log/hello.jsonl'))).toBe('{"n":1}\n{"n":2}\n')
    await t.run('probe')
    const report = JSON.parse(new TextDecoder().decode(t.files.repo.get('probe.json')))
    expect(report.canvases.map((c: { id: string }) => c.id)).toEqual(['acme', 'web'])
    expect(report['field:Web']).toBe('ACME-1')
    expect(report['add:Acme'].ok).toBe(false)
    expect(report['add:Web']).toEqual({ ok: true, value: { ext: 'builtin.probe', probe: '1' } })
    expect(report.search).toEqual(['web'])
    expect(report.escapeFiles.ok).toBe(false)
  })

  it('delivers notices and settings changes', async () => {
    const t = createTestContext()
    const seen: string[] = []
    t.ctx.activity.on((n) => seen.push(n.type))
    t.ctx.settings.onChange((s) => seen.push(`settings:${s.a}`))
    t.notice({ t: 'x', type: 'pause', reason: 'locked' })
    t.setSettings({ a: '1' })
    expect(seen).toEqual(['pause', 'settings:1'])
    expect(t.ctx.settings.get('a')).toBe('1')
  })
})
