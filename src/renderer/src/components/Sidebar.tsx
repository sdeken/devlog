import { useMemo, useState } from 'react'
import { JOURNAL_PAGE_ID, buildCategoryTree, categoryPath, formatCategory, samePath, type CategoryNode } from '@shared/pages'
import type { PageMeta, WikiMeta } from '@shared/types'
import { kbd } from '@renderer/keys'

export type SidebarSelection =
  | { kind: 'page'; pageId: string }
  | { kind: 'review' }
  | { kind: 'timeline' }
  | { kind: 'category'; path: string[] }

interface Props {
  pages: PageMeta[]
  wikis: WikiMeta[]
  selection: SidebarSelection
  search: string
  onSearch: (q: string) => void
  onSelect: (sel: SidebarSelection) => void
  onNewPage: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

export function Sidebar({ pages, wikis, selection, search, onSearch, onSelect, onNewPage, searchRef }: Props): React.JSX.Element {
  const live = useMemo(() => pages.filter((p) => !p.archived), [pages])
  const tree = useMemo(
    () => buildCategoryTree(live, wikis.filter((w) => !w.archived).map((w) => w.path)),
    [live, wikis]
  )
  const archivedPages = useMemo(() => pages.filter((p) => p.archived), [pages])
  const archivedWikis = useMemo(() => wikis.filter((w) => w.archived), [wikis])
  const [showArchived, setShowArchived] = useState(() => {
    try {
      return localStorage.getItem('devlog:sidebar:archived') === '1'
    } catch {
      return false
    }
  })
  const toggleArchived = (): void => {
    setShowArchived((v) => {
      try {
        localStorage.setItem('devlog:sidebar:archived', v ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !v
    })
  }
  const isPage = (id: string): boolean => !search && selection.kind === 'page' && selection.pageId === id
  const isCategory = (path: string[]): boolean => !search && selection.kind === 'category' && samePath(selection.path, path)

  const pageButton = (p: PageMeta, depth: number): React.JSX.Element => (
    <li key={p.id}>
      <button
        type="button"
        className={`page-link${isPage(p.id) ? ' is-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect({ kind: 'page', pageId: p.id })}
        title={p.description || p.title}
      >
        <span className="page-icon">#</span>
        <span className="page-name">{p.title}</span>
      </button>
    </li>
  )

  const renderNode = (node: CategoryNode): React.JSX.Element => {
    const depth = node.path.length - 1
    return (
      <li key={node.path.join('/')} className="category-node">
        <button
          type="button"
          className={`category-label depth-${Math.min(depth, 3)}${isCategory(node.path) ? ' is-selected' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={`${node.path.join(' / ')} · wiki`}
          onClick={() => onSelect({ kind: 'category', path: node.path })}
        >
          {node.name}
        </button>
        <ul>
          {node.children.map(renderNode)}
          {node.pages.map((p) => pageButton(p, depth + 1))}
        </ul>
      </li>
    )
  }

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
            <button
              type="button"
              className={`page-link page-journal${isPage(JOURNAL_PAGE_ID) ? ' is-selected' : ''}`}
              onClick={() => onSelect({ kind: 'page', pageId: JOURNAL_PAGE_ID })}
            >
              <span className="page-icon">✎</span>
              <span className="page-name">Journal</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`page-link page-review${!search && selection.kind === 'review' ? ' is-selected' : ''}`}
              onClick={() => onSelect({ kind: 'review' })}
              title={`Weekly review (${kbd('mod', 'shift', 'R')})`}
            >
              <span className="page-icon">▦</span>
              <span className="page-name">Weekly review</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={`page-link page-timeline${!search && selection.kind === 'timeline' ? ' is-selected' : ''}`}
              onClick={() => onSelect({ kind: 'timeline' })}
              title={`Day timeline (${kbd('mod', 'shift', 'T')})`}
            >
              <span className="page-icon">◷</span>
              <span className="page-name">Timeline</span>
            </button>
          </li>
        </ul>
        {(tree.roots.length > 0 || tree.uncategorised.length > 0) && (
          <ul className="sidebar-tree">
            {tree.roots.map(renderNode)}
            {tree.uncategorised.length > 0 && (
              <li className="category-node">
                <div className="category-label depth-0">Pages</div>
                <ul>{tree.uncategorised.map((p) => pageButton(p, 1))}</ul>
              </li>
            )}
          </ul>
        )}
        <button type="button" className="page-link page-new" onClick={onNewPage} title={`New page (${kbd('mod', 'N')})`}>
          <span className="page-icon">+</span>
          <span className="page-name">New page</span>
        </button>
        {(archivedPages.length > 0 || archivedWikis.length > 0) && (
          <div className="sidebar-archived">
            <button type="button" className="category-label depth-0 archived-toggle" onClick={toggleArchived}>
              {showArchived ? '▾' : '▸'} Archived ({archivedPages.length + archivedWikis.length})
            </button>
            {showArchived && (
              <ul>
                {archivedWikis.map((w) => (
                  <li key={`w-${w.path.join('/')}`}>
                    <button type="button" className={`page-link page-archived${isCategory(w.path) ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'category', path: w.path })}>
                      <span className="page-icon">▤</span>
                      <span className="page-name">{formatCategory(w.path)}</span>
                    </button>
                  </li>
                ))}
                {archivedPages.map((p) => (
                  <li key={p.id}>
                    <button type="button" className={`page-link page-archived${isPage(p.id) ? ' is-selected' : ''}`} onClick={() => onSelect({ kind: 'page', pageId: p.id })} title={p.category ? `${p.category} / ${p.title}` : p.title}>
                      <span className="page-icon">#</span>
                      <span className="page-name">{[...categoryPath(p.category), p.title].join(' / ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </nav>
    </aside>
  )
}
