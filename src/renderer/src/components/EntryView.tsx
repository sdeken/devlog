import { memo, useEffect, useMemo, useState } from 'react'
import type { CanvasMeta, Entry } from '@shared/types'
import { canvasLabel } from '@devlog/core'
import { renderMarkdown } from '@renderer/markdown'
import { parseDurationMarker } from '@devlog/core'
import { formatMinutes } from '@shared/review'
import { api } from '@renderer/api'
import { Composer } from './Composer'
import { Lightbox } from './Lightbox'

interface Props {
  canvasId: string
  date: string
  entry: Entry
  showDate?: boolean
  /** Number of replies beneath this note (deleted or moved together with it). */
  replyCount?: number
  /** When true the note opens in edit mode (Up arrow in the composer). */
  forceEdit?: boolean
  /** Every canvas, for the move picker and task labels. */
  canvases?: CanvasMeta[]
  onUpdate: (canvasId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (canvasId: string, date: string, id: string) => Promise<void>
  onMove?: (canvasId: string, date: string, id: string, toCanvasId: string) => Promise<void>
  /** Turn this block into a task (a task canvas beneath this one). */
  onPromote?: (canvasId: string, date: string, id: string) => Promise<void>
  onSetHidden?: (canvasId: string, date: string, id: string, hidden: boolean) => Promise<void>
  onOpenCanvas?: (id: string) => void
  onReply?: () => void
  /** Show a drag grip (the enclosing slot handles the drag events). */
  draggable?: boolean
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

function handleContentClick(ev: React.MouseEvent<HTMLDivElement>, openImage: (src: string, alt: string) => void): void {
  const el = ev.target as HTMLElement
  const img = el.closest('img')
  if (img && img.getAttribute('data-lightbox')) {
    ev.preventDefault()
    openImage(img.getAttribute('src') ?? '', img.getAttribute('alt') ?? '')
    return
  }
  const target = el.closest('a')
  if (!target) return
  const href = target.getAttribute('href')
  if (!href) return
  ev.preventDefault()
  void api.shell.openExternal(href)
}

export const EntryView = memo(function EntryView({
  canvasId,
  date,
  entry,
  showDate,
  replyCount = 0,
  forceEdit,
  canvases,
  onUpdate,
  onDelete,
  onMove,
  onPromote,
  onSetHidden,
  onOpenCanvas,
  onReply,
  draggable
}: Props) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moving, setMoving] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const html = useMemo(() => renderMarkdown(entry.markdown), [entry.markdown])
  const created = new Date(entry.createdAt)

  useEffect(() => {
    if (forceEdit) setEditing(true)
  }, [forceEdit])

  const timeLabel = showDate ? dateTimeFmt.format(created) : timeFmt.format(created)
  const targets = (canvases ?? []).filter((c) => c.id !== canvasId && !c.archived)
  const readOnly = entry.kind === 'commit' || entry.kind === 'done'
  const isTask = entry.kind === 'task'
  const taskCanvasId = isTask ? entry.meta?.canvas : undefined
  const taskLabel = taskCanvasId && canvases ? canvasLabel(canvases, taskCanvasId).split(' / ').pop() : undefined
  const duration = readOnly ? null : parseDurationMarker(entry.markdown)

  if (editing) {
    return (
      <article className="entry entry-editing" id={`entry-${entry.id}`}>
        <header className="entry-meta">
          <time dateTime={entry.createdAt}>{timeLabel}</time>
          <span className="entry-editing-label">editing</span>
        </header>
        <Composer
          mode="edit"
          initialMarkdown={entry.markdown}
          assetCanvasId={canvasId}
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onUpdate(canvasId, date, entry.id, md)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </article>
    )
  }

  return (
    <article
      className={`entry${readOnly ? ' entry-commit' : ''}${isTask ? ' entry-task' : ''}${entry.hidden ? ' entry-hidden' : ''}${showDate ? ' entry-dated' : ''}${confirmDelete || moving ? ' is-busy' : ''}`}
      id={`entry-${entry.id}`}
      onDoubleClick={(ev) => {
        // Double-click on the text edits the note, unless the user is selecting text.
        if (readOnly) return
        if ((ev.target as HTMLElement).closest('a, img, button, select')) return
        if (!window.getSelection()?.isCollapsed) return
        setEditing(true)
      }}
    >
      {readOnly && <span className="entry-brace brace-auto" title={entry.kind === 'done' ? 'Written when the todo was ticked off; read-only' : `Captured automatically from ${entry.meta?.repo ?? 'git'}; read-only`} aria-label="Automatic block" />}
      {isTask && taskCanvasId && (
        <button
          type="button"
          className="entry-brace brace-task"
          onClick={() => onOpenCanvas?.(taskCanvasId)}
          title={`Task: ${taskLabel ?? 'open the task canvas'}`}
          aria-label={`Open task ${taskLabel ?? ''}`}
        />
      )}
      <header className="entry-meta">
        {draggable && !entry.parentId && (
          <span className="entry-grip" draggable title="Drag to reorder within the day" aria-label="Drag handle">
            ⋮⋮
          </span>
        )}
        <time dateTime={entry.createdAt} title={created.toLocaleString()}>
          {timeLabel}
        </time>
        {isTask && taskCanvasId && (
          <button type="button" className="task-chip" onClick={() => onOpenCanvas?.(taskCanvasId)} title="Open the task canvas">
            ◉ {taskLabel ?? 'task'}
          </button>
        )}
        {duration !== null && (
          <span className="duration-chip" title="Explicit duration: counts exactly this much for this canvas">
            {formatMinutes(duration)}
          </span>
        )}
        {entry.updatedAt && (
          <span className="entry-edited" title={`Edited ${new Date(entry.updatedAt).toLocaleString()}`}>
            (edited)
          </span>
        )}
        <span className="spacer" />
        <div className="entry-actions">
          {confirmDelete ? (
            <>
              <span className="entry-confirm">
                {replyCount > 0 ? `Delete this block and ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}?` : 'Delete this block?'}
              </span>
              <button type="button" className="btn btn-danger btn-xs" onClick={() => void onDelete(canvasId, date, entry.id)}>
                Delete
              </button>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : moving ? (
            <>
              <span className="entry-confirm">Move {replyCount > 0 ? 'thread' : 'block'} to</span>
              <select
                autoFocus
                className="move-select"
                defaultValue=""
                onChange={(ev) => {
                  const to = ev.target.value
                  setMoving(false)
                  if (to && onMove) void onMove(canvasId, date, entry.id, to)
                }}
                onBlur={() => setMoving(false)}
              >
                <option value="" disabled>
                  Choose a canvas…
                </option>
                {targets.map((c) => (
                  <option key={c.id} value={c.id}>
                    {canvasLabel(canvases ?? [], c.id)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              {onReply && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={onReply} title="Reply in thread">
                  Reply
                </button>
              )}
              {!readOnly && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setEditing(true)} title="Edit (or double-click)">
                  Edit
                </button>
              )}
              {onPromote && !readOnly && !isTask && !entry.parentId && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => void onPromote(canvasId, date, entry.id)} title="Turn this block into a task with its own canvas, and start the clock">
                  Task
                </button>
              )}
              {onMove && targets.length > 0 && !entry.parentId && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setMoving(true)} title="Move to another canvas">
                  Move
                </button>
              )}
              <button
                type="button"
                className="btn btn-quiet btn-xs"
                onClick={() => void navigator.clipboard.writeText(entry.markdown)}
                title="Copy markdown"
              >
                Copy
              </button>
              {onSetHidden && !entry.parentId && (
                <button
                  type="button"
                  className="btn btn-quiet btn-xs"
                  onClick={() => void onSetHidden(canvasId, date, entry.id, !entry.hidden)}
                  title={entry.hidden ? 'Show this block in the stream again' : 'Collapse this block (and its thread) into a stub; nothing is deleted'}
                >
                  {entry.hidden ? 'Unhide' : 'Hide'}
                </button>
              )}
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(true)} title="Delete">
                Delete
              </button>
            </>
          )}
        </div>
      </header>
      <div className="entry-body markdown-body" onClick={(ev) => handleContentClick(ev, (src, alt) => setLightbox({ src, alt }))} dangerouslySetInnerHTML={{ __html: html }} />
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </article>
  )
})
