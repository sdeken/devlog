import { useEffect, useRef, useState, type ReactNode } from 'react'

/** One tab of the side panel: the To do list, or an extension's `panel` view. */
export interface PanelTab {
  key: string
  title: string
  icon?: string
  /** A number on the tab (the open todos). */
  badge?: number | null
  render: () => ReactNode
}

const WIDTH_KEY = 'devlog:panel:width'
const COLLAPSE_KEY = 'devlog:panel:collapsed'
const TAB_KEY = 'devlog:panel:tab'
/** Where 0.19 kept the To do panel's width and collapsed flag. */
const OLD_WIDTH_KEY = 'devlog:todos:width'
const OLD_COLLAPSE_KEY = 'devlog:todos:collapsed'
export const PANEL_DEFAULT_WIDTH = 300
const MIN_WIDTH = 220
const MAX_WIDTH = 720

const read = (key: string, old?: string): string | null => {
  try {
    return localStorage.getItem(key) ?? (old ? localStorage.getItem(old) : null)
  } catch {
    return null
  }
}
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/** Keep the panel between its minimum and half the window. */
function clampWidth(w: number): number {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.5)))
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, w)))
}

/** The tab on screen and whether the panel is folded away, remembered on this machine. */
export function usePanelState(): {
  tab: string
  setTab: (key: string) => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
} {
  const [tab, setTabState] = useState(() => read(TAB_KEY) ?? 'todo')
  const [collapsed, setCollapsedState] = useState(() => read(COLLAPSE_KEY, OLD_COLLAPSE_KEY) === '1')
  return {
    tab,
    setTab: (key) => {
      setTabState(key)
      write(TAB_KEY, key)
    },
    collapsed,
    setCollapsed: (v) => {
      setCollapsedState(v)
      write(COLLAPSE_KEY, v ? '1' : '0')
    }
  }
}

/**
 * The panel on the right: tabs (To do, and each extension's panel view),
 * resized by dragging its left edge, folded away into a strip of its tabs.
 * A tab once shown stays mounted while you look at another, or fold the
 * panel, so an extension's work in progress is not lost.
 */
export function SidePanel({ tabs, active, onActive, collapsed, onCollapsed }: { tabs: PanelTab[]; active: string; onActive: (key: string) => void; collapsed: boolean; onCollapsed: (v: boolean) => void }): React.JSX.Element {
  const current = tabs.some((t) => t.key === active) ? active : (tabs[0]?.key ?? '')
  const [width, setWidth] = useState(() => {
    const n = Number(read(WIDTH_KEY, OLD_WIDTH_KEY))
    return n > 0 ? clampWidth(n) : PANEL_DEFAULT_WIDTH
  })
  const widthRef = useRef(width)
  widthRef.current = width
  const setAndSaveWidth = (w: number): void => {
    const next = clampWidth(w)
    setWidth(next)
    write(WIDTH_KEY, String(next))
  }
  // Drag the left edge to resize; the width is remembered on this machine.
  const startResize = (ev: React.PointerEvent<HTMLDivElement>): void => {
    if (ev.button !== 0) return
    ev.preventDefault()
    const startX = ev.clientX
    const startWidth = widthRef.current
    document.body.classList.add('is-resizing')
    const move = (e: PointerEvent): void => setWidth(clampWidth(startWidth + (startX - e.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('is-resizing')
      write(WIDTH_KEY, String(widthRef.current))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Tabs mount when first shown and then stay.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(current ? [current] : []))
  useEffect(() => {
    if (current && !mounted.has(current)) setMounted((m) => new Set(m).add(current))
  }, [current, mounted])

  const pick = (key: string): void => {
    onActive(key)
    if (collapsed) onCollapsed(false)
  }

  return (
    <aside className={`side-panel${collapsed ? ' is-collapsed' : ''}`} style={collapsed ? undefined : { width }}>
      {collapsed ? (
        <div className="side-rail" role="tablist" aria-label="Side panel">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={false} className="side-rail-tab" data-tab={t.key} onClick={() => pick(t.key)} title={`Show ${t.title}`}>
              {t.badge != null && <span className="side-count">{t.badge}</span>}
              {t.icon && <span className="side-rail-icon">{t.icon}</span>}
              <span className="side-rail-label">{t.title}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div
            className="side-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the side panel"
            aria-valuenow={width}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={startResize}
            onDoubleClick={() => setAndSaveWidth(PANEL_DEFAULT_WIDTH)}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowLeft') setAndSaveWidth(width + 20)
              else if (ev.key === 'ArrowRight') setAndSaveWidth(width - 20)
              else return
              ev.preventDefault()
            }}
          />
          <nav className="side-tabs" role="tablist" aria-label="Side panel">
            {tabs.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === current} className={`side-tab${t.key === current ? ' is-active' : ''}`} data-tab={t.key} onClick={() => pick(t.key)}>
                {t.icon && <span className="side-tab-icon">{t.icon}</span>}
                <span className="side-tab-title">{t.title}</span>
                {t.badge != null && <span className="side-count">{t.badge}</span>}
              </button>
            ))}
            <span className="spacer" />
            <button type="button" className="side-collapse" onClick={() => onCollapsed(true)} title="Hide the side panel">
              ›
            </button>
          </nav>
        </>
      )}
      {/* Kept mounted while folded, so a view's work in progress carries on. */}
      <div className="side-body" hidden={collapsed}>
        {tabs
          .filter((t) => mounted.has(t.key) || t.key === current)
          .map((t) => (
            <div key={t.key} className="side-pane" data-pane={t.key} hidden={t.key !== current}>
              {t.render()}
            </div>
          ))}
      </div>
    </aside>
  )
}
