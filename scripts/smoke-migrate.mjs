/**
 * Upgrade smoke test: opens a devlog written by Devlog 0.3 (storage format 1,
 * activity log kept locally) with the built app and checks that it is
 * migrated, committed and pushed, and that nothing is lost on the way.
 *
 *   npm run build && xvfb-run -a node scripts/smoke-migrate.mjs
 */
import { _electron as electron } from 'playwright-core'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const appRoot = path.resolve(here, '..')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-smoke-migrate-'))
const repo = path.join(tmp, 'repo')
const bare = path.join(tmp, 'remote.git')
const userData = path.join(tmp, 'userData')
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const write = async (base, rel, text) => {
  await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true })
  await fs.writeFile(path.join(base, rel), text)
}
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const [yy, mm] = ymd.split('-')
const at = (hoursAgo) => new Date(now.getTime() - hoursAgo * 3600_000).toISOString()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

// A format 1 devlog, as Devlog 0.3 wrote it, pushed to a remote.
await fs.mkdir(repo, { recursive: true })
git(['init', '--bare', '--initial-branch=main', bare])
git(['init', '--initial-branch=main'])
git(['config', 'user.name', 'Old Version'])
git(['config', 'user.email', 'old@example.com'])
git(['remote', 'add', 'origin', bare])
await write(repo, 'README.md', '# Devlog\n')
await write(repo, 'canvases/acme-corp/canvas.md', '---\ntitle: Acme Corp\ncreated: 2026-01-01T00:00:00.000Z\n---\n\n# Acme\n\n![logo](assets/logo.png)\n')
await fs.mkdir(path.join(repo, 'canvases/acme-corp/assets'), { recursive: true })
await fs.writeFile(path.join(repo, 'canvases/acme-corp/assets/logo.png'), PNG)
await write(repo, 'canvases/website/canvas.md', '---\ntitle: Website\nparent: acme-corp\ntask: true\ncreated: 2026-01-02T00:00:00.000Z\n---\n')
await write(
  repo,
  `canvases/website/entries/${yy}/${mm}/${ymd}.md`,
  `# ${ymd}\n\n<!-- devlog:entry id=aaaaaaaa created=${at(3)} -->\n### 09:00\n\nkickoff notes ![s](assets/shot.png)\n`
)
await fs.mkdir(path.join(repo, `canvases/website/entries/${yy}/${mm}/assets`), { recursive: true })
await fs.writeFile(path.join(repo, `canvases/website/entries/${yy}/${mm}/assets/shot.png`), PNG)
await write(repo, `entries/${yy}/${mm}/${ymd}.md`, `# ${ymd}\n\n<!-- devlog:entry id=bbbbbbbb created=${at(4)} kind=task canvas=website -->\n### 08:00\n\nRebuild the website\n`)
git(['add', '-A'])
git(['commit', '-m', 'format 1 history'])
git(['push', '-u', 'origin', 'main'])

// 0.3 user data: settings without a revision, a local activity log, the active task by its old id.
await fs.mkdir(userData, { recursive: true })
await fs.writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ repoPath: repo, syncIntervalMinutes: 60, commitDebounceSeconds: 2, autoPush: true, pullOnStart: false, commitOnQuit: true, authorName: 'Smoke Test', authorEmail: 'smoke@example.com', trackingEnabled: true, trackFocus: false, idleMinutes: 0, activityInRepo: false, captureCommits: true })
)
await fs.writeFile(path.join(userData, 'tracker-state.json'), JSON.stringify({ activeCanvasId: 'website' }))
await write(
  userData,
  `activity/${yy}/${mm}/${ymd}.jsonl`,
  [
    { t: at(2), type: 'start', canvasId: 'website' },
    { t: at(1.5), type: 'heartbeat' },
    { t: at(1), type: 'stop' }
  ]
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n'
)

const app = await electron.launch({
  args: [appRoot, '--no-sandbox', '--disable-gpu'],
  env: { ...process.env, DEVLOG_USER_DATA: userData, NODE_ENV: 'production' }
})
const failures = []
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures.push(msg)
}
app.on('console', (m) => console.log('  [main]', m.text()))

