import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localDate } from '@shared/entries'
import { JOURNAL, JOURNAL_ID, canvasLabel } from '@shared/canvases'
import { themeCssVars } from '@shared/theme'
import type { CanvasMeta, Day, EntryPosition, RepoInfo, SearchResult, Settings, SyncStatus, TrackerStatus } from '@shared/types'
import { api } from '@renderer/api'
import { Composer } from './components/Composer'
import { Feed } from './components/Feed'
import { CanvasView } from './components/CanvasView'
import { CanvasDialog } from './components/CanvasDialog'
import { Review } from './components/Review'
import { Summary } from './components/Summary'
import { QuickSwitcher, type SwitchTarget } from './components/QuickSwitcher'
import { Timeline } from './components/Timeline'
import { Sidebar, type SidebarSelection } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { Welcome } from './components/Welcome'
import { getActiveComposer } from './editor/active'
import { Toasts } from './components/Toasts'
import { errorMessage, reported, showToast } from './toasts'
import { kbd } from './keys'

const TIMELINE_DAYS = 10

type View = 'canvas' | 'review' | 'summary' | 'timeline'

/** Replace or insert one day in an ascending timeline; drop it when empty. */
function mergeDay(days: Day[], day: Day): Day[] {
  const rest = days.filter((d) => d.date !== day.date)
  if (day.entries.length === 0) return rest
  return [...rest, day].sort((a, b) => a.date.localeCompare(b.date))
}

