import { useEffect, useMemo, useState } from 'react'
import { JOURNAL_ID, buildCanvasTree, describeScope, flattenTree, type Grant, type GrantScope } from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
import type { ExtensionInfo } from '@shared/extensions'
import { api } from '@renderer/api'
import { reported, showToast } from '@renderer/toasts'

/** The extensions of the open devlog, kept current. */
export function useExtensions(): ExtensionInfo[] {
  const [list, setList] = useState<ExtensionInfo[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      void api.extensions
        .list()
        .then((l) => alive && setList(l))
        .catch(() => undefined)
    }
    load()
    const off = api.extensions.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])
  return list
}

const STATE_LABEL: Record<ExtensionInfo['state'], string> = {
  installing: 'Installing…',
  error: 'Error',
  'needs-consent': 'Not allowed yet',
  starting: 'Starting…',
  running: 'Running',
  failed: 'Stopped'
}

const SOURCE_LABEL: Record<ExtensionInfo['source'], string> = { github: 'GitHub', url: 'URL', builtin: 'Built in', dev: 'Development folder' }

interface Props {
  canvases: CanvasMeta[]
  onClose: () => void
}

export function ExtensionsDialog({ canvases, onClose }: Props): React.JSX.Element {
  const list = useExtensions()
  const [consentFor, setConsentFor] = useState<string | null>(null)
  const [openSettings, setOpenSettings] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')
  const [builtins, setBuiltins] = useState<Array<{ name: string; displayName: string; description?: string }>>([])

  useEffect(() => {
    void api.extensions.githubToken().then(setHasToken)
    void api.extensions.builtins().then(setBuiltins)
  }, [])
  const addable = builtins.filter((b) => !list.some((e) => e.key === b.name))

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape' && !consentFor) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, consentFor])

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const add = (): Promise<void> =>
    run(async () => {
      const key = source.trim()
      let spec = version.trim()
      if (!key) throw new Error('Name a GitHub repository (owner/repo), or give a name and a URL.')
      if (!spec) spec = key.includes('/') ? '*' : ''
      if (!spec) throw new Error('Give a version range, an https:// URL, or "builtin".')
      await api.extensions.add(key, spec)
      setSource('')
      setVersion('')
    })

  const checkUpdates = (): Promise<void> =>
    run(async () => {
      const r = await api.extensions.update()
      if (r.errors.length) throw new Error(r.errors.map((e) => `${e.key}: ${e.error}`).join('; '))
      showToast(r.updated.length ? `Updated ${r.updated.map((u) => `${u.key} to ${u.to}`).join(', ')}; allow them again to run the new code` : 'Every extension is up to date', 'info')
    })

  const consentTarget = list.find((e) => e.key === consentFor) ?? null

  return (
    <div className="modal-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && !consentFor && onClose()}>
      <div className="modal modal-extensions" role="dialog" aria-modal="true" aria-labelledby="ext-title">
        <h2 id="ext-title">Extensions</h2>
        <p className="hint">
          Extensions this devlog uses, listed in its <code>devlog.json</code>. Each runs in its own process with no access to your files, and only after you
          allow it on this machine. You choose what it may read and write.
        </p>

        {list.length === 0 && <p className="ext-empty">No extensions yet.</p>}
        <ul className="ext-list">
          {list.map((e) => (
            <li key={e.key} className={`ext-item is-${e.state}`} data-ext={e.key}>
              <div className="ext-head">
                <span className="ext-name">{e.displayName}</span>
                {e.version && <span className="ext-version">{e.version}</span>}
                <span className={`ext-state state-${e.state}`}>{STATE_LABEL[e.state]}</span>
              </div>
              <div className="ext-source">
                {SOURCE_LABEL[e.source]} · <code>{e.key}</code>
                {e.source === 'github' || e.source === 'url' ? (
                  <>
                    {' '}
                    <code>{e.spec}</code>
                  </>
                ) : null}
              </div>
              {e.description && <p className="ext-desc">{e.description}</p>}
              {e.error && <p className="form-error ext-error">{e.error}</p>}
              <p className="ext-perms">
                {e.permissions.read ? <>Reads: {e.grant ? describeScope(canvases, e.grant.read) : 'asks for access'}. </> : 'Reads nothing. '}
                {e.permissions.write ? <>Writes: {e.grant ? describeScope(canvases, e.grant.write) : 'asks for access'}. </> : null}
                {e.permissions.unrestricted ? <>Runs unrestricted{e.grant?.trusted ? ' (trusted)' : ''}. </> : null}
                {e.permissions.network?.length ? <>Network: {e.permissions.network.join(', ')}. </> : null}
              </p>
              <div className="ext-actions">
                {e.state === 'needs-consent' && (
                  <button type="button" className="btn btn-primary btn-xs" onClick={() => setConsentFor(e.key)}>
                    {e.changedSinceConsent ? 'Review the new version…' : 'Review and allow…'}
                  </button>
                )}
                {(e.state === 'running' || e.state === 'starting' || e.state === 'failed') && (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConsentFor(e.key)}>
                    Access…
                  </button>
                )}
                {e.state === 'failed' && (
                  <button type="button" className="btn btn-quiet btn-xs" disabled={busy} onClick={() => void run(() => api.extensions.restart(e.key))}>
                    Start again
                  </button>
                )}
                {(e.settings.length > 0 || e.secrets.length > 0) && (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => setOpenSettings((k) => (k === e.key ? null : e.key))} aria-expanded={openSettings === e.key}>
                    Settings
                  </button>
                )}
                {(e.state === 'running' || e.state === 'starting' || e.state === 'failed') && (
                  <button type="button" className="btn btn-quiet btn-xs" disabled={busy} onClick={() => void run(() => api.extensions.revoke(e.key))} title="Stop it and withdraw your permission on this machine">
                    Stop
                  </button>
                )}
                <span className="spacer" />
                <button type="button" className="btn btn-quiet btn-xs btn-danger-text" disabled={busy} onClick={() => void run(() => api.extensions.remove(e.key))} title="Remove it from this devlog (its data stays)">
                  Remove
                </button>
              </div>
              {openSettings === e.key && <ExtensionSettings ext={e} />}
            </li>
          ))}
        </ul>

        {addable.length > 0 && (
          <section className="ext-builtins">
            <h3>Built into Devlog</h3>
            <ul className="ext-list">
              {addable.map((b) => (
                <li key={b.name} className="ext-item" data-builtin={b.name}>
                  <div className="ext-head">
                    <span className="ext-name">{b.displayName}</span>
                    <span className="spacer" />
                    <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void run(() => api.extensions.add(b.name, 'builtin'))}>
                      Add
                    </button>
                  </div>
                  {b.description && <p className="ext-desc">{b.description}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="ext-add">
          <h3>Add an extension</h3>
          <div className="field-row">
            <input type="text" aria-label="Source" placeholder="owner/repository, or a name" value={source} onChange={(ev) => setSource(ev.target.value)} />
            <input type="text" aria-label="Version" placeholder="^1.0.0, an https:// URL, or builtin" value={version} onChange={(ev) => setVersion(ev.target.value)} />
            <button type="button" className="btn" disabled={busy} onClick={() => void add()}>
              Add
            </button>
          </div>
          <p className="hint">
            From a GitHub repository's releases (the newest release matching the version range, pinned in <code>devlog.lock.json</code>), a single{' '}
            <code>.devlog-ext.zip</code> URL, or an extension built into Devlog.
          </p>
          <div className="field-row">
            <label htmlFor="ghToken" className="ext-token-label">
              GitHub token {hasToken ? '(set)' : '(for private repositories)'}
            </label>
            <input id="ghToken" type="password" autoComplete="off" value={token} placeholder={hasToken ? '••••••••' : 'ghp_…'} onChange={(ev) => setToken(ev.target.value)} />
            <button
              type="button"
              className="btn btn-quiet btn-xs"
              disabled={!token.trim()}
              onClick={() =>
                void run(async () => {
                  setHasToken(await api.extensions.githubToken(token))
                  setToken('')
                })
              }
            >
              Save
            </button>
            {hasToken && (
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => void run(async () => setHasToken(await api.extensions.githubToken(null)))}>
                Clear
              </button>
            )}
          </div>
        </section>

        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" disabled={busy || list.length === 0} onClick={() => void checkUpdates()}>
            Check for updates
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      {consentTarget && <ConsentDialog ext={consentTarget} canvases={canvases} onClose={() => setConsentFor(null)} />}
    </div>
  )
}

/** Devlog-wide settings (stored in devlog.json) and secrets (this machine's keychain). */
function ExtensionSettings({ ext }: { ext: ExtensionInfo }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(ext.settingValues)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  return (
    <div className="ext-settings">
      {ext.settings.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`set-${ext.key}-${f.key}`}>{f.label}</label>
          <input
            id={`set-${ext.key}-${f.key}`}
            type="text"
            placeholder={f.placeholder}
            value={values[f.key] ?? ''}
            onChange={(ev) => {
              setSaved(false)
              setValues((v) => ({ ...v, [f.key]: ev.target.value }))
            }}
          />
        </div>
      ))}
      {ext.settings.length > 0 && (
        <div className="field-row">
          <button type="button" className="btn btn-xs" onClick={() => void reported(api.extensions.setSettings(ext.key, values).then(() => setSaved(true)))}>
            Save settings
          </button>
          {saved && <span className="hint">Saved to devlog.json</span>}
        </div>
      )}
      {ext.secrets.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={`sec-${ext.key}-${f.key}`}>
            {f.label} <span className="hint">{f.set ? '(set on this machine)' : '(not set)'}</span>
          </label>
          <div className="field-row">
            <input
              id={`sec-${ext.key}-${f.key}`}
              type="password"
              autoComplete="off"
              placeholder={f.set ? '••••••••' : f.placeholder}
              value={secrets[f.key] ?? ''}
              onChange={(ev) => setSecrets((s) => ({ ...s, [f.key]: ev.target.value }))}
            />
            <button
              type="button"
              className="btn btn-xs"
              disabled={!secrets[f.key]}
              onClick={() => void reported(api.extensions.setSecret(ext.key, f.key, secrets[f.key]).then(() => setSecrets((s) => ({ ...s, [f.key]: '' }))))}
            >
              Save
            </button>
            {f.set && (
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => void reported(api.extensions.setSecret(ext.key, f.key, null))}>
                Clear
              </button>
            )}
          </div>
        </div>
      ))}
      {ext.secrets.length > 0 && <p className="hint">Secrets are encrypted with this computer's keychain and never written to the devlog.</p>}
    </div>
  )
}

