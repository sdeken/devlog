import { useEffect, useRef, useState } from 'react'
import type { CanvasMeta, RepoInfo, Settings, ThemeSettings, UpdateStatus } from '@shared/types'
import type { ExtensionInfo } from '@shared/extensions'
import { THEME_PRESETS, resolveTheme } from '@shared/theme'
import { api } from '@renderer/api'
import { PagedDialog, type DialogPage } from './PagedDialog'
import { ExtensionPage, ExtensionsPage, needsAttention } from './ExtensionPages'

/** The app's own pages, and which settings each one edits (for its unsaved-changes marker). */
const APP_PAGES: Array<{ id: string; label: string; keys: Array<keyof Settings | 'remote'> }> = [
  { id: 'repository', label: 'Repository', keys: ['remote', 'authorName', 'authorEmail'] },
  { id: 'sync', label: 'Sync', keys: ['commitDebounceSeconds', 'syncIntervalMinutes', 'autoPush', 'pullOnStart', 'commitOnQuit'] },
  { id: 'appearance', label: 'Appearance', keys: ['theme'] },
  { id: 'tracking', label: 'Activity tracking', keys: ['trackingEnabled', 'idleMinutes', 'focusMinSeconds', 'activityInRepo', 'captureCommits', 'commitBackfillDays'] },
  { id: 'updates', label: 'Updates', keys: ['autoUpdate'] }
]

export type SettingsPage = string

interface Props {
  settings: Settings
  repo: RepoInfo | null
  canvases: CanvasMeta[]
  extensions: ExtensionInfo[]
  /** The page to open on: an app page id, 'extensions', or 'ext:<key>'. */
  initialPage?: SettingsPage
  onClose: () => void
  onSaved: (s: Settings) => void
  onRepoChanged: (r: RepoInfo | null) => void
  /** Live-preview colours while the dialog is open. */
  onPreview?: (s: Settings) => void
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Settings: the app's own pages and, under Extensions, a page for each
 * extension this devlog uses. App settings save together; Save only lights
 * up once something changed, and each page with unsaved changes is marked.
 */
export function SettingsDialog({ settings, repo, canvases, extensions, initialPage, onClose, onSaved, onRepoChanged, onPreview }: Props): React.JSX.Element {
  const [page, setPage] = useState<SettingsPage>(initialPage ?? 'repository')
  const [form, setForm] = useState<Settings>(settings)
  const [remote, setRemote] = useState(repo?.remoteUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [extDirty, setExtDirty] = useState<Record<string, boolean>>({})
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    void api.updates.status().then(setUpdate)
    return api.updates.onStatus(setUpdate)
  }, [])

  // An extension that went away (removed here, or by a pull) loses its page;
  // one just added may not be listed yet, so its page waits for it.
  const seen = useRef(new Set<string>())
  for (const e of extensions) seen.current.add(e.key)
  const pageExt = page.startsWith('ext:') ? page.slice(4) : null
  useEffect(() => {
    if (pageExt && seen.current.has(pageExt) && !extensions.some((e) => e.key === pageExt)) setPage('extensions')
  }, [extensions, pageExt])

  const changed = (key: keyof Settings | 'remote'): boolean => (key === 'remote' ? remote.trim() !== (repo?.remoteUrl ?? '') : !same(form[key], settings[key]))
  const pageDirty = (id: string): boolean => APP_PAGES.find((p) => p.id === id)?.keys.some(changed) ?? false
  const dirty = APP_PAGES.some((p) => pageDirty(p.id))
  const anyDirty = dirty || Object.values(extDirty).some(Boolean)

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => {
    setSaved(false)
    setForm((f) => ({ ...f, [k]: v }))
  }
  const setTheme = (patch: Partial<ThemeSettings>): void => {
    setSaved(false)
    setForm((f) => {
      const theme: ThemeSettings = { ...f.theme, ...patch }
      if (patch.sidebar === undefined && 'sidebar' in patch) delete theme.sidebar
      if (patch.accent === undefined && 'accent' in patch) delete theme.accent
      const next = { ...f, theme }
      onPreview?.(next)
      return next
    })
  }
  const resolved = resolveTheme(form.theme)

  const close = (force = false): void => {
    if (anyDirty && !force) {
      setConfirmClose(true)
      return
    }
    onPreview?.(settings) // drop any unsaved preview
    onClose()
  }

