import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localDate } from '@devlog/core'
import { JOURNAL, JOURNAL_ID, buildCanvasTree, canvasLabel, flattenTree } from '@devlog/core'
import { themeCssVars } from '@shared/theme'
import type { CanvasMeta, Day, Entry, EntryPosition, RepoInfo, SearchResult, Settings, SyncStatus, TrackerStatus } from '@shared/types'
import { api } from '@renderer/api'
import { Composer } from './components/Composer'
import { Feed } from './components/Feed'
import { CanvasView } from './components/CanvasView'
import { BlockPage, blockTitle } from './components/BlockPage'
import { CanvasDialog } from './components/CanvasDialog'
import { LinkRepoDialog } from './components/LinkRepoDialog'
import { TodoPanel } from './components/TodoPanel'
import { Review } from './components/Review'
import { Summary } from './components/Summary'
import { QuickSwitcher, type SwitchTarget } from './components/QuickSwitcher'
import { Timeline } from './components/Timeline'
import { Timesheet } from './components/Timesheet'
import { Sidebar, type SidebarSelection } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { needsAttention, useExtensions } from './components/ExtensionPages'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { ExtensionView } from './components/ExtensionView'
import { ExtensionPopover } from './components/ExtensionPopover'
import { Welcome } from './components/Welcome'
import { getActiveComposer, getDockEditor } from './editor/active'
import { Toasts } from './components/Toasts'
import { errorMessage, reported, showToast } from './toasts'
import { kbd } from './keys'

const TIMELINE_DAYS = 10

type View = 'canvas' | 'review' | 'summary' | 'timeline' | 'timesheet' | 'ext'

/** A block open as a page: its canvas, its day file and its id. */
interface OpenBlock {
  canvasId: string
  date: string
  id: string
}

/** A place in the app, for back / forward. */
interface Place {
  view: View
  canvasId: string
  block: OpenBlock | null
  timelineDate: string
  /** On the 'ext' view: which extension page. */
  extPage: string
}

const blockKey = (b: OpenBlock | null): string => (b ? `${b.canvasId}/${b.date}/${b.id}` : '')

/** Only what the view shows counts: the open canvas (or block page) on a canvas, the date on the timeline. */
function samePlace(a: Place, b: Place): boolean {
  if (a.view !== b.view) return false
  if (a.view === 'canvas') return a.canvasId === b.canvasId && blockKey(a.block) === blockKey(b.block)
  if (a.view === 'timeline') return a.timelineDate === b.timelineDate
  if (a.view === 'ext') return a.extPage === b.extPage
  return true
}

const LAST_CANVAS_KEY = 'devlog:last-canvas'

