import { useEffect, useState } from 'react'
import type { DestinationLine, SendResult } from '@devlog/extension-api'
import { api } from '@renderer/api'

interface Props {
  extensionKey: string
  destination: string
  label: string
  week: string
  onClose: () => void
}

const ACTION_LABEL: Record<DestinationLine['action'], string> = { create: 'New', update: 'Change', delete: 'Remove', unchanged: 'Sent', skip: 'Not sent' }

const hm = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(Math.round(minutes) % 60).padStart(2, '0')}`
const when = (l: DestinationLine): string => {
  if (!l.start) return l.date
  const d = new Date(l.start)
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Preview what a destination would do with the week's timesheet, then send it. */
export function SendDialog({ extensionKey, destination, label, week, onClose }: Props): React.JSX.Element {
  const [lines, setLines] = useState<DestinationLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)

  const load = (): void => {
    setLines(null)
    setError(null)
    api.extensions
      .previewSend(extensionKey, destination, week)
      .then(setLines)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  useEffect(load, [extensionKey, destination, week]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const send = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.extensions.send(extensionKey, destination, week))
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const shown = (lines ?? []).filter((l) => l.action !== 'skip')
  const skipped = (lines ?? []).filter((l) => l.action === 'skip')
  const todo = shown.filter((l) => l.action !== 'unchanged').length
  const count = (a: DestinationLine['action']): number => (lines ?? []).filter((l) => l.action === a).length

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && !busy && onClose()}>
      <div className="modal modal-send" role="dialog" aria-modal="true" aria-labelledby="send-title">
        <h2 id="send-title">Send to {label}</h2>
        <p className="hint">Week of {week}. Only what changed since the last send goes out.</p>
        {!lines && !error && <p className="hint">Working out what to send…</p>}
        {lines && (
          <p className="send-counts">
            {count('create')} new · {count('update')} changed · {count('delete')} removed · {count('unchanged')} already sent
            {skipped.length ? ` · ${skipped.length} not for ${label}` : ''}
          </p>
        )}
        {shown.length > 0 && (
          <table className="send-table">
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} className={`send-line action-${l.action}`} data-line={l.id}>
                  <td>
                    <span className={`send-action action-${l.action}`}>{ACTION_LABEL[l.action]}</span>
                  </td>
                  <td className="send-when">{when(l)}</td>
                  <td className="send-hours">{hm(l.minutes)}</td>
                  <td className="send-target">{l.target}</td>
                  <td className="send-desc">
                    {l.description}
                    {l.reason ? <span className="hint"> ({l.reason})</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {skipped.length > 0 && (
          <div className="send-skipped">
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setShowSkipped((v) => !v)} aria-expanded={showSkipped}>
              {showSkipped ? '▾' : '▸'} {skipped.length} entr{skipped.length === 1 ? 'y' : 'ies'} not sent to {label}
            </button>
            {showSkipped && (
              <ul>
                {skipped.map((l) => (
                  <li key={l.id}>
                    {when(l)} · {hm(l.minutes)} · {l.description}: <span className="hint">{l.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {result && (
          <p className={result.failed.length ? 'form-error send-result' : 'send-result send-ok'}>
            {result.summary}
            {result.failed.length > 0 && <> · {result.failed.length} failed: {result.failed.map((f) => f.error).join('; ')}</>}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onClose}>
            {result ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !lines || todo === 0} onClick={() => void send()}>
            {busy ? 'Sending…' : todo === 0 && lines ? 'Nothing to send' : `Send ${todo} change${todo === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  )
}
