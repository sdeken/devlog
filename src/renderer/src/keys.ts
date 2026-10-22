/** Platform-aware shortcut labels: "⌘⇧R" on macOS, "Ctrl+Shift+R" elsewhere. */
export const isMac = window.devlog.platform === 'darwin'

export function kbd(...parts: Array<'mod' | 'shift' | 'alt' | string>): string {
  const mapped = parts.map((p) => (p === 'mod' ? (isMac ? '⌘' : 'Ctrl') : p === 'shift' ? (isMac ? '⇧' : 'Shift') : p === 'alt' ? (isMac ? '⌥' : 'Alt') : p))
  return isMac ? mapped.join('') : mapped.join('+')
}

const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space'
}

/**
 * Whether a key press is an extension keybinding (`Mod+Shift+S`, as the
 * manifest normalizes it). Letters, digits and punctuation go by the key's
 * place on the keyboard, so Shift does not change them.
 */
export function matchesKeybinding(ev: KeyboardEvent | React.KeyboardEvent, binding: string): boolean {
  const parts = binding.split('+')
  const key = binding.endsWith('++') ? '+' : parts[parts.length - 1]
  const mods = new Set(parts.slice(0, binding.endsWith('++') ? -2 : -1))
  const mod = isMac ? ev.metaKey : ev.ctrlKey
  const ctrl = isMac ? ev.ctrlKey : false
  if (mod !== mods.has('Mod') || ctrl !== mods.has('Ctrl') || ev.altKey !== mods.has('Alt') || ev.shiftKey !== mods.has('Shift')) return false
  if (!isMac && ev.metaKey) return false
  const code = ev.code
  if (/^Key[A-Z]$/.test(code)) return key === code.slice(3)
  if (/^Digit\d$/.test(code)) return key === code.slice(5)
  if (/^F\d+$/.test(code)) return key === code
  if (CODE_KEYS[code]) return key === CODE_KEYS[code]
  return key === ev.key || (key === '+' && ev.key === '+')
}

/** A keybinding as the platform writes it: "⌘⇧S" or "Ctrl+Shift+S". */
export function keybindingLabel(binding: string): string {
  const parts = binding.endsWith('++') ? [...binding.slice(0, -2).split('+').filter(Boolean), '+'] : binding.split('+')
  return kbd(...parts.map((p) => (p === 'Mod' ? 'mod' : p === 'Shift' ? 'shift' : p === 'Alt' ? 'alt' : p === 'Ctrl' ? (isMac ? '⌃' : 'Ctrl') : p)))
}

/** What opens a block (or edits a surface), for tooltips: "double-click, middle-click or Ctrl+click". */
export const OPEN_CLICK = `double-click, middle-click or ${isMac ? '⌘-click' : 'Ctrl+click'}`

/** Elements that keep their own clicks: links, images, form controls. */
const OWN_CLICKS = 'a, img, button, select, input, textarea, label, summary'

/** How far (px) the pointer may move during a double-click that opens; further is a drag that selects. */
export const DOUBLE_CLICK_SLOP = 4

// Where the second press of a double-click went down (one pointer, so one at a time).
let pressedAt: { x: number; y: number } | null = null

/**
 * Open-click handlers for a block or surface: a double-click, a middle
 * click, or a left click with Ctrl (⌘ on a Mac).
 *
 * A double-click opens only when the second press is released where it went
 * down: double-click and drag still selects text word by word. The word the
 * second press selected is let go, so nothing stays highlighted. The middle
 * button is swallowed too, so it neither starts autoscroll (Windows, on the
 * press) nor pastes the selection into the composer (Linux, on the release).
 */
export function openClickHandlers(open: (() => void) | null | undefined): Pick<React.HTMLAttributes<HTMLElement>, 'onMouseDown' | 'onMouseUp' | 'onAuxClick' | 'onClick' | 'onDoubleClick'> {
  if (!open) return {}
  const ownClick = (ev: React.MouseEvent): boolean => Boolean((ev.target as HTMLElement).closest(OWN_CLICKS))
  return {
    onMouseDown: (ev) => {
      if (ev.button === 1 && !ownClick(ev)) ev.preventDefault()
      if (ev.button === 0) pressedAt = ev.detail === 2 ? { x: ev.clientX, y: ev.clientY } : null
    },
    onMouseUp: (ev) => {
      if (ev.button === 1 && !ownClick(ev)) ev.preventDefault()
    },
    onAuxClick: (ev) => {
      if (ev.button !== 1 || ownClick(ev)) return
      ev.preventDefault()
      open()
    },
    onClick: (ev) => {
      if (ev.button !== 0 || !(isMac ? ev.metaKey : ev.ctrlKey) || ownClick(ev)) return
      ev.preventDefault()
      open()
    },
    onDoubleClick: (ev) => {
      const at = pressedAt
      pressedAt = null
      if (ev.button !== 0 || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey || ownClick(ev)) return
      if (!at || Math.hypot(ev.clientX - at.x, ev.clientY - at.y) > DOUBLE_CLICK_SLOP) return
      ev.preventDefault()
      window.getSelection()?.removeAllRanges()
      open()
    }
  }
}
