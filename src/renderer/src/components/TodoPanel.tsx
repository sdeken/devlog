import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { JOURNAL_ID, ancestorIds, canvasLabel, descendantCanvasIds, splitTodoLines } from '@devlog/core'
import type { CanvasMeta, TodoRef } from '@shared/types'
import { api } from '@renderer/api'
import { renderMarkdown } from '@renderer/markdown'
import { reported, showToast } from '@renderer/toasts'

interface Props {
  canvases: CanvasMeta[]
  /** The canvas on screen; null on the review, summary and timeline views. */
  canvasId: string | null
  /** The block open as a page, if any: "Here" is then that block and what is inside it. */
  page: { canvasId: string; date: string; id: string; title: string } | null
  /** Where new todos go when no canvas is on screen (the composer's target). */
  fallbackCanvasId: string | null
  onOpenCanvas: (id: string) => void
  onOpenBlock: (canvasId: string, date: string, id: string) => void
  /** A todo was added or ticked off: that day file changed. */
  onStreamChanged: (canvasId: string, date: string) => void
  /** Bumped whenever a day file changes in this window (blocks posted, moved, deleted…). */
  version: number
}

/** A heading in the panel: a canvas or a block, holding todos and further headings. */
interface Group {
  key: string
  label: string
  open: () => void
  todos: TodoRef[]
  children: Group[]
}

/** How long ticked-off todos stay in the Done section. */
const DONE_DAYS = 14
const FOLDED_KEY = 'devlog:todos:folded'

const COLLAPSE_KEY = 'devlog:todos:collapsed'
const WIDTH_KEY = 'devlog:todos:width'
const DEFAULT_WIDTH = 300
const MIN_WIDTH = 220
const MAX_WIDTH = 720

/** Keep the panel between its minimum and half the window. */
function clampWidth(w: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)))
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, w)))
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n > 0 ? clampWidth(n) : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function writeWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
  } catch {
    /* ignore */
  }
}
const SCOPE_KEY = 'devlog:todos:all'
const DRAG_MIME = 'application/x-devlog-todo'
const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

function readFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

/**
 * Nest todos under the canvases and blocks they live in. A heading with no
 * todos of its own and a single heading beneath it merges into it
 * ("Acme / Website"), so a long single path takes one line.
 */
