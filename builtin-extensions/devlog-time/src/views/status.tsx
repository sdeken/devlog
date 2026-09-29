/**
 * The status bar item: the active task and how long it has run, Stop, and
 * Start for the task on screen; ▾ opens the picker.
 */
import '@devlog/ui/styles.css'
import './views.css'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, devlog, mount, useCall, useMessages, useNow, useViewContext } from '@devlog/ui'
import { PAUSED, elapsed, type ClockStatus, type TaskInfo } from './common'

function Status(): React.JSX.Element {
  const initial = useCall<ClockStatus>('status')
  const [st, setSt] = useState<ClockStatus | undefined>()
  useEffect(() => {
    if (initial.data) setSt(initial.data)
  }, [initial.data])
  useMessages((d) => setSt(d as ClockStatus))
  const now = useNow(15_000)
  const here = useViewContext().canvasId
  const { data: task } = useCall<TaskInfo | null>('task', [here ?? ''], [here, st?.active])
  const offer = task && task.id !== st?.active ? task : null

  // Ask for the width the content needs.
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) devlog.resize({ width: Math.ceil(ref.current.scrollWidth) + 2 })
  })

  const picker = (): void => devlog.popover('picker', { width: 340, height: 380 })
  return (
    <div className="tt-row" ref={ref}>
      <span className={`dl-dot${st?.active ? (st.paused ? ' is-warn' : ' is-busy') : ''}`} />
      {st?.active ? (
        <button type="button" className="tt-link" onClick={() => devlog.open({ canvasId: st.active! })} title={`${st.label} (open)`}>
          <span className="tt-label">{st.label?.split(' / ').pop()}</span>
          <span className="dl-muted">{st.paused ? ` · paused (${PAUSED[st.paused] ?? st.paused})` : elapsed(st, now) ? ` · ${elapsed(st, now)}` : ''}</span>
        </button>
      ) : (
        <span className="dl-muted">No active task</span>
      )}
      {st?.active && (
        <Button small variant="quiet" onClick={() => void devlog.call('stop')} title="Stop the clock">
          Stop
        </Button>
      )}
      {offer ? (
        <span className="tt-split">
          <Button small variant={st?.active ? 'default' : 'primary'} onClick={() => void devlog.call('start', offer.id)} title={`${st?.active ? 'Switch to' : 'Start'} ${offer.label}`}>
            ▶ {st?.active ? 'Switch to' : 'Start'} <span className="tt-title">{offer.title}</span>
          </Button>
          <Button small variant={st?.active ? 'default' : 'primary'} onClick={picker} title="Start a different task" aria-label="Start a different task">
            ▾
          </Button>
        </span>
      ) : (
        <Button small variant={st?.active ? 'quiet' : 'primary'} onClick={picker} title={st?.active ? 'Switch to another task' : 'Start a task'}>
          {st?.active ? '▾' : 'Start ▾'}
        </Button>
      )}
    </div>
  )
}

mount(<Status />, { slot: true })
