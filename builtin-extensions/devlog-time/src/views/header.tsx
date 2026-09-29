/** On a task canvas: Start it, switch to it, or stop it. */
import '@devlog/ui/styles.css'
import './views.css'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, devlog, mount, useCall, useMessages, useNow, useViewContext } from '@devlog/ui'
import { PAUSED, elapsed, type ClockStatus } from './common'

function Header(): React.JSX.Element {
  const canvasId = useViewContext().canvasId
  const initial = useCall<ClockStatus>('status')
  const [st, setSt] = useState<ClockStatus | undefined>()
  useEffect(() => {
    if (initial.data) setSt(initial.data)
  }, [initial.data])
  useMessages((d) => setSt(d as ClockStatus))
  const now = useNow(15_000)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) devlog.resize({ width: Math.ceil(ref.current.scrollWidth) + 2 })
  })
  const running = Boolean(canvasId && st?.active === canvasId)
  return (
    <div className="tt-row tt-header" ref={ref}>
      {running ? (
        <>
          <Button small variant="quiet" onClick={() => void devlog.call('stop')} title="Stop the clock">
            ■ Stop
          </Button>
          <span className="dl-muted">{st?.paused ? `paused (${PAUSED[st.paused] ?? st.paused})` : (elapsed(st, now) ?? '')}</span>
        </>
      ) : (
        <Button small variant="primary" disabled={!canvasId} onClick={() => canvasId && void devlog.call('start', canvasId)} title={st?.active ? `Switch from ${st.label}` : 'Start the clock on this task'}>
          ▶ {st?.active ? 'Switch to this task' : 'Start'}
        </Button>
      )}
    </div>
  )
}

mount(<Header />, { slot: true })
