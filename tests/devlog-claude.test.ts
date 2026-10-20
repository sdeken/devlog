import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestContext, type TestCanvas } from '@devlog/extension-api/testing'
import type { ActivityRecord, ExtensionBlock } from '@devlog/extension-api'
import * as claude from '../builtin-extensions/devlog-claude/src/main'
import { SYSTEM } from '../builtin-extensions/devlog-claude/src/claude'
import { checkRequest, gather } from '../builtin-extensions/devlog-claude/src/gather'
import type { PanelMessage, SummaryDone } from '../builtin-extensions/devlog-claude/src/messages'
import { startFakeAnthropic } from '../scripts/fake-anthropic.mjs'

const ID = 'builtin.devlog-claude'
const at = (day: number, h: number, m = 0): string => new Date(2026, 9, day, h, m).toISOString()
const block = (id: string, createdAt: string, markdown: string, extra: Partial<ExtensionBlock> = {}): ExtensionBlock => ({ id, createdAt, markdown, ...extra })

/** Acme (a client) → Website (a project) → Fix login (a task); Globex beside them. */
function canvases(): TestCanvas[] {
  return [
    { id: 'acme', title: 'Acme', parentId: null, task: false, archived: false, fields: {}, days: { '2026-10-13': [block('a1', at(13, 9), 'Kick-off call with Dana: scope is the login flow and the CDN.')] } },
    {
      id: 'web',
      title: 'Website',
      parentId: 'acme',
      task: false,
      archived: false,
      fields: {},
      days: {
        '2026-10-06': [block('old', at(6, 10), 'Last week: nothing to do with this one.'), block('t0', at(6, 11), 'Renew the staging certificate', { kind: 'todo', meta: { done: at(14, 16) } })],
        '2026-10-14': [block('w1', at(14, 10), 'Found the redirect loop: the cookie domain was wrong.\nFixed it on staging.'), block('w2', at(14, 11), 'Deploy notes', { parentId: 'w1' }), block('c1', at(14, 12), 'Fix cookie domain', { kind: 'commit', meta: { branch: 'fix/login', repo: 'C:\\src\\acme-site' } })]
      }
    },
    { id: 'fix', title: 'Fix login', parentId: 'web', task: true, archived: false, fields: {}, days: { '2026-10-15': [block('f1', at(15, 9), 'Ask Priya about the SSO copy', { kind: 'todo' })] } },
    { id: 'globex', title: 'Globex', parentId: null, task: false, archived: false, fields: {}, days: { '2026-10-14': [block('g1', at(14, 9), 'Globex work, not Acme.')] } },
    { id: 'sheets', title: 'Timesheets', parentId: null, task: false, archived: false, fields: { 'devlog.managed': 'timesheets' } }
  ]
}

/** Two hours on Fix login on the 15th, from the clock; the clock ran (with no task) on the 13th and 14th. */
const activity: ActivityRecord[] = [
  { t: at(13, 8), type: 'start', canvasId: null, machine: 'm' },
  { t: at(14, 8), type: 'start', canvasId: null, machine: 'm' },
  { t: at(15, 9), type: 'start', canvasId: 'fix', machine: 'm' },
  ...Array.from({ length: 23 }, (_, i) => ({ t: new Date(Date.parse(at(15, 9)) + (i + 1) * 5 * 60_000).toISOString(), type: 'heartbeat' as const, machine: 'm' })),
  { t: at(15, 11), type: 'stop', machine: 'm' }
]

function setup(opts: { secrets?: Record<string, string>; settings?: Record<string, string> } = {}) {
  return createTestContext({ id: ID, canvases: canvases(), activity, secrets: opts.secrets ?? { api_key: 'sk-ant-test' }, settings: opts.settings, read: 'all', write: 'all' })
}

