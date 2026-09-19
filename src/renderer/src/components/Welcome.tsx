import { useState } from 'react'
import type { RepoInfo } from '@shared/types'
import { api } from '@renderer/api'

interface Props {
  onOpened: (info: RepoInfo) => void
  initialError?: string | null
}

export function Welcome({ onOpened, initialError }: Props): React.JSX.Element {
  const [remote, setRemote] = useState('')
  const [busy, setBusy] = useState<'create' | 'open' | null>(null)
  const [error, setError] = useState<string | null>(initialError ?? null)

  const run = async (kind: 'create' | 'open'): Promise<void> => {
    const dir = await api.repo.chooseDirectory()
    if (!dir) return
    setBusy(kind)
    setError(null)
    try {
      const info = kind === 'create' ? await api.repo.create(dir, remote.trim() || undefined) : await api.repo.open(dir)
      onOpened(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Devlog</h1>
        <p className="lede">
          A running log of what you're working on. Every post is a markdown file in a git repository, committed and pushed
          automatically.
        </p>
        <div className="welcome-cards">
          <div className="card">
            <h2>Create a new devlog</h2>
            <p>Pick an empty folder. Devlog will run <code>git init</code>, lay out the folders and make the first commit.</p>
            <label htmlFor="remote">Remote URL (optional)</label>
            <input id="remote" type="text" placeholder="git@github.com:you/devlog.git" value={remote} onChange={(ev) => setRemote(ev.target.value)} />
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('create')}>
              {busy === 'create' ? 'Creating…' : 'Choose folder & create'}
            </button>
          </div>
          <div className="card">
            <h2>Open an existing devlog</h2>
            <p>Choose a folder that is already a git repository, for example a clone of a devlog from another machine.</p>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('open')}>
              {busy === 'open' ? 'Opening…' : 'Choose folder & open'}
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <p className="hint">Requires git on your PATH. Pushing uses the credentials git already has (SSH agent or credential helper).</p>
      </div>
    </div>
  )
}
