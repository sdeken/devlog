import { useEffect, useMemo, useState } from 'react'
import { JOURNAL_ID, buildCanvasTree, canvasLabel, flattenTree, inheritedField, isWithin } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import type { ExtensionInfo } from '@shared/extensions'
import { api } from '@renderer/api'
import { FieldRow } from './FieldInput'

interface Props {
  /** Existing canvas to edit, or null to create one. */
  canvas: CanvasMeta | null
  canvases: CanvasMeta[]
  /** Extensions that add fields to canvases (a Jira issue, a client id). */
  extensions?: ExtensionInfo[]
  /** Pre-selected parent for a new canvas. */
  initialParentId?: string | null
  initialTask?: boolean
  onClose: () => void
  onSaved: (canvas: CanvasMeta) => void
  onDeleted: (id: string) => void
}

export function CanvasDialog({ canvas, canvases, extensions = [], initialParentId, initialTask, onClose, onSaved, onDeleted }: Props): React.JSX.Element {
  const [title, setTitle] = useState(canvas?.title ?? '')
  const [parentId, setParentId] = useState<string>(canvas?.parentId ?? (initialParentId && initialParentId !== JOURNAL_ID ? initialParentId : '') ?? '')
  const [task, setTask] = useState(canvas?.task ?? initialTask ?? false)
  const [repos, setRepos] = useState<string[]>(canvas?.repos ?? [])
  const [importHistory, setImportHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const withFields = extensions.filter((e) => e.canvasFields.length > 0)
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(canvas?.fields ?? {}) }))

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
      // Extension fields: only the ones shown here change; an empty value removes one.
      const fieldPatch: Record<string, string | null> = {}
      for (const e of withFields) for (const f of e.canvasFields) {
        const k = `ext.${e.id}.${f.key}`
        const v = (fields[k] ?? '').trim()
        if (v !== (canvas?.fields?.[k] ?? '')) fieldPatch[k] = v || null
      }
      const input = { title, parentId: parentId || null, task, repos, ...(Object.keys(fieldPatch).length ? { fields: fieldPatch } : {}) }
      let saved = canvas ? await api.canvases.update(canvas.id, input) : await api.canvases.create(input)
      if (!canvas && input.fields) saved = await api.canvases.update(saved.id, { fields: input.fields })
      if (importHistory) {
        const settings = await api.settings.get()
        for (const r of saved.repos.filter((x) => !(canvas?.repos ?? []).includes(x))) await api.repo.importHistory(saved.id, r, settings.commitBackfillDays)
      }
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
              void api.repo.chooseDirectory().then(async (dir) => {
                if (!dir) return
                const check = await api.repo.inspectWorkingCopy(dir)
                if (!check.ok) {
                  setError(`${check.error}. Pick the folder that contains .git.`)
                  return
                }
                setError(null)
                if (!repos.includes(check.root)) setRepos([...repos, check.root])
              })
            }
          >
            + Add repository folder…
          </button>
          {repos.some((r) => !(canvas?.repos ?? []).includes(r)) && (
            <label className="check">
              <input type="checkbox" checked={importHistory} onChange={(ev) => setImportHistory(ev.target.checked)} /> Import my recent commits from the newly added
              repositories (days set in Settings)
            </label>
          )}
          <p className="hint">The working copies you code in. Commits land here as read-only blocks; branch switches and pushes show on the timeline.</p>
        </div>
        {withFields.map((e) => (
          <fieldset className="field ext-fields" key={e.key}>
            <legend>{e.displayName}</legend>
            {e.canvasFields.map((f) => {
              const k = `ext.${e.id}.${f.key}`
              const inherited = canvas ? inheritedField(canvases, canvas.parentId ?? '', k) : parentId ? inheritedField(canvases, parentId, k) : null
              return (
                <FieldRow
                  key={k}
                  id={`f-${k}`}
                  field={{ ...f, required: false, ...(inherited && !fields[k] ? { placeholder: `${inherited.value} (from ${canvases.find((c) => c.id === inherited.from)?.title ?? 'above'})` } : {}) }}
                  value={fields[k] ?? ''}
                  onChange={(v) => setFields((cur) => ({ ...cur, [k]: v }))}
                />
              )
            })}
            <p className="hint">Canvases inside this one use these values unless they set their own.</p>
          </fieldset>
        ))}
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
