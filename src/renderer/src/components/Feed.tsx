import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { buildTree, previewText, type EntryNode } from '@devlog/core'
import { JOURNAL_ID, canvasLabel } from '@devlog/core'
import type { CanvasMeta, Day, Entry, EntryPosition, SearchResult } from '@shared/types'
import { Composer } from './Composer'
import { EntryView } from './EntryView'

interface Props {
  canvas: CanvasMeta
  canvases: CanvasMeta[]
  days: Day[]
  hasMore: boolean
  today: string
  search: string
  hits: SearchResult | null
  loading: boolean
  /** Id of the entry that should open in edit mode, if any. */
  editRequest: string | null
  /** Rendered above the stream (the canvas header and surface). */
  header?: React.ReactNode
  onLoadMore: () => Promise<void>
  onAdd: (canvasId: string, markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (canvasId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (canvasId: string, date: string, id: string) => Promise<void>
  onMove: (canvasId: string, date: string, id: string, toCanvasId: string) => Promise<void>
  /** Move a block within its canvas: inside another (drop it on the middle of one), or out of the one it is in. */
  onNest?: (canvasId: string, date: string, id: string, to: { date: string; parentId?: string; afterId?: string }) => Promise<void>
  onPromote?: (canvasId: string, date: string, id: string) => Promise<void>
  onSetHidden?: (canvasId: string, date: string, id: string, hidden: boolean) => Promise<void>
  onSetDone?: (canvasId: string, date: string, id: string, done: boolean) => Promise<void>
  /** Drag-and-drop reordering of a top-level block within its day. */
  onReorder?: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }) => Promise<void>
  onJumpTo: (canvasId: string, date: string) => void
  onOpenCanvas: (id: string) => void
  /** Open a block as a page (its day file's date and its id). */
  onOpenBlock?: (canvasId: string, date: string, id: string) => void
  /**
   * On a block page the stream is the block's children, grouped by the day
   * each was written, but they all live in the block's day file: this is
   * that file's date, used for every change.
   */
  fileDate?: string
  /** On a block page, the block: its children count as the stream's top level. */
  streamParentId?: string
  emptyText?: string
}

const DRAG_MIME = 'application/x-devlog-block'

/** The block being dragged, if any (drops can land in another day's group). */
let dragged: { id: string; date: string; canvasId: string } | null = null

const headingFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function countDescendants(node: EntryNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0)
}

/** Thin hover target between two blocks that expands into an inline composer. */
function InsertGap({ canvasId, date, position, onAdd }: { canvasId: string; date: string; position: EntryPosition; onAdd: Props['onAdd'] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (open) {
    return (
      <div className="gap gap-open">
        <Composer
          mode="insert"
          assetCanvasId={canvasId}
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onAdd(canvasId, md, { date, ...position })
            setOpen(false)
          }}
          onCancel={() => setOpen(false)}
        />
      </div>
    )
  }
  return (
    <div className="gap" role="presentation">
      <button type="button" className="gap-add" title="Insert a block here" onClick={() => setOpen(true)}>
        +
      </button>
    </div>
  )
}

interface NodeProps {
  node: EntryNode
  canvasId: string
  canvases: CanvasMeta[]
  date: string
  editRequest: string | null
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
  onNest?: Props['onNest']
  onPromote?: Props['onPromote']
  onSetHidden?: Props['onSetHidden']
  onSetDone?: Props['onSetDone']
  onOpenCanvas: Props['onOpenCanvas']
  onOpenBlock?: Props['onOpenBlock']
  /** Blocks get a drag grip when reordering is available. */
  draggable?: boolean
}

/** A block in a stream. What is written inside it lives on its own page, behind a chip. */
function NoteNode({ node, canvasId, canvases, date, editRequest, onUpdate, onDelete, onMove, onNest, onPromote, onSetHidden, onSetDone, onOpenCanvas, onOpenBlock, draggable }: NodeProps): React.JSX.Element {
  return (
    <div className="note">
      <EntryView
        canvasId={canvasId}
        date={date}
        entry={node.entry}
        replyCount={countDescendants(node)}
        forceEdit={editRequest === node.entry.id}
        canvases={canvases}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMove={onMove}
        onNest={onNest}
        onPromote={onPromote}
        onSetHidden={onSetHidden}
        onSetDone={onSetDone}
        onOpenCanvas={onOpenCanvas}
        onOpen={onOpenBlock ? () => onOpenBlock(canvasId, date, node.entry.id) : undefined}
        draggable={draggable}
      />
    </div>
  )
}

/** A run of hidden blocks collapsed into one line; click to look inside. */
function HiddenGroup({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button type="button" className={`hidden-stub${open ? ' is-open' : ''}`} onClick={onToggle} title={open ? 'Collapse again' : 'Show the hidden blocks'}>
      {open ? '▾' : '▸'} {count} hidden block{count === 1 ? '' : 's'}
    </button>
  )
}

