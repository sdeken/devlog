import { useMemo, useState } from 'react'
import { JOURNAL_ID, buildCanvasTree, canvasLabel, type CanvasNode } from '@shared/canvases'
import type { CanvasMeta } from '@shared/types'
import { kbd } from '@renderer/keys'

export type SidebarSelection = { kind: 'canvas'; canvasId: string } | { kind: 'review' } | { kind: 'summary' } | { kind: 'timeline' }

interface Props {
  canvases: CanvasMeta[]
  selection: SidebarSelection
  /** The active task, marked with a running dot. */
  activeCanvasId: string | null
  searching: boolean
  onSelect: (sel: SidebarSelection) => void
  onNewCanvas: () => void
}

export function Sidebar({ canvases, selection, activeCanvasId, searching, onSelect, onNewCanvas }: Props): React.JSX.Element {
  const tree = useMemo(() => buildCanvasTree(canvases), [canvases])
  const archived = useMemo(() => canvases.filter((c) => c.archived), [canvases])
  const [showArchived, setShowArchived] = useState(() => {
    try {
      return localStorage.getItem('devlog:sidebar:archived') === '1'
    } catch {
      return false
    }
  })
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('devlog:sidebar:collapsed') ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const toggleCollapsed = (id: string): void =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      try {
        localStorage.setItem('devlog:sidebar:collapsed', JSON.stringify([...n]))
      } catch {
        /* ignore */
      }
      return n
    })
  const toggleArchived = (): void => {
    setShowArchived((v) => {
      try {
        localStorage.setItem('devlog:sidebar:archived', v ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !v
    })
  }
  const isSelected = (id: string): boolean => !searching && selection.kind === 'canvas' && selection.canvasId === id
  const isView = (kind: SidebarSelection['kind']): boolean => !searching && selection.kind === kind

  const renderNode = (node: CanvasNode, depth: number): React.JSX.Element => {
    const c = node.canvas
    const hasChildren = node.children.length > 0
    const open = !collapsed.has(c.id)
    return (
      <li key={c.id} className={`canvas-node${c.task ? ' is-task' : ''}`}>
        <div className={`canvas-row${isSelected(c.id) ? ' is-selected' : ''}`} style={{ paddingLeft: 4 + depth * 12 }}>
          <button
            type="button"
            className={`canvas-caret${hasChildren ? '' : ' is-leaf'}`}
            onClick={() => hasChildren && toggleCollapsed(c.id)}
            tabIndex={hasChildren ? 0 : -1}
            aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
          >
            {hasChildren ? (open ? '▾' : '▸') : ''}
          </button>
          <button type="button" className="canvas-link" onClick={() => onSelect({ kind: 'canvas', canvasId: c.id })} title={c.task ? `${c.title} · task` : c.title}>
            <span className={`canvas-icon${activeCanvasId === c.id ? ' is-active' : ''}`}>{c.task ? '◉' : '▤'}</span>
            <span className="canvas-name">{c.title}</span>
          </button>
        </div>
        {hasChildren && open && <ul>{node.children.map((ch) => renderNode(ch, depth + 1))}</ul>}
      </li>
    )
  }

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        <ul className="sidebar-views">
          <li>
            <button type="button" className={`view-link${isSelected(JOURNAL_ID) ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'canvas', canvasId: JOURNAL_ID })}>
              <span className="view-icon">✎</span>
              <span className="view-name">Journal</span>
            </button>
          </li>
          <li>
            <button type="button" className={`view-link${isView('summary') ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'summary' })} title={`Hours per client (${kbd('mod', 'shift', 'H')})`}>
              <span className="view-icon">Σ</span>
              <span className="view-name">Summary</span>
            </button>
          </li>
          <li>
            <button type="button" className={`view-link${isView('review') ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'review' })} title={`Weekly review (${kbd('mod', 'shift', 'R')})`}>
              <span className="view-icon">▦</span>
              <span className="view-name">Weekly review</span>
            </button>
          </li>
          <li>
            <button type="button" className={`view-link${isView('timeline') ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'timeline' })} title={`Day timeline (${kbd('mod', 'shift', 'T')})`}>
              <span className="view-icon">◷</span>
              <span className="view-name">Timeline</span>
            </button>
          </li>
        </ul>
        <div className="sidebar-section">
          <span>Canvases</span>
          <button type="button" className="sidebar-add" onClick={onNewCanvas} title={`New canvas (${kbd('mod', 'N')})`}>
            +
          </button>
        </div>
        {tree.length === 0 && <p className="sidebar-hint">No canvases yet. Add a client or a project, or turn a note into a task.</p>}
        <ul className="canvas-tree">{tree.map((n) => renderNode(n, 0))}</ul>
        {archived.length > 0 && (
          <div className="sidebar-archived">
            <button type="button" className="sidebar-section archived-toggle" onClick={toggleArchived}>
              {showArchived ? '▾' : '▸'} Archived ({archived.length})
            </button>
            {showArchived && (
              <ul>
                {archived.map((c) => (
                  <li key={c.id}>
                    <button type="button" className={`view-link canvas-archived${isSelected(c.id) ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'canvas', canvasId: c.id })} title={canvasLabel(canvases, c.id)}>
                      <span className="view-icon">{c.task ? '◉' : '▤'}</span>
                      <span className="view-name">{canvasLabel(canvases, c.id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>
    </aside>
  )
}
