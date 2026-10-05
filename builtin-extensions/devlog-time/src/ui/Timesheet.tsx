import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  JOURNAL_ID,
  QUARTER_MINUTES,
  adoptTimesheet,
  balanceDays,
  buildCanvasTree,
  canvasLabel,
  carryAdjustments,
  emptyAdjustments,
  flattenTree,
  followsTrackedTime,
  localDate,
  resolveTimesheet,
  roundToQuarterHour,
  topLevelCanvasId,
  type DayBalance,
  type Timesheet as Sheet,
  type TimesheetAdjustments,
  type TimesheetEntry
} from '@devlog/core'
import type { ActivityEvent, CanvasMeta } from '@shared/types'
import { activeCorrections } from '@shared/activity'
import { addDays, weekDates, weekStart, type ReviewNote } from '@shared/review'
import { draftTimesheet, newEntryId } from '@shared/timesheet'
import type { DestinationInfo } from '@devlog/extension-api'
import { api } from './api'
import { SendDialog } from './SendDialog'
import { Targets } from './Targets'

interface Props {
  canvases: CanvasMeta[]
  today: string
  /** Something went wrong in the background (a save): say so. */
  onError: (message: string) => void
}

const parseLocal = (d: string): Date => {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day)
}
const dayHead = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const rangeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' })

