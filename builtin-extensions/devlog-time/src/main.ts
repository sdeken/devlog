/**
 * devlog-time: time tracking, as an extension.
 *
 * It brings the task node type (a canvas you record time against), the
 * clock (one active task; paused while the machine is locked, idle or
 * asleep), the Start/Stop item in the status bar and on task canvases, the
 * commands (Stop, Start a task…, post as a task, turn a block into a task),
 * the tray label, and the time events the app's timeline, review, summary
 * and timesheet are drawn from. See docs/TIME-EXTENSION.md.
 */
import type { CommandContext, DevlogContext } from '@devlog/extension-api'
import { parseDurationMarker } from '@devlog/core'
import { Clock, TASK_TYPE_ID, type ClockStatus } from './tracker'
import { Timesheets, asMeta } from './timesheets'

let clock: Clock | null = null

export async function activate(ctx: DevlogContext): Promise<void> {
  const c = new Clock(ctx)
  clock = c

  const idle = (): number => {
    const n = Number(ctx.settings.get('idle_minutes') ?? '10')
    return Number.isFinite(n) && n >= 0 ? n : 10
  }
  ctx.activity.idleAfter(idle())
  ctx.settings.onChange(() => ctx.activity.idleAfter(idle()))
  ctx.activity.on((n) => c.notice(n))
  ctx.app.keepRunning(true)
  ctx.provide.activity((from, to) => c.events(from, to))

  // What the views, the tray and the sidebar show.
  const publish = (st: ClockStatus): void => {
    ctx.app.setTrayLabel(st.active ? `${st.label}${st.paused ? ' (paused)' : ''}` : 'no active task')
    ctx.ui.highlight(st.active)
    for (const v of ['status', 'header', 'picker']) ctx.views.post(v, st)
  }
  c.onChange(publish)

  // Posting on a task makes it the active task (a block with a duration records the past instead).
  ctx.devlog.onBlockAdded((ev) => {
    if (ev.block.kind && ev.block.kind !== 'note') return
    if (parseDurationMarker(ev.block.markdown) !== null) return
    void c
      .refreshCanvases()
      .then(() => (c.isTask(ev.canvasId) && c.status().active !== ev.canvasId ? c.setTask(ev.canvasId, ev.block.id) : undefined))
      .catch(() => undefined)
  })

  /** Turn a block into a task (just inside its canvas) and start it. */
  const makeTask = async (context: CommandContext): Promise<string | null> => {
    if (!context.canvasId || !context.date || !context.blockId) throw new Error('Run this on a block')
    const { canvas } = await ctx.devlog.promote(context.canvasId, context.date, context.blockId, { type: TASK_TYPE_ID })
    await c.setTask(canvas.id, context.blockId)
    return null
  }

  ctx.commands.register('stop', () => c.setTask(null))
  ctx.commands.register('start', async (context) => {
    if (!context.canvasId) throw new Error('Open a task first')
    await c.setTask(context.canvasId)
  })
  ctx.commands.register('switch', async (context) => {
    await c.refreshCanvases()
    const items = c.tasks(context.canvasId).map((t) => ({ id: t.id, label: t.title, hint: t.path }))
    if (c.status().active) items.unshift({ id: '', label: 'Stop the clock', hint: c.status().label ?? '' })
    const id = await ctx.ui.pick(items, { placeholder: 'Start a task…' })
    if (id === null) return
    await c.setTask(id || null)
  })
  ctx.commands.register('open-summary', () => ctx.ui.openPage('summary'))
  ctx.commands.register('posttask', makeTask)
  ctx.commands.register('maketask', makeTask)

  // Views: the status bar item, its picker, and the button on task canvases.
  const handler = async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'status':
        return c.status()
      case 'tasks':
        await c.refreshCanvases()
        return c.tasks(typeof args[0] === 'string' ? args[0] : undefined)
      case 'task': {
        // A task, if the canvas is one: for the Start button on it.
        await c.refreshCanvases()
        const id = typeof args[0] === 'string' ? args[0] : ''
        return c.isTask(id) ? (c.tasks(id).find((t) => t.id === id) ?? null) : null
      }
      case 'start':
        await c.setTask(String(args[0]))
        return c.status()
      case 'stop':
        await c.setTask(null)
        return c.status()
      case 'newTask': {
        const title = String(args[0] ?? '').trim()
        if (!title) throw new Error('Give the task a name')
        const parentId = typeof args[1] === 'string' && args[1] ? args[1] : null
        const task = await ctx.devlog.createCanvas({ title, parentId, type: TASK_TYPE_ID })
        await c.setTask(task.id)
        return c.status()
      }
      default:
        throw new Error(`No method ${method}`)
    }
  }
  for (const v of ['status', 'header', 'picker']) ctx.views.handle(v, handler)

  // The Timesheet and Summary pages.
  const sheets = new Timesheets(ctx)
  const str = (v: unknown): string => {
    if (typeof v !== 'string') throw new Error('Expected text')
    return v
  }
  const destination = (v: unknown): { extension: string; id: string } => {
    const d = (v ?? {}) as { extension?: unknown; id?: unknown }
    return { extension: str(d.extension), id: str(d.id) }
  }
  const pages = async (method: string, args: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'canvases': {
        const kept = await sheets.canvas()
        return asMeta((await ctx.devlog.canvases()).filter((x) => x.id !== kept))
      }
      case 'range':
        return (await ctx.devlog.range(str(args[0]), str(args[1]))).map((d) => ({ canvasId: d.canvasId, date: d.date, blocks: d.blocks }))
      case 'activity':
        return ctx.devlog.activity(str(args[0]), str(args[1]))
      case 'timesheet':
        return sheets.read(str(args[0]))
      case 'saveTimesheet':
        return sheets.save(args[0])
      case 'destinations':
        return ctx.destinations.list()
      case 'previewSend':
        return sheets.preview(destination(args[0]), str(args[1]))
      case 'send':
        return sheets.send(destination(args[0]), str(args[1]))
      case 'pref':
        return (await ctx.files.local.readText(`prefs/${str(args[0]).replace(/[^a-z0-9._-]/gi, '')}`)) ?? null
      case 'setPref':
        await ctx.files.local.write(`prefs/${str(args[0]).replace(/[^a-z0-9._-]/gi, '')}`, str(args[1]))
        return null
      default:
        throw new Error(`No method ${method}`)
    }
  }
  for (const v of ['timesheet', 'summary']) ctx.views.handle(v, pages)

  await c.start()
}

export async function deactivate(): Promise<void> {
  await clock?.stop()
  clock = null
}
