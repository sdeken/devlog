/**
 * The bridge between an extension's view and the Devlog window showing it
 * (see `@devlog/extension-api/view` for the messages). Importing this module
 * tells the app the page is ready and applies the app's colours as they
 * arrive, so a plain page gets the theme with no further code.
 */
import type { AppToView, ViewContext, ViewToApp } from '@devlog/extension-api/view'

type Outgoing = ViewToApp extends infer M ? (M extends { devlog: 1 } ? Omit<M, 'devlog'> : never) : never

const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const messageListeners = new Set<(data: unknown) => void>()
const themeListeners = new Set<(dark: boolean) => void>()
const contextListeners = new Set<(context: ViewContext) => void>()
let nextId = 1
let dark = false
let context: ViewContext = {}

function send(msg: Outgoing): void {
  window.parent.postMessage({ devlog: 1, ...msg }, '*')
}

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window.parent) return
  const m = ev.data as AppToView
  if (!m || m.devlog !== 1) return
  switch (m.type) {
    case 'theme': {
      const root = document.documentElement
      for (const [k, v] of Object.entries(m.vars)) if (/^--[a-z0-9-]+$/i.test(k)) root.style.setProperty(k, v)
      dark = m.dark
      root.dataset.theme = m.dark ? 'dark' : 'light'
      for (const cb of themeListeners) cb(dark)
      break
    }
    case 'reply': {
      const w = waiting.get(m.id)
      if (!w) return
      waiting.delete(m.id)
      if (m.ok) w.resolve(m.value)
      else w.reject(new Error(m.error ?? 'Failed'))
      break
    }
    case 'message':
      for (const cb of messageListeners) cb(m.data)
      break
    case 'context':
      context = m.context ?? {}
      for (const cb of contextListeners) cb(context)
      break
  }
})

export const devlog = {
  /** Ask your extension: arrives at its `ctx.views.handle(viewId, …)` handler. */
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      send({ type: 'call', id, method, args })
    })
  },
  /** Messages your extension sends with `ctx.views.post`. Returns a function that stops listening. */
  onMessage(cb: (data: unknown) => void): () => void {
    messageListeners.add(cb)
    return () => messageListeners.delete(cb)
  },
  /** Whether the app is in dark mode now, and when it changes. */
  get dark(): boolean {
    return dark
  },
  onTheme(cb: (dark: boolean) => void): () => void {
    themeListeners.add(cb)
    return () => themeListeners.delete(cb)
  },
  /** Where the view is shown (a canvas-header view's canvas), and when that changes. */
  get context(): ViewContext {
    return context
  },
  onContext(cb: (context: ViewContext) => void): () => void {
    contextListeners.add(cb)
    return () => contextListeners.delete(cb)
  },
  /** Ask for a size. A status bar item gets its height from the bar; the width may be clamped. */
  resize(size: { width?: number; height?: number }): void {
    send({ type: 'resize', ...size })
  },
  /** Open one of your popover views, anchored to this view. */
  popover(view: string, size: { width?: number; height?: number } = {}): void {
    send({ type: 'popover', view, ...size })
  },
  /** Close this view (a popover). */
  close(): void {
    send({ type: 'close' })
  },
  /** Show a canvas, or a block's page, in the app. */
  open(target: { canvasId: string; date?: string; blockId?: string }): void {
    send({ type: 'open', ...target })
  },
  /** Run one of your commands. */
  command(command: string): void {
    send({ type: 'command', command })
  }
}

// Shortcuts the page does not use (Ctrl+K, Alt+←, …) belong to the app around it.
window.addEventListener('keydown', (ev) => {
  if (ev.defaultPrevented) return
  if (!(ev.ctrlKey || ev.metaKey || ev.altKey || /^F\d+$/.test(ev.key))) return
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(ev.key)) return
  send({ type: 'key', key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, shiftKey: ev.shiftKey })
})

send({ type: 'ready' })
