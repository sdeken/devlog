import { useEffect, useMemo, useState } from 'react'
import { JOURNAL_ID, buildCanvasTree, canvasLabel, flattenTree, isWithin } from '@shared/canvases'
import type { CanvasMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  /** Existing canvas to edit, or null to create one. */
  canvas: CanvasMeta | null
  canvases: CanvasMeta[]
  /** Pre-selected parent for a new canvas. */
  initialParentId?: string | null
  initialTask?: boolean
  onClose: () => void
  onSaved: (canvas: CanvasMeta) => void
  onDeleted: (id: string) => void
}

export function CanvasDialog({ canvas, canvases, initialParentId, initialTask, onClose, onSaved, onDeleted }: Props): React.JSX.Element {
  const [title, setTitle] = useState(canvas?.title ?? '')
  const [parentId, setParentId] = useState<string>(canvas?.parentId ?? (initialParentId && initialParentId !== JOURNAL_ID ? initialParentId : '') ?? '')
  const [task, setTask] = useState(canvas?.task ?? initialTask ?? false)
  const [repos, setRepos] = useState<string[]>(canvas?.repos ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Parents: every canvas except this one and anything beneath it.
  const parents = useMemo(
    () => flattenTree(buildCanvasTree(canvases, { includeArchived: true })).filter(({ canvas: c }) => !canvas || !isWithin(canvases, c.id, canvas.id)),
    [canvases, canvas]
  )

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      setError('Give the canvas a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input = { title, parentId: parentId || null, task, repos }
      const saved = canvas ? await api.canvases.update(canvas.id, input) : await api.canvases.create(input)
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!canvas) return
    setBusy(true)
    setError(null)
    try {
      await api.canvases.remove(canvas.id)
      onDeleted(canvas.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const beneath = canvas ? canvases.filter((c) => c.id !== canvas.id && isWithin(canvases, c.id, canvas.id)).length : 0

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <form
        className="modal modal-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-title"
        onSubmit={(ev) => {
          ev.preventDefault()
          void save()
        }}
      >
        <h2 id="canvas-title">{canvas ? 'Edit canvas' : 'New canvas'}</h2>
        <div className="field">
          <label htmlFor="canvasTitle">Title</label>
          <input id="canvasTitle" type="text" autoFocus value={title} placeholder="Acme Corp" onChange={(ev) => setTitle(ev.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="canvasParent">Inside</label>
          <select id="canvasParent" value={parentId} onChange={(ev) => setParentId(ev.target.value)}>
            <option value="">Top level</option>
            {parents.map(({ canvas: c, depth }) => (
              <option key={c.id} value={c.id}>
                {'  '.repeat(depth)}
                {c.title}
                {c.task ? ' (task)' : ''}
                {c.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <p className="hint">Canvases nest: a client holds projects, a project holds tasks. The same project name under two clients is two different projects.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={task} onChange={(ev) => setTask(ev.target.checked)} /> This is a task (time is tracked against it; posting here makes it the active task)
        </label>
        <div className="field">
          <label>Git repositories</label>
          <ul className="repo-list">
            {repos.map((r, i) => (
              <li key={`${r}-${i}`}>
                <code className="path" title={r}>
                  {r}
                </code>
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setRepos(repos.filter((_, j) => j !== i))} title="Remove">
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-quiet btn-xs"
            onClick={() =>
              void api.repo.chooseDirectory().then((dir) => {
                if (dir && !repos.includes(dir)) setRepos([...repos, dir])
              })
            }
          >
            + Add repository folder…
          </button>
          <p className="hint">The working copies you code in. Commits land here as read-only blocks; branch switches and pushes show on the timeline.</p>
        </div>
        {canvas && (
          <p className="hint">
            Stored in <code>canvases/{canvas.id}/</code> · {canvasLabel(canvases, canvas.id)}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {canvas &&
            (confirmDelete ? (
              <>
                <span className="entry-confirm">Delete this canvas, its blocks{beneath > 0 ? ` and ${beneath} canvas${beneath === 1 ? '' : 'es'} beneath it` : ''}?</span>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                  Delete
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-quiet btn-danger-text" onClick={() => setConfirmDelete(true)}>
                Delete…
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : canvas ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
