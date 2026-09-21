/**
 * Pure logic over the activity log: turns a stream of events into task
 * segments (what was active when), focus segments (which app was in front),
 * and per-day roll-ups. No I/O.
 */
import { localDate } from './entries'
import type { ActivityEvent, Entry } from './types'

export const HEARTBEAT_MS = 5 * 60_000

export interface TaskSegment {
  pageId: string
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
  pageId: string
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
 */
export function buildTaskSegments(events: ActivityEvent[], opts: SegmentOptions = {}): TaskSegment[] {
  const heartbeat = opts.heartbeatMs ?? HEARTBEAT_MS
  const nowMs = opts.now ? ms(opts.now) : Date.now()
  const sorted = [...events].sort((a, b) => a.t.localeCompare(b.t))
  const out: TaskSegment[] = []
  let active: string | null = null
  let paused = false
  let openAt: number | null = null
  let lastSeen: number | null = null

  const close = (at: number): void => {
    if (active && openAt !== null && at > openAt) out.push({ pageId: active, start: iso(openAt), end: iso(at), source: 'tracked' })
    openAt = null
  }
  const open = (at: number): void => {
    if (active && !paused && openAt === null) openAt = at
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
        active = ev.pageId ?? null
        paused = false
        open(t)
        break
      case 'task':
        close(t)
        active = ev.pageId ?? null
        open(t)
        break
      case 'stop':
        close(t)
        active = null
        break
      case 'lock':
      case 'idle':
      case 'suspend':
        close(t)
        paused = true
        break
      case 'unlock':
      case 'active':
      case 'resume':
        paused = false
        open(t)
        break
      default:
        // heartbeat / focus keep the process alive; nothing else to do.
        break
    }
  }
  if (openAt !== null && lastSeen !== null) {
    const end = Math.min(nowMs, lastSeen + heartbeat * 2)
    close(end)
  }
  return out
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
    next.push({ pageId: ex.pageId, start: iso(start), end: iso(end), source: 'explicit', entryId: ex.entryId })
    result = next
  }
  return result.sort((a, b) => a.start.localeCompare(b.start))
}

// ---------------------------------------------------------------------------
// Focus segments
// ---------------------------------------------------------------------------

/** Foreground-window runs: each focus event lasts until the next focus event, pause, stop or app death. */
export function buildFocusSegments(events: ActivityEvent[], opts: SegmentOptions = {}): FocusSegment[] {
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
    m.set(piece.segment.pageId, (m.get(piece.segment.pageId) ?? 0) + piece.minutes)
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
  pageId: string
  entry: Entry
}

export interface TimelineBucket {
  start: string
  end: string
  /** Active tasks overlapping the bucket, in order of first appearance. */
  tasks: Array<{ pageId: string; minutes: number; source: TaskSegment['source'] }>
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
    const tasks = new Map<string, { pageId: string; minutes: number; source: TaskSegment['source'] }>()
    for (const seg of opts.taskSegments) {
      const o = overlap(ms(seg.start), ms(seg.end), b0, b1)
      if (o <= 0) continue
      const cur = tasks.get(seg.pageId)
      if (cur) cur.minutes += o / 60_000
      else tasks.set(seg.pageId, { pageId: seg.pageId, minutes: o / 60_000, source: seg.source })
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
