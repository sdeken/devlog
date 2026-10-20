/**
 * What was done on a canvas over a period, as text for Claude: the blocks
 * written there (notes, todos, commits; on the canvas and, if asked, the
 * canvases inside it) and the time recorded against it. Pure apart from the
 * reads through `ctx.devlog`.
 */
import { canvasLabel, descendantCanvasIds, isManagedCanvas, localDate, type CanvasMeta } from '@devlog/core'
import type { DevlogContext, ExtensionBlock, ExtensionCanvas } from '@devlog/extension-api'
import { addDays, computeWeekTime, type ReviewNote } from '@shared/review'
import type { ActivityEvent, Entry } from '@shared/types'

export interface SummaryRequest {
  canvasId: string
  /** Local dates, inclusive. */
  from: string
  to: string
  /** Include the canvases inside it. */
  inside: boolean
}

export interface Gathered {
  /** "Acme / Website". */
  title: string
  /** "13 Oct – 19 Oct 2026". */
  period: string
  blocks: number
  /** Minutes recorded on the canvas (and inside it), tracked or estimated. */
  minutes: number
  /** What Claude is given. */
  text: string
}

/** More than this is too much to send at once: say so rather than cut it short. */
export const MAX_CHARS = 400_000
/** The longest period one summary covers. */
export const MAX_DAYS = 400

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Extension canvases as the core helpers want them. */
export function asMeta(list: ExtensionCanvas[]): CanvasMeta[] {
  return list.map((c) => ({ id: c.id, title: c.title, parentId: c.parentId, task: c.task, ...(c.type ? { type: c.type } : {}), archived: c.archived, createdAt: '', updatedAt: '', repos: [], hasSurface: false, fields: { ...c.fields } }))
}

/** Canvases a summary can be about: not those an extension keeps for itself. */
export function summarizable(list: ExtensionCanvas[]): ExtensionCanvas[] {
  return list.filter((c) => !isManagedCanvas(c))
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(d)
  return out
}

const parseLocal = (d: string): Date => {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y, m - 1, day)
}
const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const yearFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const stampFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

/** "13 Oct – 19 Oct 2026", or one day. */
export function periodLabel(from: string, to: string): string {
  return from === to ? yearFmt.format(parseLocal(from)) : `${dayFmt.format(parseLocal(from))} – ${yearFmt.format(parseLocal(to))}`
}

/** 375 → "6:15". */
export function hm(minutes: number): string {
  const m = Math.round(minutes)
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}

export function checkRequest(raw: unknown): SummaryRequest {
  const r = (raw ?? {}) as Partial<SummaryRequest>
  if (typeof r.canvasId !== 'string' || !r.canvasId) throw new Error('Pick a canvas')
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || !DATE_RE.test(r.from) || !DATE_RE.test(r.to)) throw new Error('Pick a period')
  if (r.to < r.from) throw new Error('The period ends before it starts')
  if ((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 > MAX_DAYS) throw new Error(`Summarize at most ${MAX_DAYS} days at a time`)
  return { canvasId: r.canvasId, from: r.from, to: r.to, inside: r.inside !== false }
}

/** One block, as a line (or a few) of the log Claude reads. */
function blockLine(b: ExtensionBlock, parents: Map<string, ExtensionBlock>): string {
  const when = stampFmt.format(new Date(b.createdAt))
  const tags: string[] = []
  if (b.kind === 'todo') tags.push(b.meta?.done ? `todo, done ${localDate(new Date(b.meta.done))}` : 'todo, open')
  else if (b.kind === 'commit') tags.push(`commit${b.meta?.branch ? ` on ${b.meta.branch}` : ''}${b.meta?.repo ? ` in ${b.meta.repo.split(/[\\/]/).pop()}` : ''}`)
  else if (b.kind === 'task') tags.push('became a task')
  const parent = b.parentId ? parents.get(b.parentId) : undefined
  if (parent) tags.push(`inside "${firstLine(parent.markdown, 60)}"`)
  const body = b.markdown.trim().replace(/\r\n/g, '\n').split('\n')
  return `- [${when}${tags.length ? `; ${tags.join('; ')}` : ''}] ${body[0] ?? ''}${body.slice(1).map((l) => `\n  ${l}`).join('')}`
}

