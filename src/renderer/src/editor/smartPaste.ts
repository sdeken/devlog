/**
 * Pasted evidence (stack traces, logs, diffs, shell output, JSON) should
 * land in a code block, not be reflowed into paragraphs.
 */
const CODE_SIGNS: Array<[RegExp, string]> = [
  [/^\s+at .+\(.+:\d+(?::\d+)?\)\s*$/m, ''], // JS / Java / .NET stack frames
  [/^\s+at [\w.<>$`]+ in .+:line \d+/m, ''], // .NET
  [/^Traceback \(most recent call last\)/m, 'python'],
  [/^\s+File ".+", line \d+/m, 'python'],
  [/^(Unhandled exception|Exception in thread|System\.\w+Exception|[\w.]+Exception: )/m, ''],
  [/^diff --git |^@@ -\d+,\d+ \+\d+,\d+ @@|^(\+\+\+|---) [ab]\//m, 'diff'],
  [/^\$ |^PS [A-Z]:\\|^>\s?\w+/m, 'sh'],
  [/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}.*\b(INFO|WARN|ERROR|DEBUG|TRACE|FATAL)\b/m, ''],
  [/^\s*[{[][\s\S]*[}\]]\s*$/, 'json']
]

export interface SmartPaste {
  language: string
}

/**
 * Decide whether pasted plain text should become a code block. Requires a
 * few lines and either a recognisable shape or heavy indentation.
 */
export function detectCodePaste(text: string): SmartPaste | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length < 3) return null
  for (const [re, language] of CODE_SIGNS) {
    if (re.test(text)) {
      if (language === 'json') {
        try {
          JSON.parse(text)
        } catch {
          continue
        }
      }
      return { language }
    }
  }
  const nonEmpty = lines.filter((l) => l.trim())
  const indented = nonEmpty.filter((l) => /^(\s{2,}|\t)/.test(l)).length
  const symbolic = nonEmpty.filter((l) => /[{};()=<>\[\]]/.test(l)).length
  if (nonEmpty.length >= 4 && indented / nonEmpty.length >= 0.5 && symbolic / nonEmpty.length >= 0.4) return { language: '' }
  return null
}