/** The panel's messages for one run, once it is done or failed. */
async function finished(t: ReturnType<typeof setup>, run: number): Promise<PanelMessage[]> {
  for (let i = 0; i < 200; i++) {
    const msgs = (t.viewMessages.get(claude.PANEL) ?? []) as PanelMessage[]
    const mine = msgs.filter((m) => 'run' in m && m.run === run)
    if (mine.some((m) => m.type === 'done' || m.type === 'error')) return mine
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('the summary never finished')
}

describe('what a summary is written from', () => {
  it('takes the canvas and what is inside it, in the period, with the time recorded', async () => {
    const t = setup()
    const got = await gather(t.ctx, { canvasId: 'acme', from: '2026-10-12', to: '2026-10-18', inside: true })
    expect(got).toMatchObject({ title: 'Acme', blocks: 6, minutes: 120 })
    expect(got.text).toContain('Canvas: Acme (and the canvases inside it)')
    expect(got.text).toContain('Period: 12 Oct – 18 Oct 2026 (2026-10-12 to 2026-10-18)')
    expect(got.text).toContain('Time recorded: 2:00 in all; Acme / Website / Fix login 2:00')
    expect(got.text).toContain('## Acme / Website')
    expect(got.text).toContain('Found the redirect loop: the cookie domain was wrong.\n  Fixed it on staging.')
    expect(got.text).toMatch(/inside "Found the redirect loop/)
    expect(got.text).toMatch(/commit on fix\/login in acme-site\] Fix cookie domain/)
    expect(got.text).toMatch(/todo, done 2026-10-14\] Renew the staging certificate/)
    expect(got.text).toMatch(/todo, open\] Ask Priya/)
    expect(got.text).not.toContain('Last week')
    expect(got.text).not.toContain('Globex')
  })

  it('takes only the canvas itself when asked, and says when there is nothing', async () => {
    const t = setup()
    const only = await gather(t.ctx, { canvasId: 'acme', from: '2026-10-12', to: '2026-10-18', inside: false })
    expect(only).toMatchObject({ blocks: 1, minutes: 0 })
    await expect(gather(t.ctx, { canvasId: 'globex', from: '2026-09-01', to: '2026-09-07', inside: true })).rejects.toThrow(/Nothing was written or tracked on Globex/)
  })

  it('says how much time is estimated from the notes, on days with no tracking', async () => {
    const t = createTestContext({ id: ID, canvases: canvases(), activity: [], read: 'all' })
    const got = await gather(t.ctx, { canvasId: 'globex', from: '2026-10-14', to: '2026-10-14', inside: true })
    expect(got.minutes).toBeGreaterThan(0)
    expect(got.text).toMatch(/of it estimated from the notes, on days with no time tracked\)/)
  })

  it('checks the request', () => {
    expect(() => checkRequest({ canvasId: 'acme', from: '2026-10-18', to: '2026-10-12' })).toThrow(/ends before/)
    expect(() => checkRequest({ canvasId: '', from: '2026-10-12', to: '2026-10-18' })).toThrow(/canvas/)
    expect(() => checkRequest({ canvasId: 'acme', from: '2020-01-01', to: '2026-10-18' })).toThrow(/at most/)
    expect(checkRequest({ canvasId: 'acme', from: '2026-10-12', to: '2026-10-18' }).inside).toBe(true)
  })
})

