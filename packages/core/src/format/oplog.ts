/**
 * Block files, format 3: an append-only log of operations.
 *
 *   <!-- devlog:format 3 -->
 *   # 2026-09-19
 *
 *   <!-- devlog:add id=k3j9d2ab pos=a0 at=2026-09-19T14:32:01.000Z -->
 *   Started on the git sync.
 *
 *   <!-- devlog:add id=p0q1r2s3 parent=k3j9d2ab pos=a0 at=2026-09-19T15:02:00.000Z -->
 *   A reply in the thread.
 *
 *   <!-- devlog:edit id=k3j9d2ab at=2026-09-19T15:10:00.000Z -->
 *   Started on the git sync. Pull before push.
 *
 *   <!-- devlog:set id=p0q1r2s3 at=2026-09-19T15:20:00.000Z hidden=1 -->
 *   <!-- devlog:set id=p0q1r2s3 at=2026-09-19T15:21:00.000Z pos=Zz -->
 *   <!-- devlog:delete id=p0q1r2s3 at=2026-09-19T16:00:00.000Z -->
 *
 * The app only ever appends to these files; nothing written is rewritten.
 * The current state is a replay of the log:
 *
 *  - `add` creates a block (body, parent, order key, kind, flags, metadata).
 *  - `edit` replaces its body.
 *  - `set` changes fields: placement (`pos`, with `parent`; no `parent`
 *    means top level), `hidden`, `kind`, or a metadata key (empty removes).
 *  - `delete` removes it for good (the record stays, as a tombstone).
 *
 * Each field is last-writer-wins by `at` (ties: later in the file), so the
 * result does not depend on the order in which two machines' records were
 * merged. Siblings are ordered by their `pos` order key (ties by creation
 * time, then id), so
 * reordering only ever touches the moved block. Replies whose parent is gone
 * become top-level; parent cycles are broken. A torn last record (a crash
 * mid-write) is skipped rather than merged into the block above it.
 *
 * Bodies are markdown; image paths are file-relative on disk and
 * repo-root-relative in memory. Body lines that look like devlog markers are
 * escaped with one extra backslash, so no text can forge a record.
 */
import { ENTRY_KINDS, type Day, type Entry, type EntryKind, type EntryPosition } from '../types'
import {
  ENTRIES_DIR,
  blockFileFormat,
  dayDir,
  escapeMarkerLines,
  parseLegacyBlockFile,
  parseMarkerAttrs,
  quoteAttr,
  toRelativeFrom,
  toRootRelativeFrom,
  trimBlankLines,
  unescapeMarkerLines
} from './blocks'
import { keyBetween, keysBetween } from './order'

export const BLOCK_FORMAT = 3

export type OpKind = 'add' | 'edit' | 'set' | 'delete'

export interface Op {
  op: OpKind
  id: string
  /** ISO timestamp. For `add`, the block's creation time. */
  at: string
  /** Everything else on the marker line (parent, pos, kind, hidden, updated, metadata). */
  attrs: Record<string, string>
  /** `add` / `edit` only; repo-root-relative image paths. */
  body?: string
}

const OP_RE = /^<!--\s*devlog:(add|edit|set|delete)\s+([^>]*?)\s*-->\s*$/
/** Any line starting like a devlog marker that is not escaped: a record, a header, or a torn write. */
const RAW_MARKER_RE = /^\s*<!--\s*devlog:/i
const FIELD_ATTRS = new Set(['id', 'at', 'parent', 'pos', 'kind', 'hidden', 'updated'])
const META_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes)$/i.test(v)

// ---------------------------------------------------------------------------
// Reading and writing records
// ---------------------------------------------------------------------------

