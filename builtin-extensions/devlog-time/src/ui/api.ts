/**
 * What the time pages ask of the extension (its `views.handle` handler in
 * main.ts), in the shapes the app's own views used to get from the app.
 */
import { devlog } from '@devlog/ui'
import type { Timesheet } from '@devlog/core'
import type { DestinationInfo, DestinationLine, SendResult } from '@devlog/extension-api'
import type { ActivityEvent, CanvasMeta, Entry } from '@shared/types'

export interface DayChunk {
  canvasId: string
  date: string
  blocks: Entry[]
}

export type DestinationRef = Pick<DestinationInfo, 'extension' | 'id'>

export const api = {
  /** Canvases (without the one timesheets are kept in). */
  canvases: (): Promise<CanvasMeta[]> => devlog.call('canvases'),
  /** Day files with blocks written in the range. */
  range: (from: string, to: string): Promise<DayChunk[]> => devlog.call('range', from, to),
  /** What the app recorded: time, locks, idle, sleep, corrections. */
  activity: (from: string, to: string): Promise<ActivityEvent[]> => devlog.call('activity', from, to),
  timesheet: (week: string): Promise<Timesheet | null> => devlog.call('timesheet', week),
  saveTimesheet: (sheet: Timesheet): Promise<Timesheet> => devlog.call('saveTimesheet', sheet),
  destinations: (): Promise<DestinationInfo[]> => devlog.call('destinations'),
  /** What sending the saved week would do. */
  previewSend: (to: DestinationRef, week: string): Promise<DestinationLine[]> => devlog.call('previewSend', to, week),
  /** Send the saved (final) week, and keep a record under it. */
  send: (to: DestinationRef, week: string): Promise<SendResult> => devlog.call('send', to, week),
  pref: (key: string): Promise<string | null> => devlog.call('pref', key),
  setPref: (key: string, value: string): Promise<void> => devlog.call('setPref', key, value)
}
