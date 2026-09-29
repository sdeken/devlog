import { describe, expect, it } from 'vitest'
import { draftTimesheet, newEntryId } from '../src/shared/timesheet'
import type { ReviewNote } from '../src/shared/review'
import type { ActivityEvent } from '../src/shared/types'

const at = (day: number, h: number, m = 0): string => new Date(2026, 8, day, h, m).toISOString()
const ev = (t: string, type: ActivityEvent['type'], canvasId?: string): ActivityEvent => ({ t, type, ...(canvasId ? { canvasId } : {}) })
const hm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

describe('the draft timesheet', () => {
  it('turns tracked time into rounded entries and estimates untracked days', () => {
    const events: ActivityEvent[] = [
      ev(at(22, 9, 2), 'start', 'acme'),
      ev(at(22, 10, 7), 'task', 'globex'), // acme 09:02–10:07 (65 min → 60)
      ev(at(22, 10, 11), 'task', 'acme'), // globex 4 min → 15
      ev(at(22, 10, 20), 'lock'), // acme 9 min, joins the 09:02 session (gap 4 min)
      ev(at(22, 10, 21), 'stop')
    ]
    for (let m = 5; m <= 80; m += 5) events.push(ev(at(22, 9, m), 'heartbeat')) // the app is alive throughout
    const notes: ReviewNote[] = [{ canvasId: 'acme', date: '2026-09-24', entry: { id: 'n1', createdAt: at(24, 14, 10), markdown: 'untracked day' } }]
    const sheet = draftTimesheet('2026-09-21', notes, events, { now: at(26, 12) })
    expect(sheet).toMatchObject({ week: '2026-09-21', status: 'draft' })
    expect(sheet.entries.map((e) => [e.id, e.date, e.canvasId, hm(e.start), e.minutes, e.source])).toEqual([
      ['e1', '2026-09-22', 'acme', '09:00', 60, 'tracked'],
      ['e2', '2026-09-22', 'globex', '10:00', 15, 'tracked'],
      ['e3', '2026-09-22', 'acme', '10:15', 15, 'tracked'],
      ['e4', '2026-09-24', 'acme', '14:15', 15, 'estimated']
    ])
    expect(newEntryId(sheet.entries)).toBe('m5')
  })
})
