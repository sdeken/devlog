import { useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/types'

interface Props {
  status: SyncStatus | null
  onSyncNow: () => void
  onOpenSettings: () => void
}

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(iso).toLocaleDateString()
}

function inFuture(iso: string | null, now: number): string {
  if (!iso) return ''
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000))
  if (s < 60) return `${s}s`
  return `${Math.round(s / 60)} min`
}

export function StatusBar({ status, onSyncNow, onOpenSettings }: Props): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  let dot = 'idle'
  let text = 'No devlog open'
  let detail = ''
  if (status) {
    switch (status.state) {
      case 'committing':
        dot = 'busy'
        text = 'Committing…'
        break
      case 'pulling':
        dot = 'busy'
        text = 'Pulling…'
        break
      case 'pushing':
        dot = 'busy'
        text = 'Pushing…'
        break
      case 'dirty':
        dot = 'dirty'
        text = `${status.dirtyFiles} uncommitted change${status.dirtyFiles === 1 ? '' : 's'}`
        detail = status.nextSyncAt ? `· next sync in ${inFuture(status.nextSyncAt, now)}` : ''
        break
      case 'error':
        dot = 'error'
        text = 'Sync error'
        detail = status.lastError ?? ''
        break
      case 'clean':
        dot = 'ok'
        if (!status.hasRemote) {
          text = 'Committed'
          detail = `· no remote configured · last commit ${ago(status.lastCommitAt, now)}`
        } else if (status.ahead > 0) {
          dot = 'dirty'
          text = `${status.ahead} commit${status.ahead === 1 ? '' : 's'} to push`
          detail = status.nextSyncAt ? `· next sync in ${inFuture(status.nextSyncAt, now)}` : ''
        } else {
          text = 'Up to date'
          detail = `· pushed ${ago(status.lastPushAt ?? status.lastCommitAt, now)}`
        }
        break
      default:
        text = 'Ready'
    }
  }

  return (
    <footer className="statusbar">
      <span className={`status-dot status-${dot}`} />
      <span className="status-text">{text}</span>
      <span className="status-detail" title={detail}>
        {detail}
      </span>
      {status?.branch && (
        <span className="status-branch" title={status.remoteUrl ?? 'No remote'}>
          {status.branch}
          {status.behind > 0 ? ` ↓${status.behind}` : ''}
          {status.ahead > 0 ? ` ↑${status.ahead}` : ''}
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="btn btn-quiet btn-xs" onClick={onSyncNow} disabled={!status || dot === 'busy'} title="Commit and push now (⌘⇧S)">
        Sync now
      </button>
      <button type="button" className="btn btn-quiet btn-xs" onClick={onOpenSettings} title="Settings (⌘,)">
        ⚙︎
      </button>
    </footer>
  )
}