/** Where to land with no canvas chosen: the last one viewed, the running task, or the first in the tree. */
function homeCanvas(list: CanvasMeta[], activeCanvasId: string | null | undefined): string {
  const live = (id: string | null | undefined): boolean => Boolean(id) && list.some((c) => c.id === id && !c.archived)
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_CANVAS_KEY)
  } catch {
    /* ignore */
  }
  if (live(last)) return last!
  if (live(activeCanvasId)) return activeCanvasId!
  return flattenTree(buildCanvasTree(list))[0]?.canvas.id ?? ''
}

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
  const [canvases, setCanvases] = useState<CanvasMeta[]>([])
  // '' until the canvases are known (and when there are none yet).
  const [canvasId, setCanvasId] = useState<string>('')
  const [view, setView] = useState<View>('canvas')
  // A block open as a page (on the canvas view), and its day file.
  const [block, setBlock] = useState<OpenBlock | null>(null)
  const [pageDay, setPageDay] = useState<Day | null>(null)
  // An extension page on screen ('ext' view): "<devlog.json key>/<view id>".
  const [extPage, setExtPage] = useState('')
  // An extension popover open, anchored to the view that asked for it.
  const [popover, setPopover] = useState<{ extKey: string; viewId: string; url: string; title: string; anchor: DOMRect; width: number; height: number } | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // Where the composer posts. Follows the open canvas but can be pointed elsewhere.
  const [targetCanvasId, setTargetCanvasId] = useState<string>('')
  const [timelineDate, setTimelineDate] = useState<string>(localDate(new Date()))
  const [tracker, setTracker] = useState<TrackerStatus | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<SearchResult | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  // The settings page open, or null when closed.
  const [settingsPage, setSettingsPage] = useState<string | null>(null)
  const extensions = useExtensions()
  const [canvasDialog, setCanvasDialog] = useState<{ canvas: CanvasMeta | null; parentId?: string | null; task?: boolean; start?: boolean } | null>(null)
  const [canvasMenu, setCanvasMenu] = useState<{ canvasId: string; x: number; y: number } | null>(null)
  // The retired journal is listed (under Archived) only while it still holds notes.
  const [journalHasNotes, setJournalHasNotes] = useState(false)
  const [focusToken, setFocusToken] = useState(0)
  const [linkRepo, setLinkRepo] = useState<{ canvasId: string; root: string } | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [editRequest, setEditRequest] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const canvasIdRef = useRef(canvasId)
  canvasIdRef.current = canvasId
  const blockRef = useRef(block)
  blockRef.current = block
  const trackerRef = useRef(tracker)
  trackerRef.current = tracker
  const canvasesRef = useRef(canvases)
  canvasesRef.current = canvases

  // Back / forward (Alt+←/→, the mouse's side buttons): every place visited, like a browser.
  const nav = useRef<{ stack: Place[]; index: number; restoring: Place | null }>({ stack: [], index: -1, restoring: null })
  useEffect(() => {
    const here: Place = { view, canvasId, block, timelineDate, extPage }
    const h = nav.current
    if (h.restoring) {
      const target = h.restoring
      h.restoring = null
      if (samePlace(target, here)) return
    }
    if (h.index >= 0 && samePlace(h.stack[h.index], here)) return
    h.stack = [...h.stack.slice(0, h.index + 1), here].slice(-100)
    h.index = h.stack.length - 1
  }, [view, canvasId, block, timelineDate, extPage])
  const goRef = useRef<(delta: 1 | -1) => void>(() => undefined)
  goRef.current = (delta) => {
    const h = nav.current
    let i = h.index + delta
    // Skip places that no longer exist (a canvas deleted since).
    while (i >= 0 && i < h.stack.length && h.stack[i].view === 'canvas' && !canvasesRef.current.some((c) => c.id === h.stack[i].canvasId)) i += delta
    if (i < 0 || i >= h.stack.length) return
    h.index = i
    const place = h.stack[i]
    h.restoring = place
    setSearch('')
    setView(place.view)
    setCanvasId(place.canvasId)
    setBlock(place.block)
    setTimelineDate(place.timelineDate)
    setExtPage(place.extPage)
  }
  useEffect(() => {
    const onMouse = (ev: MouseEvent): void => {
      if (ev.button !== 3 && ev.button !== 4) return
      ev.preventDefault()
      goRef.current(ev.button === 3 ? -1 : 1)
    }
    // Captured on the window, so it runs before the editor sees the key.
    const mac = navigator.platform.toLowerCase().includes('mac')
    const onKey = (ev: KeyboardEvent): void => {
      const plain = !ev.ctrlKey && !ev.shiftKey
      const back = mac ? ev.metaKey && !ev.altKey && plain && ev.key === '[' : ev.altKey && !ev.metaKey && plain && ev.key === 'ArrowLeft'
      const forward = mac ? ev.metaKey && !ev.altKey && plain && ev.key === ']' : ev.altKey && !ev.metaKey && plain && ev.key === 'ArrowRight'
      if (!back && !forward) return
      ev.preventDefault()
      ev.stopPropagation()
      goRef.current(back ? -1 : 1)
    }
    window.addEventListener('mouseup', onMouse)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const page = block && block.canvasId === canvasId ? block : null
  const canvas = useMemo(() => canvases.find((c) => c.id === canvasId) ?? (canvasId === JOURNAL_ID ? JOURNAL : null), [canvases, canvasId])
  const targetCanvas = useMemo(() => canvases.find((c) => c.id === targetCanvasId && c.id !== JOURNAL_ID && !c.archived) ?? null, [canvases, targetCanvasId])

  const refreshCanvases = useCallback(async () => {
    const list = await api.canvases.list()
    setCanvases(list)
    if (!list.some((c) => c.id === canvasIdRef.current)) setCanvasId(homeCanvas(list, trackerRef.current?.activeCanvasId))
    return list
  }, [])

  const checkJournal = useCallback(async () => {
    const t = await api.blocks.timeline(JOURNAL_ID, { days: 1 })
    setJournalHasNotes(t.days.length > 0)
  }, [])

  const loadTimeline = useCallback(async (id: string) => {
    if (!id) {
      setDays([])
      setHasMore(false)
      return
    }
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

  // Every local change to a day file goes through here; the todo panel listens.
  const [dayVersion, setDayVersion] = useState(0)
  const reloadDay = useCallback(async (id: string, date: string) => {
    setDayVersion((n) => n + 1)
    const day = await api.blocks.getDay(id, date)
    if (canvasIdRef.current === id) setDays((cur) => mergeDay(cur, day))
    const b = blockRef.current
    if (b && b.canvasId === id && b.date === date) setPageDay(day)
  }, [])

  // The open block's day file.
  const loadPage = useCallback(async (b: OpenBlock | null) => {
    if (!b) {
      setPageDay(null)
      return
    }
    const day = await api.blocks.getDay(b.canvasId, b.date)
    if (blockKey(blockRef.current) === blockKey(b)) setPageDay(day)
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
      setCanvases([])
      setCanvasId('')
      setBlock(null)
      nav.current = { stack: [], index: -1, restoring: null }
    })
    const offSync = api.sync.onStatus((st) => setSync(st))
    const offTracker = api.tracker.onStatus((st) => setTracker(st))
    const offMenu = api.onMenu((cmd) => {
      if (cmd === 'openSettings') setSettingsPage((p) => p ?? 'repository')
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
      if (cmd === 'back') goRef.current(-1)
      if (cmd === 'forward') goRef.current(1)
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

  // Typing with nothing focused starts a note in the dock composer.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return
      const target = ev.target instanceof Element ? ev.target : null
      if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      // Space and Enter still press the focused button or link.
      if (ev.key === ' ' && target?.closest('button, a, summary, [role="button"], [role="separator"]')) return
      if (document.querySelector('.modal-backdrop, .lightbox, [role="dialog"]')) return
      const dock = getDockEditor()
      if (!dock) return
      ev.preventDefault()
      dock.type(ev.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Extensions speak through toasts.
  useEffect(() => api.extensions.onNotify((text) => showToast(text, 'info')), [])

  // The composer target follows the canvas being viewed; remember it for next time.
  useEffect(() => {
    if (view !== 'canvas' || !canvasId || canvasId === JOURNAL_ID) return
    setTargetCanvasId(canvasId)
    try {
      localStorage.setItem(LAST_CANVAS_KEY, canvasId)
    } catch {
      /* ignore */
    }
  }, [view, canvasId])

  const pageTitle = page && pageDay?.date === page.date ? (() => {
    const e = pageDay.entries.find((x) => x.id === page.id)
    return e ? blockTitle(e, 40) : null
  })() : null

  // Window title follows the view.
  useEffect(() => {
    const label = view === 'review' ? 'Weekly review' : view === 'summary' ? 'Summary' : view === 'timeline' ? 'Timeline' : view === 'timesheet' ? 'Timesheet' : canvas ? `${pageTitle ? `${pageTitle} · ` : ''}${canvasLabel(canvases, canvas.id)}` : 'Devlog'
    document.title = search ? `Search: ${search} · Devlog` : `${label} · Devlog`
  }, [view, canvases, canvas, search, pageTitle])

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
    void checkJournal()
    return api.blocks.onChanged(() => {
      void refreshCanvases()
      void loadTimeline(canvasIdRef.current)
      void loadPage(blockRef.current)
      void checkJournal()
    })
  }, [repo, canvasId, refreshCanvases, loadTimeline, checkJournal, loadPage])

  // Coming back to a canvas from another view shows it as it is now.
  useEffect(() => {
    if (view === 'canvas' && repo) void loadTimeline(canvasIdRef.current)
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setPageDay((d) => (d && page && d.date === page.date ? d : null))
    void loadPage(page)
  }, [blockKey(page), loadPage]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setBlock(null)
    if (date) setTimeout(() => document.querySelector(`.day-group[data-date="${date}"]`)?.scrollIntoView({ block: 'start' }), 250)
  }, [])

  const openBlock = useCallback((id: string, date: string, entryId: string) => {
    setSearch('')
    setView('canvas')
    setCanvasId(id)
    setBlock({ canvasId: id, date, id: entryId })
  }, [])

  const addEntry = useCallback(
    async (id: string, markdown: string, position?: EntryPosition, opts?: { task?: boolean }): Promise<{ date: string; entry: Entry }> => {
      const res = await api.blocks.add(id, markdown, position, opts)
      if (!position && res.date !== today) setToday(res.date)
      await reloadDay(id, res.date)
      if (res.canvas) {
        await refreshCanvases()
        showToast(`Task started: ${res.canvas.title}`)
      }
      return res
    },
    [today, reloadDay, refreshCanvases]
  )

  // Up a level: from a block page to the block it is inside (or its canvas); from a canvas to its parent.
  const goUp = useCallback(() => {
    const b = blockRef.current
    if (b && b.canvasId === canvasIdRef.current) {
      const entry = pageDay?.entries.find((e) => e.id === b.id)
      if (entry?.parentId) setBlock({ ...b, id: entry.parentId })
      else setBlock(null)
      return
    }
    const parent = canvasesRef.current.find((c) => c.id === canvasIdRef.current)?.parentId
    if (parent) openCanvas(parent)
  }, [pageDay, openCanvas])
  const goUpRef = useRef(goUp)
  goUpRef.current = goUp
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.key !== 'ArrowUp') return
      if (document.querySelector('.modal-backdrop')) return
      ev.preventDefault()
      ev.stopPropagation()
      goUpRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // A block or canvas reached from a list elsewhere (timeline, review): blocks written inside another open that block's page.
  const jumpTo = useCallback(
    (id: string, date: string, entry?: Entry) => {
      if (entry?.parentId) openBlock(id, date, entry.parentId)
      else openCanvas(id, date)
    },
    [openBlock, openCanvas]
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

  const nestEntry = useCallback(
    async (id: string, date: string, entryId: string, to: { date: string; parentId?: string; afterId?: string }) => {
      await api.blocks.move(id, date, entryId, { canvasId: id, ...to })
      await reloadDay(id, date)
      if (to.date !== date) await reloadDay(id, to.date)
    },
    [reloadDay]
  )

  const setHidden = useCallback(
    async (id: string, date: string, entryId: string, hidden: boolean) => {
      await api.blocks.setHidden(id, date, entryId, hidden)
      await reloadDay(id, date)
    },
    [reloadDay]
  )

  const setTodoDone = useCallback(
    async (id: string, date: string, entryId: string, done: boolean) => {
      await api.todos.setDone(id, date, entryId, done)
      await reloadDay(id, date)
    },
    [reloadDay]
  )

  const reorderEntry = useCallback(
    async (id: string, date: string, entryId: string, position: { afterId?: string; beforeId?: string }) => {
      const day = await api.blocks.reorder(id, date, entryId, position)
      if (canvasIdRef.current === id) setDays((cur) => mergeDay(cur, day))
    },
    []
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
    let id: string | undefined
    if (page) {
      id = pageDay?.entries.filter((e) => e.parentId === page.id).at(-1)?.id
    } else {
      const last = days[days.length - 1]
      if (!last || last.date !== today || last.entries.length === 0) return
      id = last.entries.filter((e) => !e.parentId).at(-1)?.id
    }
    if (!id) return
    setEditRequest(id)
    setTimeout(() => setEditRequest(null), 0)
  }, [days, today, page, pageDay])

  const goTo = useCallback(
    (target: SwitchTarget) => {
      if (target.kind === 'settings') {
        setSettingsPage(target.page ?? 'repository')
        return
      }
      if (target.kind === 'block') {
        openBlock(target.canvasId, target.date, target.id)
        return
      }
      if (target.kind === 'command') {
        // A command's answer (e.g. "List my CMS assignments") shows as a toast.
        void reported(api.extensions.run(target.extension, target.command)).then((text) => {
          if (text) showToast(text, 'info', 15000)
        })
        return
      }
      setSearch('')
      if (target.kind === 'view') {
        if (target.view === 'timeline') setTimelineDate(localDate(new Date()))
        setView(target.view)
      } else openCanvas(target.canvasId)
    },
    [openCanvas, openBlock]
  )

  // On a block page, the note box writes inside the block.
  const pageBlock = view === 'canvas' && page && pageDay?.date === page.date ? (pageDay.entries.find((e) => e.id === page.id) ?? null) : null

  // Block pages opened lately, for the quick switcher (per devlog, on this machine).
  const recentKey = `devlog:recent-pages:${repo?.path ?? ''}`
  const [recentPages, setRecentPages] = useState<Array<{ canvasId: string; date: string; id: string; title: string }>>([])
  useEffect(() => {
    try {
      setRecentPages(JSON.parse(localStorage.getItem(recentKey) ?? '[]'))
    } catch {
      setRecentPages([])
    }
  }, [recentKey])
  const pageTitleNow = pageBlock ? blockTitle(pageBlock, 60) : null
  useEffect(() => {
    if (!page || !pageTitleNow) return
    setRecentPages((cur) => {
      const next = [{ canvasId: page.canvasId, date: page.date, id: page.id, title: pageTitleNow }, ...cur.filter((p) => !(p.canvasId === page.canvasId && p.date === page.date && p.id === page.id))].slice(0, 12)
      try {
        localStorage.setItem(recentKey, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [blockKey(page), pageTitleNow, recentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const menuItems = (id: string): MenuItem[] => {
    const c = canvases.find((x) => x.id === id)
    if (!c) return []
    const active = tracker?.activeCanvasId === id
    const items: MenuItem[] = [{ label: 'Open', onClick: () => openCanvas(id) }]
    if (c.task && tracker?.tracking && !c.archived)
      items.push(
        active
          ? { label: 'Stop this task', onClick: () => void reported(api.tracker.setTask(null)) }
          : { label: tracker?.activeCanvasId ? 'Switch to this task' : 'Start this task', onClick: () => void reported(api.tracker.setTask(id)) }
      )
    items.push('separator', { label: 'Properties…', onClick: () => setCanvasDialog({ canvas: c }) })
    if (!c.archived)
      items.push(
        { label: 'New canvas inside…', onClick: () => setCanvasDialog({ canvas: null, parentId: id }) },
        { label: 'New task inside…', onClick: () => setCanvasDialog({ canvas: null, parentId: id, task: true }) }
      )
    items.push('separator', {
      label: c.archived ? 'Unarchive' : 'Archive',
      onClick: () =>
        void reported(
          api.canvases.archive(id, !c.archived).then(async () => {
            await refreshCanvases()
            showToast(c.archived ? `Restored ${c.title}` : `Archived ${c.title}; it is under Archived in the sidebar`, 'info')
          })
        )
    })
    return items
  }
  const openMenu = (id: string, x: number, y: number): void => {
    if (canvases.some((c) => c.id === id)) setCanvasMenu({ canvasId: id, x, y })
  }

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

  const [selExt, selView] = [extPage.slice(0, extPage.lastIndexOf('/')), extPage.slice(extPage.lastIndexOf('/') + 1)]
  const selection: SidebarSelection = view === 'canvas' ? { kind: 'canvas', canvasId } : view === 'ext' ? { kind: 'ext', extKey: selExt, viewId: selView } : { kind: view }
  const extPages = extensions.flatMap((e) => e.views.filter((v) => v.placement === 'page').map((v) => ({ extKey: e.key, viewId: v.id, title: v.title, icon: v.icon, url: v.url })))
  const statusViews = extensions.flatMap((e) => e.views.filter((v) => v.placement === 'statusbar').map((v) => ({ extKey: e.key, viewId: v.id, title: v.title, url: v.url })))
  const openPage = extPages.find((p) => `${p.extKey}/${p.viewId}` === extPage)
  const showPopover = (extKey: string, viewId: string, anchor: DOMRect, size: { width?: number; height?: number }): void => {
    const v = extensions.find((e) => e.key === extKey)?.views.find((x) => x.id === viewId && x.placement === 'popover')
    if (!v) return
    setPopover({ extKey, viewId, url: v.url, title: v.title, anchor, width: Math.min(Math.max(size.width ?? 320, 160), 560), height: Math.min(Math.max(size.height ?? 360, 80), 640) })
  }
  const openFromView = (t: { canvasId: string; date?: string; blockId?: string }): void => {
    if (!canvases.some((c) => c.id === t.canvasId)) return
    if (t.blockId && t.date) openBlock(t.canvasId, t.date, t.blockId)
    else openCanvas(t.canvasId, t.date)
  }

  return (
    <div className="app">
      <TopBar search={search} onSearch={setSearch} searchRef={searchRef} onSwitcher={() => setSwitcherOpen(true)} />
      <Sidebar
        canvases={canvases}
        selection={selection}
        activeCanvasId={tracker?.activeCanvasId ?? null}
        searching={Boolean(search)}
        showJournal={journalHasNotes}
        settingsAttention={extensions.some(needsAttention)}
        extPages={extPages}
        onCanvasMenu={openMenu}
        onOpenSettings={() => setSettingsPage('repository')}
        onSelect={(sel) => {
          setSearch('')
          if (sel.kind === 'canvas') openCanvas(sel.canvasId)
          else if (sel.kind === 'ext') {
            setExtPage(`${sel.extKey}/${sel.viewId}`)
            setView('ext')
          }
          else {
            if (sel.kind === 'timeline') setTimelineDate(localDate(new Date()))
            setView(sel.kind)
          }
        }}
        onNewCanvas={() => setCanvasDialog({ canvas: null, parentId: view === 'canvas' && canvas && canvasId !== JOURNAL_ID ? canvasId : null })}
      />
      <main className="main">
        {search && (
          <Feed
            canvas={canvas ?? JOURNAL}
            canvases={canvases}
            days={[]}
            hasMore={false}
            today={today}
            search={search}
            hits={hits}
            loading={false}
            editRequest={null}
            onLoadMore={async () => undefined}
            onAdd={async (id, md, position) => {
              await addEntry(id, md, position)
            }}
            onUpdate={updateEntry}
            onDelete={deleteEntry}
            onMove={moveEntry}
            onJumpTo={openCanvas}
            onOpenCanvas={openCanvas}
            onOpenBlock={openBlock}
          />
        )}
        {view === 'review' && !search && (
          <Review
            canvases={canvases}
            today={today}
            focusMinSeconds={settings.focusMinSeconds}
            onJumpTo={jumpTo}
            onOpenTimeline={(d) => {
              setTimelineDate(d)
              setView('timeline')
            }}
          />
        )}
        {view === 'timesheet' && !search && <Timesheet canvases={canvases} today={today} />}
        {view === 'ext' && !search && (openPage ? (
          <ExtensionView
            key={extPage}
            className="ext-page-view"
            extKey={openPage.extKey}
            viewId={openPage.viewId}
            url={openPage.url}
            title={openPage.title}
            onPopover={(id, anchor, size) => showPopover(openPage.extKey, id, anchor, size)}
            onOpen={openFromView}
          />
        ) : (
          <p className="feed-empty">That page is not available: its extension is not running.</p>
        ))}
        {view === 'summary' && !search && <Summary canvases={canvases} today={today} focusMinSeconds={settings.focusMinSeconds} onOpenCanvas={openCanvas} />}
        {view === 'timeline' && !search && (
          <Timeline canvases={canvases} today={today} date={timelineDate} focusMinSeconds={settings.focusMinSeconds} onChangeDate={setTimelineDate} onJumpTo={jumpTo} />
        )}
        {view === 'canvas' && !search && !canvas && (
          <div className="empty-home">
            <h2>Start with a canvas</h2>
            <p>Canvases hold your notes: one for each client or project, and tasks inside them that you track time against.</p>
            <button type="button" className="btn btn-primary" onClick={() => setCanvasDialog({ canvas: null })}>
              + New canvas
            </button>
          </div>
        )}
        {view === 'canvas' && !search && canvas && page && (
          <BlockPage
            key={blockKey(page)}
            canvas={canvas}
            canvases={canvases}
            day={pageDay && pageDay.date === page.date ? pageDay : null}
            blockId={page.id}
            today={today}
            editRequest={editRequest}
            activeCanvasId={tracker?.activeCanvasId ?? null}
            tracking={Boolean(tracker?.tracking)}
            onStartTask={() => void reported(api.tracker.setTask(canvas.id))}
            onStopTask={() => void reported(api.tracker.setTask(null))}
            onCanvasMenu={openMenu}
            onAdd={async (id, md, position) => {
              await addEntry(id, md, position)
            }}
            onUpdate={updateEntry}
            onDelete={deleteEntry}
            onMove={moveEntry}
            onNest={nestEntry}
            onPromote={promoteEntry}
            onSetHidden={setHidden}
            onSetDone={setTodoDone}
            onReorder={reorderEntry}
            onOpenCanvas={openCanvas}
            onOpenBlock={openBlock}
            onUp={goUp}
          />
        )}
        {view === 'canvas' && !search && canvas && !page && (
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
            tracking={Boolean(tracker?.tracking)}
            onStartTask={() => void reported(api.tracker.setTask(canvas.id))}
            onStopTask={() => void reported(api.tracker.setTask(null))}
            onCanvasMenu={openMenu}
            onOpenBlock={openBlock}
            onLoadMore={loadMore}
            onAdd={async (id, md, position) => {
              await addEntry(id, md, position)
            }}
            onUpdate={updateEntry}
            onDelete={deleteEntry}
            onMove={moveEntry}
            onNest={nestEntry}
            onPromote={promoteEntry}
            onOpenCanvas={openCanvas}
            onEditCanvas={() => setCanvasDialog({ canvas })}
            onNewCanvasHere={(task) => setCanvasDialog({ canvas: null, parentId: canvasId, task })}
            onArchive={async (archived) => {
              await api.canvases.archive(canvasId, archived)
              await refreshCanvases()
            }}
            onSetHidden={setHidden}
            onSetDone={setTodoDone}
            onLinkRepo={() =>
              void reported(
                api.repo.chooseDirectory().then(async (dir) => {
                  if (!dir) return
                  const check = await api.repo.inspectWorkingCopy(dir)
                  if (!check.ok) {
                    showToast(`${check.error}. Pick the folder that contains .git.`)
                    return
                  }
                  if (canvas.repos.includes(check.root)) {
                    showToast('That repository is already linked here')
                    return
                  }
                  setLinkRepo({ canvasId, root: check.root })
                })
              )
            }
            onUnlinkRepo={(path) =>
              void reported(
                api.canvases.update(canvasId, { repos: canvas.repos.filter((r) => r !== path) }).then(async () => {
                  await refreshCanvases()
                  showToast(`Unlinked ${path.split(/[\\/]/).filter(Boolean).pop()}`)
                })
              )
            }
            onReorder={reorderEntry}
          />
        )}
        {!search && targetCanvas && view !== 'ext' && !(view === 'canvas' && (!canvas || canvas.archived || canvas.id === JOURNAL_ID)) && (
          <div className="composer-dock">
            <Composer
              key={pageBlock ? blockKey(page) : targetCanvasId}
              mode="new"
              placeholder={
                pageBlock
                  ? `Write inside “${blockTitle(pageBlock, 40)}”…  Enter posts, Alt+Enter posts and opens it${targetCanvas.task ? ' · counts toward this task' : ''}`
                  : targetCanvas.task
                    ? `Note on ${targetCanvas.title}…  posting here makes it the active task · Enter posts, Alt+Enter posts and opens it`
                    : `Note on ${targetCanvas.title}…  Enter posts, Alt+Enter posts and opens it, ${kbd('mod', 'shift', 'Enter')} posts as a task`
              }
              assetCanvasId={targetCanvasId}
              assetDate={pageBlock ? page?.date : undefined}
              draftKey={`devlog:draft:${repo.path}:${targetCanvasId}${pageBlock ? `:${pageBlock.id}` : ''}`}
              autoFocus={view === 'canvas'}
              dock
              onSubmit={async (md, opts) => {
                const res = await addEntry(targetCanvasId, md, pageBlock && page ? { date: page.date, parentId: pageBlock.id } : undefined, opts)
                if (opts?.open) openBlock(targetCanvasId, res.date, res.entry.id)
                else if (view !== 'canvas') showToast(`Posted to ${canvasLabel(canvases, targetCanvasId)}`)
              }}
              onEditLast={view === 'canvas' ? editLast : undefined}
              focusToken={focusToken}
              canvases={canvases}
              targetCanvasId={targetCanvasId}
              onTargetChange={pageBlock ? undefined : setTargetCanvasId}
            />
          </div>
        )}
        <StatusBar
          extViews={statusViews}
          onExtPopover={showPopover}
          onExtOpen={openFromView}
          status={sync}
          tracker={tracker}
          taskLabel={tracker?.activeCanvasId ? canvasLabel(canvases, tracker.activeCanvasId) : null}
          canvases={canvases}
          currentCanvasId={view === 'canvas' ? canvasId : null}
          onSyncNow={() => void reported(api.sync.now())}
          onStartTask={(id) => void reported(api.tracker.setTask(id))}
          onStopTask={() => void reported(api.tracker.setTask(null))}
          onNewTask={() => setCanvasDialog({ canvas: null, parentId: view === 'canvas' && canvas && canvasId !== JOURNAL_ID ? canvasId : null, task: true, start: true })}
          onOpenTimeline={() => {
            setTimelineDate(localDate(new Date()))
            setView('timeline')
          }}
        />
      </main>
      <TodoPanel
        canvases={canvases}
        canvasId={view === 'canvas' && canvas ? canvasId : null}
        page={pageBlock && page ? { canvasId: page.canvasId, date: page.date, id: page.id, title: blockTitle(pageBlock, 40) } : null}
        fallbackCanvasId={targetCanvas?.id ?? null}
        onOpenCanvas={openCanvas}
        onOpenBlock={openBlock}
        onStreamChanged={(id, date) => void reloadDay(id, date)}
        version={dayVersion}
      />
      <Toasts />
      {switcherOpen && (
        <QuickSwitcher
          canvases={canvases}
          extensions={extensions}
          recentPages={recentPages}
          onPick={(t) => {
            setSwitcherOpen(false)
            goTo(t)
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {settingsPage && (
        <SettingsDialog
          settings={settings}
          repo={repo}
          canvases={canvases}
          extensions={extensions}
          initialPage={settingsPage}
          onClose={() => setSettingsPage(null)}
          onSaved={setSettings}
          onRepoChanged={(r) => setRepo(r)}
          onPreview={applyTheme}
        />
      )}
      {popover && (
        <ExtensionPopover
          {...popover}
          onClose={() => setPopover(null)}
          onOpen={(t) => {
            setPopover(null)
            openFromView(t)
          }}
        />
      )}
      {canvasMenu && <ContextMenu x={canvasMenu.x} y={canvasMenu.y} items={menuItems(canvasMenu.canvasId)} onClose={() => setCanvasMenu(null)} />}
      {linkRepo && (
        <LinkRepoDialog
          repoPath={linkRepo.root}
          canvasTitle={canvases.find((c) => c.id === linkRepo.canvasId)?.title ?? 'this canvas'}
          defaultDays={settings.commitBackfillDays}
          onClose={() => setLinkRepo(null)}
          onLink={async (importDays) => {
            const target = canvases.find((c) => c.id === linkRepo.canvasId)
            if (!target) return
            const name = linkRepo.root.split(/[\\/]/).filter(Boolean).pop()
            await api.canvases.update(target.id, { repos: [...target.repos, linkRepo.root] })
            await refreshCanvases()
            if (importDays) {
              const n = await api.repo.importHistory(target.id, linkRepo.root, importDays)
              showToast(`Linked ${name}; imported ${n} commit${n === 1 ? '' : 's'}`)
            } else showToast(`Linked ${name}`)
          }}
        />
      )}
      {canvasDialog && (
        <CanvasDialog
          canvas={canvasDialog.canvas}
          canvases={canvases}
          extensions={extensions}
          initialParentId={canvasDialog.parentId}
          initialTask={canvasDialog.task}
          onClose={() => setCanvasDialog(null)}
          onSaved={async (saved) => {
            await refreshCanvases()
            openCanvas(saved.id)
            if (canvasDialog.start && saved.task) void reported(api.tracker.setTask(saved.id))
          }}
          onDeleted={async () => {
            await refreshCanvases()
          }}
        />
      )}
    </div>
  )
}
