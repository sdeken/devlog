import { useEffect, useMemo, useRef, useState } from 'react'
import { JOURNAL_ID, ancestorIds, canvasLabel } from '@shared/canvases'
import type { Canvas, CanvasMeta, Day, EntryPosition, SearchResult } from '@shared/types'
import { api } from '@renderer/api'
import { renderMarkdown } from '@renderer/markdown'
import { Composer } from './Composer'
import { Feed } from './Feed'
import { Lightbox } from './Lightbox'

interface Props {
  canvas: CanvasMeta
  canvases: CanvasMeta[]
  days: Day[]
  hasMore: boolean
  today: string
  loading: boolean
  editRequest: string | null
  activeCanvasId: string | null
  onLoadMore: () => Promise<void>
  onAdd: (canvasId: string, markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (canvasId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (canvasId: string, date: string, id: string) => Promise<void>
  onMove: (canvasId: string, date: string, id: string, toCanvasId: string) => Promise<void>
  onPromote: (canvasId: string, date: string, id: string) => Promise<void>
  onOpenCanvas: (id: string) => void
  onEditCanvas: () => void
  onNewCanvasHere: (task: boolean) => void
  onArchive: (archived: boolean) => Promise<void>
  onSetHidden: (canvasId: string, date: string, id: string, hidden: boolean) => Promise<void>
  onReorder: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }) => Promise<void>
}

/**
 * One canvas: breadcrumbs and actions, the surface (free markdown, read
 * mode by default so links work), then the stream of blocks.
 */
