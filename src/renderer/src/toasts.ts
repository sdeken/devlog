/** Tiny toast bus: failures from fire-and-forget actions surface here instead of vanishing. */
export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

type Listener = (toasts: Toast[]) => void
let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l(toasts)
}

export function showToast(message: string, kind: Toast['kind'] = 'error', ttlMs = 6000): void {
  const id = nextId++
  toasts = [...toasts, { id, kind, message }]
  emit()
  setTimeout(() => dismissToast(id), ttlMs)
}

export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(toasts)
  return () => {
    listeners.delete(l)
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Wrap a promise so a failure shows a toast instead of an unhandled rejection. */
export function reported<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch((err: unknown) => {
    showToast(errorMessage(err))
    return undefined
  })
}
