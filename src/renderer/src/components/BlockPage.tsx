import { useMemo } from 'react'
import { ancestorIds, canvasLabel, localDate, previewText } from '@devlog/core'
import type { CanvasMeta, Day, Entry, EntryPosition } from '@shared/types'
import { kbd } from '@renderer/keys'
import { Feed } from './Feed'
import { EntryView } from './EntryView'
import { TaskControl } from './CanvasView'

interface Props {
  canvas: CanvasMeta
  canvases: CanvasMeta[]
  /** The day file the block lives in (with everything inside it); null while loading. */
  day: Day | null
  blockId: string
  today: string
  editRequest: string | null
  activeCanvasId: string | null
  tracking: boolean
  onStartTask: () => void
  onStopTask: () => void
  onCanvasMenu: (canvasId: string, x: number, y: number) => void
  onAdd: (canvasId: string, markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (canvasId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (canvasId: string, date: string, id: string) => Promise<void>
  onMove: (canvasId: string, date: string, id: string, toCanvasId: string) => Promise<void>
  onNest: (canvasId: string, date: string, id: string, to: { date: string; parentId?: string; afterId?: string }) => Promise<void>
  onPromote: (canvasId: string, date: string, id: string) => Promise<void>
  onSetHidden: (canvasId: string, date: string, id: string, hidden: boolean) => Promise<void>
  onSetDone: (canvasId: string, date: string, id: string, done: boolean) => Promise<void>
  onReorder: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }) => Promise<void>
  onOpenCanvas: (id: string) => void
  onOpenBlock: (canvasId: string, date: string, id: string) => void
  /** Up a level: the block this one is inside, or the canvas. */
  onUp: () => void
}

/** A block's title for breadcrumbs: its first line, shortened. */
export function blockTitle(entry: Entry, max = 60): string {
  return previewText(entry.markdown, max) || 'Untitled block'
}

/**
 * A block as a page: the block itself at the top (its surface: double-click
 * to edit), and the blocks written inside it below, grouped by the day each
 * was written. They all live in the block's own day file.
 */
export function BlockPage(props: Props): React.JSX.Element {
  const { canvas, canvases, day, blockId, today, editRequest, activeCanvasId, onOpenCanvas, onOpenBlock, onUp } = props
  const entries = day?.entries ?? []
  const block = entries.find((e) => e.id === blockId)

  // The chain of blocks above this one, outermost first.
  const trail = useMemo(() => {
    const byId = new Map(entries.map((e) => [e.id, e]))
    const out: Entry[] = []
    const seen = new Set<string>([blockId])
    let cur = block?.parentId ? byId.get(block.parentId) : undefined
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      out.unshift(cur)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    return out
  }, [entries, block, blockId])

  // Children with everything inside them, grouped by the day each child was written.
  const { groups, inside } = useMemo(() => {
    const kids = new Map<string, Entry[]>()
    for (const e of entries) {
      if (!e.parentId) continue
      const list = kids.get(e.parentId) ?? []
      list.push(e)
      kids.set(e.parentId, list)
    }
    const subtree = (e: Entry, seen: Set<string>): Entry[] => {
      if (seen.has(e.id)) return []
      seen.add(e.id)
      return [e, ...(kids.get(e.id) ?? []).flatMap((c) => subtree(c, seen))]
    }
    const seen = new Set<string>([blockId])
    const out: Day[] = []
    let count = 0
    for (const child of kids.get(blockId) ?? []) {
      const list = subtree(child, seen)
      count += list.length
      const date = localDate(new Date(child.createdAt))
      const last = out[out.length - 1]
      if (last && last.date === date) last.entries.push(...list)
      else out.push({ date, entries: list })
    }
    return { groups: out, inside: count }
  }, [entries, blockId])

  const crumbs = useMemo(() => [...ancestorIds(canvases, canvas.id).reverse(), canvas.id], [canvases, canvas.id])

  const header = (
    <header className="feed-head page-head block-page-head">
      <div className="page-head-row">
        <h2 className="breadcrumbs">
          {crumbs.map((id) => (
            <span key={id}>
              <button
                type="button"
                className="crumb"
                onClick={() => onOpenCanvas(id)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  props.onCanvasMenu(id, ev.clientX, ev.clientY)
                }}
              >
                {canvasLabel(canvases, id).split(' / ').pop()}
              </button>
              <span className="crumb-sep"> / </span>
            </span>
          ))}
          {day &&
            trail.map((e) => (
              <span key={e.id}>
                <button type="button" className="crumb crumb-block" onClick={() => onOpenBlock(canvas.id, day.date, e.id)}>
                  {blockTitle(e, 30)}
                </button>
                <span className="crumb-sep"> / </span>
              </span>
            ))}
          <span className="crumb is-current">{block ? blockTitle(block, 50) : '…'}</span>
        </h2>
        <TaskControl canvas={canvas} activeCanvasId={activeCanvasId} tracking={props.tracking} onStart={props.onStartTask} onStop={props.onStopTask} />
        <span className="spacer" />
        <button type="button" className="btn btn-quiet btn-xs block-up" onClick={onUp} title={`Up a level (${kbd('alt', '↑')})`}>
          ↑ Up
        </button>
      </div>
      {day && block && (
        <div className="block-surface">
          <EntryView
            canvasId={canvas.id}
            date={day.date}
            entry={block}
            surface
            showDate
            replyCount={inside}
            forceEdit={editRequest === block.id}
            canvases={canvases}
            onUpdate={props.onUpdate}
            onDelete={async (c, d, id) => {
              await props.onDelete(c, d, id)
              onUp()
            }}
            onMove={
              block.parentId
                ? undefined
                : async (c, d, id, to) => {
                    await props.onMove(c, d, id, to)
                    onOpenCanvas(to)
                  }
            }
            onNest={props.onNest}
            onPromote={props.onPromote}
            onSetDone={props.onSetDone}
            onOpenCanvas={onOpenCanvas}
          />
        </div>
      )}
      {day && !block && <p className="feed-empty">This block is no longer here.</p>}
    </header>
  )

  return (
    <Feed
      canvas={canvas}
      canvases={canvases}
      days={groups}
      hasMore={false}
      today={today}
      search=""
      hits={null}
      loading={!day}
      editRequest={editRequest}
      header={header}
      fileDate={day?.date}
      streamParentId={blockId}
      emptyText={canvas.archived ? 'Nothing inside this block.' : 'Nothing inside yet. What you write below goes inside this block.'}
      onLoadMore={async () => undefined}
      onAdd={props.onAdd}
      onUpdate={props.onUpdate}
      onDelete={props.onDelete}
      onMove={props.onMove}
      onNest={props.onNest}
      onPromote={props.onPromote}
      onSetHidden={props.onSetHidden}
      onSetDone={props.onSetDone}
      onReorder={props.onReorder}
      onJumpTo={(id) => onOpenCanvas(id)}
      onOpenCanvas={onOpenCanvas}
      onOpenBlock={onOpenBlock}
    />
  )
}