function firstLine(markdown: string, max: number): string {
  const line = markdown.trim().split('\n')[0].replace(/^#+\s*/, '').replace(/^- \[[ x]\]\s*/i, '')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Read what was written and recorded, and lay it out for Claude: the
 * canvas, the period, the time per canvas, then every block written in the
 * period (and every todo ticked off in it), oldest first, under its canvas.
 */
export async function gather(ctx: DevlogContext, req: SummaryRequest): Promise<Gathered> {
  const all = await ctx.devlog.canvases()
  const metas = asMeta(all)
  const canvas = all.find((c) => c.id === req.canvasId)
  if (!canvas) throw new Error('That canvas is not one this extension may read')
  const scope = new Set([req.canvasId, ...(req.inside ? descendantCanvasIds(metas, req.canvasId) : [])])
  const label = (id: string): string => canvasLabel(metas, id)
  const title = label(req.canvasId)
  const dates = datesBetween(req.from, req.to)
  const inPeriod = (iso: string | undefined): boolean => {
    if (!iso) return false
    const d = localDate(new Date(iso))
    return d >= req.from && d <= req.to
  }

  const [days, activity] = await Promise.all([ctx.devlog.range(req.from, req.to), ctx.devlog.activity(req.from, req.to).catch(() => [])])

  // Time: every readable note feeds the estimate for untracked days, as in the review; the canvases in scope are counted.
  const notes: ReviewNote[] = []
  const blocks: Array<{ canvasId: string; block: ExtensionBlock }> = []
  const parents = new Map<string, ExtensionBlock>()
  for (const day of days) {
    for (const b of day.blocks) {
      parents.set(b.id, b)
      if (inPeriod(b.createdAt)) notes.push({ canvasId: day.canvasId, date: localDate(new Date(b.createdAt)), entry: b as unknown as Entry })
      if (!scope.has(day.canvasId) || b.kind === 'timesheet') continue
      if (inPeriod(b.createdAt) || (b.kind === 'todo' && inPeriod(b.meta?.done))) blocks.push({ canvasId: day.canvasId, block: b })
    }
  }
  const time = computeWeekTime(notes, activity as unknown as ActivityEvent[], { dates })
  const perCanvas = new Map<string, number>()
  let estimated = 0
  for (const [date, byCanvas] of time.byCanvasDay) {
    for (const [id, m] of byCanvas) {
      if (!scope.has(id)) continue
      perCanvas.set(id, (perCanvas.get(id) ?? 0) + m)
      if (time.method.get(date) === 'estimated') estimated += m
    }
  }
  const minutes = [...perCanvas.values()].reduce((n, m) => n + m, 0)

  if (blocks.length === 0 && minutes === 0) throw new Error(`Nothing was written or tracked on ${title} in that period`)

  blocks.sort((a, b) => a.block.createdAt.localeCompare(b.block.createdAt))
  const byCanvas = new Map<string, string[]>()
  for (const { canvasId, block } of blocks) byCanvas.set(canvasId, [...(byCanvas.get(canvasId) ?? []), blockLine(block, parents)])
  const order = [...scope].filter((id) => byCanvas.has(id)).sort((a, b) => label(a).localeCompare(label(b)))

  const lines = [
    `Canvas: ${title}${req.inside && scope.size > 1 ? ' (and the canvases inside it)' : ''}`,
    `Period: ${periodLabel(req.from, req.to)} (${req.from} to ${req.to})`,
    minutes > 0
      ? `Time recorded: ${hm(minutes)} in all; ${[...perCanvas]
          .filter(([, m]) => m >= 1)
          .sort((a, b) => b[1] - a[1])
          .map(([id, m]) => `${label(id)} ${hm(m)}`)
          .join('; ')}${estimated >= 1 ? ` (${hm(estimated)} of it estimated from the notes, on days with no time tracked)` : ''}`
      : 'Time recorded: none',
    '',
    `Blocks written in the period, oldest first (${blocks.length}):`
  ]
  for (const id of order) lines.push('', `## ${label(id)}`, ...byCanvas.get(id)!)
  const text = lines.join('\n')
  if (text.length > MAX_CHARS) throw new Error(`That is a lot to summarize at once (${blocks.length} blocks). Pick a shorter period, or a canvas further down.`)
  return { title, period: periodLabel(req.from, req.to), blocks: blocks.length, minutes, text }
}
