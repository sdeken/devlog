/** What the extension says about the clock (the `status` call, and its messages); see ../tracker.ts. */
export interface ClockStatus {
  active: string | null
  label: string | null
  since: string | null
  paused: 'locked' | 'idle' | 'suspended' | null
}

export interface TaskInfo {
  id: string
  title: string
  label: string
  path: string
}

/** "1h 23m", "5m". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const rest = m % 60
  if (h === 0) return `${rest}m`
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`
}

export function elapsed(st: ClockStatus | undefined, now: number): string | null {
  return st?.since && !st.paused ? formatMinutes((now - new Date(st.since).getTime()) / 60_000) : null
}

export const PAUSED: Record<string, string> = { locked: 'locked', idle: 'idle', suspended: 'asleep' }
