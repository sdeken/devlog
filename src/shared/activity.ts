/**
 * Pure logic over the activity log: turns a stream of events into task
 * segments (what was active when), focus segments (which app was in front),
 * and per-day roll-ups. No I/O.
 */
import { localDate } from '@devlog/core'
import type { ActivityEvent, Entry } from './types'

export const HEARTBEAT_MS = 5 * 60_000

export interface TaskSegment {
  canvasId: string
  start: string
  end: string
  /** `tracked` from live events; `explicit` from a duration marker in a note. */
  source: 'tracked' | 'explicit'
  entryId?: string
}

export type AppKind = 'meeting' | 'coding' | 'terminal' | 'browser' | 'comms' | 'devlog' | 'other'

export interface FocusSegment {
  app: string
  title: string
  kind: AppKind
  start: string
  end: string
}

export interface ExplicitDuration {
  canvasId: string
  /** ISO time the note was written; the duration ends here. */
  end: string
  minutes: number
  entryId: string
}

const ms = (iso: string): number => new Date(iso).getTime()
const iso = (t: number): string => new Date(t).toISOString()

// ---------------------------------------------------------------------------
// App classification
// ---------------------------------------------------------------------------

const KIND_RULES: Array<{ kind: AppKind; app?: RegExp; title?: RegExp }> = [
  { kind: 'devlog', app: /^(devlog|electron)$/i, title: /devlog/i },
  { kind: 'meeting', app: /^(ms-?teams|teams|zoom|webex|webexmta|skype|discord|facetime|slack)$/i },
  { kind: 'meeting', title: /\b(meet\.google\.com|google meet|zoom meeting|microsoft teams meeting|webex meeting)\b/i },
  { kind: 'coding', app: /^(code|code - insiders|cursor|devenv|rider64?|idea64?|webstorm64?|pycharm64?|clion64?|goland64?|xcode|sublime_text|notepad\+\+|vim|nvim|emacs|zed|android studio|studio64|windsurf)$/i },
  { kind: 'terminal', app: /^(windowsterminal|wt|powershell|pwsh|cmd|conhost|iterm2?|terminal|alacritty|kitty|wezterm-gui|hyper|ghostty|mintty)$/i },
  { kind: 'browser', app: /^(chrome|msedge|firefox|safari|brave|opera|arc|vivaldi|chromium)$/i },
  { kind: 'comms', app: /^(outlook|olk|mail|thunderbird|slack|discord|whatsapp|signal|telegram|messages)$/i }
]

/** Classify a foreground app (process name, without ".exe") and window title. */
export function classifyApp(app: string, title: string): AppKind {
  const name = app.replace(/\.exe$/i, '').trim()
  for (const rule of KIND_RULES) {
    if (rule.app && rule.title) {
      if (rule.app.test(name) && rule.title.test(title)) return rule.kind
    } else if (rule.app && rule.app.test(name)) return rule.kind
    else if (rule.title && rule.title.test(title)) return rule.kind
  }
  return 'other'
}

export const APP_KIND_LABEL: Record<AppKind, string> = {
  meeting: 'Meetings',
  coding: 'Coding',
  terminal: 'Terminal',
  browser: 'Browser',
  comms: 'Email & chat',
  devlog: 'Devlog',
  other: 'Other'
}

// ---------------------------------------------------------------------------
// Task segments
// ---------------------------------------------------------------------------

export interface SegmentOptions {
  /** Treat the app as dead if no event arrives within this window. */
  heartbeatMs?: number
  /** Upper bound for open segments (ISO); defaults to now. */
  now?: string
}

/**
 * Replay the event stream into task segments. A task is active between a
 * `task`/`start` event naming a page and the next `task`, `stop`, pause
 * (`lock`/`idle`/`suspend`) or app death (gap longer than the heartbeat).
 *
 * Each machine's events are replayed on their own (locking the laptop does
 * not pause the desktop), then merged: where two machines both tracked time,
 * the one whose segment started later (the task picked or the machine woken
 * most recently) wins, so the same hour is never counted twice.
 */
