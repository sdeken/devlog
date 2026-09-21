import { useEffect } from 'react'

interface Props {
  src: string
  alt?: string
  onClose: () => void
}

/** Full-size view of an image from a note; click or Escape closes it. */
export function Lightbox({ src, alt, onClose }: Props): React.JSX.Element {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={alt || 'Image'}>
      <img src={src} alt={alt ?? ''} />
    </div>
  )
}
