/** What the extension and its panel say to each other (types only: shared by both sides). */

/** A finished summary. */
export interface SummaryDone {
  run: number
  text: string
  model: string
  truncated: boolean
  title: string
  period: string
  blocks: number
  minutes: number
  inputTokens: number
  outputTokens: number
}

/**
 * Posted to the panel. A summary can take longer than a view call may
 * wait, so `summarize` answers at once with its run number and the rest
 * arrives as messages: the text so far, then done or an error.
 */
export type PanelMessage =
  | { type: 'delta'; run: number; text: string }
  | { type: 'done'; run: number; result: SummaryDone }
  | { type: 'error'; run: number; message: string }
  | { type: 'select'; canvasId: string }
  | { type: 'settings' }