export function buildTaskSegments(events: ActivityEvent[], opts: SegmentOptions = {}): TaskSegment[] {
  return flattenOverlaps(byMachine(events).flatMap((evs) => replayTasks(evs, opts)))
}

function replayTasks(events: ActivityEvent[], opts: SegmentOptions): TaskSegment[] {
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS
  const nowMs = opts.now ? ms(opts.now) : Date.now()
  const sorted = [...events].sort((a, b) => a.t.localeCompare(b.t))
  const out: TaskSegment[] = []
  let active: string | null = null
  // Each reason pauses independently: waking from sleep while the screen is
  // still locked must not restart the clock, and neither must input after
  // idle while locked. Only when every reason has cleared does time accrue.
  const pauses = new Set<'locked' | 'idle' | 'suspended'>()
  let openAt: number | null = null
  let lastSeen: number | null = null

  const close = (at: number): void => {
    if (active && openAt !== null && at > openAt) out.push({ canvasId: active, start: iso(openAt), end: iso(at), source: 'tracked' })
    openAt = null
  }
  const open = (at: number): void => {
    if (active && pauses.size === 0 && openAt === null) openAt = at
  }

  for (const ev of sorted) {
    const t = ms(ev.t)
    if (Number.isNaN(t)) continue
    // App death: nothing heard for longer than the heartbeat window.
    if (lastSeen !== null && t - lastSeen > heartbeat * 2 && openAt !== null) {
      close(lastSeen + heartbeat)
    }
    lastSeen = t
    switch (ev.type) {
      case 'start':
        // Fresh process: whatever was open is stale; restore the persisted task.
        openAt = null
        active = ev.canvasId ?? null
        pauses.clear()
        open(t)
        break
      case 'task':
        close(t)
        active = ev.canvasId ?? null
        open(t)
        break
      case 'stop':
        close(t)
        active = null
        break
      case 'lock':
        close(t)
        pauses.add('locked')
        break
      case 'idle':
        close(t)
        pauses.add('idle')
        break
      case 'suspend':
        close(t)
        pauses.add('suspended')
        break
      case 'unlock':
        // The user is demonstrably back: nothing else can still be pausing.
        pauses.clear()
        open(t)
        break
      case 'active':
        pauses.delete('idle')
        open(t)
        break
      case 'resume':
        pauses.delete('suspended')
        open(t)
        break
      default:
        // heartbeat / focus / git / exclude keep the process alive; nothing else to do.
        break
    }
  }
  if (openAt !== null && lastSeen !== null) {
    const end = Math.min(nowMs, lastSeen + heartbeat * 2)
    close(end)
  }
  return out
}

/** Events grouped by the machine that logged them (untagged events form one group). */
function byMachine(events: ActivityEvent[]): ActivityEvent[][] {
  const groups = new Map<string, ActivityEvent[]>()
  for (const ev of events) {
    const key = ev.machine ?? ''
    let g = groups.get(key)
    if (!g) groups.set(key, (g = []))
    g.push(ev)
  }
  return [...groups.values()]
}

/**
 * Make segments non-overlapping: a segment that starts later overrides the
 * part of any earlier one it covers; what is left of the earlier one on
 * either side remains. Sorted by start.
 */
