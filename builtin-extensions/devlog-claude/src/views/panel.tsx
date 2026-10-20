/**
 * The Claude tab of the side panel: a canvas (the one on screen, unless you
 * pick another), a period, and Summarize; the summary streams in, then can
 * be added to the canvas as a block.
 */
import '@devlog/ui/styles.css'
import './panel.css'
import { useEffect, useMemo, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { buildCanvasTree, canvasLabel, flattenTree, localDate, type CanvasMeta } from '@devlog/core'
import { Button, Empty, Field, Row, devlog, mount, useCall, useMessages, useViewContext } from '@devlog/ui'
import { addDays, weekStart } from '@shared/review'
import type { PanelMessage, SummaryDone } from '../messages'

interface State {
  hasKey: boolean
  model: string
  canvases: CanvasMeta[]
}

type Preset = 'today' | 'week' | 'lastweek' | 'month' | 'lastmonth' | 'custom'
const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'lastweek', label: 'Last week' },
  { id: 'month', label: 'This month' },
  { id: 'lastmonth', label: 'Last month' },
  { id: 'custom', label: 'Dates…' }
]

/** The dates a preset covers, from today (local). */
export function presetRange(preset: Exclude<Preset, 'custom'>, today: string): { from: string; to: string } {
  const monthStart = `${today.slice(0, 7)}-01`
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'week':
      return { from: weekStart(today), to: today }
    case 'lastweek': {
      const from = addDays(weekStart(today), -7)
      return { from, to: addDays(from, 6) }
    }
    case 'month':
      return { from: monthStart, to: today }
    case 'lastmonth': {
      const to = addDays(monthStart, -1)
      return { from: `${to.slice(0, 7)}-01`, to }
    }
  }
}

const render = (md: string): string => DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: false }) as string, { USE_PROFILES: { html: true } })
const hm = (m: number): string => `${Math.floor(Math.round(m) / 60)}:${String(Math.round(m) % 60).padStart(2, '0')}`

