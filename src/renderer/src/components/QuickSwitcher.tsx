import { useEffect, useMemo, useRef, useState } from 'react'
import { buildCanvasTree, canvasLabel, flattenTree } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import type { ExtensionInfo } from '@shared/extensions'
import type { PickItem } from '@devlog/extension-api'
import { typeOf, useNodeTypes } from '@renderer/nodeTypes'

export type SwitchTarget =
  | { kind: 'canvas'; canvasId: string }
  | { kind: 'view'; view: 'review' | 'timeline' | 'summary' | 'timesheet' }
  | { kind: 'settings'; page?: string }
  | { kind: 'block'; canvasId: string; date: string; id: string }
  | { kind: 'command'; extension: string; command: string }

interface Props {
  canvases: CanvasMeta[]
  /** Running extensions contribute their commands. */
  extensions?: ExtensionInfo[]
  /** Block pages opened lately, newest first. */
  recentPages?: Array<{ canvasId: string; date: string; id: string; title: string }>
  /** Offer the time views (Summary, Timesheet): an extension tracks time. */
  timeViews?: boolean
  /** The node type of the canvas on screen: commands for another type are left out. */
  canvasType?: string
  onPick: (target: SwitchTarget) => void
  onClose: () => void
}

interface Item {
  key: string
  label: string
  hint: string
  target: SwitchTarget
  /** Listed first when nothing is typed yet (recent pages, newest first). */
  recent?: number
}

function score(query: string, label: string): number {
  const q = query.toLowerCase()
  const l = label.toLowerCase()
  if (!q) return 1
  if (l.startsWith(q)) return 3
  if (l.includes(q)) return 2
  // subsequence match
  let i = 0
  for (const ch of l) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

export function QuickSwitcher({ canvases, extensions = [], recentPages = [], timeViews = true, canvasType, onPick, onClose }: Props): React.JSX.Element {
  const types = useNodeTypes()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      ...(timeViews ? [{ key: 'view:summary', label: 'Summary', hint: 'view', target: { kind: 'view', view: 'summary' } } as Item] : []),
      { key: 'view:review', label: 'Weekly review', hint: 'view', target: { kind: 'view', view: 'review' } },
      { key: 'view:timeline', label: 'Timeline', hint: 'view', target: { kind: 'view', view: 'timeline' } },
      ...(timeViews ? [{ key: 'view:timesheet', label: 'Timesheet', hint: 'view', target: { kind: 'view', view: 'timesheet' } } as Item] : []),
      { key: 'settings', label: 'Settings', hint: 'settings', target: { kind: 'settings' } },
      { key: 'extensions', label: 'Extensions', hint: 'settings', target: { kind: 'settings', page: 'extensions' } }
    ]
    recentPages.forEach((p, i) => {
      if (!canvases.some((c) => c.id === p.canvasId)) return
      out.push({
        key: `page:${p.canvasId}/${p.date}/${p.id}`,
        label: `${canvasLabel(canvases, p.canvasId)} / ${p.title}`,
        hint: 'page',
        target: { kind: 'block', canvasId: p.canvasId, date: p.date, id: p.id },
        recent: recentPages.length - i
      })
    })
    for (const e of extensions) {
      for (const c of e.commands) {
        // Note-box commands post first; commands for a node type show on canvases of that type.
        if (c.post || (c.nodeType && c.nodeType !== canvasType)) continue
        if (e.state === 'running' && c.ready) out.push({ key: `cmd:${e.key}:${c.id}`, label: `${e.displayName}: ${c.label}`, hint: 'command', target: { kind: 'command', extension: e.key, command: c.id } })
      }
    }
    for (const { canvas: c } of flattenTree(buildCanvasTree(canvases, { includeArchived: true }))) {
      out.push({
        key: `canvas:${c.id}`,
        label: canvasLabel(canvases, c.id),
        hint: `${typeOf(types, c)?.label.toLowerCase() ?? 'canvas'}${c.archived ? ' · archived' : ''}`,
        target: { kind: 'canvas', canvasId: c.id }
      })
    }
    return out
  }, [canvases, extensions, recentPages, types, canvasType, timeViews])

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, s: score(query, it.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? 0 : (b.it.recent ?? 0) - (a.it.recent ?? 0)) || b.s - a.s || a.it.label.localeCompare(b.it.label))
      .slice(0, 12)
      .map((x) => x.it)
  }, [items, query])

  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => setIndex(0), [query])

  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="switcher" role="dialog" aria-label="Go to">
        <input
          ref={input}
          type="text"
          placeholder="Go to a canvas, task or view…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') onClose()
            else if (ev.key === 'ArrowDown') {
              ev.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (ev.key === 'Enter' && results[index]) {
              ev.preventDefault()
              onPick(results[index].target)
            }
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li key={r.key}>
              <button type="button" className={`switcher-item${i === index ? ' is-active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => onPick(r.target)}>
                <span className="switcher-label">{r.label}</span>
                <span className="switcher-hint">{r.hint}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="switcher-empty">No matches</li>}
        </ul>
      </div>
    </div>
  )
}

/** An extension's quick pick (1.6): the switcher's list with the extension's items. */
export function ExtensionPick({ title, items, placeholder, onDone }: { title: string; items: PickItem[]; placeholder?: string; onDone: (id: string | null) => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(
    () =>
      items
        .map((it, i) => ({ it, i, s: score(query, it.label) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (query ? b.s - a.s : 0) || a.i - b.i)
        .slice(0, 50)
        .map((x) => x.it),
    [items, query]
  )
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => setIndex(0), [query])
  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onDone(null)}>
      <div className="switcher" role="dialog" aria-label={title}>
        <input
          ref={input}
          type="text"
          placeholder={placeholder ?? `${title}: choose…`}
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') onDone(null)
            else if (ev.key === 'ArrowDown') {
              ev.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (ev.key === 'ArrowUp') {
              ev.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (ev.key === 'Enter' && results[index]) {
              ev.preventDefault()
              onDone(results[index].id)
            }
          }}
        />
        <ul>
          {results.map((r, i) => (
            <li key={r.id}>
              <button type="button" className={`switcher-item${i === index ? ' is-active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => onDone(r.id)}>
                <span className="switcher-label">{r.label}</span>
                {r.hint && <span className="switcher-hint">{r.hint}</span>}
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="switcher-empty">No matches</li>}
        </ul>
      </div>
    </div>
  )
}
