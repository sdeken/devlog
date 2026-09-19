import { useMemo } from 'react'
import { JOURNAL_PAGE_ID, groupPages } from '@shared/pages'
import type { PageMeta } from '@shared/types'

interface Props {
  pages: PageMeta[]
  currentPageId: string
  search: string
  onSearch: (q: string) => void
  onSelectPage: (pageId: string) => void
  onNewPage: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

export function Sidebar({ pages, currentPageId, search, onSearch, onSelectPage, onNewPage, searchRef }: Props): React.JSX.Element {
  const groups = useMemo(() => groupPages(pages), [pages])
  const active = (id: string): string => (id === currentPageId && !search ? ' is-selected' : '')

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Devlog</h1>
      </div>
      <div className="sidebar-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search all pages…"
          value={search}
          onChange={(ev) => onSearch(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              onSearch('')
              ;(ev.target as HTMLInputElement).blur()
            }
          }}
        />
      </div>
      <nav className="sidebar-pages">
        <ul>
          <li>
            <button type="button" className={`page-link page-journal${active(JOURNAL_PAGE_ID)}`} onClick={() => onSelectPage(JOURNAL_PAGE_ID)}>
              <span className="page-icon">✎</span>
              <span className="page-name">Journal</span>
            </button>
          </li>
        </ul>
        {groups.map((g) => (
          <section key={g.category || '\u0000none'} className="sidebar-group">
            <h2>{g.category || 'Pages'}</h2>
            <ul>
              {g.pages.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`page-link${active(p.id)}`} onClick={() => onSelectPage(p.id)} title={p.description || p.title}>
                    <span className="page-icon">#</span>
                    <span className="page-name">{p.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button type="button" className="page-link page-new" onClick={onNewPage} title="New page (⌘N)">
          <span className="page-icon">+</span>
          <span className="page-name">New page</span>
        </button>
      </nav>
    </aside>
  )
}
