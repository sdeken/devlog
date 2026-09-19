import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localDate } from '@shared/entries'
import { JOURNAL_PAGE, JOURNAL_PAGE_ID, categoryPath, categorySuggestions, formatCategory } from '@shared/pages'
import type { Day, EntryPosition, PageMeta, RepoInfo, SearchResult, Settings, SyncStatus, TrackerStatus, WikiMeta } from '@shared/types'
import { api } from '@renderer/api'
import { Composer } from './components/Composer'
import { Feed } from './components/Feed'
import { PageDialog } from './components/PageDialog'
import { Review } from './components/Review'
import { CategoryView } from './components/CategoryView'
import { Timeline } from './components/Timeline'
import { Sidebar, type SidebarSelection } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { Welcome } from './components/Welcome'
import { getActiveComposer } from './editor/active'

const TIMELINE_DAYS = 10

function pageLabelOf(pages: PageMeta[], id: string): string {
  if (id === JOURNAL_PAGE_ID) return 'Journal'
  const p = pages.find((x) => x.id === id)
  return p ? [...categoryPath(p.category), p.title].join(' / ') : id
}

/** Replace or insert one day in an ascending timeline; drop it when empty. */
function mergeDay(days: Day[], day: Day): Day[] {
  const rest = days.filter((d) => d.date !== day.date)
  if (day.entries.length === 0) return rest
  return [...rest, day].sort((a, b) => a.date.localeCompare(b.date))
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [repo, setRepo] = useState<RepoInfo | null | undefined>(undefined)
  const [today, setToday] = useState(localDate(new Date()))
  const [pages, setPages] = useState<PageMeta[]>([JOURNAL_PAGE])
  const [pageId, setPageId] = useState<string>(JOURNAL_PAGE_ID)
  const [view, setView] = useState<'page' | 'review' | 'timeline' | 'category'>('page')
  const [categoryPathSel, setCategoryPathSel] = useState<string[]>([])
  const [wikis, setWikis] = useState<WikiMeta[]>([])
  const [timelineDate, setTimelineDate] = useState<string>(localDate(new Date()))
  const [tracker, setTracker] = useState<TrackerStatus | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<SearchResult | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pageDialog, setPageDialog] = useState<{ page: PageMeta | null; category?: string } | null>(null)
  const [focusToken, setFocusToken] = useState(0)
  const [bootError, setBootError] = useState<string | null>(null)
  const [editRequest, setEditRequest] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const pageIdRef = useRef(pageId)
  pageIdRef.current = pageId

  const page = useMemo(() => pages.find((p) => p.id === pageId) ?? JOURNAL_PAGE, [pages, pageId])
  const categories = useMemo(() => categorySuggestions(pages), [pages])

  const refreshPages = useCallback(async () => {
    const [list, wikiList] = await Promise.all([api.pages.list(), api.wiki.list()])
    setPages(list)
    setWikis(wikiList)
    if (!list.some((p) => p.id === pageIdRef.current)) setPageId(JOURNAL_PAGE_ID)
  }, [])

  const loadTimeline = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const t = await api.entries.timeline(id, { days: TIMELINE_DAYS })
      if (pageIdRef.current !== id) return
      setDays(t.days)
      setHasMore(t.hasMore)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    const first = days[0]
    if (!first) return
    const t = await api.entries.timeline(pageId, { beforeDate: first.date, days: TIMELINE_DAYS })
    if (pageIdRef.current !== pageId) return
    setDays((cur) => [...t.days, ...cur])
    setHasMore(t.hasMore)
  }, [days, pageId])

  const reloadDay = useCallback(
    async (id: string, date: string) => {
      const day = await api.entries.getDay(id, date)
      if (pageIdRef.current === id) setDays((cur) => mergeDay(cur, day))
    },
    []
  )

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
      setPageId(JOURNAL_PAGE_ID)
    })
    const offSync = api.sync.onStatus((st) => setSync(st))
    const offTracker = api.tracker.onStatus((st) => setTracker(st))
    const offMenu = api.onMenu((cmd) => {
      if (cmd === 'openSettings') setSettingsOpen(true)
      if (cmd === 'focusComposer') setFocusToken((n) => n + 1)
      if (cmd === 'search') searchRef.current?.focus()
      if (cmd === 'syncNow') void api.sync.now()
      if (cmd === 'newPage') setPageDialog({ page: null })
      if (cmd === 'review') setView('review')
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

  // Roll over at midnight.
  useEffect(() => {
    const t = setInterval(() => {
      const d = localDate(new Date())
      if (d !== today) setToday(d)
    }, 30_000)
    return () => clearInterval(t)
  }, [today])

  // Load pages + timeline when the repo or page changes, or another machine pushed something.
  useEffect(() => {
    if (!repo) return
    void refreshPages()
    void loadTimeline(pageId)
    return api.entries.onChanged(() => {
      void refreshPages()
      void loadTimeline(pageIdRef.current)
    })
  }, [repo, pageId, refreshPages, loadTimeline])

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
    async (id: string, markdown: string, position?: EntryPosition) => {
      const { date } = await api.entries.add(id, markdown, position)
      if (!position && date !== today) setToday(date)
      await reloadDay(id, date)
    },
    [today, reloadDay]
  )

  const updateEntry = useCallback(
    async (id: string, date: string, entryId: string, markdown: string) => {
      await api.entries.update(id, date, entryId, markdown)
      await reloadDay(id, date)
      if (search) setHits(await api.entries.search(search))
    },
    [search, reloadDay]
  )

  const deleteEntry = useCallback(
    async (id: string, date: string, entryId: string) => {
      await api.entries.remove(id, date, entryId)
      await reloadDay(id, date)
      if (search) setHits(await api.entries.search(search))
    },
    [search, reloadDay]
  )

  const moveEntry = useCallback(
    async (id: string, date: string, entryId: string, toPageId: string) => {
      await api.entries.move(id, date, entryId, toPageId)
      await reloadDay(id, date)
    },
    [reloadDay]
  )

  const editLast = useCallback(() => {
    const last = days[days.length - 1]
    if (!last || last.date !== today || last.entries.length === 0) return
    setEditRequest(last.entries[last.entries.length - 1].id)
    setTimeout(() => setEditRequest(null), 0)
  }, [days, today])

  const openCategory = useCallback((path: string[]) => {
    setSearch('')
    setCategoryPathSel(path)
    setView('category')
  }, [])

  const jumpTo = useCallback((id: string, date: string) => {
    setSearch('')
    setView('page')
    setPageId(id)
    // Scroll the day into view once the timeline has rendered.
    setTimeout(() => document.querySelector(`.day-group[data-date="${date}"]`)?.scrollIntoView({ block: 'start' }), 250)
  }, [])

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
      <Sidebar
        pages={pages}
        wikis={wikis}
        selection={
          view === 'review'
            ? { kind: 'review' }
            : view === 'timeline'
              ? { kind: 'timeline' }
              : view === 'category'
                ? { kind: 'category', path: categoryPathSel }
                : { kind: 'page', pageId }
        }
        search={search}
        onSearch={setSearch}
        onSelect={(sel: SidebarSelection) => {
          setSearch('')
          if (sel.kind === 'review') setView('review')
          else if (sel.kind === 'timeline') setView('timeline')
          else if (sel.kind === 'category') openCategory(sel.path)
          else {
            setView('page')
            setPageId(sel.pageId)
          }
        }}
        onNewPage={() => setPageDialog({ page: null })}
        searchRef={searchRef}
      />
      <main className="main">
        {view === 'review' && !search && (
          <Review
            pages={pages}
            today={today}
            onJumpTo={jumpTo}
            onOpenTimeline={(d) => {
              setTimelineDate(d)
              setView('timeline')
            }}
          />
        )}
        {view === 'timeline' && !search && <Timeline pages={pages} today={today} date={timelineDate} onChangeDate={setTimelineDate} onJumpTo={jumpTo} />}
        {view === 'category' && !search && (
          <CategoryView
            key={formatCategory(categoryPathSel)}
            path={categoryPathSel}
            pages={pages}
            onSelectCategory={openCategory}
            onSelectPage={(id) => {
              setView('page')
              setPageId(id)
            }}
            onNewPage={(category) => setPageDialog({ page: null, category })}
            onChanged={refreshPages}
          />
        )}
        {(view === 'page' || search) && (
        <Feed
          page={page}
          pages={pages}
          days={days}
          hasMore={hasMore}
          today={today}
          search={search}
          hits={hits}
          loading={loading}
          editRequest={editRequest}
          onLoadMore={loadMore}
          onAdd={addEntry}
          onUpdate={updateEntry}
          onDelete={deleteEntry}
          onMove={moveEntry}
          onEditPage={() => setPageDialog({ page })}
          onArchivePage={(archived) => void api.pages.archive(pageId, archived).then(() => refreshPages())}
          onJumpTo={jumpTo}
          onOpenCategory={openCategory}
        />
        )}
        {view === 'page' && !page.archived && (
        <div className="composer-dock">
          <Composer
            key={pageId}
            mode="new"
            placeholder={
              page.id === JOURNAL_PAGE_ID
                ? undefined
                : `Write a note on ${page.title}…  Enter posts, Shift+Enter new line, ⇧⌘I or paste for images`
            }
            assetPageId={pageId}
            draftKey={`devlog:draft:${repo.path}:${pageId}`}
            autoFocus
            onSubmit={(md) => addEntry(pageId, md)}
            onEditLast={editLast}
            focusToken={focusToken}
          />
        </div>
        )}
        <StatusBar
          status={sync}
          tracker={tracker}
          taskLabel={tracker?.activePageId ? pageLabelOf(pages, tracker.activePageId) : null}
          onSyncNow={() => void api.sync.now()}
          onOpenSettings={() => setSettingsOpen(true)}
          onStopTask={() => void api.tracker.setTask(null)}
          onOpenTimeline={() => {
            setTimelineDate(localDate(new Date()))
            setView('timeline')
          }}
        />
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
      {pageDialog && (
        <PageDialog
          page={pageDialog.page}
          categories={categories}
          initialCategory={pageDialog.category}
          onClose={() => setPageDialog(null)}
          onSaved={async (saved) => {
            await refreshPages()
            setSearch('')
            setView('page')
            setPageId(saved.id)
          }}
          onDeleted={async () => {
            setPageId(JOURNAL_PAGE_ID)
            await refreshPages()
          }}
        />
      )}
    </div>
  )
}
