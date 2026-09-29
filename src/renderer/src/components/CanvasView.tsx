import { useEffect, useMemo, useRef, useState } from 'react'
import { JOURNAL_ID, ancestorIds, canvasLabel } from '@devlog/core'
import type { Canvas, CanvasMeta, Day, EntryPosition, SearchResult } from '@shared/types'
import { api } from '@renderer/api'
import { renderMarkdown } from '@renderer/markdown'
import { Composer } from './Composer'
import { Feed } from './Feed'
import { Lightbox } from './Lightbox'
import { canvasIcon, typeOf, useNodeTypes } from '@renderer/nodeTypes'

interface Props {
  canvas: CanvasMeta
  canvases: CanvasMeta[]
  days: Day[]
  hasMore: boolean
  today: string
  loading: boolean
  editRequest: string | null
  activeCanvasId: string | null
  /** Activity tracking is on, so tasks can be started from here. */
  tracking: boolean
  onStartTask: () => void
  onStopTask: () => void
  onCanvasMenu: (canvasId: string, x: number, y: number) => void
  onOpenBlock: (canvasId: string, date: string, id: string) => void
  onLoadMore: () => Promise<void>
  onAdd: (canvasId: string, markdown: string, position: EntryPosition) => Promise<void>
  onUpdate: (canvasId: string, date: string, id: string, markdown: string) => Promise<void>
  onDelete: (canvasId: string, date: string, id: string) => Promise<void>
  onMove: (canvasId: string, date: string, id: string, toCanvasId: string) => Promise<void>
  onNest: (canvasId: string, date: string, id: string, to: { date: string; parentId?: string; afterId?: string }) => Promise<void>
  onPromote: (canvasId: string, date: string, id: string) => Promise<void>
  onOpenCanvas: (id: string) => void
  onEditCanvas: () => void
  onNewCanvasHere: (task: boolean) => void
  onArchive: (archived: boolean) => Promise<void>
  onSetHidden: (canvasId: string, date: string, id: string, hidden: boolean) => Promise<void>
  onSetDone: (canvasId: string, date: string, id: string, done: boolean) => Promise<void>
  /** Link another working copy to this canvas (folder picker, then update). */
  onLinkRepo: () => void
  onUnlinkRepo: (path: string) => void
  onReorder: (canvasId: string, date: string, id: string, position: { afterId?: string; beforeId?: string }) => Promise<void>
}

