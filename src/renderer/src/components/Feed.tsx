import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { buildTree, type EntryNode } from '@shared/entries'
import { JOURNAL_ID, canvasLabel } from '@shared/canvases'
import type { CanvasMeta, Day, EntryPosition, SearchResult } from '@shared/types'
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
  onPromote?: (canvasId: string, date: string, id: string) => Promise<void>
  onJumpTo: (canvasId: string, date: string) => void
  onOpenCanvas: (id: string) => void
}

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
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
  onPromote?: Props['onPromote']
  onOpenCanvas: Props['onOpenCanvas']
}

function NoteNode({ node, canvasId, canvases, date, editRequest, onAdd, onUpdate, onDelete, onMove, onPromote, onOpenCanvas }: NodeProps): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const replies = countDescendants(node)
  return (
    <div className={`note depth-${Math.min(node.depth, 4)}`}>
      <EntryView
        canvasId={canvasId}
        date={date}
        entry={node.entry}
        replyCount={replies}
        forceEdit={editRequest === node.entry.id}
        canvases={canvases}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMove={onMove}
        onPromote={onPromote}
        onOpenCanvas={onOpenCanvas}
        onReply={() => setReplying(true)}
      />
      {(node.children.length > 0 || replying) && (
        <div className="thread">
          {node.children.map((child) => (
            <NoteNode
              key={child.entry.id}
              node={child}
              canvasId={canvasId}
              canvases={canvases}
              date={date}
              editRequest={editRequest}
              onAdd={onAdd}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onMove={onMove}
              onPromote={onPromote}
              onOpenCanvas={onOpenCanvas}
            />
          ))}
          {replying && (
            <div className="reply-composer">
              <Composer
                mode="reply"
                assetCanvasId={canvasId}
                assetDate={date}
                autoFocus
                onSubmit={async (md) => {
                  await onAdd(canvasId, md, { date, parentId: node.entry.id })
                  setReplying(false)
                }}
                onCancel={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DayGroup({
  day,
  isToday,
  canvasId,
  canvases,
  editRequest,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onPromote,
  onOpenCanvas
}: {
  day: Day
  isToday: boolean
  canvasId: string
  canvases: CanvasMeta[]
  editRequest: string | null
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
  onPromote?: Props['onPromote']
  onOpenCanvas: Props['onOpenCanvas']
}): React.JSX.Element {
  const roots = buildTree(day.entries)
  return (
    <section className="day-group" data-date={day.date}>
      <div className="day-divider">
        <span className="day-divider-label">{isToday ? 'Today' : headingFmt.format(parseLocal(day.date))}</span>
      </div>
      {roots.map((node, i) => (
        <div key={node.entry.id} className="note-slot">
          <InsertGap canvasId={canvasId} date={day.date} position={i === 0 ? { beforeId: node.entry.id } : { afterId: roots[i - 1].entry.id }} onAdd={onAdd} />
          <NoteNode
            node={node}
            canvasId={canvasId}
            canvases={canvases}
            date={day.date}
            editRequest={editRequest}
            onAdd={onAdd}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onMove={onMove}
            onPromote={onPromote}
            onOpenCanvas={onOpenCanvas}
          />
        </div>
      ))}
      {!isToday && roots.length > 0 && <InsertGap canvasId={canvasId} date={day.date} position={{ afterId: roots[roots.length - 1].entry.id }} onAdd={onAdd} />}
    </section>
  )
}

export function Feed({ canvas, canvases, days, hasMore, today, search, hits, loading, editRequest, header, onLoadMore, onAdd, onUpdate, onDelete, onMove, onPromote, onJumpTo, onOpenCanvas }: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const lastCanvas = useRef<string | null>(null)
  const lastKey = useRef<string>('')
  const pendingRestore = useRef<{ height: number; top: number } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const total = days.reduce((n, d) => n + d.entries.length, 0)
  const last = days[days.length - 1]
  const lastEntry = last?.entries[last.entries.length - 1]
  const key = `${canvas.id}:${total}:${lastEntry?.id ?? ''}`

  // Scroll to the bottom on canvas change and when a new block is appended to the newest day.
  useEffect(() => {
    if (search) return
    const el = scroller.current
    if (!el) return
    const canvasChanged = lastCanvas.current !== canvas.id
    const changed = lastKey.current !== key
    lastCanvas.current = canvas.id
    lastKey.current = key
    if (pendingRestore.current) return
    if (canvasChanged || (changed && lastEntry && !lastEntry.parentId)) {
      requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: canvasChanged ? 'auto' : 'smooth' }))
    }
  }, [key, canvas.id, search, lastEntry])

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
            <button type="button" className="hit-day" onClick={() => onJumpTo(h.canvasId, h.date)}>
              {labelOf(h.canvasId)} · {headingFmt.format(parseLocal(h.date))}
              {h.entry.parentId ? ' · in thread' : ''}
              {h.archived ? ' · archived' : ''}
            </button>
            <EntryView canvasId={h.canvasId} date={h.date} entry={h.entry} showDate onUpdate={onUpdate} onDelete={onDelete} onOpenCanvas={onOpenCanvas} />
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
        if (hasMore && !loadingMore && ev.currentTarget.scrollTop < 120) void loadMore()
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
        <p className="feed-empty">{canvas.id === JOURNAL_ID ? 'No blocks yet. Write something below.' : `Nothing on ${canvas.title} yet. Write the first block below.`}</p>
      )}
      {days.map((day) => (
        <DayGroup
          key={day.date}
          day={day}
          isToday={day.date === today}
          canvasId={canvas.id}
          canvases={canvases}
          editRequest={editRequest}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onMove={onMove}
          onPromote={onPromote}
          onOpenCanvas={onOpenCanvas}
        />
      ))}
    </div>
  )
}
