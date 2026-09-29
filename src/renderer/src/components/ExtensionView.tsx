import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AppToView, ViewContext, ViewToApp } from '@devlog/extension-api/view'
import { api } from '@renderer/api'

/** The app's colour tokens a view gets, read from the live stylesheet so theme changes reach it. */
const THEME_VARS = ['--bg', '--bg-2', '--bg-3', '--fg', '--fg-muted', '--border', '--border-strong', '--accent', '--accent-fg', '--warn', '--danger', '--ok', '--link', '--code-bg', '--shadow', '--mono', '--sans', '--font']

function themeMessage(): AppToView {
  const css = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const v of THEME_VARS) {
    const value = css.getPropertyValue(v).trim()
    if (value) vars[v] = value
  }
  vars['--font'] ||= getComputedStyle(document.body).fontFamily
  return { devlog: 1, type: 'theme', vars, dark: window.matchMedia('(prefers-color-scheme: dark)').matches }
}

interface Props {
  extKey: string
  viewId: string
  url: string
  title: string
  className?: string
  /** The page asked for a size (status bar items: a width). */
  onResize?: (size: { width?: number; height?: number }) => void
  /** The page asked for one of its extension's popover views, anchored to this frame. */
  onPopover?: (viewId: string, anchor: DOMRect, size: { width?: number; height?: number }) => void
  onClose?: () => void
  onOpen?: (target: { canvasId: string; date?: string; blockId?: string }) => void
  /** Where it is shown (a canvas-header view's canvas); given to the page and to the commands it runs. */
  context?: ViewContext
}

/**
 * An extension's view: its page in a sandboxed frame (scripts only: no
 * access to this window, the app's storage, or the network; see the
 * devlog-ext:// handler's CSP), talking to its extension through the app.
 */
export function ExtensionView({ extKey, viewId, url, title, className, onResize, onPopover, onClose, onOpen, context }: Props): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const handlers = useRef({ onResize, onPopover, onClose, onOpen })
  handlers.current = { onResize, onPopover, onClose, onOpen }
  const contextRef = useRef<ViewContext>(context ?? {})
  contextRef.current = context ?? {}
  const contextKey = JSON.stringify(context ?? {})

  // A new context (another canvas on screen) reaches the page.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ devlog: 1, type: 'context', context: contextRef.current } satisfies AppToView, '*')
  }, [contextKey])

  // Listen before the frame can load (a layout effect runs before the page's first paint), so its "ready" is never missed.
  useLayoutEffect(() => {
    const post = (msg: AppToView): void => frame.current?.contentWindow?.postMessage(msg, '*')
    const onMessage = (ev: MessageEvent): void => {
      if (!frame.current || ev.source !== frame.current.contentWindow) return
      const msg = ev.data as ViewToApp
      if (!msg || msg.devlog !== 1) return
      const h = handlers.current
      switch (msg.type) {
        case 'ready':
          post(themeMessage())
          post({ devlog: 1, type: 'context', context: contextRef.current })
          break
        case 'call':
          api.extensions
            .viewCall(extKey, viewId, String(msg.method), Array.isArray(msg.args) ? msg.args : [])
            .then(
              (value) => post({ devlog: 1, type: 'reply', id: msg.id, ok: true, value }),
              (err: unknown) =>
                post({ devlog: 1, type: 'reply', id: msg.id, ok: false, error: (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
            )
          break
        case 'resize':
          h.onResize?.({ width: Number(msg.width) || undefined, height: Number(msg.height) || undefined })
          break
        case 'popover':
          if (frame.current) h.onPopover?.(String(msg.view), frame.current.getBoundingClientRect(), { width: Number(msg.width) || undefined, height: Number(msg.height) || undefined })
          break
        case 'close':
          h.onClose?.()
          break
        case 'open':
          if (typeof msg.canvasId === 'string') h.onOpen?.({ canvasId: msg.canvasId, date: msg.date, blockId: msg.blockId })
          break
        case 'key':
          // A shortcut the page did not use: as if pressed in the app.
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: String(msg.key), code: String(msg.code), ctrlKey: Boolean(msg.ctrlKey), metaKey: Boolean(msg.metaKey), altKey: Boolean(msg.altKey), shiftKey: Boolean(msg.shiftKey), bubbles: true, cancelable: true })
          )
          break
        case 'command':
          void api.extensions.run(extKey, String(msg.command), { source: 'view', ...contextRef.current }).catch(() => undefined)
          break
      }
    }
    window.addEventListener('message', onMessage)
    // The extension's own messages, for every open copy of this view.
    const off = api.extensions.onViewMessage((key, id, data) => {
      if (key === extKey && id === viewId) post({ devlog: 1, type: 'message', data })
    })
    // Keep its colours in step with the app's.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = (): void => post(themeMessage())
    mq.addEventListener('change', retheme)
    const mo = new MutationObserver(retheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    return () => {
      window.removeEventListener('message', onMessage)
      off()
      mq.removeEventListener('change', retheme)
      mo.disconnect()
    }
  }, [extKey, viewId])

  // Once loaded, say the theme and context again: a page that asked before anyone listened still gets them.
  const onLoad = (): void => {
    const w = frame.current?.contentWindow
    w?.postMessage(themeMessage(), '*')
    w?.postMessage({ devlog: 1, type: 'context', context: contextRef.current } satisfies AppToView, '*')
  }

  return <iframe ref={frame} className={`ext-view${className ? ` ${className}` : ''}`} src={url} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={onLoad} />
}
