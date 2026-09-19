import { useMemo } from 'react'
import { JOURNAL_PAGE_ID, buildCategoryTree, type CategoryNode } from '@shared/pages'
import type { PageMeta } from '@shared/types'

export type SidebarSelection = { kind: 'page'; pageId: string } | { kind: 'review' } | { kind: 'timeline' }

interface Props {
  pages: PageMeta[]
  selection: SidebarSelection
  search: string
  onSearch: (q: string) => void
  onSelect: (sel: SidebarSelection) => void
  onNewPage: () => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

export function Sidebar({ pages, selection, search, onSearch, onSelect, onNewPage, searchRef }: Props): React.JSX.Element {
  const tree = useMemo(() => buildCategoryTree(pages), [pages])
  const isPage = (id: string): boolean => !search && selection.kind === 'page' && selection.pageId === id

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
        <div className={`category-label depth-${Math.min(depth, 3)}`} style={{ paddingLeft: 8 + depth * 14 }} title={node.path.join(' / ')}>
          {node.name}
        </div>
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
              title="Weekly review (⌘⇧R)"
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
              title="Day timeline (⌘⇧T)"
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
        <button type="button" className="page-link page-new" onClick={onNewPage} title="New page (⌘N)">
          <span className="page-icon">+</span>
          <span className="page-name">New page</span>
        </button>
      </nav>
    </aside>
  )
}
