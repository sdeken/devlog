// A test extension for API 1.6. Written as a bundle would be: CommonJS, no dependencies.
exports.activate = async (ctx) => {
  const seen = []
  const events = []
  ctx.devlog.onBlockAdded((ev) => seen.push({ canvasId: ev.canvasId, date: ev.date, text: ev.block.markdown }))
  ctx.activity.idleAfter(7)
  ctx.app.setTrayLabel('shaping')
  ctx.app.keepRunning(true)
  ctx.provide.activity(async () => events)

  // The context it was run with, for the test (and the header view) to check.
  ctx.commands.register('where', async (context) => JSON.stringify(context))
  // Posted from the note box: the new block becomes a job.
  ctx.commands.register('asjob', async (context) => {
    const { canvas } = await ctx.devlog.promote(context.canvasId, context.date, context.blockId, { type: 'job' })
    events.push({ t: new Date().toISOString(), type: 'task', canvasId: canvas.id, blockId: context.blockId, machine: ctx.machine })
    ctx.ui.highlight(canvas.id)
    return canvas.id
  })
  ctx.commands.register('pick', async () => ctx.ui.pick([{ id: 'a', label: 'A' }, { id: 'b', label: 'B', hint: 'the second' }], { placeholder: 'Which?' }))

  // API 1.7: a destination of its own, which it can also send through (via the app).
  const ledger = []
  ctx.destinations.register('ledger', {
    preview: async (sheet) => sheet.entries.map((e) => ({ id: e.id, entryIds: [e.id], date: e.date, minutes: e.minutes, target: e.task, action: 'create' })),
    send: async (sheet) => {
      ledger.push(...sheet.entries.map((e) => `${e.client}|${e.task}|${e.minutes}`))
      return { done: sheet.entries.map((e) => e.id), failed: [], summary: `${sheet.entries.length} booked` }
    }
  })
  ctx.views.handle('board', async (method, args) => {
    switch (method) {
      case 'activity':
        return ctx.devlog.activity(args[0], args[1])
      case 'range':
        return ctx.devlog.range(args[0], args[1])
      case 'keep': {
        const c = await ctx.devlog.managedCanvas('sheets', { title: 'Sheets' })
        const again = await ctx.devlog.managedCanvas('sheets', { title: 'Sheets' })
        const r = await ctx.devlog.addBlock(c.id, 'week one', { kind: 'sheet', date: '2026-09-21', meta: { week: '2026-09-21' } })
        const edited = await ctx.devlog.editBlock(c.id, r.date, r.block.id, 'week one, edited')
        return { id: c.id, same: again.id === c.id, date: r.date, kind: r.block.kind, markdown: edited.markdown }
      }
      case 'badKind':
        return ctx.devlog.addBlock(args[0], 'x', { kind: args[1] })
      case 'dests':
        return ctx.destinations.list()
      case 'preview':
        return ctx.destinations.preview({ extension: 'shaper', id: 'ledger' }, args[0])
      case 'send':
        return ctx.destinations.send({ extension: 'shaper', id: 'ledger' }, args[0])
      case 'ledger':
        return ledger
      case 'page':
        ctx.ui.openPage('board')
        return null
      default:
        throw new Error(`board: no method ${method}`)
    }
  })

  ctx.views.handle('head', async (method, args) => {
    switch (method) {
      case 'seen':
        return seen
      case 'make':
        return ctx.devlog.createCanvas({ title: args[0], parentId: args[1], type: 'job' })
      case 'retitle':
        return ctx.devlog.updateCanvas(args[0], { title: args[1] })
      case 'untype':
        return ctx.devlog.updateCanvas(args[0], { type: null })
      case 'foreign':
        return ctx.devlog.createCanvas({ title: 'Not mine', parentId: args[0], type: 'builtin.other/task' })
      case 'note': {
        const r = await ctx.devlog.addBlock(args[0], 'draft')
        return ctx.devlog.editBlock(args[0], r.date, r.block.id, 'final')
      }
      case 'editOther':
        return ctx.devlog.editBlock(args[0], args[1], args[2], 'changed by an extension')
      case 'open':
        ctx.ui.open({ canvasId: args[0] })
        return null
      default:
        throw new Error(`head: no method ${method}`)
    }
  })
}