/** Parse the records of a format 3 file. Unknown, malformed and torn records are skipped. */
export function parseOps(text: string, dir: string): Op[] {
  const ops: Op[] = []
  let cur: { op: OpKind; attrs: Record<string, string>; lines: string[] } | null = null
  const flush = (): void => {
    if (!cur) return
    const { id, at, ...attrs } = cur.attrs
    if (id) {
      const op: Op = { op: cur.op, id, at: at ?? '', attrs }
      if (cur.op === 'add' || cur.op === 'edit') op.body = toRootRelativeFrom(unescapeMarkerLines(trimBlankLines(cur.lines).join('\n')), dir)
      ops.push(op)
    }
    cur = null
  }
  for (const line of text.split(/\r?\n/)) {
    const m = OP_RE.exec(line)
    if (m) {
      flush()
      cur = { op: m[1] as OpKind, attrs: parseMarkerAttrs(m[2]), lines: [] }
    } else if (RAW_MARKER_RE.test(line)) {
      // The format header, a record from a newer version, or a torn write: it
      // ends the body above it, and what follows it is not a body.
      flush()
    } else if (cur) {
      cur.lines.push(line)
    }
  }
  flush()
  return ops
}

/** Records as text, ready to append to a file in `dir`. Always ends with a newline. */
export function serializeOps(ops: Op[], dir: string): string {
  const out: string[] = []
  for (const op of ops) {
    const attrs = [`id=${op.id}`]
    const put = (k: string): void => {
      if (op.attrs[k] !== undefined) attrs.push(`${k}=${quoteAttr(op.attrs[k])}`)
    }
    put('parent')
    put('pos')
    attrs.push(`at=${op.at}`)
    for (const k of ['updated', 'kind', 'hidden']) put(k)
    for (const [k, v] of Object.entries(op.attrs)) {
      if (!FIELD_ATTRS.has(k) && META_KEY_RE.test(k)) attrs.push(`${k}=${quoteAttr(v)}`)
    }
    out.push(`<!-- devlog:${op.op} ${attrs.join(' ')} -->`)
    if (op.op === 'add' || op.op === 'edit') {
      const body = escapeMarkerLines(toRelativeFrom(op.body ?? '', dir).replace(/\s+$/, ''))
      if (body) out.push(body)
      out.push('')
    }
  }
  return `${out.join('\n')}\n`
}