  const revert = (): void => {
    setForm(settings)
    setRemote(repo?.remoteUrl ?? '')
    onPreview?.(settings)
    setError(null)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const next = await api.settings.set(form)
      onSaved(next)
      setForm(next)
      if (repo && remote.trim() !== (repo.remoteUrl ?? '')) {
        const info = await api.repo.setRemote(remote.trim())
        onRepoChanged(info)
      }
      setSaved(true)
      setConfirmClose(false)
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

  const pages: DialogPage[] = [
    ...APP_PAGES.map((p) => ({ id: p.id, label: p.label, group: 'Devlog', badge: pageDirty(p.id) ? ('dirty' as const) : null })),
    ...(repo
      ? [
          { id: 'extensions', label: 'Manage', group: 'Extensions', badge: null },
          ...extensions.map((e) => ({
            id: `ext:${e.key}`,
            label: e.displayName,
            group: 'Extensions',
            badge: extDirty[e.key] ? ('dirty' as const) : needsAttention(e) ? ('attention' as const) : null
          }))
        ]
      : [])
  ]
  const onAppPage = APP_PAGES.some((p) => p.id === page)

  const footer = confirmClose ? (
    <>
      <span className="entry-confirm">Close without saving your changes?</span>
      <span className="spacer" />
      <button type="button" className="btn btn-quiet" onClick={() => setConfirmClose(false)}>
        Keep editing
      </button>
      <button type="button" className="btn btn-danger" onClick={() => close(true)}>
        Discard changes
      </button>
    </>
  ) : onAppPage ? (
    <>
      {error && <p className="form-error">{error}</p>}
      <span className="spacer" />
      {dirty ? <span className="hint">Unsaved changes</span> : saved ? <span className="hint state-saved">Saved</span> : null}
      {dirty && (
        <button type="button" className="btn btn-quiet" onClick={revert} disabled={saving}>
          Revert
        </button>
      )}
      <button type="button" className="btn btn-primary settings-save" onClick={() => void save()} disabled={saving || !dirty}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </>
  ) : null

  return (
    <PagedDialog title="Settings" className="modal-settings" pages={pages} page={page} onPage={setPage} onClose={() => close()} footer={footer}>
      {page === 'repository' && (
        <div className="settings-page">
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
            <input
              id="remote"
              type="text"
              placeholder="git@github.com:you/devlog.git"
              value={remote}
              onChange={(ev) => {
                setSaved(false)
                setRemote(ev.target.value)
              }}
            />
            <p className="hint">Pushes use your existing git credentials (SSH agent or credential helper). Leave blank to keep the log local.</p>
          </div>
          <h3>Commit author</h3>
          <p className="hint">Optional. Overrides the git config for this app only; leave blank to use your global git identity.</p>
          <div className="field-grid">
            <label htmlFor="authorName">Name</label>
            <input id="authorName" type="text" value={form.authorName} onChange={(ev) => set('authorName', ev.target.value)} />
            <label htmlFor="authorEmail">Email</label>
            <input id="authorEmail" type="email" value={form.authorEmail} onChange={(ev) => set('authorEmail', ev.target.value)} />
          </div>
        </div>
      )}

      {page === 'sync' && (
        <div className="settings-page">
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
        </div>
      )}

      {page === 'appearance' && (
        <div className="settings-page">
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
        </div>
      )}

      {page === 'tracking' && (
        <div className="settings-page">
          <h3>Activity tracking</h3>
          <label className="check">
            <input type="checkbox" checked={form.trackingEnabled} onChange={(ev) => set('trackingEnabled', ev.target.checked)} /> Track the active task and machine
            activity (lock, idle, sleep)
          </label>
          <p className="hint">
            Recording the focused window (app and title) is the <strong>devlog-focus</strong> extension: add it under Extensions to turn it on for this devlog.
          </p>
          <div className="field-grid">
            <label htmlFor="idle">Pause the task after idle (minutes, 0 = never)</label>
            <input id="idle" type="number" min={0} max={240} value={form.idleMinutes} onChange={(ev) => set('idleMinutes', Number(ev.target.value))} />
            <label htmlFor="focusMin" title="Alt-tab flips shorter than this are folded into the surrounding window. Raw data is always kept.">
              Ignore window switches shorter than (seconds)
            </label>
            <input
              id="focusMin"
              type="number"
              min={0}
              max={120}
              value={form.focusMinSeconds}
              disabled={!form.trackingEnabled}
              onChange={(ev) => set('focusMinSeconds', Number(ev.target.value))}
            />
          </div>
          <label className="check">
            <input type="checkbox" checked={form.activityInRepo} onChange={(ev) => set('activityInRepo', ev.target.checked)} /> Keep the activity log in the devlog
            repository, one folder per machine, so time tracked on every machine adds up (synced). Off: this machine only
          </label>
          <h3>Commits</h3>
          <label className="check">
            <input type="checkbox" checked={form.captureCommits} onChange={(ev) => set('captureCommits', ev.target.checked)} /> Capture commits from canvas
            repositories as read-only blocks
          </label>
          <div className="field-grid">
            <label htmlFor="backfill" title="When you link a repository you can choose to import your own recent commits; this is the number of days offered.">
              Days of history offered when linking
            </label>
            <input id="backfill" type="number" min={1} max={3650} value={form.commitBackfillDays} disabled={!form.captureCommits} onChange={(ev) => set('commitBackfillDays', Number(ev.target.value))} />
          </div>
          <p className="hint">With tracking on, closing the window keeps Devlog running in the tray. Quit from the tray or the File menu.</p>
        </div>
      )}

      {page === 'updates' && (
        <div className="settings-page">
          <h3>Updates</h3>
          <label className="check">
            <input type="checkbox" checked={form.autoUpdate} onChange={(ev) => set('autoUpdate', ev.target.checked)} /> Update automatically in the background and
            restart at a quiet moment
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
        </div>
      )}

      {page === 'extensions' && <ExtensionsPage list={extensions} onOpen={(key) => setPage(`ext:${key}`)} />}

      {pageExt && !extensions.some((e) => e.key === pageExt) && <p className="hint">Installing…</p>}

      {/* Every extension page stays mounted, so switching pages keeps what you typed. */}
      {extensions.map((e) => (
        <div key={e.key} hidden={page !== `ext:${e.key}`}>
          <ExtensionPage
            ext={e}
            canvases={canvases}
            onDirty={(d) => setExtDirty((cur) => (Boolean(cur[e.key]) === d ? cur : { ...cur, [e.key]: d }))}
            onRemoved={() => setPage('extensions')}
          />
        </div>
      ))}
    </PagedDialog>
  )
}