/** Completed todos ticked off in a row, folded into one line; click to see the blocks. */
function DoneGroup({ nodes, open, onToggle }: { nodes: EntryNode[]; open: boolean; onToggle: () => void }): React.JSX.Element {
  const titles = nodes.map((n) => previewText(n.entry.markdown.replace(/^\s*✓\s*/, ''), 80))
  return (
    <button
      type="button"
      className={`done-stub${open ? ' is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      title={open ? 'Fold these back into one line' : `Show the ${nodes.length} completed todos:\n${titles.join('\n')}`}
    >
      <span className="entry-brace brace-auto" aria-hidden="true" />
      <span className="done-count">
        {open ? '▾' : '▸'} ✓ {nodes.length} todos done
      </span>
      <span className="done-titles">{open ? '' : titles.join(' · ')}</span>
      <span className="done-toggle">{open ? 'Hide' : 'Show all'}</span>
    </button>
  )
}

/** A ticked-off todo (or an old "✓" block) with nothing inside it: these fold together when they come in a row. */
const isFoldableDone = (node: EntryNode): boolean =>
  (node.entry.kind === 'done' || (node.entry.kind === 'todo' && Boolean(node.entry.meta?.done))) && !node.entry.hidden && node.children.length === 0

function DayGroup({
  day,
  fileDate,
  isToday,
  canvasId,
  canvases,
  editRequest,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onNest,
  onPromote,
  onSetHidden,
  onReorder,
  onSetDone,
  onOpenCanvas,
  onOpenBlock
}: {
  day: Day
  /** The day file the blocks live in, when it is not the day they are shown under. */
  fileDate?: string
  isToday: boolean
  canvasId: string
  canvases: CanvasMeta[]
  editRequest: string | null
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
  onNest?: Props['onNest']
  onPromote?: Props['onPromote']
  onSetHidden?: Props['onSetHidden']
  onReorder?: Props['onReorder']
  onSetDone?: Props['onSetDone']
  onOpenCanvas: Props['onOpenCanvas']
  onOpenBlock?: Props['onOpenBlock']
}): React.JSX.Element {
  const roots = buildTree(day.entries)
  const opDate = fileDate ?? day.date
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' | 'inside' } | null>(null)

  // Consecutive hidden roots collapse into one stub, and so do consecutive completed todos;
  // each run is keyed by its first id.
  type Run = { kind: 'hidden' | 'done'; key: string; nodes: EntryNode[]; index: number }
  const items: Array<{ kind: 'node'; node: EntryNode; index: number } | Run> = []
  for (let i = 0; i < roots.length; i++) {
    const node = roots[i]
    const runKind = node.entry.hidden ? 'hidden' : isFoldableDone(node) ? 'done' : null
    const prev = items[items.length - 1]
    if (runKind && prev && prev.kind === runKind) prev.nodes.push(node)
    else if (runKind) items.push({ kind: runKind, key: node.entry.id, nodes: [node], index: i })
    else items.push({ kind: 'node', node, index: i })
  }
  // A single completed todo shows as the block it is.
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'done' && item.nodes.length === 1) items[i] = { kind: 'node', node: item.nodes[0], index: item.index }
  }
  const toggle = (key: string): void =>
    setRevealed((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  // The top and bottom of a block reorder (same day only); its middle puts the dragged block inside it.
  const onDragOver = (ev: React.DragEvent<HTMLDivElement>, id: string): void => {
    const d = dragged
    if (!onReorder || !d || d.id === id || d.canvasId !== canvasId) return
    if (!ev.dataTransfer.types.includes(DRAG_MIME)) return
    const r = ev.currentTarget.getBoundingClientRect()
    const y = (ev.clientY - r.top) / Math.max(1, r.height)
    const sameDay = d.date === opDate
    const side: 'before' | 'after' | 'inside' | null = onNest && (y > 0.3 && y < 0.7) ? 'inside' : sameDay ? (y < 0.5 ? 'before' : 'after') : onNest ? 'inside' : null
    if (!side) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'move'
    if (!drop || drop.id !== id || drop.side !== side) setDrop({ id, side })
  }
  const onDrop = (ev: React.DragEvent<HTMLDivElement>, id: string): void => {
    ev.preventDefault()
    const target = drop
    const d = dragged
    setDrop(null)
    dragged = null
    if (!onReorder || !d || !target || target.id !== id || d.canvasId !== canvasId || d.id === id) return
    if (target.side === 'inside') void onNest?.(canvasId, d.date, d.id, { date: opDate, parentId: id })
    else if (d.date === opDate) void onReorder(canvasId, opDate, d.id, target.side === 'before' ? { beforeId: id } : { afterId: id })
  }

  const renderNode = (node: EntryNode, i: number, extraClass = ''): React.JSX.Element => (
    <div
      key={node.entry.id}
      className={`note-slot${extraClass}${drop?.id === node.entry.id ? ` drop-${drop.side}` : ''}`}
      onDragStart={(ev) => {
        if (!onReorder) return
        dragged = { id: node.entry.id, date: opDate, canvasId }
        ev.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragged))
        ev.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => {
        dragged = null
        setDrop(null)
      }}
      onDragOver={(ev) => onDragOver(ev, node.entry.id)}
      onDragLeave={(ev) => {
        if (!ev.currentTarget.contains(ev.relatedTarget as Node | null) && drop?.id === node.entry.id) setDrop(null)
      }}
      onDrop={(ev) => onDrop(ev, node.entry.id)}
    >
      <InsertGap canvasId={canvasId} date={opDate} position={i === 0 ? { beforeId: node.entry.id } : { afterId: roots[i - 1].entry.id }} onAdd={onAdd} />
      <NoteNode
        node={node}
        canvasId={canvasId}
        canvases={canvases}
        date={opDate}
        editRequest={editRequest}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMove={onMove}
        onNest={onNest}
        onPromote={onPromote}
        onSetHidden={onSetHidden}
        onSetDone={onSetDone}
        onOpenCanvas={onOpenCanvas}
        onOpenBlock={onOpenBlock}
        draggable={Boolean(onReorder)}
      />
    </div>
  )

  return (
    <section className="day-group" data-date={day.date} data-file-date={opDate}>
      <div className="day-divider">
        <span className="day-divider-label">{isToday ? 'Today' : headingFmt.format(parseLocal(day.date))}</span>
      </div>
      {items.map((item) => {
        if (item.kind === 'node') return renderNode(item.node, item.index)
        if (item.kind === 'done') {
          const key = `done:${item.key}`
          const open = revealed.has(key)
          return (
            <div key={key} className="done-run">
              <InsertGap canvasId={canvasId} date={opDate} position={item.index === 0 ? { beforeId: item.key } : { afterId: roots[item.index - 1].entry.id }} onAdd={onAdd} />
              <DoneGroup nodes={item.nodes} open={open} onToggle={() => toggle(key)} />
              {open && item.nodes.map((node, j) => renderNode(node, item.index + j, ' is-done-run'))}
            </div>
          )
        }
        const open = revealed.has(item.key)
        return (
          <div key={`hidden-${item.key}`} className="hidden-run">
            <HiddenGroup count={item.nodes.length} open={open} onToggle={() => toggle(item.key)} />
            {open && item.nodes.map((node, j) => renderNode(node, item.index + j, ' is-hidden'))}
          </div>
        )
      })}
      {!isToday && roots.length > 0 && <InsertGap canvasId={canvasId} date={opDate} position={{ afterId: roots[roots.length - 1].entry.id }} onAdd={onAdd} />}
    </section>
  )
}

/** A block someone wrote (as opposed to an automatic one: a commit, a ticked-off todo). */
function isWritten(entry: Entry): boolean {
  return !entry.kind || entry.kind === 'note' || entry.kind === 'task'
}

export function Feed({
  canvas,
  canvases,
  days,
  hasMore,
  today,
  search,
  hits,
  loading,
  editRequest,
  header,
  onLoadMore,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onNest,
  onPromote,
  onSetHidden,
  onReorder,
  onSetDone,
  onJumpTo,
  onOpenCanvas,
  onOpenBlock,
  fileDate,
  streamParentId,
  emptyText
}: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const lastCanvas = useRef<string | null>(null)
  const pendingRestore = useRef<{ height: number; top: number } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const total = days.reduce((n, d) => n + d.entries.length, 0)
  const last = days[days.length - 1]
  const lastEntry = last?.entries[last.entries.length - 1]
  const place = `${canvas.id}/${streamParentId ?? ''}`
  const key = `${place}:${total}:${lastEntry?.id ?? ''}`
  const lastSeen = useRef<{ total: number; lastId: string | undefined }>({ total: 0, lastId: undefined })

  // "Pinned to the bottom": set when a canvas opens or a block is posted, and
  // kept while content keeps growing (surface loading, images decoding), until
  // the user scrolls up. This is what makes switching canvases land at the end.
  // Anything else (a delete, an edit, a done block from the todo panel, a
  // captured commit) leaves the scroll position alone unless already pinned.
  const pinned = useRef(false)
  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    if (search) return
    const canvasChanged = lastCanvas.current !== place
    const before = lastSeen.current
    lastCanvas.current = place
    lastSeen.current = { total, lastId: lastEntry?.id }
    if (pendingRestore.current) return
    const posted = total > before.total && lastEntry !== undefined && lastEntry.id !== before.lastId && lastEntry.parentId === streamParentId && isWritten(lastEntry)
    if (canvasChanged || posted) {
      pinned.current = true
      requestAnimationFrame(() => scrollToEnd(!canvasChanged))
    }
  }, [key, place, search, total, lastEntry, scrollToEnd, streamParentId])

  useEffect(() => {
    const el = scroller.current
    if (!el || search) return
    const ro = new ResizeObserver(() => {
      if (pinned.current && !pendingRestore.current) el.scrollTop = el.scrollHeight
    })
    for (const child of Array.from(el.children)) ro.observe(child)
    const mo = new MutationObserver(() => {
      for (const child of Array.from(el.children)) ro.observe(child)
    })
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [search, place])

  // After loading older days, keep the viewport where it was.
  useLayoutEffect(() => {
    const el = scroller.current
    const pending = pendingRestore.current
    if (!el || !pending) return
    el.scrollTop = pending.top + (el.scrollHeight - pending.height)
    pendingRestore.current = null
  }, [days])

  const loadMore = async (): Promise<void> => {
    const el = scroller.current
    if (!el || loadingMore || !hasMore) return
    setLoadingMore(true)
    pendingRestore.current = { height: el.scrollHeight, top: el.scrollTop }
    try {
      await onLoadMore()
    } finally {
      setLoadingMore(false)
    }
  }

  if (search) {
    const labelOf = (id: string): string => canvasLabel(canvases, id)
    const count = hits ? hits.blocks.length + hits.surfaces.length : 0
    return (
      <div className="feed" ref={scroller}>
        <header className="feed-head">
          <h2>Search: “{search}”</h2>
          <span className="feed-sub">{hits ? `${count} result${count === 1 ? '' : 's'} across every canvas, archived included` : 'Searching…'}</span>
        </header>
        {hits && count === 0 && <p className="feed-empty">Nothing matched.</p>}
        {hits?.surfaces.map((w) => (
          <div key={`surface/${w.canvasId}`} className="hit hit-wiki">
            <button type="button" className="hit-day" onClick={() => onOpenCanvas(w.canvasId)}>
              ▤ {labelOf(w.canvasId)} · surface{w.archived ? ' · archived' : ''}
            </button>
            <p className="hit-excerpt">{w.excerpt}</p>
          </div>
        ))}
        {hits?.blocks.map((h) => (
          <div key={`${h.canvasId}/${h.date}/${h.entry.id}`} className="hit">
            <button
              type="button"
              className="hit-day"
              onClick={() => (h.entry.parentId && onOpenBlock ? onOpenBlock(h.canvasId, h.date, h.entry.parentId) : onJumpTo(h.canvasId, h.date))}
            >
              {labelOf(h.canvasId)} · {headingFmt.format(parseLocal(h.date))}
              {h.entry.parentId ? ' · inside a block' : ''}
              {h.archived ? ' · archived' : ''}
            </button>
            <EntryView
              canvasId={h.canvasId}
              date={h.date}
              entry={h.entry}
              showDate
              onUpdate={onUpdate}
              onDelete={onDelete}
              onOpenCanvas={onOpenCanvas}
              onOpen={onOpenBlock ? () => onOpenBlock(h.canvasId, h.date, h.entry.id) : undefined}
            />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div
      className="feed"
      ref={scroller}
      onScroll={(ev) => {
        const el = ev.currentTarget
        // Scrolling away from the end releases the pin; reaching it again restores it.
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        if (hasMore && !loadingMore && el.scrollTop < 120) void loadMore()
      }}
    >
      {header}
      {hasMore && (
        <div className="load-more">
          <button type="button" className="btn btn-quiet btn-xs" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Show earlier blocks'}
          </button>
        </div>
      )}
      {loading && days.length === 0 && <p className="feed-empty">Loading…</p>}
      {!loading && days.length === 0 && (
        <p className="feed-empty">{emptyText ?? (canvas.id === JOURNAL_ID ? 'No blocks yet.' : `Nothing on ${canvas.title} yet. Write the first block below.`)}</p>
      )}
      {days.map((day, i) => (
        <DayGroup
          key={fileDate ? `${day.date}:${i}` : day.date}
          day={day}
          fileDate={fileDate}
          isToday={day.date === today}
          canvasId={canvas.id}
          canvases={canvases}
          editRequest={editRequest}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onMove={onMove}
          onNest={onNest}
          onPromote={onPromote}
          onSetHidden={onSetHidden}
          onReorder={onReorder}
          onSetDone={onSetDone}
          onOpenCanvas={onOpenCanvas}
          onOpenBlock={onOpenBlock}
        />
      ))}
    </div>
  )
}
