import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ViewContext } from '@devlog/extension-api/view'
import { ExtensionView } from './ExtensionView'

interface Props {
  extKey: string
  viewId: string
  url: string
  title: string
  /** The frame that asked for it. */
  anchor: DOMRect
  width: number
  height: number
  onClose: () => void
  onOpen: (target: { canvasId: string; date?: string; blockId?: string }) => void
  /** The context of the view that opened it. */
  context?: ViewContext
}

/**
 * An extension's popover view, anchored to the view that asked for it
 * (above it when there is no room below, as for status bar items). Closes
 * on Escape, a click outside, or when the page asks.
 */
export function ExtensionPopover({ extKey, viewId, url, title, anchor, width, height, onClose, onOpen, context }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width, height })
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 })

  useLayoutEffect(() => {
    const below = anchor.bottom + 4 + size.height <= window.innerHeight - 4
    const top = below ? anchor.bottom + 4 : Math.max(4, anchor.top - 4 - size.height)
    const left = Math.max(4, Math.min(anchor.left, window.innerWidth - size.width - 4))
    setPos({ left, top })
  }, [anchor, size])

  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      if (ref.current && !ref.current.contains(ev.target as Node)) onClose()
    }
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    // Clicks inside the frame never reach this window; clicks elsewhere do.
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div className="ext-popover" ref={ref} style={{ ...pos, width: size.width, height: size.height }} role="dialog" aria-label={title} data-ext-view={`${extKey}/${viewId}`}>
      <ExtensionView
        extKey={extKey}
        viewId={viewId}
        url={url}
        title={title}
        onResize={(s) =>
          setSize((cur) => ({ width: s.width ? Math.min(Math.max(s.width, 160), 560) : cur.width, height: s.height ? Math.min(Math.max(s.height, 60), 640) : cur.height }))
        }
        onClose={onClose}
        onOpen={onOpen}
        context={context}
      />
    </div>
  )
}
