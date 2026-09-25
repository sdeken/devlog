import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JOURNAL_ID, canvasLabel, descendantCanvasIds } from '@devlog/core'
import { buildTree, splitTodoLines, type EntryNode } from '@devlog/core'
import type { CanvasMeta, Entry } from '@shared/types'
import { api } from '@renderer/api'
import { renderMarkdown } from '@renderer/markdown'
import { reported, showToast } from '@renderer/toasts'
import { Composer } from './Composer'

interface Props {
  canvases: CanvasMeta[]
  /** The canvas on screen; null on the review, summary and timeline views. */
  canvasId: string | null
  onOpenCanvas: (id: string) => void
  /** A todo was ticked off or promoted: the stream for that canvas changed today. */
  onStreamChanged: (canvasId: string, date: string) => void
  onCanvasesChanged: () => Promise<unknown>
}

type Lists = Array<{ canvasId: string; entries: Entry[] }>

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

/** One comment in a todo's thread, with its own replies. */
function Comment({ node }: { node: EntryNode }): React.JSX.Element {
  return (
    <li className="todo-comment">
      <div className="todo-comment-meta">{timeFmt.format(new Date(node.entry.createdAt))}</div>
      <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(node.entry.markdown) }} />
      {node.children.length > 0 && (
        <ul className="todo-comments">
          {node.children.map((c) => (
            <Comment key={c.entry.id} node={c} />
          ))}
        </ul>
      )}
    </li>
  )
}

function TodoItem({
  node,
  canvasId,
  open,
  onToggleOpen,
  onChanged,
  onDone,
  onPromote,
  onDrop
}: {
  node: EntryNode
  canvasId: string
  open: boolean
  onToggleOpen: () => void
  onChanged: () => Promise<void>
  onDone: (done: boolean) => Promise<void>
  onPromote: () => Promise<void>
  onDrop: (movingId: string, side: 'before' | 'after') => void
}): React.JSX.Element {
  const todo = node.entry
  const done = Boolean(todo.meta?.done)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [drop, setDrop] = useState<'before' | 'after' | null>(null)
  const [replyKey, setReplyKey] = useState(0)
  // The box ticks at once; the saved state catches up when the list reloads.
  const [pending, setPending] = useState<boolean | null>(null)
  useEffect(() => setPending(null), [done])
  const comments = node.children.length

  return (
    <li
      className={`todo${done ? ' is-done' : ''}${open ? ' is-open' : ''}${drop ? ` drop-${drop}` : ''}`}
      draggable={!done && !editing}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: todo.id, canvasId }))
        ev.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(ev) => {
        if (done || !ev.dataTransfer.types.includes(DRAG_MIME)) return
        ev.preventDefault()
        const r = ev.currentTarget.getBoundingClientRect()
        setDrop(ev.clientY < r.top + r.height / 2 ? 'before' : 'after')
      }}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setDrop(null)
      }}
      onDrop={(ev) => {
        ev.preventDefault()
        const side = drop
        setDrop(null)
        try {
          const data = JSON.parse(ev.dataTransfer.getData(DRAG_MIME)) as { id: string; canvasId: string }
          if (side && data.canvasId === canvasId && data.id !== todo.id) onDrop(data.id, side)
        } catch {
          /* not a todo */
        }
      }}
    >
      <div className="todo-row">
        <input
          type="checkbox"
          className="todo-check"
          checked={pending ?? done}
          onChange={(ev) => {
            const next = ev.target.checked
            setPending(next)
            void reported(onDone(next)).then(() => setPending(null))
          }}
          title={done ? 'Mark as not done' : 'Done: records it in the stream'}
          aria-label={done ? 'Mark as not done' : 'Mark as done'}
        />
        {editing ? (
          <div className="todo-edit">
            <Composer
              mode="edit"
              initialMarkdown={todo.markdown}
              assetCanvasId={canvasId}
              autoFocus
              onSubmit={async (md) => {
                await api.todos.update(canvasId, todo.id, md)
                setEditing(false)
                await onChanged()
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <button type="button" className="todo-text" onClick={onToggleOpen} title={open ? 'Collapse' : 'Open comments and actions'}>
            <span className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(todo.markdown) }} />
            {comments > 0 && <span className="todo-count">{comments}</span>}
          </button>
        )}
      </div>
      {open && !editing && (
        <div className="todo-detail">
          {comments > 0 && (
            <ul className="todo-comments">
              {node.children.map((c) => (
                <Comment key={c.entry.id} node={c} />
              ))}
            </ul>
          )}
          {!done && (
            <div className="todo-reply">
              <Composer
                key={replyKey}
                mode="reply"
                placeholder="Comment…  Enter posts"
                assetCanvasId={canvasId}
                onSubmit={async (md) => {
                  await api.todos.reply(canvasId, todo.id, md)
                  setReplyKey((k) => k + 1)
                  await onChanged()
                }}
              />
            </div>
          )}
          <div className="todo-actions">
            {todo.meta?.task ? (
              <span className="todo-meta">Became a task</span>
            ) : (
              !done && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => void reported(onPromote())} title="Make it a task canvas and start the clock">
                  Make task
                </button>
              )
            )}
            {!done && (
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-xs"
                  onClick={() =>
                    void reported(
                      api.todos.remove(canvasId, todo.id).then(async () => {
                        await onChanged()
                      })
                    )
                  }
                >
                  Delete{comments ? ` with ${comments} comment${comments === 1 ? '' : 's'}` : ''}
                </button>
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
            <span className="todo-meta">{done ? `Done ${timeFmt.format(new Date(todo.meta!.done!))}` : `Added ${timeFmt.format(new Date(todo.createdAt))}`}</span>
          </div>
        </div>
      )}
    </li>
  )
}

