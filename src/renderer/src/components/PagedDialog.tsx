import { useEffect } from 'react'

export interface DialogPage {
  id: string
  label: string
  /** Pages with the same group are listed under that heading. */
  group?: string
  /** A small marker after the label: unsaved changes, something missing. */
  badge?: 'dirty' | 'attention' | null
}

interface Props {
  title: string
  className?: string
  pages: DialogPage[]
  page: string
  onPage: (id: string) => void
  onClose: () => void
  /** Escape and the backdrop close only when this allows it (e.g. no nested dialog open). */
  closable?: boolean
  footer?: React.ReactNode
  children: React.ReactNode
  /** Render as a <form> so Enter submits. */
  onSubmit?: () => void
}

/**
 * A dialog with its own navigation: pages down the left, one page at a time
 * on the right, and a footer that stays put. Settings and canvas properties
 * both use it, so whatever extensions add gets a page of its own instead of
 * lengthening one long form.
 */
export function PagedDialog({ title, className, pages, page, onPage, onClose, closable = true, footer, children, onSubmit }: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      // Only the topmost dialog answers Escape (a consent prompt may sit on top).
      if (ev.key !== 'Escape' || !closable || document.querySelectorAll('.modal-backdrop').length > 1) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, closable])

  const groups: Array<{ name: string | undefined; pages: DialogPage[] }> = []
  for (const p of pages) {
    const last = groups[groups.length - 1]
    if (last && last.name === p.group) last.pages.push(p)
    else groups.push({ name: p.group, pages: [p] })
  }

  const body = (
    <>
      <nav className="paged-nav" aria-label={`${title} sections`}>
        <h2 className="paged-title">{title}</h2>
        {groups.map((g, i) => (
          <div className="paged-group" key={`${g.name ?? ''}-${i}`}>
            {g.name && <div className="paged-group-name">{g.name}</div>}
            {g.pages.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`paged-link${p.id === page ? ' is-selected' : ''}`}
                data-page={p.id}
                aria-current={p.id === page ? 'page' : undefined}
                onClick={() => onPage(p.id)}
              >
                <span className="paged-link-label">{p.label}</span>
                {p.badge && <span className={`paged-badge is-${p.badge}`} title={p.badge === 'dirty' ? 'Unsaved changes' : 'Needs attention'} />}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="paged-main">
        <button type="button" className="paged-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
        <div className="paged-content">{children}</div>
        {footer && <div className="paged-footer">{footer}</div>}
      </div>
    </>
  )

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && closable && onClose()}>
      {onSubmit ? (
        <form
          className={`modal modal-paged${className ? ` ${className}` : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onSubmit={(ev) => {
            ev.preventDefault()
            onSubmit()
          }}
        >
          {body}
        </form>
      ) : (
        <div className={`modal modal-paged${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={title}>
          {body}
        </div>
      )}
    </div>
  )
}
