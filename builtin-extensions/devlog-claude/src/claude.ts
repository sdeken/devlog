/**
 * The call to Claude: one streamed request through the official SDK, with
 * the summary's text passed on as it arrives.
 */
import Anthropic from '@anthropic-ai/sdk'

export const DEFAULT_MODEL = 'claude-opus-5-5'
/** Models offered in the settings (current generation). */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const
/** Server-side fallback on a policy decline: not available for Haiku (a declined request stays declined). */
const WITH_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])
export type Effort = 'low' | 'medium' | 'high'

/** Kept the same for every request (no dates or names in it), so it can be cached. */
export const SYSTEM = `You write summaries of work from a developer's log (Devlog). You are given the notes, todos and commits written on one canvas (a client, project or task, and the canvases inside it) over a period, and the time recorded there.

Write a summary the developer can keep in their log or send on:
- Start with two or three sentences on what the period was about.
- Then the main pieces of work, grouped by topic or sub-project, as short bullet points. Say what was done, decided or found out, not only what was touched.
- Then the open items: todos still open and loose ends the notes mention.
- Give time where the log has it (for example "about 6 h on the login work"); never invent figures.

Use Markdown: ### headings and bullet points. Be concise; no preamble and no closing remarks. Work only from the log: leave out what is unclear rather than guess. Write in the language the notes are written in.`

export interface ClaudeOptions {
  apiKey: string
  model: string
  effort: Effort
  /** Another address for the API (a gateway); empty for Anthropic's. */
  baseURL?: string
}

export interface ClaudeResult {
  text: string
  /** The model that wrote it (a fallback model, if the first declined). */
  model: string
  /** It ran out of room before finishing. */
  truncated: boolean
  inputTokens: number
  outputTokens: number
}

export function makeClient(opts: Pick<ClaudeOptions, 'apiKey' | 'baseURL'>): Anthropic {
  // The key is passed explicitly: nothing is looked up in the environment or on disk.
  return new Anthropic({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) })
}

/**
 * Ask Claude for the summary, streaming. `onText` gets the summary so far
 * (restarting from empty if the model declined mid-way and a fallback
 * model took over). A refusal is an error, not a summary.
 */
export async function summarize(client: Anthropic, opts: ClaudeOptions, log: string, onText: (text: string) => void, signal?: AbortSignal): Promise<ClaudeResult> {
  const stream = client.beta.messages.stream(
    {
      model: opts.model,
      max_tokens: 64000,
      ...(WITH_FALLBACK.has(opts.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: { effort: opts.effort },
      system: SYSTEM,
      messages: [{ role: 'user', content: `Here is the log. Summarize the work in it.\n\n${log}` }]
    },
    { signal }
  )
  let text = ''
  stream.on('streamEvent', (event) => {
    // A fallback model takes over from here: what came before is not the summary.
    if (event.type === 'content_block_start' && event.content_block.type === 'fallback') {
      text = ''
      onText(text)
    }
  })
  stream.on('text', (delta) => {
    text += delta
    onText(text)
  })
  const message = await stream.finalMessage()
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category
    throw new Error(`Claude declined to write this summary${category ? ` (${category})` : ''}.`)
  }
  // The text after the last hand-over to a fallback model.
  let start = 0
  message.content.forEach((block, i) => {
    if (block.type === 'fallback') start = i + 1
  })
  const summary = message.content
    .slice(start)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()
  return {
    text: summary,
    model: message.model,
    truncated: message.stop_reason === 'max_tokens',
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens
  }
}

/** What went wrong, in words for the panel; most specific first. */
export function describeError(err: unknown, baseURL?: string): string {
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.'
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic did not accept the API key. Check it in Settings → Extensions → Claude.'
  if (err instanceof Anthropic.PermissionDeniedError) return `That API key may not use this model: ${err.message}`
  if (err instanceof Anthropic.NotFoundError) return `Not found (is the model name right?): ${err.message}`
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate limiting this key; try again in a minute.'
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach ${baseURL || 'api.anthropic.com'}: ${err.message}`
  if (err instanceof Anthropic.APIError) return `Anthropic API error${err.status ? ` ${err.status}` : ''}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