function applyTheme(settings: Settings | null): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeCssVars(settings?.theme))) root.style.setProperty(k, v)
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [repo, setRepo] = useState<RepoInfo | null | undefined>(undefined)
  const [today, setToday] = useState(localDate(new Date()))
  const [canvases, setCanvases] = useState<CanvasMeta[]>([JOURNAL])
  const [canvasId, setCanvasId] = useState<string>(JOURNAL_ID)
  const [view, setView] = useState<View>('canvas')
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // Where the composer posts. Follows the open canvas but can be pointed elsewhere.
  const [targetCanvasId, setTargetCanvasId] = useState<string>(JOURNAL_ID)
  const [timelineDate, setTimelineDate] = useState<string>(localDate(new Date()))
  const [tracker, setTracker] = useState<TrackerStatus | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<SearchResult | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [canvasDialog, setCanvasDialog] = useState<{ canvas: CanvasMeta | null; parentId?: string | null; task?: boolean } | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [bootError, setBootError] = useState<string | null>(null)
  const [editRequest, setEditRequest] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const canvasIdRef = useRef(canvasId)
  canvasIdRef.current = canvasId

  const canvas = useMemo(() => canvases.find((c) => c.id === canvasId) ?? JOURNAL, [canvases, canvasId])
  const targetCanvas = useMemo(() => canvases.find((c) => c.id === targetCanvasId) ?? JOURNAL, [canvases, targetCanvasId])

  const refreshCanvases = useCallback(async () => {
    const list = await api.canvases.list()
    setCanvases(list)
    if (!list.some((c) => c.id === canvasIdRef.current)) setCanvasId(JOURNAL_ID)
    return list
  }, [])

  const loadTimeline = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const t = await api.blocks.timeline(id, { days: TIMELINE_DAYS })
      if (canvasIdRef.current !== id) return
      setDays(t.days)
      setHasMore(t.hasMore)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    const first = days[0]
    if (!first) return
    const t = await api.blocks.timeline(canvasId, { beforeDate: first.date, days: TIMELINE_DAYS })
    if (canvasIdRef.current !== canvasId) return
    setDays((cur) => [...t.days, ...cur])
    setHasMore(t.hasMore)
  }, [days, canvasId])

  const reloadDay = useCallback(async (id: string, date: string) => {
    const day = await api.blocks.getDay(id, date)
    if (canvasIdRef.current === id) setDays((cur) => mergeDay(cur, day))
  }, [])

  // Boot: settings + repo.
  useEffect(() => {
    void (async () => {
      const [s, r, st, tr] = await Promise.all([api.settings.get(), api.repo.info(), api.sync.status(), api.tracker.status()])
      setSettings(s)
      setRepo(r)
      setSync(st)
      setTracker(tr)
      if (!r && s.repoPath) setBootError(`Could not reopen ${s.repoPath}. Open it again or create a new devlog.`)
    })()
    const offRepo = api.repo.onChanged((info) => {
      setRepo(info)
      setCanvasId(JOURNAL_ID)
    })
    const offSync = api.sync.onStatus((st) => setSync(st))
    const offTracker = api.tracker.onStatus((st) => setTracker(st))
    const offMenu = api.onMenu((cmd) => {
      if (cmd === 'openSettings') setSettingsOpen(true)
      if (cmd === 'focusComposer') setFocusToken((n) => n + 1)
      if (cmd === 'search') searchRef.current?.focus()
      if (cmd === 'syncNow') void reported(api.sync.now())
      if (cmd === 'newCanvas') setCanvasDialog({ canvas: null })
      if (cmd === 'review') setView('review')
      if (cmd === 'summary') setView('summary')
      if (cmd === 'switcher') setSwitcherOpen((v) => !v)
      if (cmd === 'timeline') {
        setTimelineDate(localDate(new Date()))
        setView('timeline')
      }
    })
    const offAttach = api.onAttachImages((images) => {
      const sink = getActiveComposer()
      if (!sink) return
      sink(images.map((im) => new File([im.bytes as BlobPart], im.name, { type: im.mime })))
    })
    return () => {
      offRepo()
      offSync()
      offTracker()
      offMenu()
      offAttach()
    }
  }, [])

  // Colours come from settings.
  useEffect(() => applyTheme(settings), [settings])

  // Surface failures from fire-and-forget calls instead of losing them in the console.
  useEffect(() => {
    const onRejection = (ev: PromiseRejectionEvent): void => {
      ev.preventDefault()
      showToast(errorMessage(ev.reason))
    }
    window.addEventListener('unhandledrejection', onRejection)
    return () => window.removeEventListener('unhandledrejection', onRejection)
  }, [])

  // Quick switcher: Ctrl/Cmd+K from anywhere outside the editor (Ctrl/Cmd+P arrives via the menu).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey) return
      if (ev.key.toLowerCase() !== 'k') return
      if ((ev.target as HTMLElement | null)?.closest('.ProseMirror')) return
      ev.preventDefault()
      setSwitcherOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The composer target follows the canvas being viewed.
  useEffect(() => {
    if (view === 'canvas') setTargetCanvasId(canvasId)
  }, [view, canvasId])

  // Window title follows the view.
  useEffect(() => {
    const label = view === 'review' ? 'Weekly review' : view === 'summary' ? 'Summary' : view === 'timeline' ? 'Timeline' : canvasLabel(canvases, canvasId)
    document.title = search ? `Search: ${search} · Devlog` : `${label} · Devlog`
  }, [view, canvases, canvasId, search])

  // Roll over at midnight.
  useEffect(() => {
    const t = setInterval(() => {
      const d = localDate(new Date())
      if (d !== today) setToday(d)
    }, 30_000)
    return () => clearInterval(t)
  }, [today])

  // Load canvases + stream when the repo or canvas changes, or another machine pushed something.
  useEffect(() => {
    if (!repo) return
    void refreshCanvases()
    void loadTimeline(canvasId)
    return api.blocks.onChanged(() => {
      void refreshCanvases()
      void loadTimeline(canvasIdRef.current)
    })
  }, [repo, canvasId, refreshCanvases, loadTimeline])

  // Search (debounced).
  useEffect(() => {
    if (!repo) return
    if (!search.trim()) {
      setHits(null)
      return
    }
    setHits(null)
    const t = setTimeout(() => {
      void api.blocks.search(search).then(setHits)
    }, 180)
    return () => clearTimeout(t)
  }, [search, repo])

  const openCanvas = useCallback((id: string, date?: string) => {
    setSearch('')
    setView('canvas')
    setCanvasId(id)
    if (date) setTimeout(() => document.querySelector(`.day-group[data-date="${date}"]`)?.scrollIntoView({ block: 'start' }), 250)
  }, [])

  const addEntry = useCallback(
    async (id: string, markdown: string, position?: EntryPosition, opts?: { task?: boolean }) => {
      const res = await api.blocks.add(id, markdown, position, opts)
      if (!position && res.date !== today) setToday(res.date)
      await reloadDay(id, res.date)
      if (res.canvas) {
        await refreshCanvases()
        showToast(`Task started: ${res.canvas.title}`)
      }
    },
    [today, reloadDay, refreshCanvases]
  )

  const updateEntry = useCallback(
    async (id: string, date: string, entryId: string, markdown: string) => {
      await api.blocks.update(id, date, entryId, markdown)
      await reloadDay(id, date)
      if (search) setHits(await api.blocks.search(search))
    },
    [search, reloadDay]
  )

  const deleteEntry = useCallback(
    async (id: string, date: string, entryId: string) => {
      await api.blocks.remove(id, date, entryId)
      await reloadDay(id, date)
      if (search) setHits(await api.blocks.search(search))
    },
    [search, reloadDay]
  )

  const moveEntry = useCallback(
    async (id: string, date: string, entryId: string, toCanvasId: string) => {
      await api.blocks.move(id, date, entryId, toCanvasId)
      await reloadDay(id, date)
    },
    [reloadDay]
  )

  const promoteEntry = useCallback(
    async (id: string, date: string, entryId: string) => {
      const res = await api.blocks.promote(id, date, entryId)
      await reloadDay(id, date)
      await refreshCanvases()
      showToast(`Task started: ${res.canvas.title}`)
    },
    [reloadDay, refreshCanvases]
  )

  const editLast = useCallback(() => {
    const last = days[days.length - 1]
    if (!last || last.date !== today || last.entries.length === 0) return
    setEditRequest(last.entries[last.entries.length - 1].id)
    setTimeout(() => setEditRequest(null), 0)
  }, [days, today])

  const goTo = useCallback(
    (target: SwitchTarget) => {
      setSearch('')
      if (target.kind === 'view') {
        if (target.view === 'timeline') setTimelineDate(localDate(new Date()))
        setView(target.view)
      } else openCanvas(target.canvasId)
    },
    [openCanvas]
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

  const selection: SidebarSelection = view === 'canvas' ? { kind: 'canvas', canvasId } : { kind: view }

  return (
    <div className="app">
      <TopBar search={search} onSearch={setSearch} searchRef={searchRef} onSwitcher={() => setSwitcherOpen(true)} />
      <Sidebar
        canvases={canvases}
        selection={selection}
        activeCanvasId={tracker?.activeCanvasId ?? null}
        searching={Boolean(search)}
        onSelect={(sel) => {
          setSearch('')
          if (sel.kind === 'canvas') openCanvas(sel.canvasId)
          else {
            if (sel.kind === 'timeline') setTimelineDate(localDate(new Date()))
            setView(sel.kind)
          }
        }}
        onNewCanvas={() => setCanvasDialog({ canvas: null, parentId: view === 'canvas' && canvasId !== JOURNAL_ID ? canvasId : null })}
      />
      <main className="main">
        {search && (
          <Feed
            canvas={canvas}
            canvases={canvases}
            days={[]}
            hasMore={false}
            today={today}
            search={search}
            hits={hits}
            loading={false}
            editRequest={null}
            onLoadMore={async () => undefined}
            onAdd={addEntry}
            onUpdate={updateEntry}
            onDelete={deleteEntry}
            onMove={moveEntry}
            onJumpTo={openCanvas}
            onOpenCanvas={openCanvas}
          />
        )}
        {view === 'review' && !search && (
          <Review
            canvases={canvases}
            today={today}
            focusMinSeconds={settings.focusMinSeconds}
            onJumpTo={openCanvas}
            onOpenTimeline={(d) => {
              setTimelineDate(d)
              setView('timeline')
            }}
          />
        )}
        {view === 'summary' && !search && <Summary canvases={canvases} today={today} focusMinSeconds={settings.focusMinSeconds} onOpenCanvas={openCanvas} />}
        {view === 'timeline' && !search && (
          <Timeline canvases={canvases} today={today} date={timelineDate} focusMinSeconds={settings.focusMinSeconds} onChangeDate={setTimelineDate} onJumpTo={openCanvas} />
        )}
        {view === 'canvas' && !search && (
          <CanvasView
            key={canvasId}
            canvas={canvas}
            canvases={canvases}
            days={days}
            hasMore={hasMore}
            today={today}
            loading={loading}
            editRequest={editRequest}
            activeCanvasId={tracker?.activeCanvasId ?? null}
            onLoadMore={loadMore}
            onAdd={addEntry}
            onUpdate={updateEntry}
            onDelete={deleteEntry}
            onMove={moveEntry}
            onPromote={promoteEntry}
            onOpenCanvas={openCanvas}
            onEditCanvas={() => setCanvasDialog({ canvas })}
            onNewCanvasHere={(task) => setCanvasDialog({ canvas: null, parentId: canvasId, task })}
            onArchive={async (archived) => {
              await api.canvases.archive(canvasId, archived)
              await refreshCanvases()
            }}
            onStartTask={() => void reported(api.tracker.setTask(canvasId))}
            onStopTask={() => void reported(api.tracker.setTask(null))}
          />
        )}
        {!search && !(view === 'canvas' && canvas.archived) && (
          <div className="composer-dock">
            <Composer
              key={targetCanvasId}
              mode="new"
              placeholder={
                targetCanvas.id === JOURNAL_ID
                  ? undefined
                  : targetCanvas.task
                    ? `Note on ${targetCanvas.title}…  posting here makes it the active task · Enter posts, Shift+Enter new line`
                    : `Note on ${targetCanvas.title}…  Enter posts, ${kbd('mod', 'shift', 'Enter')} posts as a task, Shift+Enter new line`
              }
              assetCanvasId={targetCanvasId}
              draftKey={`devlog:draft:${repo.path}:${targetCanvasId}`}
              autoFocus={view === 'canvas'}
              onSubmit={async (md, opts) => {
                await addEntry(targetCanvasId, md, undefined, opts)
                if (view !== 'canvas') showToast(`Posted to ${canvasLabel(canvases, targetCanvasId)}`)
              }}
              onEditLast={view === 'canvas' ? editLast : undefined}
              focusToken={focusToken}
              canvases={canvases}
              targetCanvasId={targetCanvasId}
              onTargetChange={setTargetCanvasId}
            />
          </div>
        )}
        <StatusBar
          status={sync}
          tracker={tracker}
          taskLabel={tracker?.activeCanvasId ? canvasLabel(canvases, tracker.activeCanvasId) : null}
          onSyncNow={() => void reported(api.sync.now())}
          onOpenSettings={() => setSettingsOpen(true)}
          onStopTask={() => void reported(api.tracker.setTask(null))}
          onOpenTimeline={() => {
            setTimelineDate(localDate(new Date()))
            setView('timeline')
          }}
        />
      </main>
      <Toasts />
      {switcherOpen && (
        <QuickSwitcher
          canvases={canvases}
          onPick={(t) => {
            setSwitcherOpen(false)
            goTo(t)
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog settings={settings} repo={repo} onClose={() => setSettingsOpen(false)} onSaved={setSettings} onRepoChanged={(r) => setRepo(r)} onPreview={applyTheme} />
      )}
      {canvasDialog && (
        <CanvasDialog
          canvas={canvasDialog.canvas}
          canvases={canvases}
          initialParentId={canvasDialog.parentId}
          initialTask={canvasDialog.task}
          onClose={() => setCanvasDialog(null)}
          onSaved={async (saved) => {
            await refreshCanvases()
            openCanvas(saved.id)
          }}
          onDeleted={async () => {
            setCanvasId(JOURNAL_ID)
            await refreshCanvases()
          }}
        />
      )}
    </div>
  )
}
