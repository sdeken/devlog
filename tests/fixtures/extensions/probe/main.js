// A test extension. Written as a bundle would be: CommonJS, no dependencies.
const attempt = async (fn) => {
  try {
    const v = await fn()
    return { ok: true, value: v === undefined ? null : v }
  } catch (err) {
    return { ok: false, error: String((err && (err.code || err.message)) || err) }
  }
}

exports.activate = async (ctx) => {
  const notices = []
  ctx.activity.on((n) => notices.push(n))

  ctx.commands.register('hello', async () => {
    const n = Number((await ctx.files.local.readText('count')) || 0) + 1
    await ctx.files.local.write('count', String(n))
    await ctx.files.repo.append('log/hello.jsonl', JSON.stringify({ n }) + '\n')
    ctx.ui.notify(`${ctx.settings.get('greeting') || 'Hello'} #${n}`)
  })

  ctx.commands.register('probe', async () => {
    const fs = require('fs')
    const canvases = await ctx.devlog.canvases()
    const report = {
      id: ctx.id,
      apiVersion: ctx.apiVersion,
      readFile: await attempt(() => fs.readFileSync(process.execPath).length),
      readDir: await attempt(() => fs.readdirSync('.')),
      writeFile: await attempt(() => fs.writeFileSync(require('path').join(require('os').tmpdir(), 'devlog-probe-escape.txt'), 'x')),
      spawn: await attempt(() => require('child_process').execSync('echo hi').toString()),
      worker: await attempt(() => new (require('worker_threads').Worker)('1', { eval: true })),
      requirePackage: await attempt(() => require('left-pad')),
      env: Object.keys(process.env).sort(),
      canvases: canvases.map((c) => ({ id: c.id, title: c.title, parentId: c.parentId, fields: c.fields })),
      escapeFiles: await attempt(() => ctx.files.repo.write('../../devlog.json', '{}')),
      secretBefore: await attempt(() => ctx.secrets.get('token')),
      settings: { greeting: ctx.settings.get('greeting') || null },
      notices
    }
    for (const c of canvases) {
      report['field:' + c.title] = await ctx.devlog.field(c.id, 'code')
      report['days:' + c.title] = await attempt(() => ctx.devlog.days(c.id))
      report['add:' + c.title] = await attempt(async () => (await ctx.devlog.addBlock(c.id, `Probe was here (${c.title})`, { meta: { probe: '1' } })).block.meta)
    }
    report.search = (await ctx.devlog.search('needle')).blocks.map((b) => b.canvasId)
    await ctx.files.repo.write('probe.json', JSON.stringify(report, null, 2))
  })
}
