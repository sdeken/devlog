/** The task picker (a popover): find a task and start it, stop the clock, or make a new task. */
import '@devlog/ui/styles.css'
import './views.css'
import { useEffect, useState } from 'react'
import { Menu, devlog, mount, useCall, useMessages, useViewContext, type MenuEntry } from '@devlog/ui'
import type { ClockStatus, TaskInfo } from './common'

function Picker(): React.JSX.Element {
  const here = useViewContext().canvasId
  const { data: tasks, error } = useCall<TaskInfo[]>('tasks', [here ?? ''], [here])
  const initial = useCall<ClockStatus>('status')
  const [st, setSt] = useState<ClockStatus | undefined>()
  useEffect(() => {
    if (initial.data) setSt(initial.data)
  }, [initial.data])
  useMessages((d) => setSt(d as ClockStatus))
  const [problem, setProblem] = useState<string | null>(null)

  const run = (p: Promise<unknown>): void => {
    p.then(
      () => devlog.close(),
      (err: Error) => setProblem(err.message)
    )
  }
  const items: MenuEntry[] = [
    ...(st?.active ? [{ key: 'stop', label: '■ Stop the clock', hint: st.label ?? '', onSelect: () => run(devlog.call('stop')) }] : []),
    ...(tasks ?? [])
      .filter((t) => t.id !== st?.active)
      .map((t) => ({ key: t.id, label: `◉ ${t.title}`, hint: t.path, onSelect: () => run(devlog.call('start', t.id)) }))
  ]
  return (
    <div className="dl-page tt-picker">
      <Menu
        search
        placeholder="Find a task, or name a new one…"
        items={items}
        filterText={(it) => `${typeof it.label === 'string' ? it.label : ''} ${typeof it.hint === 'string' ? it.hint : ''}`}
        empty={tasks ? 'No tasks yet. Type a name to make one.' : 'Loading…'}
        extra={(q) => (q ? [{ key: 'new', label: `+ New task “${q}”`, hint: here ? 'inside the canvas on screen' : 'at the top level', onSelect: () => run(devlog.call('newTask', q, here ?? null)) }] : [])}
      />
      {(problem || error) && <p className="dl-error">{problem ?? error}</p>}
    </div>
  )
}

mount(<Picker />)
