import { useEffect, useMemo, useRef, useState } from 'react'
import { JOURNAL_ID, buildCanvasTree, canvasLabel, flattenTree } from '@shared/canvases'
import type { CanvasMeta } from '@shared/types'

export type SwitchTarget = { kind: 'canvas'; canvasId: string } | { kind: 'view'; view: 'review' | 'timeline' | 'summary' }

interface Props {
  canvases: CanvasMeta[]
  onPick: (target: SwitchTarget) => void
  onClose: () => void
}

interface Item {
  key: string
  label: string
  hint: string
  target: SwitchTarget
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

export function QuickSwitcher({ canvases, onPick, onClose }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      { key: 'canvas:journal', label: 'Journal', hint: 'journal', target: { kind: 'canvas', canvasId: JOURNAL_ID } },
      { key: 'view:summary', label: 'Summary', hint: 'view', target: { kind: 'view', view: 'summary' } },
      { key: 'view:review', label: 'Weekly review', hint: 'view', target: { kind: 'view', view: 'review' } },
      { key: 'view:timeline', label: 'Timeline', hint: 'view', target: { kind: 'view', view: 'timeline' } }
    ]
    for (const { canvas: c } of flattenTree(buildCanvasTree(canvases, { includeArchived: true }))) {
      out.push({
        key: `canvas:${c.id}`,
        label: canvasLabel(canvases, c.id),
        hint: `${c.task ? 'task' : 'canvas'}${c.archived ? ' · archived' : ''}`,
        target: { kind: 'canvas', canvasId: c.id }
      })
    }
    return out
  }, [canvases])

  const results = useMemo(() => {
    return items
      .map((it) => ({ it, s: score(query, it.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.label.localeCompare(b.it.label))
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
