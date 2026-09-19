import { useEffect, useState } from 'react'
import { dismissToast, subscribeToasts, type Toast } from '@renderer/toasts'

export function Toasts(): React.JSX.Element | null {
  const [list, setList] = useState<Toast[]>([])
  useEffect(() => subscribeToasts(setList), [])
  if (list.length === 0) return null
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismissToast(t.id)} title="Dismiss">
          {t.message}
        </button>
      ))}
    </div>
  )
}
