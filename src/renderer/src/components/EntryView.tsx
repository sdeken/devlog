import { memo, useEffect, useMemo, useState } from 'react'
import type { Entry } from '@shared/types'
import { renderMarkdown } from '@renderer/markdown'
import { api } from '@renderer/api'
import { Composer } from './Composer'

interface Props {
  date: string
  entry: Entry
  showDate?: boolean
  /** Number of replies beneath this note (deleted together with it). */
  replyCount?: number
  /** When true the note opens in edit mode (Up arrow in the composer). */
  forceEdit?: boolean
  onUpdate: (date: string, id: string, markdown: string) => Promise<void>
  onDelete: (date: string, id: string) => Promise<void>
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
  date,
  entry,
  showDate,
  replyCount = 0,
  forceEdit,
  onUpdate,
  onDelete,
  onReply
}: Props) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const html = useMemo(() => renderMarkdown(entry.markdown), [entry.markdown])
  const created = new Date(entry.createdAt)

  useEffect(() => {
    if (forceEdit) setEditing(true)
  }, [forceEdit])

  const timeLabel = showDate ? dateTimeFmt.format(created) : timeFmt.format(created)

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
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onUpdate(date, entry.id, md)
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
        if ((ev.target as HTMLElement).closest('a, img, button')) return
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
              <button type="button" className="btn btn-danger btn-xs" onClick={() => void onDelete(date, entry.id)}>
                Delete
              </button>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
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
