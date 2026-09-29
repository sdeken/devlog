import { useMemo, useState } from 'react'
import { JOURNAL_ID, TASK_TYPE, buildCanvasTree, canvasLabel, flattenTree, inheritedField, isWithin } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import type { ExtensionInfo } from '@shared/extensions'
import { api } from '@renderer/api'
import { typeOf, useNodeTypes } from '@renderer/nodeTypes'
import { FieldRow } from './FieldInput'
import { PagedDialog, type DialogPage } from './PagedDialog'

interface Props {
  /** Existing canvas to edit, or null to create one. */
  canvas: CanvasMeta | null
  canvases: CanvasMeta[]
  /** Extensions that add fields to canvases (a Jira issue, a client id). */
  extensions?: ExtensionInfo[]
  /** Pre-selected parent for a new canvas. */
  initialParentId?: string | null
  /** Node type for a new canvas ("New task inside…"). */
  initialType?: string
  /** 'general', 'repos', or 'ext:<key>'. */
  initialPage?: string
  onClose: () => void
  onSaved: (canvas: CanvasMeta) => void
  onDeleted: (id: string) => void
}

/**
 * A canvas's properties, a page per concern: the canvas itself, its git
 * repositories, and one page for each extension that adds fields to
 * canvases (a Jira issue, a CMS assignment).
 */
export function CanvasDialog({ canvas, canvases, extensions = [], initialParentId, initialType, initialPage, onClose, onSaved, onDeleted }: Props): React.JSX.Element {
  const [page, setPage] = useState(initialPage ?? 'general')
  const [title, setTitle] = useState(canvas?.title ?? '')
  const [parentId, setParentId] = useState<string>(canvas?.parentId ?? (initialParentId && initialParentId !== JOURNAL_ID ? initialParentId : '') ?? '')
  const types = useNodeTypes()
  const [type, setType] = useState<string>(canvas?.type ?? initialType ?? '')
  const [repos, setRepos] = useState<string[]>(canvas?.repos ?? [])
  const [importHistory, setImportHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const withFields = extensions.filter((e) => e.canvasFields.length > 0)
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(canvas?.fields ?? {}) }))

  // Parents: every canvas except this one and anything beneath it.
  const parents = useMemo(
    () => flattenTree(buildCanvasTree(canvases, { includeArchived: true })).filter(({ canvas: c }) => !canvas || !isWithin(canvases, c.id, canvas.id)),
    [canvases, canvas]
  )

  const fieldPatch = (): Record<string, string | null> => {
    // Extension fields: only the ones shown here change; an empty value removes one.
    const patch: Record<string, string | null> = {}
    for (const e of withFields)
      for (const f of e.canvasFields) {
        const k = `ext.${e.id}.${f.key}`
        const v = (fields[k] ?? '').trim()
        if (v !== (canvas?.fields?.[k] ?? '')) patch[k] = v || null
      }
    return patch
  }
  const extDirty = (e: ExtensionInfo): boolean => e.canvasFields.some((f) => (fields[`ext.${e.id}.${f.key}`] ?? '').trim() !== (canvas?.fields?.[`ext.${e.id}.${f.key}`] ?? ''))
  const generalDirty = title !== (canvas?.title ?? '') || (parentId || null) !== (canvas?.parentId ?? null) || type !== (canvas?.type ?? '')
  const reposDirty = JSON.stringify(repos) !== JSON.stringify(canvas?.repos ?? [])
  const dirty = !canvas || generalDirty || reposDirty || withFields.some(extDirty)

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      setPage('general')
      setError('Give the canvas a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const patch = fieldPatch()
      const input = { title, parentId: parentId || null, type: type || null, repos, ...(Object.keys(patch).length ? { fields: patch } : {}) }
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

  const pages: DialogPage[] = [
    { id: 'general', label: canvas ? 'Canvas' : 'New canvas', badge: canvas && generalDirty ? 'dirty' : null },
    { id: 'repos', label: 'Repositories', badge: canvas && reposDirty ? 'dirty' : null },
    ...withFields.map((e) => ({ id: `ext:${e.key}`, label: e.displayName, group: 'Extensions', badge: canvas && extDirty(e) ? ('dirty' as const) : null }))
  ]

  const footer = (
    <>
      {error && <p className="form-error">{error}</p>}
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
      <button type="submit" className="btn btn-primary" disabled={busy || !dirty}>
        {busy ? 'Saving…' : canvas ? 'Save' : 'Create'}
      </button>
    </>
  )

  return (
    <PagedDialog
      title={canvas ? canvas.title || 'Canvas' : initialType && types.get(initialType) ? `New ${types.get(initialType)?.label.toLowerCase()}` : 'New canvas'}
      className="modal-page"
      pages={pages}
      page={page}
      onPage={setPage}
      onClose={onClose}
      footer={footer}
      onSubmit={() => void save()}
    >
      {page === 'general' && (
        <div className="settings-page">
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
                  {'  '.repeat(depth)}
                  {c.title}
                  {typeOf(types, c) ? ` (${typeOf(types, c)?.label.toLowerCase()})` : ''}
                  {c.archived ? ' (archived)' : ''}
                </option>
              ))}
            </select>
            <p className="hint">Canvases nest: a client holds projects, a project holds tasks. The same project name under two clients is two different projects.</p>
          </div>
          <div className="field">
            <label htmlFor="canvasType">Type</label>
            <select id="canvasType" value={type} onChange={(ev) => setType(ev.target.value)}>
              <option value="">Canvas</option>
              {[...types.values()].map((t) => (
                <option key={t.type} value={t.type}>
                  {t.icon} {t.label}
                </option>
              ))}
              {type && !types.has(type) && <option value={type}>{type} (its extension is not here)</option>}
            </select>
            <p className="hint">
              {type === TASK_TYPE
                ? 'Time is tracked against a task; posting on it makes it the active task.'
                : type
                  ? 'What this type does comes from its extension.'
                  : 'Extensions can add types of canvas (a task, for time tracking).'}
            </p>
          </div>
          {canvas && (
            <p className="hint">
              Stored in <code>canvases/{canvas.id}/</code> · {canvasLabel(canvases, canvas.id)}
            </p>
          )}
        </div>
      )}
      {page === 'repos' && (
        <div className="settings-page">
          <h3>Git repositories</h3>
          <p className="hint">The working copies you code in. Commits land here as read-only blocks; branch switches and pushes show on the timeline.</p>
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
          {repos.length === 0 && <p className="hint">None linked.</p>}
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
        </div>
      )}
      {withFields
        .filter((e) => page === `ext:${e.key}`)
        .map((e) => (
          <div className="settings-page ext-fields" key={e.key}>
            <h3>{e.displayName}</h3>
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
          </div>
        ))}
    </PagedDialog>
  )
}
