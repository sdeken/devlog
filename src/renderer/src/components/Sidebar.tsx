import { useMemo } from 'react'
import type { DaySummary } from '@shared/types'

interface Props {
  days: DaySummary[]
  today: string
  selected: string
  search: string
  onSearch: (q: string) => void
  onSelect: (date: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
}

const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' })

function parseLocal(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function Sidebar({ days, today, selected, search, onSearch, onSelect, searchRef }: Props): React.JSX.Element {
  const groups = useMemo(() => {
    const all = days.some((d) => d.date === today) ? days : [{ date: today, count: 0 }, ...days]
    const map = new Map<string, DaySummary[]>()
    for (const d of all) {
      const key = d.date.slice(0, 7)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(d)
    }
    return Array.from(map.entries())
  }, [days, today])

  const total = days.reduce((n, d) => n + d.count, 0)

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Devlog</h1>
        <span className="sidebar-count" title="Total entries">
          {total}
        </span>
      </div>
      <div className="sidebar-search">
        <input
          ref={searchRef}
          type="search"
          placeholder="Search entries…"
          value={search}
          onChange={(ev) => onSearch(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              onSearch('')
              ;(ev.target as HTMLInputElement).blur()
            }
          }}
        />
      </div>
      <nav className="sidebar-days">
        {groups.map(([month, list]) => (
          <section key={month} className="sidebar-month">
            <h2>{monthFmt.format(parseLocal(`${month}-01`))}</h2>
            <ul>
              {list.map((d) => (
                <li key={d.date}>
                  <button
                    type="button"
                    className={`day-link${d.date === selected && !search ? ' is-selected' : ''}${d.date === today ? ' is-today' : ''}`}
                    onClick={() => {
                      onSearch('')
                      onSelect(d.date)
                    }}
                  >
                    <span className="day-name">{d.date === today ? 'Today' : dayFmt.format(parseLocal(d.date))}</span>
                    {d.count > 0 && <span className="day-count">{d.count}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </aside>
  )
}
