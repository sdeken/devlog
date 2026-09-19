import { useEffect, useState } from 'react'
import type { PageMeta } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  /** Existing page to edit, or null to create one. */
  page: PageMeta | null
  /** Known categories, offered as suggestions. */
  categories: string[]
  onClose: () => void
  onSaved: (page: PageMeta) => void
  onDeleted: (pageId: string) => void
}

export function PageDialog({ page, categories, onClose, onSaved, onDeleted }: Props): React.JSX.Element {
  const [title, setTitle] = useState(page?.title ?? '')
  const [category, setCategory] = useState(page?.category ?? '')
  const [description, setDescription] = useState(page?.description ?? '')
  const [repos, setRepos] = useState<string[]>(page?.repos ?? [])
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

  const save = async (): Promise<void> => {
    if (!title.trim()) {
      setError('Give the page a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const saved = page
        ? await api.pages.update(page.id, { title, category, description, repos })
        : await api.pages.create({ title, category, description, repos })
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!page) return
    setBusy(true)
    setError(null)
    try {
      await api.pages.remove(page.id)
      onDeleted(page.id)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <form
        className="modal modal-page"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-title"
        onSubmit={(ev) => {
          ev.preventDefault()
          void save()
        }}
      >
        <h2 id="page-title">{page ? 'Edit page' : 'New page'}</h2>
        <div className="field">
          <label htmlFor="pageTitle">Title</label>
          <input id="pageTitle" type="text" autoFocus value={title} placeholder="Acme Corp" onChange={(ev) => setTitle(ev.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="pageCategory">Category</label>
          <input
            id="pageCategory"
            type="text"
            list="page-categories"
            value={category}
            placeholder="Acme Corp / Website  (client / project, optional)"
            onChange={(ev) => setCategory(ev.target.value)}
          />
          <datalist id="page-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <p className="hint">
            Use <code>/</code> to nest: <code>Acme Corp / Website</code> puts this page under the Website project of the Acme Corp client.
            The same project name under two clients is two different projects.
          </p>
        </div>
        <div className="field">
          <label htmlFor="pageDescription">Description</label>
          <textarea
            id="pageDescription"
            rows={3}
            value={description}
            placeholder="Shown at the top of the page. Markdown is fine."
            onChange={(ev) => setDescription(ev.target.value)}
          />
        </div>
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
          <p className="hint">Commits made in these repositories are added to this page as read-only notes.</p>
        </div>
        {page && (
          <p className="hint">
            Stored in <code>pages/{page.id}/</code>
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          {page &&
            (confirmDelete ? (
              <>
                <span className="entry-confirm">Delete this page and all of its notes?</span>
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
                  Delete page
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
            {busy ? 'Saving…' : page ? 'Save' : 'Create page'}
          </button>
        </div>
      </form>
    </div>
  )
}