function Panel(): React.JSX.Element {
  const state = useCall<State>('state')
  const context = useViewContext()
  const today = localDate(new Date())
  /** A canvas you picked here; until then, the one on screen. */
  const [picked, setPicked] = useState<string | null>(null)
  const [preset, setPreset] = useState<Preset>('week')
  const [custom, setCustom] = useState(() => ({ from: weekStart(today), to: today }))
  const [inside, setInside] = useState(true)
  const [run, setRun] = useState<{ run: number; title: string; period: string; blocks: number; minutes: number; from: string; to: string; canvasId: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [text, setText] = useState('')
  const [done, setDone] = useState<SummaryDone | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<{ canvasId: string; date: string; blockId: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const canvases = useMemo(() => state.data?.canvases ?? [], [state.data])
  const tree = useMemo(() => flattenTree(buildCanvasTree(canvases)), [canvases])
  const onScreen = context.canvasId && canvases.some((c) => c.id === context.canvasId) ? context.canvasId : null
  const canvasId = picked ?? onScreen ?? ''
  const range = preset === 'custom' ? custom : presetRange(preset, today)

  useMessages((data) => {
    const m = data as PanelMessage
    if (m.type === 'select') {
      setPicked(m.canvasId)
      return
    }
    if (m.type === 'settings') return state.reload()
    if (!run || m.run !== run.run) return
    if (m.type === 'delta') setText(m.text)
    else if (m.type === 'done') {
      setText(m.result.text)
      setDone(m.result)
      setRunning(false)
    } else if (m.type === 'error') {
      setError(m.message)
      setRunning(false)
    }
  })
  // The key may have been added in Settings meanwhile.
  useEffect(() => {
    const t = setInterval(() => !state.data?.hasKey && state.reload(), 4000)
    return () => clearInterval(t)
  }, [state])

  const start = async (): Promise<void> => {
    setError(null)
    setDone(null)
    setAdded(null)
    setText('')
    setRunning(true)
    try {
      const r = await devlog.call<{ run: number; title: string; period: string; blocks: number; minutes: number }>('summarize', { canvasId, from: range.from, to: range.to, inside })
      setRun({ ...r, from: range.from, to: range.to, canvasId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRunning(false)
    }
  }
  const add = async (): Promise<void> => {
    if (!done || !run) return
    const markdown = `### Summary: ${run.title}, ${run.period}\n\n${done.text}\n\n*Written by Claude from ${run.blocks} block${run.blocks === 1 ? '' : 's'}${run.minutes ? ` and ${hm(run.minutes)} recorded` : ''}.*`
    try {
      setAdded(await devlog.call('add', { canvasId: run.canvasId, markdown, from: run.from, to: run.to }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const copy = async (): Promise<void> => {
    if (!done) return
    try {
      await navigator.clipboard.writeText(done.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Copying is not allowed here: select the text and copy it instead.')
    }
  }

  if (state.loading && !state.data) return <Empty>Loading…</Empty>
  if (state.error) return <p className="dl-error">{state.error}</p>
  if (!state.data?.hasKey) {
    return (
      <div className="cl-panel">
        <h3 className="cl-title">Summaries by Claude</h3>
        <p>Add your Anthropic API key in Settings → Extensions → Claude to start.</p>
        <p className="dl-muted">It is kept in this computer&apos;s keychain, never in the devlog.</p>
      </div>
    )
  }

  return (
    <div className="cl-panel">
      <div className="cl-form">
        <Field label="Summarize">
          <select className="dl-input" value={canvasId} onChange={(ev) => setPicked(ev.target.value || null)} aria-label="Canvas">
            {!canvasId && <option value="">Choose a canvas…</option>}
            {tree.map(({ canvas: c, depth }) => (
              <option key={c.id} value={c.id}>
                {' '.repeat(depth * 2)}
                {c.title}
              </option>
            ))}
          </select>
        </Field>
        <label className="cl-check">
          <input type="checkbox" checked={inside} onChange={(ev) => setInside(ev.target.checked)} /> and the canvases inside it
        </label>
        <Field label="Period">
          <select className="dl-input" value={preset} onChange={(ev) => setPreset(ev.target.value as Preset)} aria-label="Period">
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        {preset === 'custom' && (
          <Row className="cl-dates">
            <input className="dl-input" type="date" value={custom.from} max={custom.to} aria-label="From" onChange={(ev) => ev.target.value && setCustom((c) => ({ ...c, from: ev.target.value }))} />
            <span>to</span>
            <input className="dl-input" type="date" value={custom.to} min={custom.from} aria-label="To" onChange={(ev) => ev.target.value && setCustom((c) => ({ ...c, to: ev.target.value }))} />
          </Row>
        )}
        <Row>
          <Button variant="primary" className="cl-go" disabled={!canvasId || running} onClick={() => void start()}>
            {running ? 'Writing…' : 'Summarize'}
          </Button>
          {running && (
            <Button variant="quiet" onClick={() => void devlog.call('stop')}>
              Stop
            </Button>
          )}
        </Row>
        <p className="dl-muted cl-note">Sends the notes, todos and commits in this period to Anthropic ({state.data.model}).</p>
      </div>

      {error && <p className="dl-error cl-error">{error}</p>}
      {run && (text || running) && (
        <section className="cl-result">
          <div className="cl-meta dl-muted">
            {run.title} · {run.period} · {run.blocks} block{run.blocks === 1 ? '' : 's'}
            {run.minutes ? ` · ${hm(run.minutes)} recorded` : ''}
          </div>
          {text ? <div className="cl-summary markdown-body" dangerouslySetInnerHTML={{ __html: render(text) }} /> : <p className="dl-muted">Claude is reading…</p>}
          {done && (
            <>
              {done.truncated && <p className="dl-error">The summary ran out of room before it finished.</p>}
              <Row className="cl-actions">
                {added ? (
                  <>
                    <span className="cl-added">Added to {canvasLabel(canvases, added.canvasId)}.</span>
                    <Button small variant="quiet" onClick={() => void devlog.call('open', added)}>
                      Open
                    </Button>
                  </>
                ) : (
                  <Button small className="cl-add" onClick={() => void add()} title="Post the summary on the canvas, as a block">
                    Add to {canvasLabel(canvases, run.canvasId).split(' / ').pop()}
                  </Button>
                )}
                <Button small variant="quiet" onClick={() => void copy()}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </Row>
            </>
          )}
        </section>
      )}
    </div>
  )
}

mount(<Panel />)