export function flattenOverlaps<T extends { start: string; end: string }>(segments: T[]): T[] {
  const sorted = [...segments].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
  let out: T[] = []
  for (const seg of sorted) {
    const s = ms(seg.start)
    const e = ms(seg.end)
    const next: T[] = []
    for (const r of out) {
      const rs = ms(r.start)
      const re = ms(r.end)
      if (re <= s || rs >= e) {
        next.push(r)
        continue
      }
      if (rs < s) next.push({ ...r, end: seg.start })
      if (re > e) next.push({ ...r, start: seg.end })
    }
    next.push(seg)
    out = next
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

export interface ExclusionWindow {
  id: string
  start: string
  end: string
}

/** The user's time corrections still in force: exclude events not undone by a later one. */
export function activeExclusions(events: ActivityEvent[]): ExclusionWindow[] {
  const cancelled = new Set(events.filter((e) => e.type === 'exclude' && e.cancels).map((e) => e.cancels!))
  const out: ExclusionWindow[] = []
  for (const e of events) {
    if (e.type !== 'exclude' || e.cancels || !e.id || !e.start || !e.end || cancelled.has(e.id)) continue
    if (Number.isNaN(ms(e.start)) || Number.isNaN(ms(e.end)) || ms(e.end) <= ms(e.start)) continue
    out.push({ id: e.id, start: e.start, end: e.end })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/** Cut every exclusion window out of the tracked segments (explicit ones are the user's own word and stay). */
export function applyExclusions(segments: TaskSegment[], windows: ExclusionWindow[]): TaskSegment[] {
  if (windows.length === 0) return segments
  let cur = segments
  for (const w of windows) {
    const ws = ms(w.start)
    const we = ms(w.end)
    const next: TaskSegment[] = []
    for (const seg of cur) {
      const s = ms(seg.start)
      const e = ms(seg.end)
      if (seg.source !== 'tracked' || e <= ws || s >= we) {
        next.push(seg)
        continue
      }
      if (s < ws) next.push({ ...seg, end: iso(ws) })
      if (e > we) next.push({ ...seg, start: iso(we) })
    }
    cur = next
  }
  return cur
}

/** Task segments as the views should see them: replayed, then with the user's corrections applied. */
export function buildTrackedSegments(events: ActivityEvent[], opts: SegmentOptions = {}): TaskSegment[] {
  return applyExclusions(buildTaskSegments(events, opts), activeExclusions(events))
}

/**
 * Explicit durations win: for each marker, cut every tracked segment that
 * overlaps its window and add a segment of exactly that length ending at the
 * note. "[2h] Acme sync" means the last two hours were Acme, whatever the
 * machine thought.
 */
export function applyExplicitDurations(segments: TaskSegment[], explicit: ExplicitDuration[]): TaskSegment[] {
  let result = [...segments]
  for (const ex of [...explicit].sort((a, b) => a.end.localeCompare(b.end))) {
    const end = ms(ex.end)
    const start = end - ex.minutes * 60_000
    const next: TaskSegment[] = []
    for (const seg of result) {
      const s = ms(seg.start)
      const e = ms(seg.end)
      if (e <= start || s >= end) {
        next.push(seg)
        continue
      }
      if (s < start) next.push({ ...seg, end: iso(start) })
      if (e > end) next.push({ ...seg, start: iso(end) })
    }
    next.push({ canvasId: ex.canvasId, start: iso(start), end: iso(end), source: 'explicit', entryId: ex.entryId })
    result = next
  }
  return result.sort((a, b) => a.start.localeCompare(b.start))
}

// ---------------------------------------------------------------------------
// Focus segments
// ---------------------------------------------------------------------------

/**
 * Foreground-window runs: each focus event lasts until the next focus event,
 * pause, stop or app death. Replayed per machine and merged like task segments.
 */
export function buildFocusSegments(events: ActivityEvent[], opts: SegmentOptions = {}): FocusSegment[] {
  return flattenOverlaps(byMachine(events).flatMap((evs) => replayFocus(evs, opts)))
}

function replayFocus(events: ActivityEvent[], opts: SegmentOptions): FocusSegment[] {
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS
  const nowMs = opts.now ? ms(opts.now) : Date.now()
  const sorted = [...events].sort((a, b) => a.t.localeCompare(b.t))
  const out: FocusSegment[] = []
  let cur: { app: string; title: string; start: number } | null = null
  let lastSeen: number | null = null
  const close = (at: number): void => {
    if (cur && at > cur.start) out.push({ app: cur.app, title: cur.title, kind: classifyApp(cur.app, cur.title), start: iso(cur.start), end: iso(at) })
    cur = null
  }
  for (const ev of sorted) {
    const t = ms(ev.t)
    if (Number.isNaN(t)) continue
    if (lastSeen !== null && t - lastSeen > heartbeat * 2) close(lastSeen + heartbeat)
    lastSeen = t
    switch (ev.type) {
      case 'focus':
        close(t)
        cur = { app: ev.app ?? '', title: ev.title ?? '', start: t }
        break
      case 'lock':
      case 'idle':
      case 'suspend':
      case 'stop':
        close(t)
        break
      case 'start':
        cur = null
        break
      default:
        break
    }
  }
  if (cur && lastSeen !== null) close(Math.min(nowMs, lastSeen + heartbeat * 2))
  return out
}

// ---------------------------------------------------------------------------
// Focus cleanup: the raw log keeps every flip; views do not have to show it.
// ---------------------------------------------------------------------------

/** Windows that are chrome around real windows, not work: task switcher, start menu, search, lock screen. */
const IGNORED_FOCUS: Array<{ app: RegExp; title?: RegExp }> = [
  { app: /^explorer$/i, title: /^(task switching|task view|program manager|)$/i },
  { app: /^(searchhost|searchapp|searchui|startmenuexperiencehost|shellexperiencehost|lockapp|textinputhost|screenclippinghost|snippingtool|applicationframehost)$/i, title: /^(|search|start|windows input experience|snipping tool)$/i },
  { app: /^(dwm|winlogon|logonui)$/i },
  { app: /^(dock|loginwindow|screensaverengine|notificationcenter|spotlight)$/i },
  { app: /^$/ , title: /^$/ }
]

export function isIgnoredFocus(app: string, title: string): boolean {
  const name = app.replace(/\.exe$/i, '').trim()
  return IGNORED_FOCUS.some((r) => r.app.test(name) && (!r.title || r.title.test(title.trim())))
}

export interface CleanOptions {
  /** Segments shorter than this are folded into a neighbour. */
  minSeconds: number
}

/**
 * Tidy focus segments for display: drop the task switcher and friends, fold
 * sub-threshold flips into the window before them (or after, at the start),
 * then merge adjacent segments of the same window. The raw log is untouched.
 */
export function cleanFocusSegments(segments: FocusSegment[], opts: CleanOptions): FocusSegment[] {
  const minMs = Math.max(0, opts.minSeconds) * 1000
  const sorted = [...segments].sort((a, b) => a.start.localeCompare(b.start))
  // 1. Drop chrome windows; their time goes to whoever is next to them.
  const kept: FocusSegment[] = []
  for (const seg of sorted) {
    if (isIgnoredFocus(seg.app, seg.title)) {
      const prev = kept[kept.length - 1]
      if (prev && prev.end === seg.start) prev.end = seg.end
      continue
    }
    kept.push({ ...seg })
  }
  // 2. Fold brief flips into the previous segment (or the next one when first).
  const folded: FocusSegment[] = []
  for (let i = 0; i < kept.length; i++) {
    const seg = kept[i]
    const dur = ms(seg.end) - ms(seg.start)
    if (dur < minMs) {
      const prev = folded[folded.length - 1]
      if (prev && prev.end === seg.start) {
        prev.end = seg.end
        continue
      }
      const next = kept[i + 1]
      if (next && next.start === seg.end) {
        next.start = seg.start
        continue
      }
    }
    folded.push(seg)
  }
  // 3. Merge adjacent identical windows.
  const merged: FocusSegment[] = []
  for (const seg of folded) {
    const prev = merged[merged.length - 1]
    if (prev && prev.app === seg.app && prev.title === seg.title && prev.end === seg.start) prev.end = seg.end
    else merged.push({ ...seg })
  }
  return merged
}

// ---------------------------------------------------------------------------
// Roll-ups
// ---------------------------------------------------------------------------

export interface DatedSegment<T> {
  date: string
  minutes: number
  segment: T
}

/** Split segments at local midnight and tag each piece with its date. */
export function splitByLocalDay<T extends { start: string; end: string }>(segments: T[]): DatedSegment<T>[] {
  const out: DatedSegment<T>[] = []
  for (const seg of segments) {
    let s = ms(seg.start)
    const e = ms(seg.end)
    while (s < e) {
      const d = new Date(s)
      const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const pieceEnd = Math.min(e, midnight)
      out.push({ date: localDate(d), minutes: (pieceEnd - s) / 60_000, segment: { ...seg, start: iso(s), end: iso(pieceEnd) } })
      s = pieceEnd
    }
  }
  return out
}

/** Minutes per page per date. */
export function taskMinutesByDay(segments: TaskSegment[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const piece of splitByLocalDay(segments)) {
    if (!out.has(piece.date)) out.set(piece.date, new Map())
    const m = out.get(piece.date)!
    m.set(piece.segment.canvasId, (m.get(piece.segment.canvasId) ?? 0) + piece.minutes)
  }
  return out
}

export interface AppSummary {
  app: string
  kind: AppKind
  minutes: number
  /** Most-seen titles with their minutes, descending. */
  titles: Array<{ title: string; minutes: number }>
}

/** Per date: minutes by app (with titles) and by kind. */
export function focusSummaryByDay(segments: FocusSegment[]): Map<string, { apps: AppSummary[]; kinds: Map<AppKind, number>; total: number }> {
  const byDate = new Map<string, Map<string, { kind: AppKind; minutes: number; titles: Map<string, number> }>>()
  for (const piece of splitByLocalDay(segments)) {
    if (!byDate.has(piece.date)) byDate.set(piece.date, new Map())
    const apps = byDate.get(piece.date)!
    const key = piece.segment.app.replace(/\.exe$/i, '') || '(unknown)'
    if (!apps.has(key)) apps.set(key, { kind: piece.segment.kind, minutes: 0, titles: new Map() })
    const a = apps.get(key)!
    a.minutes += piece.minutes
    a.titles.set(piece.segment.title, (a.titles.get(piece.segment.title) ?? 0) + piece.minutes)
  }
  const out = new Map<string, { apps: AppSummary[]; kinds: Map<AppKind, number>; total: number }>()
  for (const [date, apps] of byDate) {
    const kinds = new Map<AppKind, number>()
    let total = 0
    const list: AppSummary[] = []
    for (const [app, a] of apps) {
      kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + a.minutes)
      total += a.minutes
      list.push({
        app,
        kind: a.kind,
        minutes: a.minutes,
        titles: [...a.titles.entries()].map(([title, minutes]) => ({ title, minutes })).sort((x, y) => y.minutes - x.minutes)
      })
    }
    out.set(date, { apps: list.sort((x, y) => y.minutes - x.minutes), kinds, total })
  }
  return out
}

// ---------------------------------------------------------------------------
// Interval buckets for the day timeline
// ---------------------------------------------------------------------------

export interface TimelineNote {
  canvasId: string
  entry: Entry
}

export interface TimelineBucket {
  start: string
  end: string
  /** Active tasks overlapping the bucket, in order of first appearance. */
  tasks: Array<{ canvasId: string; minutes: number; source: TaskSegment['source'] }>
  /** Foreground apps overlapping the bucket, most-used first, with titles. */
  apps: AppSummary[]
  screenMinutes: number
  notes: TimelineNote[]
  /** Lock/unlock, idle/active, sleep/wake, start/stop inside the bucket. */
  system: ActivityEvent[]
  /** Branch, checkout, push, merge… in watched repositories. */
  git: ActivityEvent[]
}

export interface BucketOptions {
  date: string
  intervalMinutes: number
  taskSegments: TaskSegment[]
  focusSegments: FocusSegment[]
  notes: TimelineNote[]
  events: ActivityEvent[]
  /** Buckets after this instant are not produced (defaults to now). */
  now?: string
}

const SYSTEM_TYPES = new Set<ActivityEvent['type']>(['start', 'stop', 'lock', 'unlock', 'idle', 'active', 'suspend', 'resume'])

/**
 * Slice a local day into fixed intervals and summarise what happened in
 * each: which task was active, which apps were in front (with minutes and
 * titles), the notes written, and system events. Empty intervals are
 * dropped, so the caller can render a gap between non-adjacent buckets.
 */
export function bucketizeDay(opts: BucketOptions): TimelineBucket[] {
  const [y, m, d] = opts.date.split('-').map(Number)
  const dayStart = new Date(y, m - 1, d).getTime()
  const dayEnd = new Date(y, m - 1, d + 1).getTime()
  const nowMs = opts.now ? ms(opts.now) : Date.now()
  const step = Math.max(1, opts.intervalMinutes) * 60_000
  const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  const out: TimelineBucket[] = []
  for (let b0 = dayStart; b0 < dayEnd && b0 < nowMs; b0 += step) {
    const b1 = Math.min(b0 + step, dayEnd)
    const tasks = new Map<string, { canvasId: string; minutes: number; source: TaskSegment['source'] }>()
    for (const seg of opts.taskSegments) {
      const o = overlap(ms(seg.start), ms(seg.end), b0, b1)
      if (o <= 0) continue
      const cur = tasks.get(seg.canvasId)
      if (cur) cur.minutes += o / 60_000
      else tasks.set(seg.canvasId, { canvasId: seg.canvasId, minutes: o / 60_000, source: seg.source })
    }
    const apps = new Map<string, { kind: AppKind; minutes: number; titles: Map<string, number> }>()
    let screenMinutes = 0
    for (const seg of opts.focusSegments) {
      const o = overlap(ms(seg.start), ms(seg.end), b0, b1)
      if (o <= 0) continue
      const key = seg.app.replace(/\.exe$/i, '') || '(unknown)'
      if (!apps.has(key)) apps.set(key, { kind: seg.kind, minutes: 0, titles: new Map() })
      const a = apps.get(key)!
      a.minutes += o / 60_000
      a.titles.set(seg.title, (a.titles.get(seg.title) ?? 0) + o / 60_000)
      screenMinutes += o / 60_000
    }
    const notes = opts.notes.filter((n) => {
      const t = ms(n.entry.createdAt)
      return t >= b0 && t < b1
    })
    const system = opts.events.filter((e) => {
      if (!SYSTEM_TYPES.has(e.type)) return false
      const t = ms(e.t)
      return t >= b0 && t < b1
    })
    const git = opts.events.filter((e) => {
      if (e.type !== 'git') return false
      const t = ms(e.t)
      return t >= b0 && t < b1
    })
    if (tasks.size === 0 && apps.size === 0 && notes.length === 0 && system.length === 0 && git.length === 0) continue
    out.push({
      start: iso(b0),
      end: iso(b1),
      tasks: [...tasks.values()],
      apps: [...apps.entries()]
        .map(([app, a]) => ({
          app,
          kind: a.kind,
          minutes: a.minutes,
          titles: [...a.titles.entries()].map(([title, minutes]) => ({ title, minutes })).sort((x, y2) => y2.minutes - x.minutes)
        }))
        .sort((x, y2) => y2.minutes - x.minutes),
      screenMinutes,
      notes: notes.sort((a, b) => a.entry.createdAt.localeCompare(b.entry.createdAt)),
      system: system.sort((a, b) => a.t.localeCompare(b.t)),
      git: git.sort((a, b) => a.t.localeCompare(b.t))
    })
  }
  return out
}