describe('devlog-claude', () => {
  let api: Awaited<ReturnType<typeof startFakeAnthropic>>
  let reply: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ text: ['### The week\n', 'Fixed the login redirect.'] })
  beforeEach(async () => {
    api = await startFakeAnthropic((body: Record<string, unknown>) => reply(body))
  })
  afterEach(async () => {
    claude.deactivate()
    await api.close()
  })
  const start = async (opts: { settings?: Record<string, string>; secrets?: Record<string, string> } = {}) => {
    const t = setup({ ...opts, settings: { base_url: api.url, ...opts.settings } })
    await claude.activate(t.ctx)
    return t
  }
  const summarize = (t: ReturnType<typeof setup>) => t.viewCall(claude.PANEL, 'summarize', { canvasId: 'acme', from: '2026-10-12', to: '2026-10-18', inside: true }) as Promise<{ run: number; blocks: number }>

  it('streams a summary from Claude Opus 5.5, with fallbacks on, into the panel', async () => {
    const t = await start()
    const state = (await t.viewCall(claude.PANEL, 'state')) as { hasKey: boolean; model: string; canvases: Array<{ id: string }> }
    expect(state).toMatchObject({ hasKey: true, model: 'claude-opus-5-5' })
    expect(state.canvases.map((c) => c.id)).not.toContain('sheets')

    const { run, blocks } = await summarize(t)
    expect(blocks).toBe(6)
    const msgs = await finished(t, run)
    expect(msgs.filter((m) => m.type === 'delta').map((m) => (m as { text: string }).text)).toEqual(['### The week\n', '### The week\nFixed the login redirect.'])
    const done = msgs.find((m) => m.type === 'done') as { result: SummaryDone }
    expect(done.result).toMatchObject({ text: '### The week\nFixed the login redirect.', model: 'claude-opus-5-5', truncated: false, title: 'Acme', minutes: 120 })

    const req = api.requests.find((r) => r.path.startsWith('/v1/messages'))!
    expect(req.headers['x-api-key']).toBe('sk-ant-test')
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(req.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', output_config: { effort: 'medium' }, system: SYSTEM, max_tokens: 64000 })
    expect(req.body.thinking).toBeUndefined()
    const sent = (req.body.messages as Array<{ content: string }>)[0].content
    expect(sent).toContain('Found the redirect loop')
    expect(sent).not.toContain('Globex')
  })

  it('uses the model and effort chosen in its settings (Haiku has no server-side fallback)', async () => {
    const t = await start({ settings: { model: 'claude-haiku-5-5', effort: 'high' } })
    await finished(t, (await summarize(t)).run)
    const req = api.requests.find((r) => r.path.startsWith('/v1/messages'))!
    expect(req.body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'high' } })
    expect(req.body.fallbacks).toBeUndefined()
    expect(req.headers['anthropic-beta']).toBeUndefined()
  })

  it('starts again from the fallback model when the first one declines mid-way', async () => {
    reply = () => ({ text: ['Half a sentence fr'], fallback: 'claude-opus-4-8', then: ['The whole summary.'] })
    const t = await start()
    const msgs = await finished(t, (await summarize(t)).run)
    const texts = msgs.filter((m) => m.type === 'delta').map((m) => (m as { text: string }).text)
    expect(texts).toEqual(['Half a sentence fr', '', 'The whole summary.'])
    expect((msgs.find((m) => m.type === 'done') as { result: SummaryDone }).result.text).toBe('The whole summary.')
  })

  it('says so when Claude declines, when the key is wrong, and when there is no key', async () => {
    reply = () => ({ text: [], refusal: 'cyber' })
    const t = await start()
    let msgs = await finished(t, (await summarize(t)).run)
    expect(msgs.find((m) => m.type === 'error')).toMatchObject({ message: 'Claude declined to write this summary (cyber).' })

    reply = () => ({ status: 401, error: 'invalid x-api-key' })
    msgs = await finished(t, (await summarize(t)).run)
    expect((msgs.find((m) => m.type === 'error') as { message: string }).message).toMatch(/did not accept the API key/)

    const none = await start({ secrets: {} })
    expect(await none.viewCall(claude.PANEL, 'state')).toMatchObject({ hasKey: false })
    await expect(summarize(none)).rejects.toThrow(/Add your Anthropic API key/)
  })

  it('adds the summary to the canvas as a block, and opens it', async () => {
    const t = await start()
    const added = (await t.viewCall(claude.PANEL, 'add', { canvasId: 'acme', markdown: '### Summary\n\nDone.', from: '2026-10-12', to: '2026-10-18' })) as { canvasId: string; date: string; blockId: string }
    expect(t.added).toEqual([expect.objectContaining({ canvasId: 'acme', block: expect.objectContaining({ markdown: '### Summary\n\nDone.', meta: expect.objectContaining({ summary: 'claude', from: '2026-10-12', to: '2026-10-18' }) }) })])
    await t.viewCall(claude.PANEL, 'open', added)
    expect(t.opened).toEqual([{ canvasId: 'acme', date: added.date, blockId: added.blockId }])
    await expect(t.viewCall(claude.PANEL, 'add', { canvasId: 'acme', markdown: '  ' })).rejects.toThrow(/Nothing to add/)
  })

  it('opens its panel on a canvas from the command, and checks the connection', async () => {
    const t = await start()
    await t.run('summarize', { source: 'menu', canvasId: 'web' })
    expect(t.openedPanels).toEqual(['claude'])
    expect(t.viewMessages.get(claude.PANEL)).toContainEqual({ type: 'select', canvasId: 'web' })
    expect(await t.run('check')).toBe('Connected: Claude Opus 5.5 is available.')
    expect(api.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models/claude-opus-5-5' })
  })
})
