import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { buildTree, type EntryNode } from '@shared/entries'
import { JOURNAL_PAGE_ID } from '@shared/pages'
import type { Day, EntryPosition, PageMeta, SearchResult } from '@shared/types'
import { categoryPath, formatCategory } from '@shared/pages'
import { renderMarkdown } from '@renderer/markdown'
import { Composer } from './Composer'
import { EntryView } from './EntryView'

interface Props {
  page: PageMeta
  pages: PageMeta[]
  days: Day[]
  hasMore: boolean
  today: string
  search: string
  hits: SearchResult | null
  loading: boolean
  /** Id of the entry that should open in edit mode, if any. */
  editRequest: string | null
  onLoadMore: () => Promise<void>
  onAdd: (pageId: string, markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (pageId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (pageId: string, date: string, id: string) => Promise<void>
  onMove: (pageId: string, date: string, id: string, toPageId: string) => Promise<void>
  onEditPage: () => void
  onArchivePage: (archived: boolean) => void
  onJumpTo: (pageId: string, date: string) => void
  onOpenCategory: (path: string[]) => void
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
function InsertGap({
  pageId,
  date,
  position,
  onAdd
}: {
  pageId: string
  date: string
  position: EntryPosition
  onAdd: Props['onAdd']
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (open) {
    return (
      <div className="gap gap-open">
        <Composer
          mode="insert"
          assetPageId={pageId}
          assetDate={date}
          autoFocus
          onSubmit={async (md) => {
            await onAdd(pageId, md, { date, ...position })
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

interface NodeProps {
  node: EntryNode
  pageId: string
  pages: PageMeta[]
  date: string
  editRequest: string | null
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
}

function NoteNode({ node, pageId, pages, date, editRequest, onAdd, onUpdate, onDelete, onMove }: NodeProps): React.JSX.Element {
  const [replying, setReplying] = useState(false)
  const replies = countDescendants(node)
  return (
    <div className={`note depth-${Math.min(node.depth, 4)}`}>
      <EntryView
        pageId={pageId}
        date={date}
        entry={node.entry}
        replyCount={replies}
        forceEdit={editRequest === node.entry.id}
        pages={pages.filter((p) => !p.archived)}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onMove={onMove}
        onReply={() => setReplying(true)}
      />
      {(node.children.length > 0 || replying) && (
        <div className="thread">
          {node.children.map((child) => (
            <NoteNode
              key={child.entry.id}
              node={child}
              pageId={pageId}
              pages={pages}
              date={date}
              editRequest={editRequest}
              onAdd={onAdd}
              onUpdate={onUpdate}
              onDelete={onDelete}
              onMove={onMove}
            />
          ))}
          {replying && (
            <div className="reply-composer">
              <Composer
                mode="reply"
                assetPageId={pageId}
                assetDate={date}
                autoFocus
                onSubmit={async (md) => {
                  await onAdd(pageId, md, { date, parentId: node.entry.id })
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
  pageId,
  pages,
  editRequest,
  onAdd,
  onUpdate,
  onDelete,
  onMove
}: {
  day: Day
  isToday: boolean
  pageId: string
  pages: PageMeta[]
  editRequest: string | null
  onAdd: Props['onAdd']
  onUpdate: Props['onUpdate']
  onDelete: Props['onDelete']
  onMove: Props['onMove']
}): React.JSX.Element {
  const roots = buildTree(day.entries)
  return (
    <section className="day-group" data-date={day.date}>
      <div className="day-divider">
        <span className="day-divider-label">{isToday ? 'Today' : headingFmt.format(parseLocal(day.date))}</span>
      </div>
      {roots.map((node, i) => (
        <div key={node.entry.id} className="note-slot">
          <InsertGap
            pageId={pageId}
            date={day.date}
            position={i === 0 ? { beforeId: node.entry.id } : { afterId: roots[i - 1].entry.id }}
            onAdd={onAdd}
          />
          <NoteNode
            node={node}
            pageId={pageId}
            pages={pages}
            date={day.date}
            editRequest={editRequest}
            onAdd={onAdd}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onMove={onMove}
          />
        </div>
      ))}
      {!isToday && roots.length > 0 && (
        <InsertGap pageId={pageId} date={day.date} position={{ afterId: roots[roots.length - 1].entry.id }} onAdd={onAdd} />
      )}
    </section>
  )
}

export function Feed({
  page,
  pages,
  days,
  hasMore,
  today,
  search,
  hits,
  loading,
  editRequest,
  onLoadMore,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onEditPage,
  onArchivePage,
  onJumpTo,
  onOpenCategory
}: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const lastPage = useRef<string | null>(null)
  const lastKey = useRef<string>('')
  const pendingRestore = useRef<{ height: number; top: number } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const total = days.reduce((n, d) => n + d.entries.length, 0)
  const last = days[days.length - 1]
  const lastEntry = last?.entries[last.entries.length - 1]
  const key = `${page.id}:${total}:${lastEntry?.id ?? ''}`

  // Scroll to the bottom on page change and when a new note is appended to the newest day.
  useEffect(() => {
    if (search) return
    const el = scroller.current
    if (!el) return
    const pageChanged = lastPage.current !== page.id
    const changed = lastKey.current !== key
    lastPage.current = page.id
    lastKey.current = key
    if (pendingRestore.current) return
    if (pageChanged || (changed && lastEntry && !lastEntry.parentId)) {
      requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: pageChanged ? 'auto' : 'smooth' }))
    }
  }, [key, page.id, search, lastEntry])

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
    const labelOf = (id: string): string => {
      const p = pages.find((x) => x.id === id)
      return p ? [...categoryPath(p.category), p.title].join(' / ') : id === JOURNAL_PAGE_ID ? 'Journal' : id
    }
    const total = hits ? hits.notes.length + hits.wikis.length : 0
    return (
      <div className="feed" ref={scroller}>
        <header className="feed-head">
          <h2>Search: “{search}”</h2>
          <span className="feed-sub">{hits ? `${total} result${total === 1 ? '' : 's'} across all pages and wikis, archived included` : 'Searching…'}</span>
        </header>
        {hits && total === 0 && <p className="feed-empty">Nothing matched.</p>}
        {hits?.wikis.map((w) => (
          <div key={`wiki/${w.path.join('/')}`} className="hit hit-wiki">
            <button type="button" className="hit-day" onClick={() => onOpenCategory(w.path)}>
              ▤ {formatCategory(w.path)} · wiki{w.archived ? ' · archived' : ''}
            </button>
            <p className="hit-excerpt">{w.excerpt}</p>
          </div>
        ))}
        {hits?.notes.map((h) => (
          <div key={`${h.pageId}/${h.date}/${h.entry.id}`} className="hit">
            <button type="button" className="hit-day" onClick={() => onJumpTo(h.pageId, h.date)}>
              {labelOf(h.pageId)} · {headingFmt.format(parseLocal(h.date))}
              {h.entry.parentId ? ' · in thread' : ''}
              {h.archived ? ' · archived' : ''}
            </button>
            <EntryView pageId={h.pageId} date={h.date} entry={h.entry} showDate onUpdate={onUpdate} onDelete={onDelete} />
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
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>{page.title}</h2>
          {page.category && (
            <button type="button" className="page-category page-category-link" onClick={() => onOpenCategory(categoryPath(page.category))} title="Open the category wiki">
              {page.category}
            </button>
          )}
          <span className="spacer" />
          {page.id !== JOURNAL_PAGE_ID && (
            <>
              <button type="button" className="btn btn-quiet btn-xs" onClick={onEditPage} title="Edit page">
                Edit page
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-xs"
                onClick={() => onArchivePage(!page.archived)}
                title={page.archived ? 'Bring this page back to the sidebar' : 'Hide this page from the sidebar; it stays searchable'}
              >
                {page.archived ? 'Unarchive' : 'Archive'}
              </button>
            </>
          )}
        </div>
        {page.archived && <div className="archived-banner">This page is archived. It stays searchable and readable; unarchive it to post again.</div>}
        {page.description && (
          <div className="page-description markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.description) }} />
        )}
      </header>
      {hasMore && (
        <div className="load-more">
          <button type="button" className="btn btn-quiet btn-xs" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? 'Loading…' : 'Show earlier notes'}
          </button>
        </div>
      )}
      {loading && days.length === 0 && <p className="feed-empty">Loading…</p>}
      {!loading && days.length === 0 && (
        <p className="feed-empty">
          {page.id === JOURNAL_PAGE_ID ? 'No notes yet. Write something below.' : `Nothing on ${page.title} yet. Write the first note below.`}
        </p>
      )}
      {days.map((day) => (
        <DayGroup
          key={day.date}
          day={day}
          isToday={day.date === today}
          pageId={page.id}
          pages={pages}
          editRequest={editRequest}
          onAdd={onAdd}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onMove={onMove}
        />
      ))}
    </div>
  )
}
