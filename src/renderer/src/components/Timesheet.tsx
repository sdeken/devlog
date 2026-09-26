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
import { api } from '@renderer/api'
import { reported } from '@renderer/toasts'

interface Props {
  canvases: CanvasMeta[]
  today: string
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
export function Timesheet({ canvases, today }: Props): React.JSX.Element {
  const [start, setStart] = useState(() => weekStart(today))
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [state, setState] = useState<SaveState>('saved')
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const dates = useMemo(() => weekDates(start), [start])
  const end = dates[6]
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<Sheet | null>(null)

  const buildDraft = useCallback(async (week: string): Promise<Sheet> => {
    const last = addDays(week, 6)
    const [chunks, events] = await Promise.all([api.blocks.range(week, last), api.activity.range(week, last)])
    const notes: ReviewNote[] = []
    for (const { canvasId, day } of chunks) {
      for (const entry of day.entries) {
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
    void (async () => {
      const saved = await api.timesheets.get(start)
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

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const s = latest.current
    if (!s) return
    setState('saving')
    try {
      const saved = await api.timesheets.save(s)
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
  const clientOf = useCallback((id: string) => topLevelCanvasId(canvases, id), [canvases])
  const label = (id: string): string => (id === JOURNAL_ID ? 'Journal' : canvasLabel(canvases, id))
  const balances = useMemo(() => (sheet ? balanceDays(sheet.entries, clientOf) : []), [sheet, clientOf])
  const final = sheet?.status === 'final'

  // Week totals per client.
  const clients = useMemo(() => {
    const m = new Map<string, { reported: number; worked: number }>()
    for (const e of sheet?.entries ?? []) {
      const c = clientOf(e.canvasId)
      const cur = m.get(c) ?? { reported: 0, worked: 0 }
      m.set(c, { reported: cur.reported + e.minutes, worked: cur.worked + e.worked })
    }
    return [...m].sort((a, b) => b[1].reported - a[1].reported)
  }, [sheet, clientOf])
  const total = sheet?.entries.reduce((n, e) => n + e.minutes, 0) ?? 0
  const worked = sheet?.entries.reduce((n, e) => n + e.worked, 0) ?? 0

  const addEntry = (date: string): void =>
    change((s) => {
      const dayEntries = s.entries.filter((e) => e.date === date)
      const lastEnd = dayEntries.reduce((t, e) => Math.max(t, Date.parse(e.start) + e.minutes * 60_000), 0)
      const startAt = lastEnd || parseLocal(date).setHours(9, 0, 0, 0)
      const canvasId = dayEntries.at(-1)?.canvasId ?? tree[0]?.canvas.id ?? JOURNAL_ID
      const entry: TimesheetEntry = { id: newEntryId(s.entries), date, start: new Date(startAt).toISOString(), minutes: 60, canvasId, worked: 0, source: 'manual' }
      return { ...s, entries: [...s.entries, entry] }
    })

  const applySuggestions = (b: DayBalance): void =>
    change((s) => ({ ...s, entries: s.entries.map((e) => ({ ...e, minutes: b.suggestions.find((x) => x.entryId === e.id)?.to ?? e.minutes })) }))

  const stateText: Record<SaveState, string> = {
    'unsaved-draft': 'Draft from tracked time, not saved yet',
    saved: final ? 'Final' : 'Saved',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Could not save'
  }

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
              <button type="button" className="btn btn-quiet btn-xs" onClick={() => setStatus('draft')} title="Make changes again">
                Reopen
              </button>
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
              </>
            )}
          </div>
        )}
      </header>

      {!sheet && <p className="feed-empty">Loading…</p>}
      {sheet && clients.length > 0 && (
        <div className="ts-clients">
          {clients.map(([c, t]) => (
            <span key={c} className="ts-client" title={`${hm(t.worked)} worked`}>
              <span className="ts-client-name">{label(c)}</span> {hm(t.reported)}
            </span>
          ))}
        </div>
      )}
      {sheet &&
        dates.map((date) => {
          const entries = sheet.entries.filter((e) => e.date === date).sort((a, b) => a.start.localeCompare(b.start))
          const dayBalances = balances.filter((b) => b.date === date && (b.suggestions.length > 0 || b.residual !== 0))
          const reportedDay = entries.reduce((n, e) => n + e.minutes, 0)
          const workedDay = entries.reduce((n, e) => n + e.worked, 0)
          return (
            <section key={date} className={`ts-day${date === today ? ' is-today' : ''}`} data-date={date}>
              <div className="ts-day-head">
                <span className="ts-day-name">{dayHead.format(parseLocal(date))}</span>
                {entries.length > 0 && (
                  <span className="ts-day-sum">
                    {hm(reportedDay)} reported · {hm(workedDay)} worked
                  </span>
                )}
                <span className="spacer" />
                {!final && (
                  <button type="button" className="btn btn-quiet btn-xs ts-add" onClick={() => addEntry(date)}>
                    + Add
                  </button>
                )}
              </div>
              {entries.length > 0 && (
                <table className="ts-table">
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className={`ts-row source-${e.source}`} data-entry={e.id}>
                        <td className="ts-when">
                          <select value={e.date} disabled={final} aria-label="Day" onChange={(ev) => updateEntry(e.id, { date: ev.target.value, start: atTime(ev.target.value, timeOf(e.start)) })}>
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
                          <select value={e.canvasId} disabled={final} aria-label="Task" onChange={(ev) => updateEntry(e.id, { canvasId: ev.target.value })}>
                            <option value={JOURNAL_ID}>Journal</option>
                            {!canvases.some((c) => c.id === e.canvasId) && e.canvasId !== JOURNAL_ID && <option value={e.canvasId}>{e.canvasId} (gone)</option>}
                            {tree.map(({ canvas: c, depth }) => (
                              <option key={c.id} value={c.id}>
                                {' '.repeat(depth * 2)}
                                {c.title}
                              </option>
                            ))}
                          </select>
                          <span className="ts-client-of">{clientOf(e.canvasId) !== e.canvasId ? label(clientOf(e.canvasId)) : ''}</span>
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
              {dayBalances.map((b) => (
                <div key={b.group} className="ts-balance" data-group={b.group}>
                  <span>
                    <strong>{label(b.group)}</strong>: {hm(b.reported)} reported for {hm(b.worked)} worked
                    {b.suggestions.length > 0 && (
                      <>
                        {' '}
                        · suggest{' '}
                        {b.suggestions
                          .map((s) => {
                            const e = entries.find((x) => x.id === s.entryId)
                            return `${e ? `${label(e.canvasId).split(' / ').pop()} (${timeOf(e.start)})` : s.entryId} ${hm(s.from)} → ${hm(s.to)}`
                          })
                          .join(', ')}
                      </>
                    )}
                    {b.residual > 0 && b.suggestions.length === 0 && <> · every entry is already 15 minutes; it cannot be evened out</>}
                  </span>
                  {b.suggestions.length > 0 && !final && (
                    <button type="button" className="btn btn-quiet btn-xs" onClick={() => applySuggestions(b)}>
                      Apply
                    </button>
                  )}
                </div>
              ))}
            </section>
          )
        })}
      {sheet && sheet.entries.length === 0 && <p className="feed-empty">No tracked time this week. Add entries by hand with + Add.</p>}
    </div>
  )
}
