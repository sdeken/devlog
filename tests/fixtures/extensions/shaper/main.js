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
