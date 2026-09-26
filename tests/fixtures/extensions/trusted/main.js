// A test extension that asks to run unrestricted.
exports.activate = (ctx) => {
  ctx.commands.register('probe', async () => {
    const fs = require('fs')
    const path = require('path')
    const report = {
      packageDir: ctx.packageDir,
      readOwnManifest: JSON.parse(fs.readFileSync(path.join(ctx.packageDir, 'devlog-extension.json'), 'utf8')).name,
      hasPath: Boolean(process.env.PATH || process.env.Path)
    }
    await ctx.files.repo.write('report.json', JSON.stringify(report))
  })
}