type ScopeChoice = 'none' | 'all' | 'some'

function choiceOf(scope: GrantScope | null | undefined, fallback: ScopeChoice): ScopeChoice {
  if (scope === undefined) return fallback
  if (!scope) return 'none'
  return 'all' in scope ? 'all' : 'some'
}

/** Allow an extension to run, and choose what it may read and write. */
export function ConsentDialog({ ext, canvases, onClose }: { ext: ExtensionInfo; canvases: CanvasMeta[]; onClose: () => void }): React.JSX.Element {
  const [read, setRead] = useState<ScopeChoice>(choiceOf(ext.grant?.read, 'some'))
  const [write, setWrite] = useState<ScopeChoice>(choiceOf(ext.grant?.write, 'some'))
  const [readIds, setReadIds] = useState<string[]>(ext.grant?.read && 'canvases' in ext.grant.read ? ext.grant.read.canvases : [])
  const [writeIds, setWriteIds] = useState<string[]>(ext.grant?.write && 'canvases' in ext.grant.write ? ext.grant.write.canvases : [])
  const [trusted, setTrusted] = useState(Boolean(ext.grant?.trusted))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const scope = (choice: ScopeChoice, ids: string[]): GrantScope | null => (choice === 'all' ? { all: true } : choice === 'some' && ids.length ? { canvases: ids } : null)

  const allow = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const grant: Grant = {
        read: ext.permissions.read ? scope(read, readIds) : null,
        write: ext.permissions.write ? scope(write, writeIds) : null,
        ...(ext.permissions.unrestricted && trusted ? { trusted: true } : {})
      }
      await api.extensions.allow(ext.key, grant)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop consent-backdrop" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="modal modal-consent" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h2 id="consent-title">Allow {ext.displayName}?</h2>
        <p className="consent-meta">
          {ext.version && <>Version {ext.version} · </>}
          {SOURCE_LABEL[ext.source]} <code>{ext.key}</code>
          {ext.sha256 && (
            <>
              {' '}
              · <code title={ext.sha256}>{ext.sha256.slice(0, 12)}</code>
            </>
          )}
        </p>
        {ext.changedSinceConsent && <p className="consent-note">Its code changed since you last allowed it.</p>}
        <ul className="consent-facts">
          {!ext.permissions.unrestricted && <li>It runs in its own process on this computer, with no access to your files or other programs.</li>}
          <li>It keeps its own data in the devlog (<code>extensions/{ext.id}/</code>) and on this machine; other extensions cannot see it.</li>
          <li>
            {ext.permissions.network?.length ? (
              <>
                It says it talks to <strong>{ext.permissions.network.join(', ')}</strong>. Network access is not restricted, so it can send out anything it can read.
              </>
            ) : (
              <>It declares no network use, but network access is not restricted, so it could send out anything it can read.</>
            )}
          </li>
        </ul>

        {ext.permissions.read && (
          <ScopePicker label="It may read notes in" choice={read} ids={readIds} canvases={canvases} onChoice={setRead} onIds={setReadIds} name="read" />
        )}
        {ext.permissions.write && (
          <ScopePicker label="It may add blocks to" choice={write} ids={writeIds} canvases={canvases} onChoice={setWrite} onIds={setWriteIds} name="write" />
        )}
        {ext.permissions.unrestricted && (
          <div className="consent-trust">
            <p>
              <strong>This extension runs unrestricted.</strong> Unlike other extensions it is not sandboxed: it can read and change any file you can, start
              programs, and see everything on this computer that you can.
            </p>
            <label className="check">
              <input type="checkbox" checked={trusted} onChange={(ev) => setTrusted(ev.target.checked)} /> I trust {ext.displayName} and its author
            </label>
          </div>
        )}
        {!ext.permissions.read && !ext.permissions.write && <p className="hint">It does not ask to read or write your notes.</p>}

        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || (ext.permissions.unrestricted && !trusted)} onClick={() => void allow()}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}

