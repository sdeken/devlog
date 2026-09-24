import { useEffect, useState } from 'react'

interface Props {
  /** Repository root, already checked to be a git working copy. */
  repoPath: string
  canvasTitle: string
  defaultDays: number
  onClose: () => void
  onLink: (importDays: number | null) => Promise<void>
}

/** Confirm linking a working copy, with an opt-in import of your recent commits. */
export function LinkRepoDialog({ repoPath, canvasTitle, defaultDays, onClose, onLink }: Props): React.JSX.Element {
  const [importHistory, setImportHistory] = useState(false)
  const [days, setDays] = useState(defaultDays)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const link = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onLink(importHistory ? Math.max(1, Math.round(days) || 1) : null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <form
        className="modal modal-link-repo"
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-repo-title"
        onSubmit={(ev) => {
          ev.preventDefault()
          void link()
        }}
      >
        <h2 id="link-repo-title">Link {name} to {canvasTitle}</h2>
        <p className="hint">
          <code className="path">{repoPath}</code>
        </p>
        <p className="hint">New commits will land on the task you are working on under {canvasTitle}, or on {canvasTitle} itself.</p>
        <label className="check">
          <input id="importHistory" type="checkbox" checked={importHistory} onChange={(ev) => setImportHistory(ev.target.checked)} /> Also import my commits from the last
          <input
            type="number"
            className="link-days"
            min={1}
            max={3650}
            value={days}
            disabled={!importHistory}
            onChange={(ev) => setDays(Number(ev.target.value))}
            aria-label="Days of history"
          />
          days
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Linking…' : 'Link'}
          </button>
        </div>
      </form>
    </div>
  )
}