try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.waitForSelector('.composer-editor', { timeout: 30_000 })

  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'devlog.json'), 'utf8'))
  check(manifest.format === 3, 'the repository is at storage format 3')
  await fs
    .stat(path.join(repo, 'canvases/website'))
    .then(() => check(false, 'old canvas folders are gone'))
    .catch(() => check(true, 'old canvas folders are gone'))
  const canvases = await page.evaluate(() => window.devlog.canvases.list())
  const website = canvases.find((c) => c.title === 'Website')
  const acme = canvases.find((c) => c.title === 'Acme Corp')
  check(/^[0-9a-z]{10}$/.test(website?.id ?? '') && website.aliases?.includes('website'), `canvases got new ids and keep the old one as an alias (${website?.id})`)
  check(website?.parentId === acme?.id && website?.task === true, 'the hierarchy and task flag survive')
  const migratedDay = await fs.readFile(path.join(repo, 'canvases', website.id.slice(0, 2), website.id, 'entries', yy, mm, `${ymd}.md`), 'utf8')
  check(migratedDay.startsWith('<!-- devlog:format 3 -->') && migratedDay.includes('<!-- devlog:add id=aaaaaaaa pos=a0 '), 'block files are rewritten as append-only logs')
  check((await fs.readFile(path.join(repo, '.gitattributes'), 'utf8')).includes('merge=union'), 'the upgrade adds the union-merge rules')
  const treeLabels = await page.locator('.canvas-tree .canvas-name').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(treeLabels.join('>') === 'Acme Corp>Website', `sidebar shows the migrated canvases (${treeLabels.join(' > ')})`)

  const log = git(['log', '--format=%s'])
  check(log.split('\n')[0] === 'devlog: migrate to storage format 3' || log.includes('devlog: migrate to storage format 3'), 'the migration is its own commit')
  check(git(['status', '--porcelain', '--', 'canvases', 'entries', 'devlog.json']) === '', 'nothing of the migration is left uncommitted')

  // The active task, persisted under its old id, is resolved to the new one.
  const status = await page.evaluate(() => window.devlog.tracker.status())
  check(status?.activeCanvasId === website?.id, `the active task follows the alias (${status?.activeCanvasId})`)
  await page.waitForFunction(() => document.querySelector('.task-status')?.textContent?.includes('Website'), null, { timeout: 10_000 })
  check(true, 'the status bar shows the active task')

  // The local activity log moved into the repository, and its old ids map to the new canvas.
  const machine = JSON.parse(await fs.readFile(path.join(userData, 'machine.json'), 'utf8')).folder
  const moved = await fs.readFile(path.join(repo, 'activity', machine, yy, mm, `${ymd}.jsonl`), 'utf8')
  check(moved.includes(at(2)) && moved.includes('"type":"stop"'), 'the local activity log moved into activity/<machine>/ in the repository')
  await fs
    .stat(path.join(userData, `activity/${yy}/${mm}/${ymd}.jsonl`))
    .then(() => check(false, 'the local copy is gone'))
    .catch(() => check(true, 'the local copy is gone'))
  const events = await page.evaluate((d) => window.devlog.activity.range(d, d), ymd)
  const oldStart = events.find((e) => e.t === at(2))
  check(oldStart?.canvasId === website?.id && oldStart?.machine === machine, `old activity reads under the new id, tagged with this machine (${oldStart?.canvasId})`)
  const settingsNow = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'))
  check(settingsNow.activityInRepo === true && settingsNow.settingsRevision === 2, 'settings upgraded: activity log kept in the repository')

  // Blocks, images and task links still work.
  await page.locator('.canvas-tree .canvas-link', { hasText: 'Website' }).first().click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  check((await page.locator('.entry .entry-body').first().textContent()).trim() === 'kickoff notes', 'the block text is intact, without the old time heading')
  await page.waitForFunction(() => {
    const img = document.querySelector('.entry .entry-body img')
    return img && img.complete && img.naturalWidth > 0
  }, null, { timeout: 10_000 })
  check(true, 'images in blocks load from their new folder')
  await page.locator('.canvas-tree .canvas-link', { hasText: 'Acme Corp' }).first().click()
  const surfaceImage = await page
    .waitForFunction(() => {
      const img = document.querySelector('.surface-read img')
      return img && img.complete && img.naturalWidth > 0
    }, null, { timeout: 10_000 })
    .then(() => true, () => false)
  check(surfaceImage, 'surface images load from their new folder')
  await page.locator('.sidebar-views .view-link', { hasText: 'Journal' }).click()
  await page.waitForSelector('.entry-task .task-chip', { state: 'attached', timeout: 10_000 })
  check((await page.locator('.entry-task .task-chip').first().textContent()).includes('Website'), 'journal task blocks link to the migrated canvas')

  // Search runs off the local index.
  const fillStart = Date.now()
  await page.locator('.topbar-search').fill('kickoff')
  const fillMs = Date.now() - fillStart
  if (fillMs > 2000) console.log(`  [diag] typing into search took ${fillMs} ms`)
  await page.waitForSelector('.hit', { timeout: 20_000 }).catch(async (err) => {
    const sub = await page.locator('.feed-sub').first().textContent({ timeout: 1000 }).catch(() => '(no header)')
    const api = await page.evaluate(() => window.devlog.blocks.search('kickoff')).catch((e) => String(e))
    const state = await page.evaluate(() => ({
      value: document.querySelector('.topbar-search')?.value,
      active: document.activeElement?.className,
      modal: Boolean(document.querySelector('.modal, .modal-backdrop')),
      welcome: Boolean(document.querySelector('.welcome')),
      title: document.querySelector('.page-head .crumb.is-current')?.textContent,
      composer: document.querySelector('.composer-new .composer-editor')?.textContent,
      searchView: Boolean(document.querySelector('.feed .hit, .feed-sub'))
    })).catch((e) => String(e))
    await page.screenshot({ path: path.join(tmp, 'search-failure.png') }).catch(() => undefined)
    throw new Error(`no search hit shown (header: ${sub}; page: ${JSON.stringify(state)}; API: ${JSON.stringify(api).slice(0, 300)})`, { cause: err })
  })
  check((await page.locator('.hit').count()) === 1, 'search finds the migrated block')
  const indexFiles = await fs.readdir(path.join(userData, 'index'))
  check(indexFiles.some((f) => f.endsWith('.sqlite')), 'the search index lives in user data, not the repository')
  check(!git(['ls-files']).includes('.sqlite'), 'no index files in the repository')

  // New canvases get random ids next to the migrated ones.
  const created = await page.evaluate(() => window.devlog.canvases.create({ title: 'Globex' }))
  check((await fs.stat(path.join(repo, 'canvases', created.id.slice(0, 2), created.id, 'canvas.md'))).isFile(), 'new canvases land in canvases/<xx>/<id>/')

  // Sync pushes the migration.
  await page.evaluate(() => window.devlog.sync.now())
  const remoteLog = git(['log', '--format=%s', 'main'], bare)
  check(remoteLog.includes('devlog: migrate to storage format 3'), 'the migration commit is pushed')
  await app.close()
  check(git(['status', '--porcelain']) === '', 'working tree clean after quit')
} catch (err) {
  console.error(err)
  failures.push(String(err))
  await app.close().catch(() => undefined)
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall migration smoke checks passed')