function ScopePicker({
  label,
  name,
  choice,
  ids,
  canvases,
  onChoice,
  onIds
}: {
  label: string
  name: string
  choice: ScopeChoice
  ids: string[]
  canvases: CanvasMeta[]
  onChoice: (c: ScopeChoice) => void
  onIds: (ids: string[]) => void
}): React.JSX.Element {
  const tree = useMemo(() => flattenTree(buildCanvasTree(canvases.filter((c) => c.id !== JOURNAL_ID))), [canvases])
  const toggle = (id: string): void => onIds(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  return (
    <fieldset className="scope-picker" data-scope={name}>
      <legend>{label}</legend>
      <label className="check">
        <input type="radio" name={`scope-${name}`} checked={choice === 'all'} onChange={() => onChoice('all')} /> The whole devlog
      </label>
      <label className="check">
        <input type="radio" name={`scope-${name}`} checked={choice === 'some'} onChange={() => onChoice('some')} /> Only these canvases (and what is inside them)
      </label>
      {choice === 'some' && (
        <ul className="scope-canvases">
          <li>
            <label className="check">
              <input type="checkbox" checked={ids.includes(JOURNAL_ID)} onChange={() => toggle(JOURNAL_ID)} /> Journal
            </label>
          </li>
          {tree.map(({ canvas: c, depth }) => (
            <li key={c.id} style={{ paddingLeft: depth * 16 }}>
              <label className="check">
                <input type="checkbox" checked={ids.includes(c.id)} onChange={() => toggle(c.id)} /> {c.title}
              </label>
            </li>
          ))}
        </ul>
      )}
      <label className="check">
        <input type="radio" name={`scope-${name}`} checked={choice === 'none'} onChange={() => onChoice('none')} /> Nothing
      </label>
    </fieldset>
  )
}
