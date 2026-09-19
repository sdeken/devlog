import { useEffect, useRef, useState } from 'react'
import { buildTree, type EntryNode } from '@shared/entries'
import type { Day, EntryPosition, SearchHit } from '@shared/types'
import { Composer } from './Composer'
import { EntryView } from './EntryView'

interface Props {
  day: Day | null
  today: string
  search: string
  hits: SearchHit[] | null
  loading: boolean
  /** Id of the entry that should open in edit mode, if any. */
  editRequest: string | null
  onAdd: (markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (date: string, id: string, markdown: string) => Promise<void>
  onDelete: (date: string, id: string) => Promise<void>
  onJumpToDay: (date: string) => void
}

const headingFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function countDescendants(node: EntryNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0)
}

/** Thin hover target between two notes that expands into an inline composer. */
function InsertGap({ date, position, onAdd }: { date: string; position: EntryPosition; onAdd: Props['onAdd'] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (open) {
    return (
      <div className="gap gap-open">
        <Composer
          mode="insert"
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onAdd(md, { date, ...position })
            setOpen(false)
          }}
          onCancel={() => setOpen(false)}
        />
      </div>
    )
  }
  return (
    <div className="gap" role="presentation">
      <button type="button" className="gap-add" title="Insert a note here" onClick={() => setOpen(true)}>
        +
      </button>
    </div>
  )
}

function NoteNode({
  node,
  date,
  editRequest,
  onAdd,
  onUpdate,
  onDelete
}: {
  node: EntryNode
  date: string
  editRequest: string | null
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
}): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const replies = countDescendants(node)
  return (
    <div className={`note depth-${Math.min(node.depth, 4)}`}>
      <EntryView
        date={date}
        entry={node.entry}
        replyCount={replies}
        forceEdit={editRequest === node.entry.id}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onReply={() => setReplying(true)}
      />
      {(node.children.length > 0 || replying) && (
        <div className="thread">
          {node.children.map((child) => (
            <NoteNode key={child.entry.id} node={child} date={date} editRequest={editRequest} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />
          ))}
          {replying && (
            <div className="reply-composer">
              <Composer
                mode="reply"
                assetDate={date}
                autoFocus
                onSubmit={async (md) => {
                  await onAdd(md, { date, parentId: node.entry.id })
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

export function Feed({ day, today, search, hits, loading, editRequest, onAdd, onUpdate, onDelete, onJumpToDay }: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)
  const lastDate = useRef<string | null>(null)

  // Keep the newest entry in view when posting to the day being displayed.
  useEffect(() => {
    if (!day || search) return
    const el = scroller.current
    if (!el) return
    const dateChanged = lastDate.current !== day.date
    const appended = day.entries.length > lastCount.current && !day.entries[day.entries.length - 1]?.parentId
    lastDate.current = day.date
    lastCount.current = day.entries.length
    if (dateChanged || appended) {
      requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: dateChanged ? 'auto' : 'smooth' }))
    }
  }, [day, search])

  if (search) {
    return (
      <div className="feed" ref={scroller}>
        <header className="feed-head">
          <h2>Search: “{search}”</h2>
          <span className="feed-sub">{hits ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'Searching…'}</span>
        </header>
        {hits && hits.length === 0 && <p className="feed-empty">Nothing matched.</p>}
        {hits?.map((h) => (
          <div key={`${h.date}/${h.entry.id}`} className="hit">
            <button type="button" className="hit-day" onClick={() => onJumpToDay(h.date)}>
              {headingFmt.format(parseLocal(h.date))}
              {h.entry.parentId ? ' · in thread' : ''}
            </button>
            <EntryView date={h.date} entry={h.entry} showDate onUpdate={onUpdate} onDelete={onDelete} />
          </div>
        ))}
      </div>
    )
  }

  if (!day) {
    return (
      <div className="feed" ref={scroller}>
        {loading ? <p className="feed-empty">Loading…</p> : null}
      </div>
    )
  }

  const isToday = day.date === today
  const roots = buildTree(day.entries)
  return (
    <div className="feed" ref={scroller}>
      <header className="feed-head">
        <h2>{isToday ? 'Today' : headingFmt.format(parseLocal(day.date))}</h2>
        <span className="feed-sub">
          {isToday ? headingFmt.format(parseLocal(day.date)) : ''}
          {day.entries.length > 0 ? ` · ${day.entries.length} note${day.entries.length === 1 ? '' : 's'}` : ''}
        </span>
      </header>
      {day.entries.length === 0 && (
        <p className="feed-empty">{isToday ? 'No notes yet today. Write something below.' : 'No notes on this day.'}</p>
      )}
      {roots.map((node, i) => (
        <div key={node.entry.id} className="note-slot">
          <InsertGap date={day.date} position={i === 0 ? { beforeId: node.entry.id } : { afterId: roots[i - 1].entry.id }} onAdd={onAdd} />
          <NoteNode node={node} date={day.date} editRequest={editRequest} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} />
        </div>
      ))}
      {!isToday && roots.length > 0 && (
        <InsertGap date={day.date} position={{ afterId: roots[roots.length - 1].entry.id }} onAdd={onAdd} />
      )}
    </div>
  )
}
