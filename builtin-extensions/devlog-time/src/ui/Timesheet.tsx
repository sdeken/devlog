import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  JOURNAL_ID,
  QUARTER_MINUTES,
  balanceDays,
  buildCanvasTree,
  canvasLabel,
  flattenTree,
  localDate,
  roundToQuarterHour,
  topLevelCanvasId,
  type DayBalance,
  type Timesheet as Sheet,
  type TimesheetEntry
} from '@devlog/core'
import type { CanvasMeta } from '@shared/types'
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
const atTime = (date: string, time: string): string => {
  const [h, m] = time.split(':').map(Number)
  const d = parseLocal(date)
  d.setHours(h || 0, m || 0, 0, 0)
  return roundToQuarterHour(d).toISOString()
}

type SaveState = 'unsaved-draft' | 'saved' | 'pending' | 'saving' | 'error'

const SOURCE_LABEL: Record<TimesheetEntry['source'], string> = { tracked: 'tracked', estimated: 'estimated', manual: 'added' }

/**
 * The weekly timesheet: a draft from tracked time, rounded once to quarter
 * hours, which you adjust (durations, tasks, days, notes; the suggested
 * trims even out rounding per client and day) and mark final. It is saved
 * as one block per week in the Timesheets canvas.
 */
export function Timesheet({ canvases, today, onError }: Props): React.JSX.Element {
  const reported = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch((err: unknown) => void onError(err instanceof Error ? err.message : String(err)))
  const [start, setStart] = useState(() => weekStart(today))
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [state, setState] = useState<SaveState>('saved')
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  /** The cell whose entries are open for editing. */
  const [selected, setSelected] = useState<{ canvasId: string; date: string } | null>(null)
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
  const latest = useRef<Sheet | null>(null)

  const buildDraft = useCallback(async (week: string): Promise<Sheet> => {
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
    return draftTimesheet(week, notes, events)
  }, [])

  // Load the week: the saved timesheet, or a fresh draft (not saved until you change something).
  useEffect(() => {
    let cancelled = false
    setSheet(null)
    setConfirmRebuild(false)
    setSelected(null)
    setExtraRows([])
    void (async () => {
      const saved = await api.timesheet(start)
      const next = saved ?? (await buildDraft(start))
      if (cancelled) return
      latest.current = next
      setSheet(next)
      setState(saved ? 'saved' : 'unsaved-draft')
    })()
    return () => {
      cancelled = true
    }
  }, [start, buildDraft])

  // Another week for the monthly targets: as saved, or drafted from tracked time.
  const loadWeek = useCallback(async (week: string): Promise<Sheet> => (await api.timesheet(week)) ?? (await buildDraft(week)), [buildDraft])

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const s = latest.current
    if (!s) return
    setState('saving')
    try {
      const saved = await api.saveTimesheet(s)
      if (latest.current === s) {
        latest.current = saved
        setSheet(saved)
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

  const change = (fn: (s: Sheet) => Sheet): void => {
    const cur = latest.current
    if (!cur || cur.status === 'final') return
    const next = fn(cur)
    latest.current = next
    setSheet(next)
    setState('pending')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void reported(flush()), 600)
  }
  const updateEntry = (id: string, patch: Partial<TimesheetEntry>): void =>
    change((s) => ({ ...s, entries: s.entries.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))

  const setStatus = (status: Sheet['status']): void => {
    const cur = latest.current
    if (!cur) return
    latest.current = { ...cur, status }
    setSheet(latest.current)
    void reported(flush())
  }

  const rebuild = async (): Promise<void> => {
    setConfirmRebuild(false)
    const draft = await buildDraft(start)
    change((s) => ({ ...s, entries: draft.entries }))
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
  const final = sheet?.status === 'final'

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

  const addEntry = (canvasId: string, date: string): void =>
    change((s) => {
      const dayEntries = s.entries.filter((e) => e.date === date)
      const lastEnd = dayEntries.reduce((t, e) => Math.max(t, Date.parse(e.start) + e.minutes * 60_000), 0)
      const startAt = lastEnd || parseLocal(date).setHours(9, 0, 0, 0)
      const entry: TimesheetEntry = { id: newEntryId(s.entries), date, start: new Date(startAt).toISOString(), minutes: 60, canvasId, worked: 0, source: 'manual' }
      return { ...s, entries: [...s.entries, entry] }
    })

  /** Edit an entry from the cell panel; moving it to another task or day moves the selection with it. */
  const editEntry = (e: TimesheetEntry, patch: Partial<TimesheetEntry>): void => {
    updateEntry(e.id, patch)
    const inCell = (sheet?.entries ?? []).filter((x) => x.canvasId === e.canvasId && x.date === e.date).length
    if ((patch.canvasId && patch.canvasId !== e.canvasId) || (patch.date && patch.date !== e.date)) {
      if (inCell <= 1) setSelected({ canvasId: patch.canvasId ?? e.canvasId, date: patch.date ?? e.date })
    }
  }

  const applySuggestions = (b: DayBalance): void =>
    change((s) => ({ ...s, entries: s.entries.map((e) => ({ ...e, minutes: b.suggestions.find((x) => x.entryId === e.id)?.to ?? e.minutes })) }))

  const stateText: Record<SaveState, string> = {
    'unsaved-draft': 'Draft from tracked time, not saved yet',
    saved: final ? 'Final' : 'Saved',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Could not save'
  }

  const selectedEntries = selected && sheet ? sheet.entries.filter((e) => e.canvasId === selected.canvasId && e.date === selected.date).sort((a, b) => a.start.localeCompare(b.start)) : []
  const inGrid = new Set(grid.clients.flatMap((c) => c.tasks))
  const addableTasks = [{ id: JOURNAL_ID, depth: 0, title: 'Journal' }, ...tree.map(({ canvas: c, depth }) => ({ id: c.id, depth, title: c.title }))].filter((t) => !inGrid.has(t.id))

  return (
    <div className="feed timesheet">
      <header className="feed-head page-head">
        <div className="page-head-row">
          <h2>Timesheet</h2>
          <span className="feed-sub">
            {rangeFmt.format(parseLocal(start))} – {rangeFmt.format(parseLocal(end))}
            {sheet ? ` · ${hm(total)} reported · ${hm(worked)} worked` : ''}
          </span>
          <span className={`ts-state state-${state}${final ? ' is-final' : ''}`}>{sheet ? stateText[state] : ''}</span>
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
            {final ? (
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
            ) : (
              <>
                {confirmRebuild ? (
                  <>
                    <span className="entry-confirm">Replace every entry with a fresh draft from tracked time?</span>
                    <button type="button" className="btn btn-danger btn-xs" onClick={() => void reported(rebuild())}>
                      Replace
                    </button>
                    <button type="button" className="btn btn-quiet btn-xs" onClick={() => setConfirmRebuild(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => (state === 'unsaved-draft' ? void reported(rebuild()) : setConfirmRebuild(true))}>
                    Rebuild from tracked time
                  </button>
                )}
                {state === 'unsaved-draft' && (
                  <button type="button" className="btn btn-quiet btn-xs" onClick={() => change((s) => s)}>
                    Save draft
                  </button>
                )}
                <button type="button" className="btn btn-primary btn-xs" onClick={() => setStatus('final')} title="Approve the week (what gets sent)">
                  Mark final
                </button>
                {destinations.length > 0 && <span className="hint">Mark the week final to send it to {destinations.map((d) => d.label).join(', ')}.</span>}
              </>
            )}
          </div>
        )}
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
                          {b && b.suggestions.length > 0 && !final && (
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
                              title={minutes ? `${hm(minutes)} reported · ${hm(grid.workedCell.get(`${id}|${d}`) ?? 0)} worked` : final ? '' : 'Add time here'}
                            >
                              {minutes ? hm(minutes) : final ? '' : '+'}
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

      {sheet && !final && addableTasks.length > 0 && (
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
            {!final && (
              <button type="button" className="btn btn-quiet btn-xs ts-add" onClick={() => addEntry(selected.canvasId, selected.date)}>
                + Add entry
              </button>
            )}
            <button type="button" className="btn btn-quiet btn-xs" onClick={() => setSelected(null)} aria-label="Close">
              ✕
            </button>
          </div>
          {selectedEntries.length === 0 && <p className="hint">No time here yet.{final ? '' : ' Add an entry.'}</p>}
          {selectedEntries.length > 0 && (
            <table className="ts-table">
              <tbody>
                {selectedEntries.map((e) => (
                  <tr key={e.id} className={`ts-row source-${e.source}`} data-entry={e.id}>
                    <td className="ts-when">
                      <select value={e.date} disabled={final} aria-label="Day" onChange={(ev) => editEntry(e, { date: ev.target.value, start: atTime(ev.target.value, timeOf(e.start)) })}>
                        {dates.map((d) => (
                          <option key={d} value={d}>
                            {weekdayFmt.format(parseLocal(d))}
                          </option>
                        ))}
                      </select>
                      <input type="time" step={900} value={timeOf(e.start)} disabled={final} aria-label="Start" onChange={(ev) => ev.target.value && updateEntry(e.id, { start: atTime(e.date, ev.target.value) })} />
                    </td>
                    <td className="ts-minutes">
                      <button type="button" className="ts-step" disabled={final || e.minutes <= QUARTER_MINUTES} aria-label="15 minutes less" onClick={() => updateEntry(e.id, { minutes: e.minutes - QUARTER_MINUTES })}>
                        −
                      </button>
                      <span className="ts-hours">{hm(e.minutes)}</span>
                      <button type="button" className="ts-step" disabled={final || e.minutes >= 24 * 60} aria-label="15 minutes more" onClick={() => updateEntry(e.id, { minutes: e.minutes + QUARTER_MINUTES })}>
                        +
                      </button>
                    </td>
                    <td className="ts-task">
                      <select value={e.canvasId} disabled={final} aria-label="Task" onChange={(ev) => editEntry(e, { canvasId: ev.target.value })}>
                        <option value={JOURNAL_ID}>Journal</option>
                        {!canvases.some((c) => c.id === e.canvasId) && e.canvasId !== JOURNAL_ID && <option value={e.canvasId}>{e.canvasId} (gone)</option>}
                        {tree.map(({ canvas: c, depth }) => (
                          <option key={c.id} value={c.id}>
                            {' '.repeat(depth * 2)}
                            {c.title}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="ts-note">
                      <input type="text" value={e.note ?? ''} placeholder="Note" disabled={final} aria-label="Note" onChange={(ev) => updateEntry(e.id, { note: ev.target.value })} />
                    </td>
                    <td className="ts-worked" title={e.source === 'manual' ? 'Added by hand' : `${Math.round(e.worked)} minutes ${e.source}`}>
                      {e.source === 'manual' ? SOURCE_LABEL.manual : `${hm(e.worked)} ${SOURCE_LABEL[e.source]}`}
                    </td>
                    <td className="ts-remove">
                      {!final && (
                        <button type="button" className="ts-step" aria-label="Remove" title="Remove this entry" onClick={() => change((s) => ({ ...s, entries: s.entries.filter((x) => x.id !== e.id) }))}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {sending && <SendDialog to={sending} label={sending.label} week={start} onClose={() => setSending(null)} />}
    </div>
  )
}

/** Rows without a wrapper element (a client row followed by its task rows). */
function FragmentRows({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>
}
