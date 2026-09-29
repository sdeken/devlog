/**
 * @devlog/ui: for extension views. Import the styles once in your view's
 * entry (`import '@devlog/ui/styles.css'`), then use `mount` and the
 * components; `devlog` is the bridge to the app and your extension.
 */
import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { devlog } from './bridge'

export { devlog }

/** Render a view's root component into the page (a `<div id="root">`, made if missing). */
export function mount(node: ReactNode, opts: { slot?: boolean } = {}): void {
  if (opts.slot) document.body.classList.add('dl-slot')
  let el = document.getElementById('root')
  if (!el) {
    el = document.createElement('div')
    el.id = 'root'
    document.body.append(el)
  }
  createRoot(el).render(<StrictMode>{node}</StrictMode>)
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Call your extension and keep the answer; `reload` asks again. */
export function useCall<T>(method: string, args: unknown[] = [], deps: unknown[] = []): { data: T | undefined; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    devlog.call<T>(method, ...args).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (err: Error) => alive && setState((s) => ({ data: s.data, error: err.message, loading: false }))
    )
    return () => {
      alive = false
    }
  }, [method, n, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) }
}

/** Messages your extension sends with `ctx.views.post`. */
export function useMessages(cb: (data: unknown) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => devlog.onMessage((d) => ref.current(d)), [])
}

/** Whether the app is in dark mode. */
export function useDark(): boolean {
  const [dark, setDark] = useState(devlog.dark)
  useEffect(() => devlog.onTheme(setDark), [])
  return dark
}

/** A time that updates on its own (for running clocks). */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'quiet' | 'danger'; small?: boolean }

export function Button({ variant = 'default', small, className, type, ...rest }: ButtonProps): React.JSX.Element {
  const cls = ['dl-btn', variant !== 'default' ? `dl-btn-${variant}` : '', small ? 'dl-btn-sm' : '', className ?? ''].filter(Boolean).join(' ')
  return <button type={type ?? 'button'} className={cls} {...rest} />
}

export function Row({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={`dl-row${className ? ` ${className}` : ''}`} {...rest} />
}

export function Stack({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={`dl-stack${className ? ` ${className}` : ''}`} {...rest} />
}

export function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="dl-field">
      <span>{label}</span>
      {children}
    </label>
  )
}

export function Empty({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="dl-empty">{children}</p>
}

export interface MenuEntry {
  key: string
  label: ReactNode
  hint?: ReactNode
  onSelect: () => void
}

/**
 * A pick list: arrow keys move, Enter picks, and typing in the optional
 * search box filters (by `filterText`, or the label when it is a string).
 */
export function Menu({ items, search, placeholder, filterText, empty }: { items: MenuEntry[]; search?: boolean; placeholder?: string; filterText?: (item: MenuEntry) => string; empty?: ReactNode }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const q = query.trim().toLowerCase()
  const text = (it: MenuEntry): string => (filterText ? filterText(it) : typeof it.label === 'string' ? it.label : '').toLowerCase()
  const shown = q ? items.filter((it) => text(it).includes(q)) : items
  useEffect(() => setActive(0), [q])
  const onKey = (ev: React.KeyboardEvent): void => {
    if (ev.key === 'ArrowDown') setActive((i) => Math.min(shown.length - 1, i + 1))
    else if (ev.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (ev.key === 'Enter') shown[active]?.onSelect()
    else if (ev.key === 'Escape') devlog.close()
    else return
    ev.preventDefault()
  }
  return (
    <div className="dl-stack" onKeyDown={onKey}>
      {search && <input className="dl-input" autoFocus placeholder={placeholder ?? 'Find…'} value={query} onChange={(ev) => setQuery(ev.target.value)} />}
      <ul className="dl-menu" role="menu">
        {shown.map((it, i) => (
          <li key={it.key}>
            <button type="button" role="menuitem" className={`dl-menu-item${i === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(i)} onClick={it.onSelect}>
              <span>{it.label}</span>
              {it.hint && <span className="dl-menu-hint">{it.hint}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="dl-empty">{empty ?? 'Nothing here.'}</li>}
      </ul>
    </div>
  )
}
