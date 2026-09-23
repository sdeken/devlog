import { useEffect, useState } from 'react'
import type { RepoInfo, Settings, ThemeSettings, UpdateStatus } from '@shared/types'
import { THEME_PRESETS, resolveTheme } from '@shared/theme'
import { api } from '@renderer/api'

interface Props {
  settings: Settings
  repo: RepoInfo | null
  onClose: () => void
  onSaved: (s: Settings) => void
  onRepoChanged: (r: RepoInfo | null) => void
  /** Live-preview colours while the dialog is open. */
  onPreview?: (s: Settings) => void
}

export function SettingsDialog({ settings, repo, onClose, onSaved, onRepoChanged, onPreview }: Props): React.JSX.Element {
  const [form, setForm] = useState<Settings>(settings)
  const [remote, setRemote] = useState(repo?.remoteUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void api.updates.status().then(setUpdate)
    return api.updates.onStatus(setUpdate)
  }, [])

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const setTheme = (patch: Partial<ThemeSettings>): void =>
    setForm((f) => {
      const theme: ThemeSettings = { ...f.theme, ...patch }
      if (patch.sidebar === undefined && 'sidebar' in patch) delete theme.sidebar
      if (patch.accent === undefined && 'accent' in patch) delete theme.accent
      const next = { ...f, theme }
      onPreview?.(next)
      return next
    })
  const resolved = resolveTheme(form.theme)
  const close = (): void => {
    onPreview?.(settings) // drop any unsaved preview
    onClose()
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.settings.set(form)
      onSaved(next)
      if (repo && remote.trim() !== (repo.remoteUrl ?? '')) {
        const info = await api.repo.setRemote(remote.trim())
        onRepoChanged(info)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const changeRepo = async (): Promise<void> => {
    const dir = await api.repo.chooseDirectory()
    if (!dir) return
    setError(null)
    try {
      const info = await api.repo.open(dir)
      onRepoChanged(info)
      setRemote(info.remoteUrl ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>

        <section>
          <h3>Repository</h3>
          <div className="field">
            <label>Folder</label>
            <div className="field-row">
              <code className="path" title={repo?.path ?? ''}>
                {repo?.path ?? 'None'}
              </code>
              <button type="button" className="btn btn-quiet" onClick={() => void changeRepo()}>
                Change…
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => void api.repo.reveal()} disabled={!repo}>
                Reveal
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="remote">Remote URL (origin)</label>
            <input id="remote" type="text" placeholder="git@github.com:you/devlog.git" value={remote} onChange={(ev) => setRemote(ev.target.value)} />
            <p className="hint">Pushes use your existing git credentials (SSH agent or credential helper). Leave blank to keep the log local.</p>
          </div>
        </section>

        <section>
          <h3>Appearance</h3>
          <div className="theme-presets">
            {THEME_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`theme-swatch${form.theme.preset === p.id && !form.theme.sidebar && !form.theme.accent ? ' is-selected' : ''}`}
                style={{ background: p.sidebar }}
                title={p.label}
                onClick={() => setTheme({ preset: p.id, sidebar: undefined, accent: undefined })}
              >
                <span className="theme-swatch-accent" style={{ background: p.accent }} />
                <span className="theme-swatch-label" style={{ color: resolveTheme({ preset: p.id }).sidebarFg }}>
                  {p.label}
                </span>
              </button>
            ))}
          </div>
          <div className="field-grid">
            <label htmlFor="themeSidebar">Sidebar colour</label>
            <span className="field-row">
              <input id="themeSidebar" type="color" value={resolved.sidebarBg} onChange={(ev) => setTheme({ sidebar: ev.target.value })} />
              <code className="path">{resolved.sidebarBg}</code>
            </span>
            <label htmlFor="themeAccent">Accent colour</label>
            <span className="field-row">
              <input id="themeAccent" type="color" value={resolved.accent} onChange={(ev) => setTheme({ accent: ev.target.value })} />
              <code className="path">{resolved.accent}</code>
              {(form.theme.sidebar || form.theme.accent) && (
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setTheme({ sidebar: undefined, accent: undefined })}>
                  Reset to preset
                </button>
              )}
            </span>
          </div>
          <p className="hint">Text, hover and selection colours follow from these two. Light and dark mode for the content area follow the system.</p>
        </section>

        <section>
          <h3>Automatic sync</h3>
          <div className="field-grid">
            <label htmlFor="debounce">Commit after edits (seconds)</label>
            <input id="debounce" type="number" min={1} max={3600} value={form.commitDebounceSeconds} onChange={(ev) => set('commitDebounceSeconds', Number(ev.target.value))} />
            <label htmlFor="interval">Sync every (minutes)</label>
            <input id="interval" type="number" min={1} max={1440} value={form.syncIntervalMinutes} onChange={(ev) => set('syncIntervalMinutes', Number(ev.target.value))} />
          </div>
          <label className="check">
            <input type="checkbox" checked={form.autoPush} onChange={(ev) => set('autoPush', ev.target.checked)} /> Push to the remote after committing
          </label>
          <label className="check">
            <input type="checkbox" checked={form.pullOnStart} onChange={(ev) => set('pullOnStart', ev.target.checked)} /> Pull from the remote when the app starts
          </label>
          <label className="check">
            <input type="checkbox" checked={form.commitOnQuit} onChange={(ev) => set('commitOnQuit', ev.target.checked)} /> Commit and push when quitting
          </label>
        </section>

        <section>
          <h3>Activity tracking</h3>
          <label className="check">
            <input type="checkbox" checked={form.trackingEnabled} onChange={(ev) => set('trackingEnabled', ev.target.checked)} /> Track the active task
            and machine activity (lock, idle, sleep)
          </label>
          <label className="check">
            <input type="checkbox" checked={form.trackFocus} disabled={!form.trackingEnabled} onChange={(ev) => set('trackFocus', ev.target.checked)} /> Record the
            focused window (app and title)
          </label>
          <div className="field-grid">
            <label htmlFor="idle">Pause the task after idle (minutes, 0 = never)</label>
            <input id="idle" type="number" min={0} max={240} value={form.idleMinutes} onChange={(ev) => set('idleMinutes', Number(ev.target.value))} />
          </div>
          <div className="field-grid">
            <label htmlFor="focusMin" title="Alt-tab flips shorter than this are folded into the surrounding window. Raw data is always kept.">
              Ignore window switches shorter than (seconds)
            </label>
            <input
              id="focusMin"
              type="number"
              min={0}
              max={120}
              value={form.focusMinSeconds}
              disabled={!form.trackingEnabled || !form.trackFocus}
              onChange={(ev) => set('focusMinSeconds', Number(ev.target.value))}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={form.activityInRepo} onChange={(ev) => set('activityInRepo', ev.target.checked)} /> Store the activity log in the devlog
            repository (synced; window titles included) instead of locally
          </label>
          <label className="check">
            <input type="checkbox" checked={form.captureCommits} onChange={(ev) => set('captureCommits', ev.target.checked)} /> Capture commits from canvas
            repositories as read-only blocks
          </label>
          <div className="field-grid">
            <label htmlFor="backfill" title="When you link a repository, this many days of your own commits are imported, dated when they were made. 0 imports nothing.">
              Import commit history when linking (days)
            </label>
            <input id="backfill" type="number" min={0} max={3650} value={form.commitBackfillDays} disabled={!form.captureCommits} onChange={(ev) => set('commitBackfillDays', Number(ev.target.value))} />
          </div>
          <p className="hint">With tracking on, closing the window keeps Devlog running in the tray. Quit from the tray or the File menu.</p>
        </section>

        <section>
          <h3>Updates</h3>
          <label className="check">
            <input type="checkbox" checked={form.autoUpdate} onChange={(ev) => set('autoUpdate', ev.target.checked)} /> Update automatically in the
            background and restart at a quiet moment
          </label>
          <p className="hint update-line">
            Version {update?.currentVersion ?? '…'}
            {update?.state === 'unavailable' && ' · updates only apply to installed builds'}
            {update?.state === 'checking' && ' · checking…'}
            {update?.state === 'downloading' && ` · downloading ${update.availableVersion ?? ''}${update.progress !== undefined ? ` (${update.progress}%)` : ''}`}
            {update?.state === 'downloaded' && ` · ${update.availableVersion} downloaded, installs when the app is idle, hidden or the screen is locked`}
            {update?.state === 'installing' && ' · restarting into the update…'}
            {update?.state === 'idle' && update.checkedAt && ` · up to date (checked ${new Date(update.checkedAt).toLocaleTimeString()})`}
            {update?.state === 'error' && ` · update check failed: ${update.error}`}
            {update && update.state !== 'unavailable' && update.state !== 'checking' && update.state !== 'downloading' && update.state !== 'installing' && (
              <>
                {' '}
                <button type="button" className="link" onClick={() => void api.updates.check()}>
                  Check now
                </button>
              </>
            )}
          </p>
        </section>

        <section>
          <h3>Commit author</h3>
          <p className="hint">Optional. Overrides the git config for this app only; leave blank to use your global git identity.</p>
          <div className="field-grid">
            <label htmlFor="authorName">Name</label>
            <input id="authorName" type="text" value={form.authorName} onChange={(ev) => set('authorName', ev.target.value)} />
            <label htmlFor="authorEmail">Email</label>
            <input id="authorEmail" type="email" value={form.authorEmail} onChange={(ev) => set('authorEmail', ev.target.value)} />
          </div>
        </section>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
