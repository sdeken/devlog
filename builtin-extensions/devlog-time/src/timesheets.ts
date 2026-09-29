/**
 * Timesheets: one block per week (on its Monday) in the Timesheets canvas,
 * which this extension keeps: a readable table and the data in a fenced
 * block (docs/TIMESHEETS.md). The first save adds the week's block; later
 * saves edit it, so the history of the shuffling is kept. What was sent
 * where is written inside it.
 */
import { canvasLabel, parseTimesheet, sanitizeTimesheet, serializeTimesheet, topLevelCanvasId, type CanvasMeta, type Timesheet } from '@devlog/core'
import type { DestinationInfo, DevlogContext, ExtensionBlock, ExtensionCanvas, SendResult } from '@devlog/extension-api'

export const TIMESHEETS_KEY = 'timesheets'

/** Extension canvases as the core helpers want them. */
export function asMeta(list: ExtensionCanvas[]): CanvasMeta[] {
  return list.map((c) => ({ id: c.id, title: c.title, parentId: c.parentId, task: c.task, ...(c.type ? { type: c.type } : {}), archived: c.archived, createdAt: '', updatedAt: '', repos: [], hasSurface: false }))
}

export class Timesheets {
  private canvasId: string | null = null

  constructor(
    private readonly ctx: DevlogContext,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The Timesheets canvas (made on first use). */
  async canvas(): Promise<string> {
    if (!this.canvasId) this.canvasId = (await this.ctx.devlog.managedCanvas(TIMESHEETS_KEY, { title: 'Timesheets' })).id
    return this.canvasId
  }

  private async block(week: string): Promise<{ canvasId: string; block: ExtensionBlock | undefined }> {
    const canvasId = await this.canvas()
    const blocks = await this.ctx.devlog.blocks(canvasId, week)
    return { canvasId, block: blocks.find((b) => b.kind === 'timesheet' && b.meta?.week === week && !b.parentId) }
  }

  async read(week: string): Promise<Timesheet | null> {
    const { block } = await this.block(week)
    return block ? parseTimesheet(block.markdown) : null
  }

  async save(input: unknown): Promise<Timesheet> {
    const sheet = sanitizeTimesheet({ ...(input as object), updatedAt: this.now().toISOString() })
    const all = asMeta(await this.ctx.devlog.canvases())
    const markdown = serializeTimesheet(
      sheet,
      (id) => canvasLabel(all, id),
      (id) => topLevelCanvasId(all, id)
    )
    const { canvasId, block } = await this.block(sheet.week)
    if (block) await this.ctx.devlog.editBlock(canvasId, sheet.week, block.id, markdown)
    else await this.ctx.devlog.addBlock(canvasId, markdown, { kind: 'timesheet', date: sheet.week, meta: { week: sheet.week } })
    return sheet
  }

  /** Send the saved week through a destination, and write what happened inside its block. */
  async send(to: Pick<DestinationInfo, 'extension' | 'id'>, week: string): Promise<SendResult> {
    const { canvasId, block } = await this.block(week)
    const sheet = block ? parseTimesheet(block.markdown) : null
    if (!block || !sheet) throw new Error('Save the timesheet first')
    const result = await this.ctx.destinations.send(to, sheet)
    const label = (await this.ctx.destinations.list()).find((d) => d.extension === to.extension && d.id === to.id)?.label ?? to.id
    const failed = result.failed.length ? ` ${result.failed.length} failed: ${result.failed.map((f) => f.error).join('; ')}` : ''
    await this.ctx.devlog.addBlock(canvasId, `Sent to ${label}: ${result.summary}.${failed}`, { parentId: block.id, date: week, meta: { destination: to.id, to: to.extension } })
    return result
  }

  async preview(to: Pick<DestinationInfo, 'extension' | 'id'>, week: string): ReturnType<DevlogContext['destinations']['preview']> {
    const sheet = await this.read(week)
    if (!sheet) throw new Error('Save the timesheet first')
    return this.ctx.destinations.preview(to, sheet)
  }
}