/** On a task canvas (and the pages inside it): start, switch to or stop the task. */
export function TaskControl({
  canvas,
  activeCanvasId,
  tracking,
  onStart,
  onStop
}: {
  canvas: CanvasMeta
  activeCanvasId: string | null
  tracking: boolean
  onStart: () => void
  onStop: () => void
}): React.JSX.Element | null {
  if (!canvas.task) return null
  const isActive = activeCanvasId === canvas.id
  if (!tracking || canvas.archived)
    return (
      <span className="task-badge" title="Task: time is tracked against it">
        task
      </span>
    )
  return isActive ? (
    <>
      <span className="task-badge is-active" title="This is the active task">
        ◉ active
      </span>
      <button type="button" className="btn btn-quiet btn-xs task-stop" onClick={onStop} title="Stop tracking time on this task">
        Stop
      </button>
    </>
  ) : (
    <button type="button" className="btn btn-primary btn-xs task-start" onClick={onStart} title={activeCanvasId ? 'Make this the active task (stops the current one)' : 'Start tracking time on this task'}>
      ▶ {activeCanvasId ? 'Switch to this task' : 'Start this task'}
    </button>
  )
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
  tracking,
  onStartTask,
  onStopTask,
  onCanvasMenu,
  onOpenBlock,
  onLoadMore,
  onAdd,
  onUpdate,
  onDelete,
  onMove,
  onNest,
  onPromote,
  onOpenCanvas,
  onEditCanvas,
  onNewCanvasHere,
  onArchive,
  onSetHidden,
  onSetDone,
  onLinkRepo,
  onUnlinkRepo,
  onReorder
}: Props): React.JSX.Element {
  const types = useNodeTypes()
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

  // Linked folders that are not (or no longer) git repositories get flagged.
  const [badRepos, setBadRepos] = useState<Record<string, string>>({})
  const reposKey = canvas.repos.join('\n')
  useEffect(() => {
    let cancelled = false
    void Promise.all(canvas.repos.map(async (r) => [r, await api.repo.inspectWorkingCopy(r)] as const)).then((results) => {
      if (cancelled) return
      const bad: Record<string, string> = {}
      for (const [r, check] of results) if (!check.ok) bad[r] = check.error
      setBadRepos(bad)
    })
    return () => {
      cancelled = true
    }
  }, [reposKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const crumbs = useMemo(() => ancestorIds(canvases, canvas.id).reverse(), [canvases, canvas.id])
  const children = useMemo(() => canvases.filter((c) => c.parentId === canvas.id), [canvases, canvas.id])

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

  const menuFor =
    (id: string) =>
    (ev: React.MouseEvent): void => {
      ev.preventDefault()
      onCanvasMenu(id, ev.clientX, ev.clientY)
    }

  const header = (
    <header className="feed-head page-head">
      <div className="page-head-row">
        <h2 className="breadcrumbs">
          {crumbs.map((id) => (
            <span key={id}>
              <button type="button" className="crumb" onClick={() => onOpenCanvas(id)} onContextMenu={menuFor(id)}>
                {canvasLabel(canvases, id).split(' / ').pop()}
              </button>
              <span className="crumb-sep"> / </span>
            </span>
          ))}
          <span className="crumb is-current" onContextMenu={isJournal ? undefined : menuFor(canvas.id)}>
            {canvas.title}
          </span>
        </h2>
        <TaskControl canvas={canvas} activeCanvasId={activeCanvasId} tracking={tracking} onStart={onStartTask} onStop={onStopTask} />
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
            <button type="button" className="btn btn-quiet btn-xs canvas-props" onClick={onEditCanvas} title="Rename, move, mark as task, repositories, extension fields… (or right-click the canvas in the sidebar)">
              Properties
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
      {isJournal && (
        <div className="archived-banner">The journal is retired: nothing new goes here. Move what is worth keeping onto a canvas (hover a block → Move).</div>
      )}
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
      {!isJournal && (
        <div className="canvas-repos">
          {canvas.repos.map((r) => (
            <span
              key={r}
              className={`repo-chip${badRepos[r] ? ' is-broken' : ''}`}
              title={badRepos[r] ? `${r}\n${badRepos[r]}; nothing is being captured from it.` : `${r}\nCommits here land on the task you are on under ${canvas.title}, or on ${canvas.title} itself.`}
            >
              {badRepos[r] ? '⚠' : '⎇'} {r.split(/[\\/]/).filter(Boolean).pop()}
              <button type="button" className="repo-remove" onClick={() => onUnlinkRepo(r)} title="Unlink this repository (captured commits stay)" aria-label={`Unlink ${r}`}>
                ✕
              </button>
            </span>
          ))}
          {!canvas.archived && (
            <button type="button" className="child-chip child-add repo-add" onClick={onLinkRepo} title="Link a working copy: its commits become blocks here, branch switches and pushes show on the timeline">
              {canvas.repos.length ? '+ repository' : '+ Link a repository…'}
            </button>
          )}
        </div>
      )}
      {children.length > 0 && (
        <div className="canvas-children">
          {children
            .filter((c) => !c.archived)
            .sort((a, b) => Number(Boolean(typeOf(types, a))) - Number(Boolean(typeOf(types, b))) || a.title.localeCompare(b.title))
            .map((c) => (
              <button
                key={c.id}
                type="button"
                className={`child-chip${c.task ? ' is-task' : ''}${activeCanvasId === c.id ? ' is-active' : ''}`}
                onClick={() => onOpenCanvas(c.id)}
                onContextMenu={menuFor(c.id)}
              >
                {canvasIcon(types, c)}{' '}
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
      onNest={onNest}
      onPromote={onPromote}
      onSetHidden={onSetHidden}
      onSetDone={onSetDone}
      onReorder={onReorder}
      onJumpTo={(id) => onOpenCanvas(id)}
      onOpenCanvas={onOpenCanvas}
      onOpenBlock={onOpenBlock}
    />
  )
}
