import { useEffect, useRef } from 'react'
import type { Day, SearchHit } from '@shared/types'
import { EntryView } from './EntryView'

interface Props {
  day: Day | null
  today: string
  search: string
  hits: SearchHit[] | null
  loading: boolean
  onUpdate: (date: string, id: string, markdown: string) => Promise<void>
  onDelete: (date: string, id: string) => Promise<void>
  onJumpToDay: (date: string) => void
}

const headingFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function Feed({ day, today, search, hits, loading, onUpdate, onDelete, onJumpToDay }: Props): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const lastCount = useRef(0)
  const lastDate = useRef<string | null>(null)

  // Keep the newest entry in view when posting to the day being displayed.
  useEffect(() => {
    if (!day || search) return
    const el = scroller.current
    if (!el) return
    const dateChanged = lastDate.current !== day.date
    const grew = day.entries.length > lastCount.current
    lastDate.current = day.date
    lastCount.current = day.entries.length
    if (dateChanged || grew) {
      requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: dateChanged ? 'auto' : 'smooth' }))
    }
  }, [day, search])

  if (search) {
    return (
      <div className="feed" ref={scroller}>
        <header className="feed-head">
          <h2>Search: “{search}”</h2>
          <span className="feed-sub">{hits ? `${hits.length} result${hits.length === 1 ? '' : 's'}` : 'Searching…'}</span>
        </header>
        {hits && hits.length === 0 && <p className="feed-empty">Nothing matched.</p>}
        {hits?.map((h) => (
          <div key={`${h.date}/${h.entry.id}`} className="hit">
            <button type="button" className="hit-day" onClick={() => onJumpToDay(h.date)}>
              {headingFmt.format(parseLocal(h.date))}
            </button>
            <EntryView date={h.date} entry={h.entry} showDate onUpdate={onUpdate} onDelete={onDelete} />
          </div>
        ))}
      </div>
    )
  }

  if (!day) {
    return (
      <div className="feed" ref={scroller}>
        {loading ? <p className="feed-empty">Loading…</p> : null}
      </div>
    )
  }

  const isToday = day.date === today
  return (
    <div className="feed" ref={scroller}>
      <header className="feed-head">
        <h2>{isToday ? 'Today' : headingFmt.format(parseLocal(day.date))}</h2>
        <span className="feed-sub">
          {isToday ? headingFmt.format(parseLocal(day.date)) : ''}
          {day.entries.length > 0 ? ` · ${day.entries.length} entr${day.entries.length === 1 ? 'y' : 'ies'}` : ''}
        </span>
      </header>
      {day.entries.length === 0 && (
        <p className="feed-empty">{isToday ? 'No entries yet today. Write something below.' : 'No entries on this day.'}</p>
      )}
      {day.entries.map((e) => (
        <EntryView key={e.id} date={day.date} entry={e} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
    </div>
  )
}
