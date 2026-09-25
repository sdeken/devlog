import { useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasMeta, SyncStatus, TrackerStatus, UpdateStatus } from '@shared/types'
import { api } from '@renderer/api'
import { JOURNAL_ID, buildCanvasTree, canvasLabel, flattenTree } from '@devlog/core'
import { formatMinutes } from '@shared/review'
import { kbd } from '@renderer/keys'

interface Props {
  status: SyncStatus | null
  tracker: TrackerStatus | null
  taskLabel: string | null
  canvases: CanvasMeta[]
  /** The canvas on screen, offered first when starting a task. */
  currentCanvasId: string | null
  onSyncNow: () => void
  onOpenSettings: () => void
  onStartTask: (canvasId: string) => void
  onStopTask: () => void
  /** Create a new task canvas (under the current canvas) and start it. */
  onNewTask: () => void
  onOpenTimeline: () => void
}

/** The Start menu: pick a task to make active, or make a new one. */
function StartMenu({ canvases, currentCanvasId, onStart, onNew, onClose }: { canvases: CanvasMeta[]; currentCanvasId: string | null; onStart: (id: string) => void; onNew: () => void; onClose: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const tasks = useMemo(() => {
    const all = flattenTree(buildCanvasTree(canvases)).filter(({ canvas }) => canvas.task)
    const q = query.trim().toLowerCase()
    const list = q ? all.filter(({ canvas }) => canvasLabel(canvases, canvas.id).toLowerCase().includes(q)) : all
    // The canvas on screen (if it is a task) or the tasks inside it come first.
    return [...list].sort((a, b) => Number(rank(b.canvas)) - Number(rank(a.canvas)))
    function rank(c: CanvasMeta): number {
      if (c.id === currentCanvasId) return 2
      if (c.parentId && c.parentId === currentCanvasId) return 1
      return 0
    }
  }, [canvases, currentCanvasId, query])
  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose()
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div className="start-menu" ref={ref} role="menu">
      <input
        type="search"
        autoFocus
        placeholder="Find a task…"
        value={query}
        onChange={(ev) => setQuery(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && tasks[0]) onStart(tasks[0].canvas.id)
        }}
      />
      <ul>
        {tasks.map(({ canvas }) => (
          <li key={canvas.id}>
            <button type="button" className="start-item" onClick={() => onStart(canvas.id)} title={canvasLabel(canvases, canvas.id)}>
              <span className="start-item-title">◉ {canvas.title}</span>
              <span className="start-item-path">{canvasLabel(canvases, canvas.id).split(' / ').slice(0, -1).join(' / ')}</span>
            </button>
          </li>
        ))}
        {tasks.length === 0 && <li className="start-empty">{query ? 'No task matches.' : 'No tasks yet.'}</li>}
      </ul>
      <button type="button" className="start-item start-new" onClick={onNew}>
        + New task{currentCanvasId && currentCanvasId !== JOURNAL_ID ? ` in ${canvasLabel(canvases, currentCanvasId).split(' / ').pop()}` : ''}…
      </button>
    </div>
  )
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

export function StatusBar({ status, tracker, taskLabel, canvases, currentCanvasId, onSyncNow, onOpenSettings, onStartTask, onStopTask, onNewTask, onOpenTimeline }: Props): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [startOpen, setStartOpen] = useState(false)
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

  const elapsed = tracker?.since && !tracker.paused ? formatMinutes((now - new Date(tracker.since).getTime()) / 60_000) : null

  return (
    <footer className="statusbar">
      {tracker?.tracking && (
        <span className="task-status" title={tracker.lastFocus ? `Focused: ${tracker.lastFocus.app} — ${tracker.lastFocus.title}` : 'Activity tracking on'}>
          <span className={`status-dot status-${tracker.activeCanvasId ? (tracker.paused ? 'dirty' : 'busy') : 'idle'}`} />
          <button type="button" className="task-label link" onClick={onOpenTimeline} title="Open today's timeline">
            {tracker.activeCanvasId ? (
              <>
                <span className="status-text">{taskLabel ?? tracker.activeCanvasId}</span>
                {tracker.paused ? <span className="status-detail">· paused ({tracker.pausedReason})</span> : elapsed ? <span className="status-detail">· {elapsed}</span> : null}
              </>
            ) : (
              <span className="status-detail">No active task</span>
            )}
          </button>
          {tracker.activeCanvasId ? (
            <button type="button" className="btn btn-quiet btn-xs" onClick={onStopTask} title={`Stop the active task (${kbd('mod', 'shift', '.')})`}>
              Stop
            </button>
          ) : (
            <span className="start-wrap">
              <button type="button" className="btn btn-primary btn-xs" onClick={() => setStartOpen((v) => !v)} title="Start a task">
                Start ▾
              </button>
              {startOpen && (
                <StartMenu
                  canvases={canvases}
                  currentCanvasId={currentCanvasId}
                  onStart={(id) => {
                    setStartOpen(false)
                    onStartTask(id)
                  }}
                  onNew={() => {
                    setStartOpen(false)
                    onNewTask()
                  }}
                  onClose={() => setStartOpen(false)}
                />
              )}
            </span>
          )}
          <span className="status-sep" />
        </span>
      )}
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
      <button type="button" className="btn btn-quiet btn-xs" onClick={onOpenSettings} title={`Settings (${kbd('mod', ',')})`}>
        ⚙︎
      </button>
    </footer>
  )
}
