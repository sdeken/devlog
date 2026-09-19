import { useCallback, useEffect, useRef, useState } from 'react'
import { localDate } from '@shared/entries'
import type { Day, DaySummary, EntryPosition, RepoInfo, SearchHit, Settings, SyncStatus } from '@shared/types'
import { api } from '@renderer/api'
import { Composer } from './components/Composer'
import { Feed } from './components/Feed'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { Welcome } from './components/Welcome'
import { getActiveComposer } from './editor/active'

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [repo, setRepo] = useState<RepoInfo | null | undefined>(undefined)
  const [today, setToday] = useState(localDate(new Date()))
  const [days, setDays] = useState<DaySummary[]>([])
  const [selected, setSelected] = useState(today)
  const [day, setDay] = useState<Day | null>(null)
  const [loadingDay, setLoadingDay] = useState(false)
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const [bootError, setBootError] = useState<string | null>(null)
  const [editRequest, setEditRequest] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const refreshDays = useCallback(async () => {
    setDays(await api.entries.listDays())
  }, [])

  const loadDay = useCallback(async (date: string) => {
    setLoadingDay(true)
    try {
      setDay(await api.entries.getDay(date))
    } finally {
      setLoadingDay(false)
    }
  }, [])

  // Boot: settings + repo.
  useEffect(() => {
    void (async () => {
      const [s, r, st] = await Promise.all([api.settings.get(), api.repo.info(), api.sync.status()])
      setSettings(s)
      setRepo(r)
      setSync(st)
      if (!r && s.repoPath) setBootError(`Could not reopen ${s.repoPath}. Open it again or create a new devlog.`)
    })()
    const offRepo = api.repo.onChanged((info) => setRepo(info))
    const offSync = api.sync.onStatus((st) => setSync(st))
    const offMenu = api.onMenu((cmd) => {
      if (cmd === 'openSettings') setSettingsOpen(true)
      if (cmd === 'focusComposer') setFocusToken((n) => n + 1)
      if (cmd === 'search') searchRef.current?.focus()
      if (cmd === 'syncNow') void api.sync.now()
    })
    const offAttach = api.onAttachImages((images) => {
      const sink = getActiveComposer()
      if (!sink) return
      sink(images.map((im) => new File([im.bytes as BlobPart], im.name, { type: im.mime })))
    })
    return () => {
      offRepo()
      offSync()
      offMenu()
      offAttach()
    }
  }, [])

  // Roll over at midnight.
  useEffect(() => {
    const t = setInterval(() => {
      const d = localDate(new Date())
      if (d !== today) {
        setToday(d)
        setSelected((sel) => (sel === today ? d : sel))
      }
    }, 30_000)
    return () => clearInterval(t)
  }, [today])

  // Load data when the repo changes or another machine pushed something.
  useEffect(() => {
    if (!repo) return
    void refreshDays()
    void loadDay(selected)
    return api.entries.onChanged(() => {
      void refreshDays()
      void loadDay(selected)
    })
  }, [repo, selected, refreshDays, loadDay])

  // Search (debounced).
  useEffect(() => {
    if (!repo) return
    if (!search.trim()) {
      setHits(null)
      return
    }
    setHits(null)
    const t = setTimeout(() => {
      void api.entries.search(search).then(setHits)
    }, 180)
    return () => clearTimeout(t)
  }, [search, repo])

  const addEntry = useCallback(
    async (markdown: string, position?: EntryPosition) => {
      const { date } = await api.entries.add(markdown, position)
      if (!position) {
        if (date !== today) setToday(date)
        setSelected(date)
      }
      await Promise.all([date === selected || !position ? loadDay(date) : Promise.resolve(), refreshDays()])
    },
    [today, selected, loadDay, refreshDays]
  )

  const editLast = useCallback(() => {
    if (selected !== today || !day || day.entries.length === 0) return
    const last = day.entries[day.entries.length - 1]
    setEditRequest(last.id)
    // Clear on the next tick so the same note can be requested again later.
    setTimeout(() => setEditRequest(null), 0)
  }, [selected, today, day])

  const updateEntry = useCallback(
    async (date: string, id: string, markdown: string) => {
      await api.entries.update(date, id, markdown)
      if (date === selected) await loadDay(date)
      if (search) setHits(await api.entries.search(search))
    },
    [selected, search, loadDay]
  )

  const deleteEntry = useCallback(
    async (date: string, id: string) => {
      await api.entries.remove(date, id)
      await Promise.all([date === selected ? loadDay(date) : Promise.resolve(), refreshDays()])
      if (search) setHits(await api.entries.search(search))
    },
    [selected, search, loadDay, refreshDays]
  )

  if (repo === undefined || settings === null) {
    return <div className="boot">Loading…</div>
  }

  if (!repo) {
    return (
      <Welcome
        initialError={bootError}
        onOpened={(info) => {
          setRepo(info)
          setBootError(null)
        }}
      />
    )
  }

  return (
    <div className="app">
      <Sidebar days={days} today={today} selected={selected} search={search} onSearch={setSearch} onSelect={setSelected} searchRef={searchRef} />
      <main className="main">
        <Feed
          day={search ? null : day}
          today={today}
          search={search}
          hits={hits}
          loading={loadingDay}
          editRequest={editRequest}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onDelete={deleteEntry}
          onJumpToDay={(d) => {
            setSearch('')
            setSelected(d)
          }}
        />
        <div className="composer-dock">
          {selected !== today && !search && (
            <div className="composer-notice">
              New entries are posted to today.{' '}
              <button type="button" className="link" onClick={() => setSelected(today)}>
                Go to today
              </button>
            </div>
          )}
          <Composer
            mode="new"
            draftKey={`devlog:draft:${repo.path}`}
            autoFocus
            onSubmit={(md) => addEntry(md)}
            onEditLast={editLast}
            focusToken={focusToken}
          />
        </div>
        <StatusBar status={sync} onSyncNow={() => void api.sync.now()} onOpenSettings={() => setSettingsOpen(true)} />
      </main>
      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          repo={repo}
          onClose={() => setSettingsOpen(false)}
          onSaved={setSettings}
          onRepoChanged={(r) => setRepo(r)}
        />
      )}
    </div>
  )
}