/** The first lines of a new format 3 file. */
export function blockFileHeader(title: string): string {
  return `<!-- devlog:format ${BLOCK_FORMAT} -->\n${title}\n\n`
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** The replayed state of a block file, plus what is needed to plan new records. */
export interface BlockLog {
  /** Live blocks in display order (threads contiguous, depth-first). */
  entries: Entry[]
  /** Order key of every live block. */
  pos: Map<string, string>
  /** Every id the file has ever used, deleted ones included (never reuse them). */
  ids: Set<string>
  /** The latest `at` in the file. */
  maxAt: string
}

interface Replayed {
  entry: Entry
  parent: string | null
  pos: string
  ts: { body: string; place: string; hidden: string; kind: string; meta: Record<string, string> }
  deleted: boolean
}

export function replayOps(ops: Op[], fallbackCreatedAt = '1970-01-01T00:00:00.000Z'): BlockLog {
  const blocks = new Map<string, Replayed>()
  const ids = new Set<string>()
  let maxAt = ''
  for (const op of ops) {
    ids.add(op.id)
    if (op.at > maxAt) maxAt = op.at
  }

  // Creations first, so a record merged in above its block's `add` still applies.
  for (const op of ops) {
    if (op.op !== 'add' || blocks.has(op.id)) continue
    const a = op.attrs
    const entry: Entry = { id: op.id, createdAt: op.at || fallbackCreatedAt, markdown: op.body ?? '' }
    if (a.updated) entry.updatedAt = a.updated
    if (a.kind && a.kind !== 'note' && (ENTRY_KINDS as readonly string[]).includes(a.kind)) entry.kind = a.kind as EntryKind
    if (truthy(a.hidden)) entry.hidden = true
    const meta: Record<string, string> = {}
    for (const [k, v] of Object.entries(a)) if (!FIELD_ATTRS.has(k) && v !== '') meta[k] = v
    if (Object.keys(meta).length) entry.meta = meta
    blocks.set(op.id, {
      entry,
      parent: a.parent || null,
      pos: a.pos ?? '',
      ts: { body: a.updated ?? '', place: '', hidden: '', kind: '', meta: {} },
      deleted: false
    })
  }

  for (const op of ops) {
    if (op.op === 'add') continue
    const b = blocks.get(op.id)
    if (!b || b.deleted) continue
    const { entry, ts } = b
    if (op.op === 'delete') {
      b.deleted = true
    } else if (op.op === 'edit') {
      if (op.at >= ts.body) {
        entry.markdown = op.body ?? ''
        entry.updatedAt = op.at
        ts.body = op.at
      }
    } else {
      const a = op.attrs
      if (a.pos !== undefined && op.at >= ts.place) {
        b.parent = a.parent || null
        b.pos = a.pos
        ts.place = op.at
      }
      if (a.hidden !== undefined && op.at >= ts.hidden) {
        if (truthy(a.hidden)) entry.hidden = true
        else delete entry.hidden
        ts.hidden = op.at
      }
      if (a.kind !== undefined && op.at >= ts.kind) {
        if (a.kind && a.kind !== 'note' && (ENTRY_KINDS as readonly string[]).includes(a.kind)) entry.kind = a.kind as EntryKind
        else delete entry.kind
        ts.kind = op.at
      }
      for (const [k, v] of Object.entries(a)) {
        if (FIELD_ATTRS.has(k) || op.at < (ts.meta[k] ?? '')) continue
        ts.meta[k] = op.at
        const meta = { ...(entry.meta ?? {}) }
        if (v === '') delete meta[k]
        else meta[k] = v
        if (Object.keys(meta).length) entry.meta = meta
        else delete entry.meta
      }
    }
  }

  // Tree: dangling parents become top level, cycles are cut at their smallest id.
  const live = [...blocks.values()].filter((b) => !b.deleted)
  const liveIds = new Set(live.map((b) => b.entry.id))
  const parentOf = new Map<string, string | null>()
  for (const b of live) parentOf.set(b.entry.id, b.parent && b.parent !== b.entry.id && liveIds.has(b.parent) ? b.parent : null)
  for (const id of [...liveIds].sort()) {
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | null = id
    while (cur !== null && !onPath.has(cur)) {
      path.push(cur)
      onPath.add(cur)
      cur = parentOf.get(cur) ?? null
    }
    if (cur !== null) {
      const cycle = path.slice(path.indexOf(cur))
      parentOf.set(cycle.reduce((m, x) => (x < m ? x : m)), null)
    }
  }
  const byParent = new Map<string | null, Replayed[]>()
  for (const b of live) {
    const p = parentOf.get(b.entry.id) ?? null
    const list = byParent.get(p) ?? []
    list.push(b)
    byParent.set(p, list)
  }
  // Equal keys happen when two machines append at once: show them in time order.
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const cmp = (x: Replayed, y: Replayed): number => by(x.pos, y.pos) || by(x.entry.createdAt, y.entry.createdAt) || by(x.entry.id, y.entry.id)
  const entries: Entry[] = []
  const pos = new Map<string, string>()
  const walk = (parent: string | null): void => {
    for (const b of (byParent.get(parent) ?? []).sort(cmp)) {
      const e = { ...b.entry }
      if (e.meta) e.meta = { ...e.meta }
      const p = parentOf.get(e.id) ?? null
      if (p) e.parentId = p
      else delete e.parentId
      entries.push(e)
      pos.set(e.id, b.pos)
      walk(e.id)
    }
  }
  walk(null)
  return { entries, pos, ids, maxAt }
}

// ---------------------------------------------------------------------------
// Whole files, any format
// ---------------------------------------------------------------------------

/** Replay any block file. Format 1 and 2 files are read as if compacted into format 3. */
export function readBlockLog(text: string, dir: string, fallbackCreatedAt = '1970-01-01T00:00:00.000Z'): BlockLog {
  if (blockFileFormat(text) >= 3) return replayOps(parseOps(text, dir), fallbackCreatedAt)
  return replayOps(compactOps(parseLegacyBlockFile(text, dir, fallbackCreatedAt)), fallbackCreatedAt)
}

/** Parse any file of blocks (a day file, a todo list) into live blocks in display order. */
export function parseBlockFile(text: string, dir: string, fallbackCreatedAt = '1970-01-01T00:00:00.000Z'): Entry[] {
  return readBlockLog(text, dir, fallbackCreatedAt).entries
}

export function parseDayFile(date: string, text: string, base: string = ENTRIES_DIR): Day {
  return { date, entries: parseBlockFile(text, dayDir(date, base), `${date}T00:00:00.000Z`) }
}

/**
 * One `add` per block, carrying its current state: the compacted form of a
 * log. Deterministic (order keys are assigned in display order), so two
 * machines compacting the same blocks write the same bytes.
 */
export function compactOps(entries: Entry[]): Op[] {
  const ids = new Set(entries.map((e) => e.id))
  const groups = new Map<string | null, string[]>()
  for (const e of entries) {
    const p = e.parentId && ids.has(e.parentId) ? e.parentId : null
    groups.set(p, [...(groups.get(p) ?? []), e.id])
  }
  const posOf = new Map<string, string>()
  for (const list of groups.values()) {
    const keys = keysBetween(null, null, list.length)
    list.forEach((id, i) => posOf.set(id, keys[i]))
  }
  return entries.map((e) => {
    const attrs: Record<string, string> = {}
    if (e.parentId && ids.has(e.parentId)) attrs.parent = e.parentId
    attrs.pos = posOf.get(e.id)!
    if (e.updatedAt) attrs.updated = e.updatedAt
    if (e.kind && e.kind !== 'note') attrs.kind = e.kind
    if (e.hidden) attrs.hidden = '1'
    for (const [k, v] of Object.entries(e.meta ?? {})) if (!FIELD_ATTRS.has(k) && META_KEY_RE.test(k) && v !== '') attrs[k] = v
    return { op: 'add', id: e.id, at: e.createdAt, attrs, body: e.markdown }
  })
}

/** A whole file in compacted format 3 (used by migrations; the app itself only appends). */
export function serializeBlockFile(entries: Entry[], dir: string, title: string): string {
  return blockFileHeader(title) + serializeOps(compactOps(entries), dir)
}

export function serializeDayFile(day: Day, base: string = ENTRIES_DIR): string {
  return serializeBlockFile(day.entries, dayDir(day.date, base), `# ${day.date}`)
}

// ---------------------------------------------------------------------------
// Planning new records against a replayed file
// ---------------------------------------------------------------------------

/**
 * Timestamp for new records: now, or the file's latest `at` if the clock is
 * behind it, so a new record always wins over what is already there.
 */
export function stampFor(log: BlockLog, now: Date): string {
  const iso = now.toISOString()
  return iso >= log.maxAt ? iso : log.maxAt
}

function siblingIds(log: BlockLog, parentId: string | null, exclude?: Set<string>): string[] {
  return log.entries.filter((e) => (e.parentId ?? null) === parentId && !exclude?.has(e.id)).map((e) => e.id)
}

/**
 * An order key for a block going in at `index` among `parentId`'s children.
 * If the neighbours' keys leave no room (equal keys from a merge, hand
 * edits), the siblings are renumbered with extra `set` records.
 */
function place(log: BlockLog, parentId: string | null, index: number, at: string, exclude?: Set<string>): { pos: string; renumber: Op[] } {
  const sibs = siblingIds(log, parentId, exclude)
  const prev = index > 0 ? (log.pos.get(sibs[index - 1]) ?? '') : null
  const next = index < sibs.length ? (log.pos.get(sibs[index]) ?? '') : null
  try {
    return { pos: keyBetween(prev, next), renumber: [] }
  } catch {
    const keys = keysBetween(null, null, sibs.length + 1)
    const renumber: Op[] = sibs.map((id, i) => {
      const attrs: Record<string, string> = { pos: keys[i < index ? i : i + 1] }
      if (parentId) attrs.parent = parentId
      return { op: 'set', id, at, attrs }
    })
    return { pos: keys[index], renumber }
  }
}

function liveEntry(log: BlockLog, id: string): Entry {
  const e = log.entries.find((x) => x.id === id)
  if (!e) throw new Error(`Entry ${id} not found`)
  return e
}

/**
 * Records that add `entry` at `position` (a reply to `parentId`, right after
 * `afterId`'s thread, right before `beforeId`, or at the end). Sets
 * `entry.parentId`. `entry.createdAt` is the record's `at`.
 */
export function planAdd(log: BlockLog, entry: Entry, position: EntryPosition, at: string): Op[] {
  let parent: string | null = null
  let index: number
  if (position.parentId) {
    liveEntry(log, position.parentId)
    parent = position.parentId
    index = siblingIds(log, parent).length
  } else if (position.afterId || position.beforeId) {
    const anchor = liveEntry(log, (position.afterId ?? position.beforeId)!)
    parent = anchor.parentId ?? null
    index = siblingIds(log, parent).indexOf(anchor.id) + (position.afterId ? 1 : 0)
  } else {
    index = siblingIds(log, null).length
  }
  const { pos, renumber } = place(log, parent, index, at)
  if (parent) entry.parentId = parent
  else delete entry.parentId
  const attrs: Record<string, string> = { pos }
  if (parent) attrs.parent = parent
  if (entry.updatedAt) attrs.updated = entry.updatedAt
  if (entry.kind && entry.kind !== 'note') attrs.kind = entry.kind
  if (entry.hidden) attrs.hidden = '1'
  for (const [k, v] of Object.entries(entry.meta ?? {})) if (!FIELD_ATTRS.has(k) && META_KEY_RE.test(k) && v !== '') attrs[k] = v
  return [...renumber, { op: 'add', id: entry.id, at: entry.createdAt, attrs, body: entry.markdown }]
}

/** Every live block in `id`'s thread, `id` first. */
export function threadIds(log: BlockLog, id: string): string[] {
  const out = [id]
  for (let i = 0; i < out.length; i++) for (const e of log.entries) if (e.parentId === out[i]) out.push(e.id)
  return out
}

/**
 * Records that move a top-level block (its thread follows) after `afterId`'s
 * thread or before `beforeId`. Empty when the move would change nothing.
 */
export function planMove(log: BlockLog, id: string, position: { afterId?: string; beforeId?: string }, at: string): Op[] {
  const root = liveEntry(log, id)
  if (root.parentId) throw new Error('Only top-level blocks can be reordered')
  const anchorId = position.afterId ?? position.beforeId
  if (!anchorId) throw new Error('Nowhere to move to')
  const moving = new Set(threadIds(log, id))
  if (moving.has(anchorId)) return []
  let top = liveEntry(log, anchorId)
  while (top.parentId) top = liveEntry(log, top.parentId)
  const sibs = siblingIds(log, null, moving)
  const index = sibs.indexOf(top.id) + (position.afterId ? 1 : 0)
  const { pos, renumber } = place(log, null, index, at, moving)
  return [...renumber, { op: 'set', id, at, attrs: { pos } }]
}

/** Records that delete a block and its whole thread. */
export function planDelete(log: BlockLog, id: string, at: string): Op[] {
  liveEntry(log, id)
  return threadIds(log, id).map((x) => ({ op: 'delete', id: x, at, attrs: {} }))
}

/** A record changing fields of a block (`hidden`, `kind`, metadata; empty value removes). */
export function planSet(log: BlockLog, id: string, fields: Record<string, string>, at: string): Op[] {
  liveEntry(log, id)
  return [{ op: 'set', id, at, attrs: { ...fields } }]
}

export function planEdit(log: BlockLog, id: string, markdown: string, at: string): Op[] {
  liveEntry(log, id)
  return [{ op: 'edit', id, at, attrs: {}, body: markdown }]
}

/**
 * The log as it will be once `ops` are appended, for planning several
 * records in a row (each placed after the one before).
 */
export function advance(log: BlockLog, ops: Op[]): BlockLog {
  const base = compactOps(log.entries).map((op) => ({ ...op, attrs: { ...op.attrs, pos: log.pos.get(op.id) ?? op.attrs.pos } }))
  const next = replayOps([...base, ...ops])
  for (const id of log.ids) next.ids.add(id)
  if (log.maxAt > next.maxAt) next.maxAt = log.maxAt
  return next
}
