// A stand-in for the Anthropic Messages API, for tests and the smoke test:
// it answers POST /v1/messages with a streamed (SSE) message built from a
// script, answers GET /v1/models/<id>, and records every request it got.
import http from 'node:http'

/**
 * `reply(body)` says what to stream for a request:
 *   { text: ['Hello', ' world'] }                         a plain answer, in pieces
 *   { text: [...], refusal: 'cyber' }                     declined after the text
 *   { text: [...], fallback: 'claude-opus-4-8', then: [...] }  declined mid-way; a fallback model goes on
 *   { status: 401, error: 'invalid x-api-key' }          an API error
 */
export async function startFakeAnthropic(reply = () => ({ text: ['A summary.'] })) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, path: req.url, headers: req.headers, body })
      if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
        const id = decodeURIComponent(req.url.slice('/v1/models/'.length).split('?')[0])
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ type: 'model', id, display_name: id === 'claude-opus-5-5' ? 'Claude Opus 5.5' : id, created_at: '2026-01-01T00:00:00Z' }))
      }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.statusCode = 404
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
      }
      const plan = reply(body)
      if (plan.status) {
        res.statusCode = plan.status
        res.setHeader('content-type', 'application/json')
        return res.end(JSON.stringify({ type: 'error', error: { type: plan.status === 401 ? 'authentication_error' : 'api_error', message: plan.error ?? 'error' } }))
      }
      res.setHeader('content-type', 'text/event-stream')
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
      const model = body.model
      send('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } })
      let index = 0
      const textBlock = (pieces) => {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } })
        for (const p of pieces) send('content_block_delta', { index, delta: { type: 'text_delta', text: p } })
        send('content_block_stop', { index })
        index++
      }
      textBlock(plan.text ?? [])
      if (plan.fallback) {
        send('content_block_start', { index, content_block: { type: 'fallback', from: { model }, to: { model: plan.fallback }, trigger: { type: 'refusal', category: 'cyber' } } })
        send('content_block_stop', { index })
        index++
        textBlock(plan.then ?? [])
      }
      const refused = Boolean(plan.refusal)
      send('message_delta', {
        delta: { stop_reason: refused ? 'refusal' : 'end_turn', stop_sequence: null, ...(refused ? { stop_details: { type: 'refusal', category: plan.refusal, explanation: null } } : {}) },
        usage: { output_tokens: 42 }
      })
      send('message_stop', {})
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r))
  }
}
