import { kbd } from '@renderer/keys'
import { api } from '@renderer/api'

interface Props {
  search: string
  onSearch: (q: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  onSwitcher: () => void
}

/**
 * The window's own title bar, Slack-style: draggable, with the hamburger
 * menu on the left and search in the middle. Native window controls are
 * overlaid on the right (Windows/Linux) or the left (macOS traffic lights).
 */
export function TopBar({ search, onSearch, searchRef, onSwitcher }: Props): React.JSX.Element {
  const openMenu = (ev: React.MouseEvent<HTMLButtonElement>): void => {
    const r = ev.currentTarget.getBoundingClientRect()
    void api.window.menu(r.left, r.bottom + 2)
  }
  return (
    <div className="topbar">
      <div className="topbar-left">
        <button type="button" className="hamburger" onClick={openMenu} title="Menu" aria-label="Menu">
          <span />
          <span />
          <span />
        </button>
        <span className="topbar-title">Devlog</span>
      </div>
      <div className="topbar-center">
        <input
          ref={searchRef}
          type="search"
          className="topbar-search"
          placeholder={`Search everything…  (${kbd('mod', 'F')})`}
          value={search}
          onChange={(ev) => onSearch(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              onSearch('')
              ;(ev.target as HTMLInputElement).blur()
            }
          }}
        />
        <button type="button" className="topbar-go" onClick={onSwitcher} title={`Go to canvas (${kbd('mod', 'P')})`}>
          Go to…
        </button>
      </div>
      <div className="topbar-right" />
    </div>
  )
}
