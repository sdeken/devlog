import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem = { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string } | 'separator'

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/** A right-click menu at the pointer, kept inside the window; closes on click-away, Escape, scroll or resize. */
export function ContextMenu({ x, y, items, onClose }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const away = (ev: MouseEvent): void => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose()
    }
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        onClose()
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(i + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    document.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', away, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return (
    <div className="context-menu" role="menu" ref={ref} style={pos} onContextMenu={(ev) => ev.preventDefault()}>
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={`sep-${i}`} className="context-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`context-item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            <span>{it.label}</span>
            {it.hint && <span className="context-hint">{it.hint}</span>}
          </button>
        )
      )}
    </div>
  )
}
