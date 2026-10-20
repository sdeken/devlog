/**
 * devlog-claude: summaries of work, written by Claude.
 *
 * A panel beside the To do list: pick a canvas and a period, and Claude
 * writes up what was done there (from the notes, todos and commits written
 * on it, and the time recorded), streaming into the panel; then add it to
 * the canvas as a block. The API key is kept in this computer's keychain;
 * only what is in the period is sent, and only when you ask.
 */
import type { CommandContext, DevlogContext } from '@devlog/extension-api'
import type Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MODEL, MODELS, describeError, makeClient, summarize, type ClaudeOptions, type Effort } from './claude'
import { checkRequest, gather, summarizable, asMeta } from './gather'
import type { PanelMessage } from './messages'

export type { PanelMessage, SummaryDone } from './messages'

export const PANEL = 'claude'

let current: { run: number; abort: AbortController } | null = null
let runs = 0

export async function activate(ctx: DevlogContext): Promise<void> {
  const settings = (): Omit<ClaudeOptions, 'apiKey'> => {
    const model = ctx.settings.get('model')
    const effort = ctx.settings.get('effort')
    return {
      model: model && (MODELS as readonly string[]).includes(model) ? model : DEFAULT_MODEL,
      effort: effort === 'low' || effort === 'high' ? (effort as Effort) : 'medium',
      baseURL: ctx.settings.get('base_url')?.trim() || undefined
    }
  }
  const client = async (): Promise<{ client: Anthropic; opts: ClaudeOptions }> => {
    const apiKey = (await ctx.secrets.get('api_key'))?.trim()
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings → Extensions → Claude first.')
    const opts = { ...settings(), apiKey }
    return { client: makeClient(opts), opts }
  }
  ctx.settings.onChange(() => ctx.views.post(PANEL, { type: 'settings' } satisfies PanelMessage))

  // Open the panel on a canvas (its menu, or the quick switcher on the canvas on screen).
  ctx.commands.register('summarize', (context: CommandContext) => {
    ctx.ui.openPanel(PANEL)
    if (context.canvasId) ctx.views.post(PANEL, { type: 'select', canvasId: context.canvasId } satisfies PanelMessage)
    return null
  })
  // The settings page's Test: the key works and the model is there (no tokens spent).
  ctx.commands.register('check', async () => {
    const { client: c, opts } = await client()
    try {
      const model = await c.models.retrieve(opts.model)
      return `Connected: ${model.display_name} is available.`
    } catch (err) {
      throw new Error(describeError(err, opts.baseURL))
    }
  })

  ctx.views.handle(PANEL, async (method, args) => {
    switch (method) {
      case 'state': {
        const canvases = summarizable(await ctx.devlog.canvases())
        return { hasKey: Boolean((await ctx.secrets.get('api_key'))?.trim()), model: settings().model, canvases: asMeta(canvases) }
      }
      case 'summarize': {
        // What was written and tracked is read now (so "nothing there" comes back at once); Claude writes in the background.
        const req = checkRequest(args[0])
        const { client: c, opts } = await client()
        const got = await gather(ctx, req)
        current?.abort.abort()
        const run = ++runs
        const abort = new AbortController()
        current = { run, abort }
        const post = (m: PanelMessage): void => ctx.views.post(PANEL, m)
        void summarize(c, opts, got.text, (text) => post({ type: 'delta', run, text }), abort.signal)
          .then((result) => post({ type: 'done', run, result: { run, ...result, title: got.title, period: got.period, blocks: got.blocks, minutes: got.minutes } }))
          .catch((err: unknown) => post({ type: 'error', run, message: describeError(err, opts.baseURL) }))
          .finally(() => {
            if (current?.run === run) current = null
          })
        return { run, title: got.title, period: got.period, blocks: got.blocks, minutes: got.minutes, model: opts.model }
      }
      case 'stop':
        current?.abort.abort()
        return null
      case 'add': {
        // The summary as a block on the canvas (today), written by this extension.
        const a = (args[0] ?? {}) as { canvasId?: unknown; markdown?: unknown; from?: unknown; to?: unknown }
        if (typeof a.canvasId !== 'string' || typeof a.markdown !== 'string' || !a.markdown.trim()) throw new Error('Nothing to add')
        const meta: Record<string, string> = { summary: 'claude' }
        if (typeof a.from === 'string' && typeof a.to === 'string') Object.assign(meta, { from: a.from, to: a.to })
        const { date, block } = await ctx.devlog.addBlock(a.canvasId, a.markdown, { meta })
        return { canvasId: a.canvasId, date, blockId: block.id }
      }
      case 'open': {
        const t = (args[0] ?? {}) as { canvasId?: unknown; date?: unknown; blockId?: unknown }
        if (typeof t.canvasId === 'string') ctx.ui.open({ canvasId: t.canvasId, ...(typeof t.date === 'string' ? { date: t.date } : {}), ...(typeof t.blockId === 'string' ? { blockId: t.blockId } : {}) })
        return null
      }
      default:
        throw new Error(`No method ${method}`)
    }
  })
}

export function deactivate(): void {
  current?.abort.abort()
  current = null
}
