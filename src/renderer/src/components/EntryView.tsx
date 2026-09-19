import { memo, useMemo, useState } from 'react'
import type { Entry } from '@shared/types'
import { renderMarkdown } from '@renderer/markdown'
import { api } from '@renderer/api'
import { Composer } from './Composer'

interface Props {
  date: string
  entry: Entry
  showDate?: boolean
  onUpdate: (date: string, id: string, markdown: string) => Promise<void>
  onDelete: (date: string, id: string) => Promise<void>
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

export const EntryView = memo(function EntryView({ date, entry, showDate, onUpdate, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const html = useMemo(() => renderMarkdown(entry.markdown), [entry.markdown])
  const created = new Date(entry.createdAt)

  if (editing) {
    return (
      <article className="entry entry-editing" id={`entry-${entry.id}`}>
        <header className="entry-meta">
          <time dateTime={entry.createdAt}>{showDate ? dateTimeFmt.format(created) : timeFmt.format(created)}</time>
          <span className="entry-editing-label">Editing</span>
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
    <article className="entry" id={`entry-${entry.id}`}>
      <header className="entry-meta">
        <time dateTime={entry.createdAt} title={created.toLocaleString()}>
          {showDate ? dateTimeFmt.format(created) : timeFmt.format(created)}
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
              <span className="entry-confirm">Delete this entry?</span>
              <button type="button" className="btn btn-danger btn-xs" onClick={() => void onDelete(date, entry.id)}>
                Delete
              </button>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setEditing(true)} title="Edit entry">
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
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmDelete(true)} title="Delete entry">
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