export function groupTodos(todos: TodoRef[], canvases: CanvasMeta[], open: { canvas: (id: string) => void; block: (canvasId: string, date: string, id: string) => void }): Group[] {
  interface Node extends Group {
    map: Map<string, Node>
  }
  const root: Node = { key: '', label: '', open: () => undefined, todos: [], children: [], map: new Map() }
  const child = (parent: Node, key: string, label: string, onOpen: () => void): Node => {
    let n = parent.map.get(key)
    if (!n) {
      n = { key, label, open: onOpen, todos: [], children: [], map: new Map() }
      parent.map.set(key, n)
      parent.children.push(n)
    }
    return n
  }
  const title = (id: string): string => canvasLabel(canvases, id).split(' / ').pop() ?? id
  for (const t of todos) {
    let node = root
    for (const id of [...ancestorIds(canvases, t.canvasId).reverse(), t.canvasId]) node = child(node, `c:${id}`, id === JOURNAL_ID ? 'Journal' : title(id), () => open.canvas(id))
    for (const b of t.trail) node = child(node, `b:${t.canvasId}/${b.id}`, b.title, () => open.block(t.canvasId, t.date, b.id))
    node.todos.push(t)
  }
  const squash = (n: Node): Group => {
    let cur: Group = n
    let label = n.label
    while (cur.todos.length === 0 && cur.children.length === 1) {
      cur = cur.children[0]
      label = label ? `${label} / ${cur.label}` : cur.label
    }
    return { key: cur.key, label, open: cur.open, todos: cur.todos, children: cur.children.map((c) => squash(c as Node)) }
  }
  const top = squash(root)
  return top.key === '' ? top.children : [top]
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
function writeFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/**
 * Todos pinned to the right edge: every open todo for the page on screen and
 * everything beneath it (or everything), grouped under the canvases and
 * blocks they live in. Clicking one opens it as a page.
 */
export function TodoPanel({ canvases, canvasId, page, fallbackCanvasId, onOpenCanvas, onOpenBlock, onStreamChanged, version }: Props): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readFlag(COLLAPSE_KEY))
  const [width, setWidth] = useState(readWidth)
  const widthRef = useRef(width)
  widthRef.current = width
  const setAndSaveWidth = (w: number): void => {
    const next = clampWidth(w)
    setWidth(next)
    writeWidth(next)
  }
  // Drag the left edge to resize; the width is remembered on this machine.
  const startResize = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const startX = ev.clientX
    const startWidth = widthRef.current
    document.body.classList.add('is-resizing')
    const move = (e: PointerEvent): void => setWidth(clampWidth(startWidth + (startX - e.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      writeWidth(widthRef.current)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const [all, setAll] = useState(() => readFlag(SCOPE_KEY))
  const [todos, setTodos] = useState<TodoRef[] | null>(null)
  const [folded, setFolded] = useState<Set<string>>(readFolded)
  const [showDone, setShowDone] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<Map<string, boolean>>(new Map())
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // Ticking one off keeps the scroll position (the list reloads once the write is done).
  const body = useRef<HTMLDivElement>(null)
  const hold = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (hold.current === null || !body.current) return
    body.current.scrollTop = hold.current
    hold.current = null
  })

  const home = canvasId && canvasId !== JOURNAL_ID ? canvasId : null
  const here = page && page.canvasId === home ? page : null
  const wholeLog = all || !home
  const fallback = fallbackCanvasId && canvases.some((c) => c.id === fallbackCanvasId && !c.archived) ? fallbackCanvasId : null
  // New todos go into the page on screen, the canvas on screen, or the one the composer posts to.
  const target = here ? { canvasId: here.canvasId, position: { date: here.date, parentId: here.id }, label: here.title } : (home ?? fallback) ? { canvasId: (home ?? fallback)!, position: {}, label: canvasLabel(canvases, (home ?? fallback)!) } : null

  const load = useCallback(async () => {
    const since = new Date(Date.now() - DONE_DAYS * 86_400_000).toISOString()
    setTodos(await api.todos.list({ doneSince: since }))
  }, [])

  useEffect(() => api.blocks.onChanged(() => void load()), [load])
  useEffect(() => {
    void load()
  }, [load, version, all])

  const inScope = useMemo(() => {
    if (wholeLog) return (): boolean => true
    if (here) return (t: TodoRef): boolean => t.canvasId === here.canvasId && t.date === here.date && t.trail.some((b) => b.id === here.id)
    const ids = new Set([home!, ...descendantCanvasIds(canvases, home!)])
    return (t: TodoRef): boolean => ids.has(t.canvasId)
  }, [wholeLog, here, home, canvases])

  const open = useMemo(() => (todos ?? []).filter((t) => !t.entry.meta?.done && inScope(t)), [todos, inScope])
  const done = useMemo(
    () =>
      (todos ?? [])
        .filter((t) => t.entry.meta?.done && inScope(t))
        .sort((a, b) => (b.entry.meta?.done ?? '').localeCompare(a.entry.meta?.done ?? ''))
        .slice(0, 30),
    [todos, inScope]
  )
  const groups = useMemo(() => groupTodos(open, canvases, { canvas: onOpenCanvas, block: onOpenBlock }), [open, canvases, onOpenCanvas, onOpenBlock])

  const add = async (text: string): Promise<void> => {
    const items = splitTodoLines(text)
    if (items.length === 0 || !target) return
    const res = await api.todos.add(target.canvasId, items, target.position)
    setDraft('')
    if (input.current) input.current.style.height = 'auto'
    await load()
    onStreamChanged(target.canvasId, res.date)
    if (items.length > 1) showToast(`Added ${items.length} todos to ${target.label}`, 'info')
  }

  const tick = async (t: TodoRef, next: boolean): Promise<void> => {
    setPending((m) => new Map(m).set(t.entry.id, next))
    try {
      await api.todos.setDone(t.canvasId, t.date, t.entry.id, next)
      if (body.current) hold.current = body.current.scrollTop
      await load()
      onStreamChanged(t.canvasId, t.date)
    } finally {
      setPending((m) => {
        const n = new Map(m)
        n.delete(t.entry.id)
        return n
      })
    }
  }

  const toggleFolded = (key: string): void =>
    setFolded((cur) => {
      const n = new Set(cur)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...n]))
      } catch {
        /* ignore */
      }
      return n
    })

  const toggleCollapsed = (): void => {
    setCollapsed((v) => {
      writeFlag(COLLAPSE_KEY, !v)
      return !v
    })
  }

  if (collapsed) {
    return (
      <aside className="todo-panel is-collapsed">
        <button type="button" className="todo-expand" onClick={toggleCollapsed} title="Show todos">
          <span className="todo-expand-count">{open.length}</span>
          <span className="todo-expand-label">To do</span>
        </button>
      </aside>
    )
  }

  // Todos are reordered among the ones beside them: same file, same block.
  const siblingKey = (t: TodoRef): string => `${t.canvasId}/${t.date}/${t.trail.at(-1)?.id ?? ''}`
  const renderTodo = (t: TodoRef): React.JSX.Element => {
    const isDone = pending.get(t.entry.id) ?? Boolean(t.entry.meta?.done)
    return (
      <li
        key={`${t.canvasId}/${t.date}/${t.entry.id}`}
        data-todo-id={t.entry.id}
        className={`todo${isDone ? ' is-done' : ''}${drop?.id === t.entry.id ? ` drop-${drop.side}` : ''}`}
        draggable={!t.entry.meta?.done}
        onDragStart={(ev) => {
          ev.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: t.entry.id, sib: siblingKey(t) }))
          ev.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(ev) => {
          if (t.entry.meta?.done || !ev.dataTransfer.types.includes(DRAG_MIME)) return
          ev.preventDefault()
          const r = ev.currentTarget.getBoundingClientRect()
          const side = ev.clientY < r.top + r.height / 2 ? 'before' : 'after'
          if (drop?.id !== t.entry.id || drop.side !== side) setDrop({ id: t.entry.id, side })
        }}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDrop(null)
        }}
        onDrop={(ev) => {
          ev.preventDefault()
          const side = drop?.side
          setDrop(null)
          try {
            const data = JSON.parse(ev.dataTransfer.getData(DRAG_MIME)) as { id: string; sib: string }
            if (!side || data.id === t.entry.id) return
            if (data.sib !== siblingKey(t)) {
              showToast('Todos can be reordered among the ones beside them (same day, same block)', 'info')
              return
            }
            void reported(api.blocks.reorder(t.canvasId, t.date, data.id, side === 'before' ? { beforeId: t.entry.id } : { afterId: t.entry.id }).then(() => load()))
          } catch {
            /* not a todo */
          }
        }}
      >
        <div className="todo-row">
          <input
            type="checkbox"
            className="todo-check"
            checked={isDone}
            onChange={(ev) => void reported(tick(t, ev.target.checked))}
            title={isDone ? 'Mark as not done' : 'Done'}
            aria-label={isDone ? 'Mark as not done' : 'Mark as done'}
          />
          <button type="button" className="todo-text" onClick={() => onOpenBlock(t.canvasId, t.date, t.entry.id)} title="Open this todo">
            <span className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.entry.markdown) }} />
            {t.inside > 0 && <span className="todo-count">{t.inside}</span>}
          </button>
        </div>
        {t.entry.meta?.done && <div className="todo-meta">Done {timeFmt.format(new Date(t.entry.meta.done))}</div>}
      </li>
    )
  }

  const renderGroup = (g: Group, depth: number, showHead: boolean): React.JSX.Element => {
    const isFolded = folded.has(g.key)
    const count = (x: Group): number => x.todos.length + x.children.reduce((n, c) => n + count(c), 0)
    return (
      <section key={g.key} className={`todo-group depth-${Math.min(depth, 3)}`} data-group={g.key}>
        {showHead && (
          <div className="todo-group-head">
            <button type="button" className="todo-group-caret" onClick={() => toggleFolded(g.key)} aria-expanded={!isFolded} title={isFolded ? 'Show' : 'Fold'}>
              {isFolded ? '▸' : '▾'}
            </button>
            <button type="button" className="todo-group-label" onClick={g.open} title="Open">
              {g.label}
            </button>
            {isFolded && <span className="todo-group-count">{count(g)}</span>}
          </div>
        )}
        {!isFolded && (
          <>
            {g.todos.length > 0 && <ul className="todo-list">{g.todos.map(renderTodo)}</ul>}
            {g.children.map((c) => renderGroup(c, depth + 1, true))}
          </>
        )}
      </section>
    )
  }

  // With "Here" and a single heading, that heading is the page on screen: leave it off.
  const soleHere = !wholeLog && groups.length === 1

  return (
    <aside className="todo-panel" style={{ width }}>
      <div
        className="todo-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the to-do panel"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setAndSaveWidth(DEFAULT_WIDTH)}
        onKeyDown={(ev) => {
          if (ev.key === 'ArrowLeft') setAndSaveWidth(width + 20)
          else if (ev.key === 'ArrowRight') setAndSaveWidth(width - 20)
          else return
          ev.preventDefault()
        }}
      />
      <header className="todo-head">
        <span className="todo-title">To do</span>
        <span className="todo-open-count">{open.length}</span>
        <span className="spacer" />
        {home && (
          <button
            type="button"
            className={`todo-scope${all ? ' is-all' : ''}`}
            onClick={() =>
              setAll((v) => {
                writeFlag(SCOPE_KEY, !v)
                return !v
              })
            }
            title={all ? `Show only ${here ? `“${here.title}”` : canvasLabel(canvases, home)} and what is inside it` : 'Show every open todo'}
          >
            {all ? 'All' : 'Here'}
          </button>
        )}
        <button type="button" className="todo-collapse" onClick={toggleCollapsed} title="Hide the todo panel">
          ›
        </button>
      </header>
      <div className="todo-add">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={target ? (here ? 'Add a todo inside this block… or paste a list' : 'Add a todo… or paste a list') : 'Open a canvas to add todos'}
          disabled={!target}
          title={target ? `New todos go to ${target.label}` : 'Open a canvas to add todos'}
          onChange={(ev) => {
            setDraft(ev.target.value)
            // Grow with the text instead of scrolling.
            ev.target.style.height = 'auto'
            ev.target.style.height = `${ev.target.scrollHeight}px`
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault()
              void reported(add(draft))
            }
          }}
          onPaste={(ev) => {
            const text = ev.clipboardData.getData('text/plain')
            if (splitTodoLines(text).length > 1 || /\n/.test(text.trim())) {
              ev.preventDefault()
              void reported(add(draft ? `${draft}\n${text}` : text))
            }
          }}
        />
      </div>
      <div className="todo-body" ref={body}>
        {todos === null && <p className="todo-empty">Loading…</p>}
        {todos && open.length === 0 && <p className="todo-empty">Nothing to do{wholeLog ? '' : ' here'}. Type above, or paste a list.</p>}
        {groups.map((g) => renderGroup(g, 0, !soleHere))}
        {done.length > 0 && (
          <section className="todo-done">
            <button type="button" className="todo-done-toggle" onClick={() => setShowDone((v) => !v)}>
              {showDone ? '▾' : '▸'} Done ({done.length})
            </button>
            {showDone && <ul className="todo-list">{done.map(renderTodo)}</ul>}
          </section>
        )}
      </div>
    </aside>
  )
}
