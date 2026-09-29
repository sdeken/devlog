/** What both time pages share: the canvases, today's date, and a line for errors. */
import { useEffect, useState } from 'react'
import { localDate } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import { api } from './api'

export function Page({ children }: { children: (props: { canvases: CanvasMeta[]; today: string; onError: (message: string) => void }) => React.ReactNode }): React.JSX.Element {
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [today, setToday] = useState(() => localDate(new Date()))
  useEffect(() => {
    api.canvases().then(setCanvases, (err: Error) => setError(err.message))
    // Past midnight, today moves on.
    const t = setInterval(() => setToday(localDate(new Date())), 60_000)
    return () => clearInterval(t)
  }, [])
  return (
    <>
      {error && (
        <p className="form-error page-error" role="alert">
          {error}{' '}
          <button type="button" className="btn btn-quiet btn-xs" onClick={() => setError(null)}>
            ✕
          </button>
        </p>
      )}
      {canvases ? children({ canvases, today, onError: setError }) : <p className="feed-empty">Loading…</p>}
    </>
  )
}