/** 90 → "1:30". */
export function hm(minutes: number): string {
  const m = Math.round(minutes)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

const timeOf = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** A local time on a day, exactly (corrections are to the minute). */
const localAt = (date: string, time: string): string => {
  const [h, m] = time.split(':').map(Number)
  const d = parseLocal(date)
  d.setHours(h || 0, m || 0, 0, 0)
  return d.toISOString()
}
/** A local time on a day, on the quarter hour (where entries start). */
const atTime = (date: string, time: string): string => roundToQuarterHour(new Date(localAt(date, time))).toISOString()

/** How often a week that includes today is drawn again from tracked time. */
const REFRESH_MS = 60_000

type SaveState = 'unsaved-draft' | 'saved' | 'pending' | 'saving' | 'error'

const SOURCE_LABEL: Record<TimesheetEntry['source'], string> = { tracked: 'tracked', estimated: 'estimated', manual: 'added' }

interface Draft {
  sheet: Sheet
  events: ActivityEvent[]
  /** When it was drawn, to tell a session still running. */
  builtAt: number
}

const cloneAdj = (a: TimesheetAdjustments | undefined): TimesheetAdjustments => {
  const src = a ?? emptyAdjustments()
  return { minutes: { ...src.minutes }, notes: { ...src.notes }, removed: [...src.removed] }
}

/**
 * The weekly timesheet. While a week is a draft it follows tracked time: it
 * is drawn again from what was tracked (with your corrections to it) each
 * time it is shown, and every minute while the week is on screen, so a
 * running task keeps counting. What you change is kept apart and laid over
 * it: hours added or trimmed, notes, entries you added. Changing when
 * tracked time started or ended, its task, or removing it corrects the
 * tracked time itself (in every view). Mark final freezes the week; it is
 * saved as one block per week in the Timesheets canvas.
 */
export function Timesheet({ canvases, today, onError }: Props): React.JSX.Element {
  const reported = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch((err: unknown) => void onError(err instanceof Error ? err.message : String(err)))
  const [start, setStart] = useState(() => weekStart(today))
  /** What is saved for the week (your changes), or null: nothing yet. */
  const [stored, setStored] = useState<Sheet | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [state, setState] = useState<SaveState>('saved')
  const [confirm, setConfirm] = useState<'reset' | 'adopt' | null>(null)
  const [clockTask, setClockTask] = useState<string | null>(null)
  /** The cell whose entries are open for editing. */
  const [selected, setSelected] = useState<{ canvasId: string; date: string } | null>(null)
  /** The Reassign time form, when open. */
  const [reassign, setReassign] = useState<ReassignValues | null>(null)
  /** Tasks added to the grid that have no entries yet. */
  const [extraRows, setExtraRows] = useState<string[]>([])
  const [sending, setSending] = useState<DestinationInfo | null>(null)
  // Destinations come and go as extensions start and stop (and get set up): look again now and then.
  const [destinations, setDestinations] = useState<DestinationInfo[]>([])
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.destinations().then(
        (list) => alive && setDestinations((cur) => (JSON.stringify(cur) === JSON.stringify(list) ? cur : list)),
        () => undefined
      )
    }
    load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  const dates = useMemo(() => weekDates(start), [start])
  const end = dates[6]
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The saved form being edited (changes go here first, then to disk). */
  const latest = useRef<Sheet | null>(null)
  const draftRef = useRef<Draft | null>(null)
  /** The week on screen, for answers that arrive after you have moved on. */
  const weekRef = useRef(start)
  weekRef.current = start

  const buildDraft = useCallback(async (week: string): Promise<Draft> => {
    const last = addDays(week, 6)
    const [chunks, events] = await Promise.all([api.range(week, last), api.activity(week, last)])
    const notes: ReviewNote[] = []
    for (const { canvasId, blocks } of chunks) {
      for (const entry of blocks) {
        if (entry.kind === 'timesheet') continue
        const date = localDate(new Date(entry.createdAt))
        if (date >= week && date <= last) notes.push({ canvasId, date, entry })
      }
    }
    const builtAt = Date.now()
    return { sheet: draftTimesheet(week, notes, events, { now: new Date(builtAt).toISOString() }), events, builtAt }
  }, [])

  /** Draw the week again from tracked time (your changes stay as they are). */
  const redraw = useCallback(async (): Promise<Draft> => {
    const week = start
    const [next, clock] = await Promise.all([buildDraft(week), api.clock().catch(() => null)])
    if (weekRef.current === week) {
      draftRef.current = next
      setDraft(next)
      setClockTask(clock?.active ?? null)
    }
    return next
  }, [start, buildDraft])

  // Load the week: what is saved for it, over a fresh draft from tracked time.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setDraft(null)
    setStored(null)
    latest.current = null
    draftRef.current = null
    setConfirm(null)
    setSelected(null)
    setReassign(null)
    setExtraRows([])
    void (async () => {
      const [saved, next, clock] = await Promise.all([api.timesheet(start), buildDraft(start), api.clock().catch(() => null)])
      if (cancelled) return
      latest.current = saved
      draftRef.current = next
      setStored(saved)
      setDraft(next)
      setClockTask(clock?.active ?? null)
      setState(saved ? 'saved' : 'unsaved-draft')
      setLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [start, buildDraft])

  const sheet = useMemo(() => (loaded && draft ? resolveTimesheet(draft.sheet, stored) : null), [loaded, draft, stored])
  const final = sheet?.status === 'final'
  /** Follows tracked time, and can be changed. */
  const live = !!sheet && !final && followsTrackedTime(sheet)
  /** Saved before 0.19: stays as it was until you have it follow tracked time. */
  const legacy = !!sheet && !final && !followsTrackedTime(sheet)

  // While the week on screen includes today, draw it again every minute: a running task keeps counting.
  useEffect(() => {
    if (!live || start !== weekStart(today)) return
    const t = setInterval(() => void redraw().catch(() => undefined), REFRESH_MS)
    return () => clearInterval(t)
  }, [live, start, today, redraw])

  // Another week for the monthly targets: as saved, over a draft from tracked time.
  const loadWeek = useCallback(async (week: string): Promise<Sheet> => {
    const [saved, d] = await Promise.all([api.timesheet(week), buildDraft(week)])
    return resolveTimesheet(d.sheet, saved)
  }, [buildDraft])

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const s = latest.current
    if (!s) return
    setState('saving')
    try {
      // What is written is the week as it stands now (a readable record), with your changes beside it.
      const d = draftRef.current
      const saved = await api.saveTimesheet(d ? resolveTimesheet(d.sheet, s) : s)
      if (latest.current === s) {
        latest.current = saved
        setStored(saved)
      }
      setState(latest.current === saved ? 'saved' : 'pending')
    } catch (err) {
      setState('error')
      throw err
    }
  }, [])

  // Save shortly after the last change; and before leaving the week.
  useEffect(
    () => () => {
      if (saveTimer.current) void reported(flush())
    },
    [start, flush]
  )

  /** The saved form to change: what is saved, or (nothing yet) an empty set of changes. */
  const base = (): Sheet => latest.current ?? { week: start, status: 'draft', entries: [], updatedAt: '', adjustments: emptyAdjustments() }

  const change = (fn: (s: Sheet) => Sheet): void => {
    if (!live) return
    const next = fn(base())
    latest.current = next
    setStored(next)
    setState('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void reported(flush()), 600)
  }
  const adjust = (fn: (a: TimesheetAdjustments) => void): void =>
    change((s) => {
      const a = cloneAdj(s.adjustments)
      fn(a)
      return { ...s, adjustments: a }
    })
  const changeManual = (id: string, patch: Partial<TimesheetEntry>): void => change((s) => ({ ...s, entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))

  const setStatus = (status: Sheet['status']): void => {
    const d = draftRef.current
    const cur = latest.current ?? base()
    // Marking final keeps the week as it stands now; reopening has it follow tracked time again.
    latest.current = status === 'final' && d ? { ...resolveTimesheet(d.sheet, cur), status } : { ...cur, status }
    setStored(latest.current)
    void reported(flush())
  }

  /** After tracked time changed, move your changes to the entries that took the place of the ones they were on. */
  const keepAdjustments = (before: TimesheetEntry[], next: Draft): void => {
    const cur = latest.current?.adjustments
    if (!cur || weekRef.current !== next.sheet.week) return
    const carried = carryAdjustments(cur, before, next.sheet.entries)
    if (JSON.stringify(carried) === JSON.stringify(cur)) return
    adjust((a) => {
      a.minutes = carried.minutes
      a.notes = carried.notes
      a.removed = carried.removed
    })
  }

  /** Correct tracked time, draw the week again, and keep your changes on the entries they were on. */
  const correct = async (from: string, to: string, canvasId: string | null): Promise<void> => {
    const before = draftRef.current?.sheet.entries ?? []
    await api.assign(from, to, canvasId)
    const next = await redraw()
    keepAdjustments(before, next)
  }
  const undoCorrection = async (id: string, from: string): Promise<void> => {
    const before = draftRef.current?.sheet.entries ?? []
    await api.unassign(id, from)
    const next = await redraw()
    keepAdjustments(before, next)
  }

  const tree = useMemo(() => flattenTree(buildCanvasTree(canvases.filter((c) => c.id !== JOURNAL_ID))), [canvases])
  const order = useMemo(() => new Map([JOURNAL_ID, ...tree.map((t) => t.canvas.id)].map((id, i) => [id, i])), [tree])
  const clientOf = useCallback((id: string) => topLevelCanvasId(canvases, id), [canvases])
  const label = (id: string): string => (id === JOURNAL_ID ? 'Journal' : canvasLabel(canvases, id))
  /** A task's name under its client: "Website / Fix login"; the client's own time is "General". */
  const rowLabel = (id: string): string => {
    const client = clientOf(id)
    if (id === client) return 'General'
    const full = label(id)
    const prefix = `${label(client)} / `
    return full.startsWith(prefix) ? full.slice(prefix.length) : full
  }
  const balances = useMemo(() => (sheet ? balanceDays(sheet.entries, clientOf) : []), [sheet, clientOf])

  // The grid: minutes per task per day, tasks grouped under their client.
  const grid = useMemo(() => {
    const cell = new Map<string, number>() // `${canvasId}|${date}` → reported minutes
    const workedCell = new Map<string, number>()
    const taskIds = new Set<string>(extraRows)
    for (const e of sheet?.entries ?? []) {
      const k = `${e.canvasId}|${e.date}`
      cell.set(k, (cell.get(k) ?? 0) + e.minutes)
      workedCell.set(k, (workedCell.get(k) ?? 0) + e.worked)
      taskIds.add(e.canvasId)
    }
    const groups = new Map<string, string[]>()
    for (const id of taskIds) {
      const c = clientOf(id)
      groups.set(c, [...(groups.get(c) ?? []), id])
    }
    const sum = (ids: string[], date?: string, m: Map<string, number> = cell): number =>
      ids.reduce((n, id) => n + (date ? (m.get(`${id}|${date}`) ?? 0) : dates.reduce((t, d) => t + (m.get(`${id}|${d}`) ?? 0), 0)), 0)
    const clients = [...groups]
      .map(([client, ids]) => ({ client, tasks: ids.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b)) }))
      .sort((a, b) => sum(b.tasks) - sum(a.tasks) || a.client.localeCompare(b.client))
    return { cell, workedCell, clients, sum }
  }, [sheet, extraRows, clientOf, order, dates])

  const dayTotal = (date: string): number => sheet?.entries.filter((e) => e.date === date).reduce((n, e) => n + e.minutes, 0) ?? 0
  const dayWorked = (date: string): number => sheet?.entries.filter((e) => e.date === date).reduce((n, e) => n + e.worked, 0) ?? 0
  const total = sheet?.entries.reduce((n, e) => n + e.minutes, 0) ?? 0
  const worked = sheet?.entries.reduce((n, e) => n + e.worked, 0) ?? 0

  /** Corrections to tracked time this week (made here; the review's removals are listed there). */
  const corrections = useMemo(
    () => (draft ? activeCorrections(draft.events).filter((c) => c.kind === 'assign' && localDate(new Date(c.start)) >= start && localDate(new Date(c.start)) <= end) : []),
    [draft, start, end]
  )

  const addEntry = (canvasId: string, date: string): void =>
    change((s) => {
      const dayEntries = (sheet?.entries ?? []).filter((e) => e.date === date)
      const lastEnd = dayEntries.reduce((t, e) => Math.max(t, Date.parse(e.start) + e.minutes * 60_000), 0)
      const startAt = lastEnd || parseLocal(date).setHours(9, 0, 0, 0)
      const entry: TimesheetEntry = { id: newEntryId([...(sheet?.entries ?? []), ...s.entries]), date, start: new Date(startAt).toISOString(), minutes: 60, canvasId, worked: 0, source: 'manual' }
      return { ...s, entries: [...s.entries, entry] }
    })

  /** Reported minutes: an entry you added changes itself; a tracked or estimated one keeps the difference as an adjustment. */
  const setMinutes = (e: TimesheetEntry, minutes: number): void => {
    if (e.source === 'manual') return changeManual(e.id, { minutes })
    adjust((a) => {
      const delta = minutes - (e.minutes - (a.minutes[e.id] ?? 0))
      if (delta) a.minutes[e.id] = delta
      else delete a.minutes[e.id]
    })
  }
  const setNote = (e: TimesheetEntry, note: string): void => {
    if (e.source === 'manual') return changeManual(e.id, { note })
    adjust((a) => {
      if (note) a.notes[e.id] = note
      else delete a.notes[e.id]
    })
  }
  /** An estimated entry moved to another day, time or task becomes one you added. */
  const estimateToManual = (e: TimesheetEntry, patch: Partial<TimesheetEntry>): void =>
    change((s) => {
      const a = cloneAdj(s.adjustments)
      a.removed = [...new Set([...a.removed, e.id])]
      delete a.minutes[e.id]
      delete a.notes[e.id]
      const added: TimesheetEntry = { id: newEntryId([...(sheet?.entries ?? []), ...s.entries]), date: e.date, start: e.start, minutes: e.minutes, canvasId: e.canvasId, worked: e.worked, source: 'manual', ...(e.note ? { note: e.note } : {}), ...patch }
      return { ...s, adjustments: a, entries: [...s.entries, added] }
    })
  const removeEntry = (e: TimesheetEntry): void => {
    if (e.source === 'manual') return change((s) => ({ ...s, entries: s.entries.filter((x) => x.id !== e.id) }))
    if (e.source === 'estimated') return adjust((a) => void (a.removed = [...new Set([...a.removed, e.id])]))
    // Tracked time that was not work: say so, for every view.
    if (e.span) void reported(correct(e.span.start, e.span.end, null))
  }

  /** Move the selection along with an entry whose task or day changed (if it was the only one in its cell). */
  const follow = (e: TimesheetEntry, canvasId: string, date: string): void => {
    const inCell = (sheet?.entries ?? []).filter((x) => x.canvasId === e.canvasId && x.date === e.date).length
    if ((canvasId !== e.canvasId || date !== e.date) && inCell <= 1) setSelected({ canvasId, date })
  }
  /** Edit an entry you added or an estimate: day, start, task. */
  const editPlain = (e: TimesheetEntry, patch: Partial<TimesheetEntry>): void => {
    if (e.source === 'manual') changeManual(e.id, patch)
    else estimateToManual(e, patch)
    follow(e, patch.canvasId ?? e.canvasId, patch.date ?? e.date)
  }

  /** Tracked time: a new start or end corrects the time itself (an earlier start counts the time before it, a later one removes it). */
  const moveStart = (e: TimesheetEntry, time: string): void => {
    if (!e.span) return
    const next = localAt(e.date, time)
    if (Date.parse(next) >= Date.parse(e.span.end)) return onError('The start must be before the end')
    if (next > e.span.start) void reported(correct(e.span.start, next, null))
    else if (next < e.span.start) void reported(correct(next, e.span.start, e.canvasId))
  }
  const moveEnd = (e: TimesheetEntry, time: string): void => {
    if (!e.span) return
    const next = localAt(e.date, time)
    if (Date.parse(next) <= Date.parse(e.span.start)) return onError('The end must be after the start')
    if (next < e.span.end) void reported(correct(next, e.span.end, null))
    else if (next > e.span.end) void reported(correct(e.span.end, next, e.canvasId))
  }
  const retask = (e: TimesheetEntry, canvasId: string): void => {
    if (!e.span || canvasId === e.canvasId) return
    void reported(correct(e.span.start, e.span.end, canvasId))
    follow(e, canvasId, e.date)
  }
  /** Still counting: the clock is on its task and the session runs up to when the week was drawn. */
  const isRunning = (e: TimesheetEntry): boolean => !!e.span && !!draft && clockTask === e.canvasId && draft.builtAt - Date.parse(e.span.end) < 2 * 60_000

  const applySuggestions = (b: DayBalance): void =>
    change((s) => {
      const a = cloneAdj(s.adjustments)
      let entries = s.entries
      for (const sg of b.suggestions) {
        const e = sheet?.entries.find((x) => x.id === sg.entryId)
        if (!e) continue
        if (e.source === 'manual') entries = entries.map((x) => (x.id === e.id ? { ...x, minutes: sg.to } : x))
        else {
          const delta = (a.minutes[e.id] ?? 0) + sg.to - sg.from
          if (delta) a.minutes[e.id] = delta
          else delete a.minutes[e.id]
        }
      }
      return { ...s, entries, adjustments: a }
    })

  const resetChanges = (): void => {
    setConfirm(null)
    change((s) => ({ ...s, entries: [], adjustments: emptyAdjustments() }))
  }
  const adopt = (): void => {
    setConfirm(null)
    const cur = latest.current
    const d = draftRef.current
    if (!cur || !d) return
    latest.current = adoptTimesheet(cur, d.sheet)
    setStored(latest.current)
    void reported(flush())
  }

  /** Open the Reassign form, starting from the selected cell's tracked time when there is some. */
  const openReassign = (): void => {
    const date = selected?.date ?? (dates.includes(today) ? today : start)
    const first = selected ? (sheet?.entries ?? []).find((e) => e.canvasId === selected.canvasId && e.date === selected.date && e.span) : undefined
    const from = first?.span ? timeOf(first.span.start) : '09:00'
    const [h, m] = from.split(':').map(Number)
    const to = `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    setReassign({ date, from, to, canvasId: '' })
  }
  const submitReassign = (v: ReassignValues): void => {
    const from = localAt(v.date, v.from)
    const to = localAt(v.date, v.to)
    if (to <= from) return onError('The end must be after the start')
    void reported(correct(from, to, v.canvasId === NOT_WORKED ? null : v.canvasId).then(() => setReassign(null)))
  }

  const stateText = (): string => {
    if (final) return 'Final'
    if (legacy) return 'Saved before Devlog 0.19 · as you left it'
    return {
      'unsaved-draft': 'Follows tracked time · not saved yet',
      saved: 'Saved · follows tracked time',
      pending: 'Unsaved changes…',
      saving: 'Saving…',
      error: 'Could not save'
    }[state]
  }

  const selectedEntries = selected && sheet ? sheet.entries.filter((e) => e.canvasId === selected.canvasId && e.date === selected.date).sort((a, b) => a.start.localeCompare(b.start)) : []
  const inGrid = new Set(grid.clients.flatMap((c) => c.tasks))
  const addableTasks = [{ id: JOURNAL_ID, depth: 0, title: 'Journal' }, ...tree.map(({ canvas: c, depth }) => ({ id: c.id, depth, title: c.title }))].filter((t) => !inGrid.has(t.id))
  const taskOptions = (current?: string): React.JSX.Element[] => [
    ...(current && current !== JOURNAL_ID && !canvases.some((c) => c.id === current) ? [<option key="gone" value={current}>{`${current} (gone)`}</option>] : []),
    ...tree.map(({ canvas: c, depth }) => (
      <option key={c.id} value={c.id}>
        {' '.repeat(depth * 2)}
        {c.title}
      </option>
    ))
  ]

  return (
    <div className="feed timesheet">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Timesheet</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(start))} – {rangeFmt.format(parseLocal(end))}
            {sheet ? ` · ${hm(total)} reported · ${hm(worked)} worked` : ''}
          </span>
          <span className={`ts-state state-${legacy ? 'saved' : state}${final ? ' is-final' : ''}${legacy ? ' is-legacy' : ''}`}>{sheet ? stateText() : ''}</span>
          <span className="spacer" />
          <div className="week-nav">
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(addDays(start, -7))} title="Previous week">
              ‹
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(weekStart(today))} disabled={start === weekStart(today)}>
              This week
            </button>
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStart(addDays(start, 7))} disabled={start >= weekStart(today)} title="Next week">
              ›
            </button>
          </div>
        </div>
        {sheet && (
          <div className="ts-actions">
            {final && (
              <>
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStatus('draft')} title="Make changes again">
                  Reopen
                </button>
                {destinations.map((d) => (
                  <button key={`${d.extension}/${d.id}`} type="button" className="btn btn-primary btn-xs ts-send" onClick={() => setSending(d)}>
                    Send to {d.label}…
                  </button>
                ))}
              </>
            )}
            {live && (
              <>
                <button type="button" className="btn btn-quiet btn-xs ts-reassign-open" onClick={openReassign} title="Say what a stretch of time was: another task, or not work">
                  Reassign time…
                </button>
                {confirm === 'reset' ? (
                  <>
                    <span className="entry-confirm">Drop your changes to this week (hours, notes, entries you added)? Corrections to tracked time stay.</span>
                    <button type="button" className="btn btn-danger btn-xs" onClick={resetChanges}>
                      Drop
                    </button>
                    <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  state !== 'unsaved-draft' && (
                    <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm('reset')}>
                      Drop my changes
                    </button>
                  )
                )}
                {state === 'unsaved-draft' && (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => change((s) => s)}>
                    Save draft
                  </button>
                )}
                <button type="button" className="btn btn-primary btn-xs" onClick={() => setStatus('final')} title="Approve the week as it stands (what gets sent)">
                  Mark final
                </button>
                {destinations.length > 0 && <span className="hint">Mark the week final to send it to {destinations.map((d) => d.label).join(', ')}.</span>}
              </>
            )}
            {legacy && (
              <>
                {confirm === 'adopt' ? (
                  <>
                    <span className="entry-confirm">Draw this week from tracked time again? Notes, trimmed hours and entries you added stay; tasks you changed on tracked entries go back, so reassign that time instead.</span>
                    <button type="button" className="btn btn-primary btn-xs" onClick={adopt}>
                      Follow tracked time
                    </button>
                    <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirm(null)}>
                      Not now
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary btn-xs ts-adopt" onClick={() => setConfirm('adopt')} title="Have this week follow tracked time, keeping your changes">
                    Follow tracked time…
                  </button>
                )}
                <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStatus('final')} title="Approve the week as it is">
                  Mark final
                </button>
                <span className="hint">Saved before timesheets followed tracked time: it shows what you left, and doesn&apos;t count time tracked since.</span>
              </>
            )}
          </div>
        )}
        {live && reassign && <ReassignForm dates={dates} values={reassign} onChange={setReassign} options={taskOptions()} onSubmit={submitReassign} onCancel={() => setReassign(null)} />}
      </header>

      {!sheet && <p className="feed-empty">Loading…</p>}
      {sheet && <Targets canvases={canvases} week={start} sheet={sheet} loadWeek={loadWeek} />}
      {sheet && (
        <div className="review-table-wrap">
          <table className="review-table ts-grid">
            <colgroup>
              <col className="ts-col-label" />
              {dates.map((d) => (
                <col key={d} className="ts-col-day" />
              ))}
              <col className="ts-col-week" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="review-corner" />
                {dates.map((d) => (
                  <th key={d} scope="col" className={`review-day${d === today ? ' is-today' : ''}`}>
                    <span className="review-day-name">{dayHead.format(parseLocal(d)).split(/[ ,]+/)[0]}</span>
                    <span className="review-day-num">{parseLocal(d).getDate()}</span>
                  </th>
                ))}
                <th scope="col" className="review-day review-total">
                  Week
                </th>
              </tr>
            </thead>
            <tbody>
              {grid.clients.map(({ client, tasks }) => (
                <FragmentRows key={client}>
                  <tr className="ts-client-row" data-client={client}>
                    <th scope="row" className="ts-client-label">
                      {label(client)}
                    </th>
                    {dates.map((d) => {
                      const b = balances.find((x) => x.date === d && x.group === client)
                      const trim = b ? b.suggestions.reduce((n, sg) => n + sg.from - sg.to, 0) : 0
                      const minutes = grid.sum(tasks, d)
                      return (
                        <td key={d} className="ts-cell ts-client-cell" title={minutes ? `${hm(minutes)} reported · ${hm(grid.sum(tasks, d, grid.workedCell))} worked` : undefined}>
                          {minutes ? hm(minutes) : ''}
                          {b && b.suggestions.length > 0 && live && (
                            <button
                              type="button"
                              className={`ts-trim${trim > 0 ? '' : ' is-add'}`}
                              onClick={() => applySuggestions(b)}
                              title={`Rounding reports ${hm(b.reported)} for ${hm(Math.round(b.worked))} worked. Apply: ${b.suggestions
                                .map((sg) => {
                                  const e = sheet.entries.find((x) => x.id === sg.entryId)
                                  return `${e ? rowLabel(e.canvasId) : sg.entryId} ${hm(sg.from)} → ${hm(sg.to)}`
                                })
                                .join(', ')}`}
                            >
                              {trim > 0 ? `−${hm(trim)}` : `+${hm(-trim)}`}
                            </button>
                          )}
                        </td>
                      )
                    })}
                    <td className="ts-cell ts-client-cell review-total">{hm(grid.sum(tasks))}</td>
                  </tr>
                  {tasks.map((id) => (
                    <tr key={id} className="ts-task-row" data-canvas={id}>
                      <th scope="row" className="ts-task-label" title={label(id)}>
                        {(() => {
                          // The task's own name first; the project path after it, muted (and first to be cut off).
                          const parts = rowLabel(id).split(' / ')
                          return (
                            <>
                              {parts.at(-1)}
                              {parts.length > 1 && <span className="ts-task-path"> · {parts.slice(0, -1).join(' / ')}</span>}
                            </>
                          )
                        })()}
                      </th>
                      {dates.map((d) => {
                        const minutes = grid.cell.get(`${id}|${d}`) ?? 0
                        const isSel = selected?.canvasId === id && selected.date === d
                        return (
                          <td key={d} className={`ts-cell${isSel ? ' is-selected' : ''}${minutes ? '' : ' is-empty'}`}>
                            <button
                              type="button"
                              className="ts-cell-btn"
                              data-canvas={id}
                              data-date={d}
                              onClick={() => setSelected(isSel ? null : { canvasId: id, date: d })}
                              title={minutes ? `${hm(minutes)} reported · ${hm(grid.workedCell.get(`${id}|${d}`) ?? 0)} worked` : live ? 'Add time here' : ''}
                            >
                              {minutes ? hm(minutes) : live ? '+' : ''}
                            </button>
                          </td>
                        )
                      })}
                      <td className="ts-cell review-total">{hm(grid.sum([id]))}</td>
                    </tr>
                  ))}
                </FragmentRows>
              ))}
              {grid.clients.length === 0 && (
                <tr>
                  <td colSpan={9} className="ts-none">
                    No tracked time this week. Add a task below and click a day to add time.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="ts-total-row">
                <th scope="row">Reported</th>
                {dates.map((d) => (
                  <td key={d} className="ts-cell ts-day-total" data-date={d}>
                    {dayTotal(d) ? hm(dayTotal(d)) : ''}
                  </td>
                ))}
                <td className="ts-cell ts-day-total review-total">{hm(total)}</td>
              </tr>
              <tr className="ts-worked-row">
                <th scope="row">Worked</th>
                {dates.map((d) => (
                  <td key={d} className="ts-cell">
                    {dayWorked(d) ? hm(Math.round(dayWorked(d))) : ''}
                  </td>
                ))}
                <td className="ts-cell review-total">{hm(Math.round(worked))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {sheet && live && addableTasks.length > 0 && (
        <div className="ts-add-task">
          <select
            aria-label="Add a task to the grid"
            value=""
            onChange={(ev) => {
              const id = ev.target.value
              if (id) setExtraRows((rows) => [...rows, id])
            }}
          >
            <option value="">+ Add a task…</option>
            {addableTasks.map((t) => (
              <option key={t.id} value={t.id}>
                {' '.repeat(t.depth * 2)}
                {t.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {sheet && selected && (
        <section className="ts-detail" aria-label="Entries in this cell">
          <div className="ts-detail-head">
            <strong>{label(selected.canvasId)}</strong>
            <span className="ts-day-sum">
              {dayHead.format(parseLocal(selected.date))} · {hm(selectedEntries.reduce((n, e) => n + e.minutes, 0))}
            </span>
            <span className="spacer" />
            {live && (
              <>
                <button type="button" className="btn btn-quiet btn-xs ts-reassign-cell" onClick={openReassign} title="Say what part of this time was: another task, or not work">
                  Reassign time…
                </button>
                <button type="button" className="btn btn-quiet btn-xs ts-add" onClick={() => addEntry(selected.canvasId, selected.date)}>
                  + Add entry
                </button>
              </>
            )}
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setSelected(null)} aria-label="Close">
              ✕
            </button>
          </div>
          {selectedEntries.length === 0 && <p className="hint">No time here yet.{live ? ' Add an entry.' : ''}</p>}
          {selectedEntries.length > 0 && (
            <table className="ts-table">
              <tbody>
                {selectedEntries.map((e) => {
                  const tracked = e.source === 'tracked' && !!e.span && live
                  const running = tracked && isRunning(e)
                  return (
                    <tr key={e.id} className={`ts-row source-${e.source}${running ? ' is-running' : ''}`} data-entry={e.id}>
                      <td className="ts-when">
                        {tracked ? (
                          <>
                            <span className="ts-weekday">{weekdayFmt.format(parseLocal(e.date))}</span>
                            <TimeField value={timeOf(e.span!.start)} label="Started" onCommit={(t) => moveStart(e, t)} />
                            <span className="ts-dash">–</span>
                            {running ? (
                              <span className="ts-now" title="Still counting: reassign part of it to split it">
                                now
                              </span>
                            ) : (
                              <TimeField value={timeOf(e.span!.end)} label="Ended" onCommit={(t) => moveEnd(e, t)} />
                            )}
                          </>
                        ) : (
                          <>
                            <select value={e.date} disabled={!live} aria-label="Day" onChange={(ev) => editPlain(e, { date: ev.target.value, start: atTime(ev.target.value, timeOf(e.start)) })}>
                              {dates.map((d) => (
                                <option key={d} value={d}>
                                  {weekdayFmt.format(parseLocal(d))}
                                </option>
                              ))}
                            </select>
                            <input type="time" step={900} value={timeOf(e.start)} disabled={!live} aria-label="Start" onChange={(ev) => ev.target.value && editPlain(e, { start: atTime(e.date, ev.target.value) })} />
                          </>
                        )}
                      </td>
                      <td className="ts-minutes">
                        <button type="button" className="ts-step" disabled={!live || e.minutes <= QUARTER_MINUTES} aria-label="15 minutes less" onClick={() => setMinutes(e, e.minutes - QUARTER_MINUTES)}>
                          −
                        </button>
                        <span className="ts-hours" title="Reported">
                          {hm(e.minutes)}
                        </span>
                        <button type="button" className="ts-step" disabled={!live || e.minutes >= 24 * 60} aria-label="15 minutes more" onClick={() => setMinutes(e, e.minutes + QUARTER_MINUTES)}>
                          +
                        </button>
                      </td>
                      <td className="ts-task">
                        <select value={e.canvasId} disabled={!live} aria-label="Task" title={tracked ? 'Changing the task reassigns this tracked time' : undefined} onChange={(ev) => (tracked ? retask(e, ev.target.value) : editPlain(e, { canvasId: ev.target.value }))}>
                          <option value={JOURNAL_ID}>Journal</option>
                          {taskOptions(e.canvasId)}
                        </select>
                      </td>
                      <td className="ts-note">
                        <input type="text" value={e.note ?? ''} placeholder="Note" disabled={!live} aria-label="Note" onChange={(ev) => setNote(e, ev.target.value)} />
                      </td>
                      <td className="ts-worked" title={e.source === 'manual' ? 'Added by hand' : `${Math.round(e.worked)} minutes ${e.source}${running ? ', still counting' : ''}`}>
                        {e.source === 'manual' ? SOURCE_LABEL.manual : `${hm(e.worked)} ${SOURCE_LABEL[e.source]}`}
                      </td>
                      <td className="ts-remove">
                        {live && (
                          <button type="button" className="ts-step" aria-label="Remove" title={tracked ? 'Not work: remove this tracked time' : 'Remove this entry'} onClick={() => removeEntry(e)}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {sheet && corrections.length > 0 && (
        <section className="ts-corrections" aria-label="Corrections to tracked time">
          <h3>Corrections to tracked time</h3>
          <ul>
            {corrections.map((c) => (
              <li key={c.id} className="ts-correction" data-correction={c.id}>
                <span className="ts-correction-when">
                  {weekdayFmt.format(new Date(c.start))} {timeOf(c.start)}–{timeOf(c.end)}
                </span>
                <span className="ts-correction-what">{c.canvasId ? `→ ${label(c.canvasId)}` : '→ not worked'}</span>
                {!final && (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => void reported(undoCorrection(c.id, c.start))}>
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {sending && <SendDialog to={sending} label={sending.label} week={start} onClose={() => setSending(null)} />}
    </div>
  )
}

const NOT_WORKED = '-'

interface ReassignValues {
  date: string
  from: string
  to: string
  /** A canvas, `NOT_WORKED`, or '' (not chosen yet). */
  canvasId: string
}

/** "From 14:00 to 15:00 on Tuesday was Globex": a correction to tracked time, in every view. */
function ReassignForm({
  dates,
  values,
  options,
  onChange,
  onSubmit,
  onCancel
}: {
  dates: string[]
  values: ReassignValues
  options: React.JSX.Element[]
  onChange: (v: ReassignValues) => void
  onSubmit: (v: ReassignValues) => void
  onCancel: () => void
}): React.JSX.Element {
  const set = (patch: Partial<ReassignValues>): void => onChange({ ...values, ...patch })
  // Not a <form>: the page runs in a sandboxed frame, where forms cannot be submitted.
  return (
    <div className="ts-reassign" role="group" aria-label="Reassign time">
      <span className="ts-reassign-label">Time on</span>
      <select value={values.date} aria-label="Day" onChange={(ev) => set({ date: ev.target.value })}>
        {dates.map((d) => (
          <option key={d} value={d}>
            {dayHead.format(parseLocal(d))}
          </option>
        ))}
      </select>
      <span>from</span>
      <input type="time" value={values.from} aria-label="From" onChange={(ev) => ev.target.value && set({ from: ev.target.value })} />
      <span>to</span>
      <input type="time" value={values.to} aria-label="To" onChange={(ev) => ev.target.value && set({ to: ev.target.value })} />
      <span>was</span>
      <select value={values.canvasId} aria-label="Was" onChange={(ev) => set({ canvasId: ev.target.value })}>
        <option value="">Choose…</option>
        <option value={NOT_WORKED}>Not work</option>
        {options}
      </select>
      <button type="button" className="btn btn-primary btn-xs ts-reassign-go" disabled={!values.canvasId} onClick={() => onSubmit(values)}>
        Reassign
      </button>
      <button type="button" className="btn btn-quiet btn-xs" onClick={onCancel}>
        Cancel
      </button>
    </div>
  )
}

/** A time that is applied when you leave the field or press Enter (each change corrects tracked time, so not on every keystroke). */
function TimeField({ value, label, onCommit }: { value: string; label: string; onCommit: (time: string) => void }): React.JSX.Element {
  const [v, setV] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => setV(value), [value])
  return (
    <input
      type="time"
      value={v}
      aria-label={label}
      onChange={(ev) => setV(ev.target.value)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter') ev.currentTarget.blur()
        if (ev.key === 'Escape') {
          cancelled.current = true
          ev.currentTarget.blur()
        }
      }}
      onBlur={() => {
        const keep = cancelled.current
        cancelled.current = false
        if (keep || !v || v === value) return setV(value)
        onCommit(v)
      }}
    />
  )
}

/** Rows without a wrapper element (a client row followed by its task rows). */
function FragmentRows({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>
}
