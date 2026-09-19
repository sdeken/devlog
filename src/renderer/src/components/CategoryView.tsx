import { useEffect, useMemo, useRef, useState } from 'react'
import { categoryPath, formatCategory, pathStartsWith, samePath } from '@shared/pages'
import type { PageMeta, Wiki } from '@shared/types'
import { api } from '@renderer/api'
import { Composer } from './Composer'

interface Props {
  path: string[]
  pages: PageMeta[]
  onSelectCategory: (path: string[]) => void
  onSelectPage: (pageId: string) => void
  onNewPage: (category: string) => void
  onChanged: () => Promise<void>
}

export function CategoryView({ path, pages, onSelectCategory, onSelectPage, onNewPage, onChanged }: Props): React.JSX.Element {
  const [wiki, setWiki] = useState<Wiki | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'archive' | 'unarchive' | null>(null)
  const [busy, setBusy] = useState(false)
  const key = formatCategory(path)
  const lastSaved = useRef<string>('')

  useEffect(() => {
    let cancelled = false
    setWiki(null)
    setSaveState('idle')
    void api.wiki.get(path).then((w) => {
      if (cancelled) return
      lastSaved.current = w.markdown
      setWiki(w)
    })
    return () => {
      cancelled = true
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const here = useMemo(() => pages.filter((p) => samePath(categoryPath(p.category), path)), [pages, path])
  const beneath = useMemo(
    () => pages.filter((p) => pathStartsWith(categoryPath(p.category), path) && !samePath(categoryPath(p.category), path)),
    [pages, path]
  )
  const active = [...here, ...beneath].filter((p) => !p.archived)
  const archived = [...here, ...beneath].filter((p) => p.archived)
  const isArchived = wiki?.archived ?? false

  const save = async (markdown: string): Promise<void> => {
    if (markdown === lastSaved.current) return
    setSaveState('saving')
    try {
      const w = await api.wiki.set(path, markdown)
      lastSaved.current = w.markdown
      setSaveState('saved')
      setError(null)
    } catch (err) {
      setSaveState('error')
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const setArchived = async (archived: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.categories.archive(path, archived)
      setWiki((w) => (w ? { ...w, archived } : w))
      await onChanged()
      setConfirm(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pageLabel = (p: PageMeta): string => {
    const rest = categoryPath(p.category).slice(path.length)
    return [...rest, p.title].join(' / ')
  }

  return (
    <div className="feed category-view">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2 className="breadcrumbs">
            {path.map((seg, i) => (
              <span key={i}>
                {i > 0 && <span className="crumb-sep"> / </span>}
                <button type="button" className={`crumb${i === path.length - 1 ? ' is-current' : ''}`} onClick={() => onSelectCategory(path.slice(0, i + 1))}>
                  {seg}
                </button>
              </span>
            ))}
          </h2>
          <span className="page-category">wiki</span>
          <span className="spacer" />
          <span className={`save-state save-${saveState}`}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
          </span>
          <button type="button" className="btn btn-quiet btn-xs" onClick={() => onNewPage(formatCategory(path))}>
            + Page here
          </button>
          {confirm ? (
            <>
              <span className="entry-confirm">
                {confirm === 'archive'
                  ? `Archive ${key} and ${active.length} page${active.length === 1 ? '' : 's'} beneath it?`
                  : `Restore ${key} and ${archived.length} archived page${archived.length === 1 ? '' : 's'}?`}
              </span>
              <button type="button" className={`btn btn-xs ${confirm === 'archive' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={() => void setArchived(confirm === 'archive')}>
                {confirm === 'archive' ? 'Archive' : 'Unarchive'}
              </button>
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </>
          ) : isArchived ? (
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm('unarchive')}>
              Unarchive category
            </button>
          ) : (
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm('archive')} title="Hide this category and its pages from the sidebar">
              Archive category…
            </button>
          )}
        </div>
        {isArchived && <div className="archived-banner">This category is archived. It stays searchable; unarchive it to bring it back to the sidebar.</div>}
      </header>

      {wiki === null ? (
        <p className="feed-empty">Loading…</p>
      ) : (
        <div className="wiki">
          <Composer
            key={key}
            mode="document"
            initialMarkdown={wiki.markdown}
            placeholder="A blank canvas for this category: links to the issue tracker, environments, contacts, credentials, how-tos… Markdown, images, anything. Saves as you type."
            saveImage={(bytes, mime, name) => api.wiki.saveAsset(path, bytes, mime, name)}
            onSubmit={async () => undefined}
            onChange={save}
          />
          {error && <p className="form-error">{error}</p>}
        </div>
      )}

      {(active.length > 0 || archived.length > 0) && (
        <section className="category-pages">
          <h3>Pages</h3>
          <ul className="page-list">
            {active.map((p) => (
              <li key={p.id}>
                <button type="button" className="link" onClick={() => onSelectPage(p.id)}>
                  {pageLabel(p)}
                </button>
              </li>
            ))}
          </ul>
          {archived.length > 0 && (
            <>
              <h4>Archived</h4>
              <ul className="page-list page-list-archived">
                {archived.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="link" onClick={() => onSelectPage(p.id)}>
                      {pageLabel(p)}
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-xs"
                      onClick={() =>
                        void api.pages.archive(p.id, false).then(() => onChanged())
                      }
                    >
                      Unarchive
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}
