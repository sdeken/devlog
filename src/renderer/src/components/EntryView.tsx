import { memo, useEffect, useMemo, useState } from 'react'
import type { Entry, PageMeta } from '@shared/types'
import { renderMarkdown } from '@renderer/markdown'
import { api } from '@renderer/api'
import { Composer } from './Composer'

interface Props {
  pageId: string
  date: string
  entry: Entry
  showDate?: boolean
  /** Number of replies beneath this note (deleted or moved together with it). */
  replyCount?: number
  /** When true the note opens in edit mode (Up arrow in the composer). */
  forceEdit?: boolean
  /** Other pages this note can be moved to. */
  pages?: PageMeta[]
  onUpdate: (pageId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (pageId: string, date: string, id: string) => Promise<void>
  onMove?: (pageId: string, date: string, id: string, toPageId: string) => Promise<void>
  onReply?: () => void
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

function handleContentClick(ev: React.MouseEvent<HTMLDivElement>): void {
  const target = (ev.target as HTMLElement).closest('a')
  if (!target) return
  const href = target.getAttribute('href')
  if (!href) return
  ev.preventDefault()
  void api.shell.openExternal(href)
}

export const EntryView = memo(function EntryView({
  pageId,
  date,
  entry,
  showDate,
  replyCount = 0,
  forceEdit,
  pages,
  onUpdate,
  onDelete,
  onMove,
  onReply
}: Props) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [moving, setMoving] = useState(false)
  const html = useMemo(() => renderMarkdown(entry.markdown), [entry.markdown])
  const created = new Date(entry.createdAt)

  useEffect(() => {
    if (forceEdit) setEditing(true)
  }, [forceEdit])

  const timeLabel = showDate ? dateTimeFmt.format(created) : timeFmt.format(created)
  const targets = (pages ?? []).filter((p) => p.id !== pageId)

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
          assetPageId={pageId}
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onUpdate(pageId, date, entry.id, md)
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      </article>
    )
  }

  return (
    <article
      className="entry"
      id={`entry-${entry.id}`}
      onDoubleClick={(ev) => {
        // Double-click on the text edits the note, unless the user is selecting text.
        if ((ev.target as HTMLElement).closest('a, img, button, select')) return
        if (!window.getSelection()?.isCollapsed) return
        setEditing(true)
      }}
    >
      <header className="entry-meta">
        <time dateTime={entry.createdAt} title={created.toLocaleString()}>
          {timeLabel}
        </time>
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
                {replyCount > 0 ? `Delete this note and ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}?` : 'Delete this note?'}
              </span>
              <button type="button" className="btn btn-danger btn-xs" onClick={() => void onDelete(pageId, date, entry.id)}>
                Delete
              </button>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : moving ? (
            <>
              <span className="entry-confirm">Move {replyCount > 0 ? 'thread' : 'note'} to</span>
              <select
                autoFocus
                className="move-select"
                defaultValue=""
                onChange={(ev) => {
                  const to = ev.target.value
                  setMoving(false)
                  if (to && onMove) void onMove(pageId, date, entry.id, to)
                }}
                onBlur={() => setMoving(false)}
              >
                <option value="" disabled>
                  Choose a page…
                </option>
                {targets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.category ? `${p.category} / ` : ''}
                    {p.title}
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
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setEditing(true)} title="Edit (or double-click)">
                Edit
              </button>
              {onMove && targets.length > 0 && !entry.parentId && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setMoving(true)} title="Move to another page">
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
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(true)} title="Delete">
                Delete
              </button>
            </>
          )}
        </div>
      </header>
      <div className="entry-body markdown-body" onClick={handleContentClick} dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  )
})