export function CanvasView({
  canvas,
  canvases,
  days,
  hasMore,
  today,
  loading,
  editRequest,
  activeCanvasId,
  onLoadMore,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onPromote,
  onOpenCanvas,
  onEditCanvas,
  onNewCanvasHere,
  onArchive,
  onSetHidden,
  onReorder
}: Props): React.JSX.Element {
  const isJournal = canvas.id === JOURNAL_ID
  const [full, setFull] = useState<Canvas | null>(null)
  const [editing, setEditing] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'archive' | 'unarchive' | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const lastSaved = useRef('')

  useEffect(() => {
    let cancelled = false
    setFull(null)
    setEditing(false)
    setSaveState('idle')
    setConfirm(null)
    if (isJournal) return
    void api.canvases.get(canvas.id).then((c) => {
      if (cancelled) return
      lastSaved.current = c.surface
      setFull(c)
    })
    return () => {
      cancelled = true
    }
  }, [canvas.id, isJournal])

  const crumbs = useMemo(() => ancestorIds(canvases, canvas.id).reverse(), [canvases, canvas.id])
  const children = useMemo(() => canvases.filter((c) => c.parentId === canvas.id), [canvases, canvas.id])
  const isActive = activeCanvasId === canvas.id

  const save = async (markdown: string): Promise<void> => {
    if (markdown === lastSaved.current) return
    setSaveState('saving')
    try {
      const c = await api.canvases.setSurface(canvas.id, markdown)
      lastSaved.current = c.surface
      setFull((f) => (f ? { ...f, surface: markdown } : f))
      setSaveState('saved')
      setError(null)
    } catch (err) {
      setSaveState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const surfaceText = full ? lastSaved.current || full.surface : ''
  const showSurface = !isJournal && (editing || surfaceText.trim().length > 0)

  const header = (
    <header className="feed-head page-head">
      <div className="page-head-row">
        <h2 className="breadcrumbs">
          {crumbs.map((id) => (
            <span key={id}>
              <button type="button" className="crumb" onClick={() => onOpenCanvas(id)}>
                {canvasLabel(canvases, id).split(' / ').pop()}
              </button>
              <span className="crumb-sep"> / </span>
            </span>
          ))}
          <span className="crumb is-current">{canvas.title}</span>
        </h2>
        {canvas.task && (
          <span className={`task-badge${isActive ? ' is-active' : ''}`} title={isActive ? 'This is the active task' : 'Task: time is tracked against it'}>
            {isActive ? '◉ active' : 'task'}
          </span>
        )}
        <span className="spacer" />
        {!isJournal && (
          <>
            {full && (
              <>
                <span className={`save-state save-${saveState}`}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}</span>
                <button
                  type="button"
                  className={`btn btn-xs ${editing ? 'btn-primary' : 'btn-quiet'}`}
                  onClick={() => setEditing((e) => !e)}
                  title={editing ? 'Back to reading (links open)' : 'Edit the surface: links, how-tos, anything that is not a dated note'}
                >
                  {editing ? 'Done' : surfaceText.trim() ? 'Edit surface' : 'Add surface'}
                </button>
              </>
            )}
            <button type="button" className="btn btn-quiet btn-xs" onClick={onEditCanvas} title="Rename, move, mark as task, repositories…">
              Edit
            </button>
            {confirm ? (
              <>
                <span className="entry-confirm">
                  {confirm === 'archive' ? `Archive ${canvas.title}${children.length ? ` and everything beneath it` : ''}?` : `Restore ${canvas.title}?`}
                </span>
                <button
                  type="button"
                  className={`btn btn-xs ${confirm === 'archive' ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => {
                    void onArchive(confirm === 'archive')
                    setConfirm(null)
                  }}
                >
                  {confirm === 'archive' ? 'Archive' : 'Unarchive'}
                </button>
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-quiet btn-xs"
                onClick={() => setConfirm(canvas.archived ? 'unarchive' : 'archive')}
                title={canvas.archived ? 'Bring it back to the sidebar' : 'Hide from the sidebar; stays searchable'}
              >
                {canvas.archived ? 'Unarchive' : 'Archive'}
              </button>
            )}
          </>
        )}
      </div>
      {canvas.archived && <div className="archived-banner">This canvas is archived. It stays searchable and readable; unarchive it to post again.</div>}
      {showSurface && (
        <div className="surface">
          {editing ? (
            <>
              <Composer
                key={canvas.id}
                mode="document"
                initialMarkdown={full?.surface ?? ''}
                placeholder="The canvas surface: links to the tracker, environments, contacts, how-tos, a research scratchpad… Markdown, images, anything. Saves as you type."
                saveImage={(bytes, mime, name) => api.canvases.saveSurfaceAsset(canvas.id, bytes, mime, name)}
                onSubmit={async () => undefined}
                onChange={save}
              />
              {error && <p className="form-error">{error}</p>}
            </>
          ) : (
            <div
              className="surface-read markdown-body"
              onDoubleClick={(ev) => {
                if ((ev.target as HTMLElement).closest('a, img')) return
                setEditing(true)
              }}
              onClick={(ev) => {
                const el = ev.target as HTMLElement
                const img = el.closest('img')
                if (img?.getAttribute('data-lightbox')) {
                  ev.preventDefault()
                  setLightbox({ src: img.getAttribute('src') ?? '', alt: img.getAttribute('alt') ?? '' })
                  return
                }
                const href = el.closest('a')?.getAttribute('href')
                if (href) {
                  ev.preventDefault()
                  void api.shell.openExternal(href)
                }
              }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(surfaceText) }}
            />
          )}
        </div>
      )}
      {children.length > 0 && (
        <div className="canvas-children">
          {children
            .filter((c) => !c.archived)
            .sort((a, b) => Number(a.task) - Number(b.task) || a.title.localeCompare(b.title))
            .map((c) => (
              <button key={c.id} type="button" className={`child-chip${c.task ? ' is-task' : ''}${activeCanvasId === c.id ? ' is-active' : ''}`} onClick={() => onOpenCanvas(c.id)}>
                {c.task ? '◉ ' : '▤ '}
                {c.title}
              </button>
            ))}
          {!isJournal && !canvas.archived && (
            <button type="button" className="child-chip child-add" onClick={() => onNewCanvasHere(false)} title="New canvas inside this one">
              +
            </button>
          )}
        </div>
      )}
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </header>
  )

  return (
    <Feed
      canvas={canvas}
      canvases={canvases}
      days={days}
      hasMore={hasMore}
      today={today}
      search=""
      hits={null}
      loading={loading}
      editRequest={editRequest}
      header={header}
      onLoadMore={onLoadMore}
      onAdd={onAdd}
      onUpdate={onUpdate}
      onDelete={onDelete}
      onMove={onMove}
      onPromote={onPromote}
      onSetHidden={onSetHidden}
      onReorder={onReorder}
      onJumpTo={(id) => onOpenCanvas(id)}
      onOpenCanvas={onOpenCanvas}
    />
  )
}
