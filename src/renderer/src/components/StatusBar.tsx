import { useEffect, useState } from 'react'
import type { SyncStatus, UpdateStatus } from '@shared/types'
import type { ViewContext } from '@devlog/extension-api/view'
import { api } from '@renderer/api'
import { kbd } from '@renderer/keys'
import { ExtensionView } from './ExtensionView'

interface Props {
  /** Status bar items extensions contribute (views in a slot of fixed height). */
  extViews: Array<{ extKey: string; viewId: string; title: string; url: string }>
  onExtPopover: (extKey: string, viewId: string, anchor: DOMRect, size: { width?: number; height?: number }, context?: ViewContext) => void
  onExtOpen: (target: { canvasId: string; date?: string; blockId?: string }) => void
  /** What is on screen (the canvas, the block page), given to the items (1.6). */
  extContext: ViewContext
  status: SyncStatus | null
  onSyncNow: () => void
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

/** A status bar slot: the view asks for a width and gets it within limits; the height is the bar's. */
function StatusSlot({ view, context, onPopover, onOpen }: { view: Props['extViews'][number]; context: ViewContext; onPopover: Props['onExtPopover']; onOpen: Props['onExtOpen'] }): React.JSX.Element {
  const [width, setWidth] = useState(120)
  return (
    <span className="status-ext" style={{ width }} data-ext-view={`${view.extKey}/${view.viewId}`}>
      <ExtensionView
        extKey={view.extKey}
        viewId={view.viewId}
        url={view.url}
        title={view.title}
        onResize={(s) => s.width && setWidth(Math.round(Math.min(Math.max(s.width, 24), 360)))}
        context={context}
        onPopover={(id, anchor, size) => onPopover(view.extKey, id, anchor, size, context)}
        onOpen={onOpen}
      />
    </span>
  )
}

export function StatusBar({ extViews, extContext, onExtPopover, onExtOpen, status, onSyncNow }: Props): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void api.updates.status().then(setUpdate)
    return api.updates.onStatus(setUpdate)
  }, [])
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
      {extViews.map((v) => (
        <StatusSlot key={`${v.extKey}/${v.viewId}`} view={v} context={extContext} onPopover={onExtPopover} onOpen={onExtOpen} />
      ))}
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
      {update && (update.state === 'downloaded' || update.state === 'downloading' || update.state === 'installing') && (
        <span className="update-status">
          {update.state === 'installing' ? (
            <span className="status-detail">Restarting into {update.availableVersion}…</span>
          ) : update.installRequested ? (
            <span className="status-detail">
              Updating to {update.availableVersion} as soon as it downloads{update.progress !== undefined ? ` (${update.progress}%)` : ''}…
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => void api.updates.installNow()}
              title={
                update.state === 'downloaded'
                  ? `Version ${update.availableVersion} is ready. Devlog commits and pushes, then restarts into it.`
                  : `Version ${update.availableVersion} is downloading${update.progress !== undefined ? ` (${update.progress}%)` : ''}; Devlog restarts into it as soon as it finishes.`
              }
            >
              Update now{update.availableVersion ? ` to ${update.availableVersion}` : ''}
            </button>
          )}
        </span>
      )}
      <button type="button" className="btn btn-quiet btn-xs" onClick={onSyncNow} disabled={!status || dot === 'busy'} title={`Commit and push now (${kbd('mod', 'shift', 'S')})`}>
        Sync now
      </button>
    </footer>
  )
}