/**
 * Todos pinned to the right edge: open items for the canvas on screen and
 * everything beneath it (or everything), always visible whatever scrolls.
 */
export function TodoPanel({ canvases, canvasId, onOpenCanvas, onStreamChanged, onCanvasesChanged }: Props): React.JSX.Element {
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
  const [lists, setLists] = useState<Lists | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [draft, setDraft] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)

  const home = canvasId && canvasId !== JOURNAL_ID ? canvasId : null
  const wholeLog = all || !home
  const scopeIds = useMemo(() => {
    const live = canvases.filter((c) => !c.archived)
    if (wholeLog) return [JOURNAL_ID, ...live.filter((c) => c.id !== JOURNAL_ID).map((c) => c.id)]
    return [home!, ...descendantCanvasIds(canvases, home!).filter((id) => live.some((c) => c.id === id))]
  }, [canvases, wholeLog, home])
  const scopeKey = scopeIds.join(',')
  // New todos go to the canvas on screen, or the journal.
  const target = home ?? JOURNAL_ID

  const load = useCallback(async () => {
    setLists(await api.todos.list(scopeIds))
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load()
    return api.blocks.onChanged(() => void load())
  }, [load])

  const add = async (text: string): Promise<void> => {
    const items = splitTodoLines(text)
    if (items.length === 0) return
    await api.todos.add(target, items)
    setDraft('')
    if (input.current) input.current.style.height = 'auto'
    await load()
    if (items.length > 1) showToast(`Added ${items.length} todos to ${canvasLabel(canvases, target)}`)
  }

  const groups = useMemo(() => {
    if (!lists) return []
    return lists
      .map(({ canvasId: id, entries }) => {
        const roots = buildTree(entries).filter((n) => n.entry.kind === 'todo')
        return {
          canvasId: id,
          open: roots.filter((n) => !n.entry.meta?.done),
          done: roots.filter((n) => n.entry.meta?.done)
        }
      })
      .filter((g) => g.open.length > 0 || g.done.length > 0)
  }, [lists])
  const openCount = groups.reduce((n, g) => n + g.open.length, 0)
  const doneList = useMemo(
    () =>
      groups
        .flatMap((g) => g.done.map((node) => ({ canvasId: g.canvasId, node })))
        .sort((a, b) => (b.node.entry.meta?.done ?? '').localeCompare(a.node.entry.meta?.done ?? ''))
        .slice(0, 30),
    [groups]
  )
  const multi = groups.filter((g) => g.open.length > 0).length > 1 || wholeLog

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
          <span className="todo-expand-count">{openCount}</span>
          <span className="todo-expand-label">To do</span>
        </button>
      </aside>
    )
  }

  const renderItem = (id: string, node: EntryNode): React.JSX.Element => (
    <TodoItem
      key={node.entry.id}
      node={node}
      canvasId={id}
      open={openId === node.entry.id}
      onToggleOpen={() => setOpenId((cur) => (cur === node.entry.id ? null : node.entry.id))}
      onChanged={load}
      onDone={async (done) => {
        const res = await api.todos.setDone(id, node.entry.id, done)
        await load()
        onStreamChanged(id, res.date)
      }}
      onPromote={async () => {
        const res = await api.todos.promote(id, node.entry.id)
        await load()
        await onCanvasesChanged()
        onStreamChanged(id, res.entry.createdAt.slice(0, 10))
        showToast(`Task started: ${res.canvas.title}`)
      }}
      onDrop={(movingId, side) =>
        void reported(api.todos.reorder(id, movingId, side === 'before' ? { beforeId: node.entry.id } : { afterId: node.entry.id }).then(() => load()))
      }
    />
  )

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
        <span className="todo-open-count">{openCount}</span>
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
            title={all ? `Show only ${canvasLabel(canvases, home)} and what is inside it` : 'Show every open todo'}
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
          placeholder="Add a todo… or paste a list"
          title={`New todos go to ${canvasLabel(canvases, target)}`}
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
      <div className="todo-body">
        {lists === null && <p className="todo-empty">Loading…</p>}
        {lists && openCount === 0 && <p className="todo-empty">Nothing to do{wholeLog ? '' : ' here'}. Type above, or paste a list.</p>}
        {groups
          .filter((g) => g.open.length > 0)
          .map((g) => (
            <section key={g.canvasId} className="todo-group">
              {multi && (
                <button type="button" className="todo-group-label" onClick={() => onOpenCanvas(g.canvasId)} title="Open this canvas">
                  {canvasLabel(canvases, g.canvasId)}
                </button>
              )}
              <ul className="todo-list">{g.open.map((node) => renderItem(g.canvasId, node))}</ul>
            </section>
          ))}
        {doneList.length > 0 && (
          <section className="todo-done">
            <button type="button" className="todo-done-toggle" onClick={() => setShowDone((v) => !v)}>
              {showDone ? '▾' : '▸'} Done ({doneList.length})
            </button>
            {showDone && <ul className="todo-list">{doneList.map(({ canvasId: id, node }) => renderItem(id, node))}</ul>}
          </section>
        )}
      </div>
    </aside>
  )
}
