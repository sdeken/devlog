// Bundles the built-in extensions written in TypeScript: for each
// builtin-extensions/<name>/src, src/main.ts → dist/main.js (the extension
// process: CommonJS, Node built-ins only) and each src/views/<view>.tsx →
// dist/views/<view>.{html,js,css} (a page for a sandboxed frame: one
// script, one stylesheet, React and @devlog/ui included).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const builtins = path.join(root, 'builtin-extensions')
const alias = {
  '@devlog/core': path.join(root, 'packages/core/src/index.ts'),
  '@devlog/ui/styles.css': path.join(root, 'packages/ui/src/styles.css'),
  '@devlog/ui': path.join(root, 'packages/ui/src/index.tsx'),
  '@shared': path.join(root, 'src/shared')
}
const exists = (p) => fs.stat(p).then(() => true, () => false)
const html = (name, title) =>
  `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n<link rel="stylesheet" href="${name}.css">\n</head>\n<body>\n<div id="root"></div>\n<script src="${name}.js"></script>\n</body>\n</html>\n`

export async function buildBuiltins({ only } = {}) {
  const built = []
  for (const name of await fs.readdir(builtins)) {
    if (only && !only.includes(name)) continue
    const src = path.join(builtins, name, 'src')
    if (!(await exists(src))) continue
    const dist = path.join(builtins, name, 'dist')
    await fs.rm(dist, { recursive: true, force: true })
    for (const main of ['main.ts', 'main.tsx']) {
      if (!(await exists(path.join(src, main)))) continue
      await build({
        entryPoints: [path.join(src, main)],
        outfile: path.join(dist, 'main.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        alias,
        logLevel: 'warning'
      })
    }
    const views = path.join(src, 'views')
    if (await exists(views)) {
      for (const file of await fs.readdir(views)) {
        if (!/\.tsx$/.test(file)) continue
        const view = file.replace(/\.tsx$/, '')
        await build({
          entryPoints: [path.join(views, file)],
          outfile: path.join(dist, 'views', `${view}.js`),
          bundle: true,
          platform: 'browser',
          format: 'iife',
          target: 'chrome120',
          jsx: 'automatic',
          minify: true,
          alias,
          define: { 'process.env.NODE_ENV': '"production"' },
          loader: { '.css': 'css' },
          logLevel: 'warning'
        })
        // esbuild writes the imported CSS next to the script; make sure the page links a file that exists.
        if (!(await exists(path.join(dist, 'views', `${view}.css`)))) await fs.writeFile(path.join(dist, 'views', `${view}.css`), '')
        await fs.writeFile(path.join(dist, 'views', `${view}.html`), html(view, view))
      }
    }
    built.push(name)
  }
  return built
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = await buildBuiltins()
  console.log(built.length ? `built-in extensions bundled: ${built.join(', ')}` : 'no built-in extensions to bundle')
}
