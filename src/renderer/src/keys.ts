/** Platform-aware shortcut labels: "⌘⇧R" on macOS, "Ctrl+Shift+R" elsewhere. */
export const isMac = window.devlog.platform === 'darwin'

export function kbd(...parts: Array<'mod' | 'shift' | 'alt' | string>): string {
  const mapped = parts.map((p) => (p === 'mod' ? (isMac ? '⌘' : 'Ctrl') : p === 'shift' ? (isMac ? '⇧' : 'Shift') : p === 'alt' ? (isMac ? '⌥' : 'Alt') : p))
  return isMac ? mapped.join('') : mapped.join('+')
}
