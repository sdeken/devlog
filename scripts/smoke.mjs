/**
 * End-to-end smoke test: launches the built app against a throwaway devlog
 * repository, posts an entry, pastes an image, edits, syncs, and checks git.
 *
 *   npm run build && xvfb-run -a node scripts/smoke.mjs
 */
import { _electron as electron } from 'playwright-core'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const here = path.dirname(new URL(import.meta.url).pathname)
const appRoot = path.resolve(here, '..')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-smoke-'))
const repo = path.join(tmp, 'repo')
const bare = path.join(tmp, 'remote.git')
const userData = path.join(tmp, 'userData')
const shots = process.env.SMOKE_SHOTS ? path.resolve(process.env.SMOKE_SHOTS) : path.join(tmp, 'shots')
await fs.mkdir(repo, { recursive: true })
await fs.mkdir(userData, { recursive: true })
await fs.mkdir(shots, { recursive: true })

const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
git(['init', '--bare', '--initial-branch=main', bare])
git(['init', '--initial-branch=main'])
git(['remote', 'add', 'origin', bare])
await fs.writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ repoPath: repo, syncIntervalMinutes: 60, commitDebounceSeconds: 2, autoPush: true, pullOnStart: false, commitOnQuit: true, authorName: 'Smoke Test', authorEmail: 'smoke@example.com', trackingEnabled: true, trackFocus: false, idleMinutes: 0, activityInRepo: true, captureCommits: true })
)

// The probe test extension, loaded from its folder (a machine-local development override).
await fs.writeFile(path.join(userData, 'extension-dev.json'), JSON.stringify({ probe: path.join(appRoot, 'tests/fixtures/extensions/probe') }))

const app = await electron.launch({
  args: [appRoot, '--no-sandbox', '--disable-gpu'],
  // This CI box has no keyring; extension secrets use Electron's in-memory key here (tests only).
  env: { ...process.env, DEVLOG_USER_DATA: userData, NODE_ENV: 'production', DEVLOG_PLAINTEXT_SECRETS: '1' }
})
const failures = []
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) failures.push(msg)
}
app.on('console', (m) => console.log('  [main]', m.text()))

try {
  const page = await app.firstWindow()
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('  [renderer]', m.type(), m.text())
  })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.waitForSelector('.empty-home', { timeout: 30_000 })
  check((await page.locator('.topbar-title').textContent()) === 'Devlog', 'window renders its own title bar')
  check((await page.locator('.hamburger').count()) === 1, 'title bar has the hamburger menu button')
  check(!(await page.locator('.sidebar').textContent()).includes('Journal'), 'there is no journal in the sidebar')
  check((await page.locator('.composer-dock').count()) === 0, 'with no canvas yet there is nowhere to post; the page offers a first canvas')
  check((await page.locator('.sidebar-foot .sidebar-settings').count()) === 1 && (await page.locator('.statusbar button[title^="Settings"]').count()) === 0, 'Settings sits at the foot of the sidebar')
  await page.screenshot({ path: path.join(shots, '01-empty.png') })

  const canvasIdOf = async (title) => (await page.evaluate(() => window.devlog.canvases.list())).find((c) => c.title === title)?.id
  const canvasFolder = (id) => path.join(repo, 'canvases', id.slice(0, 2), id)
  // The time extension's status bar item (a view in a sandboxed frame).
  const timeStatus = () => page.frameLocator('[data-ext-view="devlog-time/status"] iframe')
  const timePage = (id) => page.locator(`.sidebar-ext-pages [data-ext-page="devlog-time/${id}"]`).click()
  const stopClock = async () => {
    await timeStatus().getByRole('button', { name: 'Stop' }).click()
    await timeStatus().getByText('No active task').waitFor({ timeout: 10_000 })
  }
  const listFiles = async (dir) => {
    const out = []
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(dir, d.name)
      if (d.isDirectory()) out.push(...(await listFiles(p)))
      else out.push(p)
    }
    return out
  }
  const openCanvasNamed = async (title) => {
    await page.locator('.canvas-tree .canvas-link', { hasText: title }).first().click()
    await page.waitForSelector(`.page-head .crumb.is-current:has-text("${title}")`, { timeout: 10_000 })
  }
  const openSettings = async (pageId) => {
    if ((await page.locator('.modal-settings').count()) === 0) await page.locator('.sidebar-settings').click()
    await page.waitForSelector('.modal-settings', { timeout: 5_000 })
    if (pageId) await page.locator(`.modal-settings .paged-link[data-page="${pageId}"]`).click()
  }
  const closeSettings = async () => {
    await page.locator('.modal-settings .paged-close').click()
    await page.waitForSelector('.modal-settings', { state: 'detached', timeout: 5_000 })
  }
  await page.locator('.empty-home button').click()
  await page.waitForSelector('.modal-page')
  await page.locator('#canvasTitle').fill('Scratch')
  await page.locator('.modal-page button[type=submit]').click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Scratch")', { timeout: 10_000 })
  await page.waitForSelector('.composer-editor', { timeout: 10_000 })
  const scratchId = await canvasIdOf('Scratch')
  check(true, 'the first canvas comes from the empty page, and the composer posts to it')

  // 1. Post a markdown entry with Slack-style keys.
  const editor = page.locator('.composer-new .composer-editor')
  await editor.click()
  await page.keyboard.type('Started the **git sync** work. ')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('- first item') // "- " input rule starts a bullet list
  await page.keyboard.press('Enter') // new list item
  await page.keyboard.type('second `code` item')
  await page.keyboard.press('Enter') // new (empty) list item
  await page.keyboard.press('Enter') // exits the list
  await page.keyboard.type('done')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('```ts')
  await page.keyboard.press('Enter') // "```ts" input rule opens a highlighted code block
  await page.keyboard.type('const answer: number = 42 // comment')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter') // triple Enter exits the code block
  await page.keyboard.press('Enter') // posts
  await page.keyboard.type('typed immediately after posting') // must not be lost
  await page.waitForSelector('.entry .markdown-body', { timeout: 10_000 })
  const html = await page.locator('.entry .markdown-body').first().innerHTML()
  check(html.includes('<strong>git sync</strong>'), 'bold survives markdown round trip')
  check(html.includes('<li>') && html.includes('<code>code</code>'), 'list and inline code render')
  check(html.includes('language-ts') && html.includes('hljs-comment'), 'code block is syntax highlighted in the feed')
  check((await editor.textContent()).trim() === 'typed immediately after posting', 'composer clears on post without eating later keystrokes')
  await page.keyboard.press('Control+A')
  await page.waitForSelector('.bubble-menu .bm-bold', { timeout: 5_000 })
  check(true, 'bubble menu appears on selection')
  await page.locator('.bubble-menu .bm-bold').click()
  check((await editor.innerHTML()).includes('<strong>'), 'bubble menu applies bold')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  check((await page.locator('.entry').count()) === 1, 'exactly one entry posted')
  check((await page.locator('.composer-toolbar').count()) === 0, 'no toolbar chrome around the composer')

  const today = new Date()
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const dayFile = path.join(canvasFolder(scratchId), 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  const text1 = await fs.readFile(dayFile, 'utf8')
  check(text1.startsWith('<!-- devlog:format 3 -->') && text1.includes('<!-- devlog:add id=') && text1.includes('**git sync**'), 'entry appended to the day file as an add record')
  check(text1.includes('```ts\nconst answer'), 'code block language survives the markdown round trip')

  // 2. Paste an image (1x1 red PNG) and post it.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
  await editor.click()
  await page.keyboard.type('Screenshot: ')
  await editor.evaluate((el, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, Array.from(png))
  await page.waitForSelector('.composer-new .composer-editor img', { timeout: 10_000 })
  const imgOk = await page.locator('.composer-new .composer-editor img').first().evaluate((img) => img.complete && img.naturalWidth > 0)
  check(imgOk, 'pasted image is saved to the repo and displayed in the composer via devlog://')
  await page.screenshot({ path: path.join(shots, '02-image-in-composer.png') })
  await page.keyboard.press('Control+Enter')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 2, null, { timeout: 10_000 })
  check(true, 'Mod+Enter posts')
  await page.waitForFunction(() => {
    const img = document.querySelector('.entry .markdown-body img')
    return img && img.complete && img.naturalWidth > 0
  }, null, { timeout: 10_000 })
  check(true, 'posted image renders in the feed')
  const text2 = await fs.readFile(dayFile, 'utf8')
  check(/!\[shot]\(assets\/\d{4}-\d{2}-\d{2}-\d{6}-[a-z0-9]{4}\.png\)/.test(text2), 'image is linked relative to the day file')
  const assets = await fs.readdir(path.join(path.dirname(dayFile), 'assets'))
  check(assets.length === 1 && assets[0].endsWith('.png'), 'image file stored in assets/ next to the day file')

  // 3. Edit the first entry.
  const first = page.locator('.entry').first()
  await first.hover()
  await first.locator('button', { hasText: 'Edit' }).click()
  const editEditor = page.locator('.composer-edit .composer-editor')
  await editEditor.waitFor()
  await editEditor.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' (edited!)')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry-edited', { state: 'attached', timeout: 10_000 })
  const text3 = await fs.readFile(dayFile, 'utf8')
  check(text3.startsWith(text2) && /<!-- devlog:edit id=\w+ at=/.test(text3) && text3.includes('(edited!)'), 'an edit is appended as an edit record; nothing earlier in the file changes')

  // 3b. Blocks are pages: double-click opens one; what you write there goes inside it.
  await first.locator('.entry-body').dblclick()
  await page.waitForSelector('.block-page-head .block-surface .entry-surface', { timeout: 10_000 })
  check((await page.locator('.block-page-head .crumb.is-current').textContent()).startsWith('Started the git sync'), 'double-clicking a block opens it as a page, titled by its first line')
  check((await page.locator('.block-page-head .crumb').first().textContent()) === 'Scratch', "the page's breadcrumb starts at its canvas")
  await editor.click()
  await page.keyboard.type('a note inside the block')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.note-slot .entry-body')].some((e) => e.textContent.includes('a note inside the block')), null, { timeout: 10_000 })
  check(true, 'the note box on a page writes inside the block')
  const text4 = await fs.readFile(dayFile, 'utf8')
  check(/<!-- devlog:add id=\w+ parent=\w+ pos=/.test(text4) && text4.startsWith(text3) && !/^#{3,6} /m.test(text4), "it is stored in the block's day file with a parent link")
  await editor.click()
  await page.keyboard.type('deeper still')
  await page.keyboard.press('Alt+Enter')
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent === 'deeper still', null, { timeout: 10_000 })
  check(true, 'Alt+Enter posts and opens the new block')
  check((await page.locator('.block-page-head .crumb-block').textContent()).startsWith('Started the git sync'), 'the breadcrumb runs through the blocks above')
  await page.screenshot({ path: path.join(shots, '02b-block-page.png') })
  await page.keyboard.press('Alt+ArrowUp')
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent?.startsWith('Started the git sync'), null, { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelectorAll('.note-slot .entry').length === 2, null, { timeout: 10_000 })
  check(true, 'Alt+↑ goes up a level, to the page with both blocks written inside it')
  await page.keyboard.press('Alt+ArrowLeft')
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent === 'deeper still', null, { timeout: 10_000 })
  check(true, 'back returns to the page before')
  await page.locator('.block-up').click()
  await page.locator('.block-up').click()
  await page.waitForSelector('.page-head:not(.block-page-head) .crumb.is-current:has-text("Scratch")', { timeout: 10_000 })
  check((await page.locator('.thread').count()) === 0 && (await page.locator('.entry', { hasText: 'a note inside the block' }).count()) === 0, 'the canvas stream shows no inline threads')
  check((await first.locator('.entry-inside').textContent()).includes('2 blocks inside'), 'the chip counts everything inside the block')

  // Pages opened lately head the quick switcher.
  await page.locator('.topbar-go').click()
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  const firstSwitch = await page.locator('.switcher-item .switcher-label').first().textContent()
  check(firstSwitch.startsWith('Scratch / Started the git sync'), `the quick switcher lists recent pages first (${firstSwitch})`)
  await page.keyboard.type('deeper')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent === 'deeper still', null, { timeout: 10_000 })
  check(true, 'and opens them')
  // Move a block out of the one it is in, then back inside (through the same API the drag uses).
  await page.keyboard.press('Alt+ArrowUp')
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent?.startsWith('Started the git sync'), null, { timeout: 10_000 })
  const deeper = page.locator('.note-slot .entry', { hasText: 'deeper still' })
  await deeper.hover()
  await deeper.locator('button', { hasText: 'Move' }).click()
  await page.locator('.move-select').selectOption('__out')
  await page.waitForFunction(() => document.querySelectorAll('.note-slot .entry').length === 1, null, { timeout: 10_000 })
  await page.locator('.block-up').click()
  await page.waitForSelector('.page-head:not(.block-page-head) .crumb.is-current:has-text("Scratch")', { timeout: 10_000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.note-slot > .note > .entry .entry-body')].some((e) => e.textContent.trim() === 'deeper still'), null, { timeout: 10_000 })
  check(true, 'Move → "Out of this block" puts it beside the block it was in')
  const scratchDay = await page.evaluate(([id, d]) => window.devlog.blocks.getDay(id, d), [scratchId, ymd])
  const startedId = scratchDay.entries.find((e) => e.markdown.startsWith('Started the')).id
  const deeperId = scratchDay.entries.find((e) => e.markdown === 'deeper still').id
  await page.evaluate(([c, d, id, parent]) => window.devlog.blocks.move(c, d, id, { canvasId: c, date: d, parentId: parent }), [scratchId, ymd, deeperId, startedId])
  const nested = await page.evaluate(([id, d]) => window.devlog.blocks.getDay(id, d), [scratchId, ymd])
  check(nested.entries.find((e) => e.id === deeperId)?.parentId === startedId, 'a block can be moved inside another')
  // Moved behind the app's back: leave the canvas and come back to see it.
  await page.locator('.sidebar-views .view-link', { hasText: 'Timeline' }).click()
  await page.waitForSelector('.tlb, .feed-empty', { timeout: 10_000 })
  await openCanvasNamed('Scratch')
  await page.waitForFunction(() => document.querySelectorAll('.note-slot > .note > .entry').length === 2, null, { timeout: 10_000 })

  const gaps = page.locator('.note-slot .gap')
  await gaps.nth(1).hover()
  await gaps.nth(1).locator('.gap-add').click()
  const insertEditor = page.locator('.composer-insert .composer-editor')
  await insertEditor.waitFor()
  await insertEditor.click()
  await page.keyboard.type('inserted between')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.note-slot').length === 3, null, { timeout: 10_000 })
  const order = await page.locator('.note-slot > .note > .entry .markdown-body').evaluateAll((els) => els.map((e) => e.textContent.trim().slice(0, 16)))
  check(order[1] === 'inserted between', `inserted note sits between the two existing notes (${order.join(' | ')})`)
  await page.screenshot({ path: path.join(shots, '02b-insert.png') })

  // 3c. Up arrow in the empty composer edits the last note.
  await editor.click()
  await page.keyboard.press('ArrowUp')
  await page.waitForSelector('.entry-editing', { timeout: 5_000 })
  check(true, 'Up arrow in the empty composer opens the last note for editing')
  await page.waitForFunction(() => Boolean(document.activeElement?.closest('.entry-editing')), null, { timeout: 5_000 })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.entry-editing'), null, { timeout: 5_000 })

  // 3d. Canvases: a client canvas, a project canvas inside it, blocks on it.
  await page.locator('.sidebar-add').click()
  await page.waitForSelector('.modal-page')
  await page.locator('#canvasTitle').fill('Acme Corp')
  await page.locator('#canvasParent').selectOption('')
  await page.locator('.modal-page button[type=submit]').click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Acme Corp")', { timeout: 10_000 })
  const acmeId = await canvasIdOf('Acme Corp')
  check(/^[0-9a-z]{10}$/.test(acmeId ?? ''), `canvas ids are random (${acmeId})`)
  check((await fs.stat(path.join(canvasFolder(acmeId), 'canvas.md'))).isFile(), 'canvas.md written under canvases/<xx>/<id>/')
  check(JSON.parse(await fs.readFile(path.join(repo, 'devlog.json'), 'utf8')).format === 4, 'a new devlog is created at storage format 4')
  check((await fs.readFile(path.join(repo, '.gitattributes'), 'utf8')).includes('merge=union'), 'block files merge by keeping both sides')
  await page.locator('.sidebar-add').click()
  await page.waitForSelector('.modal-page')
  check((await page.locator('#canvasParent').inputValue()) === acmeId, 'new canvas from inside a canvas is pre-filed under it')
  await page.locator('#canvasTitle').fill('Website')
  await page.locator('#canvasParent').selectOption(acmeId)
  // A git repository for the project so its commits are captured later.
  const proj = path.join(tmp, 'proj')
  await fs.mkdir(proj)
  git(['init', '--initial-branch=main'], proj)
  git(['config', 'user.name', 'Dev'], proj)
  git(['config', 'user.email', 'd@e.com'], proj)
  await fs.writeFile(path.join(proj, 'a.txt'), '1')
  git(['add', '-A'], proj)
  git(['-c', 'user.name=Dev', '-c', 'user.email=d@e.com', 'commit', '-m', 'initial'], proj)
  await page.locator('.modal-page button[type=submit]').click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")', { timeout: 10_000 })
  const treeLabels = (await page.locator('.canvas-tree .canvas-name').evaluateAll((els) => els.map((e) => e.textContent.trim()))).filter((l) => l !== 'Scratch')
  check(treeLabels.join('>') === 'Acme Corp>Website', `sidebar nests client → project (${treeLabels.join(' > ')})`)
  check((await page.locator('.breadcrumbs .crumb').first().textContent()) === 'Acme Corp', 'canvas header shows the parent as a breadcrumb')
  check((await page.locator('.entry').count()) === 0, 'new canvas starts empty')
  const websiteId = await canvasIdOf('Website')
  const canvasFile = path.join(canvasFolder(websiteId), 'canvas.md')
  check((await fs.readFile(canvasFile, 'utf8')).includes(`parent: ${acmeId}`), 'canvas.md carries the parent')

  const pageEditor = page.locator('.composer-new .composer-editor')
  await pageEditor.click()
  await page.keyboard.type('first note for acme')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  const acmeFile = path.join(canvasFolder(websiteId), 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(acmeFile, 'utf8')).includes('first note for acme'), 'block stored under canvases/website/entries')
  // Time tracking is the devlog-time extension (0.17): switched on for this machine because it tracked time before.
  const devlogJson = JSON.parse(await fs.readFile(path.join(repo, 'devlog.json'), 'utf8'))
  check(devlogJson.extensions?.['devlog-time'] === 'builtin', 'a machine that tracked time gets the devlog-time extension added to the devlog')
  await timeStatus().getByText('No active task').waitFor({ timeout: 30_000 })
  check(true, "devlog-time's status bar item shows, allowed without asking (it was on before)")
  await page.waitForTimeout(300)
  check((await timeStatus().locator('body').textContent()).includes('No active task'), 'posting on a non-task canvas is just a note; no task starts')

  // 3d'. Tasks: Mod+Shift+Enter, "#task", and the block action each turn a block into a task canvas.
  await pageEditor.click()
  await page.keyboard.type('Fix the login redirect. It loops on Safari.')
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForSelector('.entry-task', { timeout: 10_000 })
  await timeStatus().locator('.tt-label', { hasText: 'Fix the login redirect' }).waitFor({ timeout: 10_000 })
  check(true, 'Mod+Shift+Enter posts the block as a task and makes it the active task')
  check((await page.locator('.entry-task .task-chip').first().textContent()).includes('Fix the login redirect'), 'the task block links to its canvas')
  check((await page.locator('.canvas-tree .canvas-node.is-task .canvas-name').first().textContent()) === 'Fix the login redirect', 'the task canvas appears under its project in the sidebar')
  const fixId = await canvasIdOf('Fix the login redirect')
  check((await fs.readFile(acmeFile, 'utf8')).includes(`kind=task canvas=${fixId}`), 'task block stored with kind=task and its canvas id')
  check((await fs.readFile(path.join(canvasFolder(fixId), 'canvas.md'), 'utf8')).includes('task: true'), 'task canvas.md carries task: true')
  const timeLog = path.join(repo, 'extensions', 'builtin.devlog-time')
  const timeFiles = await listFiles(timeLog)
  check(timeFiles.some((f) => f.endsWith(`${ymd}.jsonl`)), `the clock writes its events in its own folder (${timeFiles.map((f) => path.relative(timeLog, f)).join(', ')})`)
  await stopClock()
  check(true, 'Stop clears the active task')

  await pageEditor.click()
  await page.keyboard.type('#task Write the launch checklist')
  await page.keyboard.press('Enter')
  await timeStatus().locator('.tt-label', { hasText: 'Write the launch checklist' }).waitFor({ timeout: 10_000 })
  check(true, '"#task" on the first line turns a block into a task')
  check(!(await fs.readFile(acmeFile, 'utf8')).includes('#task'), 'the #task tag is stripped from the stored block')
  await stopClock()

  await pageEditor.click()
  await page.keyboard.type('[45m] retro-logged call')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.duration-chip', { state: 'attached', timeout: 10_000 })
  check((await page.locator('.entry .duration-chip').first().textContent()) === '45m', 'explicit duration marker renders as a chip')

  // The block header (time, actions) floats over what is above and takes no space.
  await page.mouse.move(5, 5)
  const layout = await page.locator('.note-slot > .note > .entry').first().evaluate((el) => {
    const meta = el.querySelector('.entry-meta')
    const body = el.querySelector('.entry-body')
    return { visibility: getComputedStyle(meta).visibility, position: getComputedStyle(meta).position, bodyOffset: body.getBoundingClientRect().top - el.getBoundingClientRect().top }
  })
  check(layout.visibility === 'hidden' && layout.position === 'absolute', `timestamps are hidden until hover (${layout.visibility}, ${layout.position})`)
  check(layout.bodyOffset <= 10, `the header takes no vertical space (body starts ${Math.round(layout.bodyOffset)}px into the block)`)
  await page.locator('.note-slot > .note > .entry').first().hover()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.note-slot > .note > .entry > .entry-meta')).visibility === 'visible', null, { timeout: 5_000 })
  check(true, 'hovering a block reveals its timestamp over the block above')
  check((await page.locator('.entry .entry-kind').count()) === 0, 'no text labels on blocks; kinds are shown by the leading brace')
  check((await page.locator('.entry-task > .entry-brace.brace-task').count()) === 2, 'task blocks carry an accent brace')

  // Open the task canvas from its brace; Start lives in the status bar and offers the canvas on screen first.
  await page.locator('.entry-task > .entry-brace').first().click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Fix the login redirect")', { timeout: 10_000 })
  check((await page.locator('.breadcrumbs').textContent()).includes('Acme Corp') && (await page.locator('.breadcrumbs').textContent()).includes('Website'), 'task canvas breadcrumbs run client / project / task')
  const header = page.frameLocator('.page-head [data-ext-view="devlog-time/header"] iframe')
  await header.getByRole('button', { name: /Start/ }).waitFor({ timeout: 10_000 })
  check(true, 'a task canvas offers Start in its header (a view of the time extension)')
  await timeStatus().locator('.tt-split', { hasText: 'Fix the login redirect' }).waitFor({ timeout: 10_000 })
  check(true, "the status bar's Start button offers the task on screen")
  await timeStatus().locator('.tt-split button').last().click()
  const picker = page.frameLocator('.ext-popover iframe')
  await picker.locator('.dl-menu-item').first().waitFor({ timeout: 10_000 })
  check((await picker.locator('.dl-menu-item').first().textContent()).includes('Fix the login redirect'), 'its drop-down lists the tasks, the one on screen first')
  await picker.locator('input').press('Escape')
  await page.waitForSelector('.ext-popover', { state: 'detached', timeout: 5_000 })
  check(true, 'Escape closes the list again')
  await timeStatus().locator('.tt-split button').first().click()
  await header.getByRole('button', { name: /Stop/ }).waitFor({ timeout: 10_000 })
  await page.waitForSelector('.canvas-icon.is-active', { timeout: 10_000 })
  check(true, 'one click on Start starts the task on screen; its header offers Stop, and the sidebar marks it')
  await page.locator('.composer-new .composer-editor').click()
  await page.keyboard.type('Reproduced it: the redirect keeps the hash.')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  const taskFile = path.join(canvasFolder(fixId), 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(taskFile, 'utf8')).includes('Reproduced it'), 'blocks on a task canvas are stored under its own folder')
  await stopClock()
  await page.locator('.breadcrumbs .crumb', { hasText: 'Website' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")', { timeout: 10_000 })

  // Link the repo to the canvas (the folder picker is native; set repos through the API path the header button uses).
  check((await page.locator('.canvas-repos .repo-add').count()) === 1, 'canvas header offers "Link a repository"')
  await page.evaluate(([id, dir]) => window.devlog.canvases.update(id, { repos: [dir] }), [websiteId, proj])
  // The header button refreshes the UI itself; after a direct API call, reopen the canvas.
  await openCanvasNamed('Scratch')
  await openCanvasNamed('Website')
  await page.waitForSelector('.repo-chip', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  check((await page.locator('.entry-commit').count()) === 0, 'linking does not import history unless asked')
  const imported = await page.evaluate(([id, dir]) => window.devlog.repo.importHistory(id, dir, 30), [websiteId, proj])
  await page.waitForSelector('.entry-commit', { timeout: 30_000 })
  check(imported === 1 && (await page.locator('.entry-commit .entry-body').first().textContent()).includes('initial'), `importing history on request adds your recent commits (${imported})`)
  check((await page.locator('.entry-commit > .entry-brace.brace-auto').count()) === 1, 'automatic blocks carry a muted brace')
  check((await page.evaluate(([id, dir]) => window.devlog.repo.importHistory(id, dir, 30), [websiteId, proj])) === 0, 'importing twice adds nothing')
  check((await page.locator('.repo-chip').textContent()).includes('proj'), 'linked repository shows as a chip on the canvas')
  await fs.writeFile(path.join(proj, 'a.txt'), '2')
  git(['add', '-A'], proj)
  git(['-c', 'user.name=Dev', '-c', 'user.email=d@e.com', 'commit', '-m', 'Add the widget'], proj)
  await page.waitForFunction(() => document.querySelectorAll('.entry-commit').length === 2, null, { timeout: 30_000 })
  const commitText = await page.locator('.entry-commit .entry-body').last().textContent()
  check(commitText.includes('proj') && commitText.includes('Add the widget'), `commit captured as a read-only block (${commitText.trim().slice(0, 60)})`)
  await page.locator('.entry-commit').first().hover()
  check((await page.locator('.entry-commit').first().locator('button', { hasText: 'Edit' }).count()) === 0, 'commit blocks have no Edit action')
  check((await fs.readFile(acmeFile, 'utf8')).includes('kind=commit'), 'commit block stored with kind=commit')
  // Branch work in the watched repo lands in the activity log (shown on the timeline), not as blocks.
  git(['checkout', '-q', '-b', 'feature/widget'], proj)
  await page.waitForFunction(async () => {
    const evs = await window.devlog.activity.range(new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10))
    return evs.some((e) => e.type === 'git' && e.action === 'checkout' && e.branch === 'feature/widget')
  }, null, { timeout: 30_000 })
  check(true, 'switching branches in a watched repo is recorded as a git activity event')
  const websiteBlocks = await page.locator('.entry').count()
  check(websiteBlocks === 6, `branch switch does not create a block (${websiteBlocks} blocks)`)

  // With a task under this canvas active, the next commit lands on the task, not the canvas.
  await page.evaluate((id) => window.devlog.extensions.run('devlog-time', 'start', { source: 'menu', canvasId: id }), fixId)
  await timeStatus().locator('.tt-label', { hasText: 'Fix the login redirect' }).waitFor({ timeout: 10_000 })
  await fs.writeFile(path.join(proj, 'a.txt'), '3')
  git(['add', '-A'], proj)
  git(['-c', 'user.name=Dev', '-c', 'user.email=d@e.com', 'commit', '-m', 'Route to the task'], proj)
  await page.waitForFunction(async (id) => {
    const d = await window.devlog.blocks.getDay(id, new Date().toISOString().slice(0, 10))
    return d.entries.some((e) => e.kind === 'commit' && e.markdown.includes('Route to the task'))
  }, fixId, { timeout: 30_000 })
  check(true, 'a commit made while a task under the linked canvas is active lands on that task')
  check((await page.locator('.entry-commit').count()) === 2, 'the routed commit does not also land on the canvas')
  await stopClock()

  // Linking checks for a git repository; unlinking is one click on the chip.
  const notRepo = path.join(tmp, 'not-a-repo')
  await fs.mkdir(notRepo)
  const refused = await page.evaluate(([id, dir]) => window.devlog.canvases.update(id, { repos: [dir] }).then(() => 'accepted', (e) => String(e.message ?? e)), [websiteId, notRepo])
  check(refused.includes('not a git repository'), `linking a folder that is not a git repository is refused (${refused.slice(-60)})`)
  const inspected = await page.evaluate((dir) => window.devlog.repo.inspectWorkingCopy(dir), path.join(proj, '.git'))
  check(inspected.ok === false || inspected.root === proj, 'inspecting reports the repository root or a reason')
  await page.locator('.repo-chip .repo-remove').first().click()
  await page.waitForFunction(() => !document.querySelector('.repo-chip'), null, { timeout: 10_000 })
  check(true, 'the ✕ on a repository chip unlinks it')
  check(!(await fs.readFile(canvasFile, 'utf8')).includes('repo:'), 'unlinking removes the repo line from canvas.md; captured commits stay')
  const afterUnlink = await page
    .waitForFunction(() => document.querySelectorAll('.entry-commit').length === 2, null, { timeout: 5_000 })
    .then(() => 2, async () => page.locator('.entry-commit').count())
  check(afterUnlink === 2, `commit blocks survive unlinking (${afterUnlink})`)
  await page.screenshot({ path: path.join(shots, '02c-canvas.png') })

  // Hide a block: it collapses into a stub, stays in the file, and comes back.
  const toHide = page.locator('.entry:not(.entry-task):not(.entry-commit)').first()
  await toHide.hover()
  await toHide.locator('button', { hasText: 'Hide' }).click()
  await page.waitForSelector('.hidden-stub', { timeout: 10_000 })
  check((await page.locator('.hidden-stub').textContent()).includes('1 hidden block'), 'a hidden block collapses into a stub')
  check((await fs.readFile(acmeFile, 'utf8')).includes('hidden=1'), 'hidden flag stored in the day file; the text is kept')
  await page.locator('.hidden-stub').click()
  await page.waitForSelector('.note-slot.is-hidden .entry', { timeout: 5_000 })
  const revealed = page.locator('.note-slot.is-hidden .entry').first()
  await revealed.hover()
  await revealed.locator('button', { hasText: 'Unhide' }).click()
  await page.waitForFunction(() => !document.querySelector('.hidden-stub'), null, { timeout: 10_000 })
  check(true, 'Unhide brings the block back into the stream')

  // Drag the last block above the first one: order changes, timestamps do not, and the file only grows by one record.
  const websiteDay = () => page.evaluate(([id, d]) => window.devlog.blocks.getDay(id, d), [websiteId, ymd])
  const topLevel = (day) => day.entries.filter((e) => !e.parentId).map((e) => e.markdown.split('\n')[0])
  const beforeDay = await websiteDay()
  const beforeOrder = topLevel(beforeDay)
  const beforeText = await fs.readFile(acmeFile, 'utf8')
  const lastEntry = page.locator('.note-slot').last()
  await lastEntry.locator('.entry').first().hover()
  // Drag like a person: press on the grip, start moving while still over the block, then travel.
  const grip = await lastEntry.locator('.entry-grip').first().boundingBox()
  const target = await page.locator('.note-slot').first().boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 4, grip.y + grip.height / 2 + 6, { steps: 4 })
  await page.mouse.move(target.x + 200, target.y + 8, { steps: 12 })
  await page.mouse.up()
  await page.waitForFunction((first) => {
    const bodies = [...document.querySelectorAll('.note-slot > .note > .entry .entry-body')].map((e) => e.textContent.trim())
    return bodies[0] !== first
  }, beforeOrder[0], { timeout: 10_000 })
  const afterText = await fs.readFile(acmeFile, 'utf8')
  const afterDay = await websiteDay()
  const afterOrder = topLevel(afterDay)
  check(afterOrder[0] === beforeOrder[beforeOrder.length - 1] && afterOrder.length === beforeOrder.length, `drag and drop reorders blocks within the day (${afterOrder.map((t) => t.slice(0, 12)).join(' | ')})`)
  const stamps = (day) => day.entries.map((e) => `${e.id}@${e.createdAt}`).sort().join()
  check(stamps(afterDay) === stamps(beforeDay), 'reordering keeps every timestamp')
  const appended = afterText.startsWith(beforeText) ? afterText.slice(beforeText.length) : ''
  check(/^<!-- devlog:set id=\w+ pos=\S+ at=\S+ -->\n$/.test(appended), `a reorder appends one record (${JSON.stringify(appended).slice(0, 80)})`)

  // The block action "Make task" (the time extension's) promotes an existing block.
  const plain = page.locator('.entry:not(.entry-task):not(.entry-commit)').first()
  await plain.hover()
  await plain.locator('button', { hasText: 'Make task' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.entry-task').length === 3, null, { timeout: 10_000 })
  check(true, 'the Make task action turns an existing block into a task')
  await stopClock()

  await openCanvasNamed('Scratch')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 3, null, { timeout: 10_000 })
  const journalLast = page.locator('.note-slot > .note > .entry').last()
  await journalLast.hover()
  await journalLast.locator('button', { hasText: 'Move' }).click()
  await page.locator('.move-select').selectOption(websiteId)
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 2, null, { timeout: 10_000 })
  check((await fs.readFile(acmeFile, 'utf8')).includes('Screenshot:'), 'block moved from one canvas into another')
  check(new RegExp(`!\\[shot]\\(\\.\\./[./]*${scratchId.slice(0, 2)}/${scratchId}/entries/`).test(await fs.readFile(acmeFile, 'utf8')), 'moved block keeps its image via a relative link')
  const journalAfterMove = await page.evaluate(([id, d]) => window.devlog.blocks.getDay(id, d), [scratchId, ymd])
  check(!journalAfterMove.entries.some((e) => e.markdown.includes('Screenshot:')) && /<!-- devlog:delete id=/.test(await fs.readFile(dayFile, 'utf8')), 'moved block leaves its canvas (a delete record; the file is never rewritten)')

  await page.locator('.topbar-search').fill('acme')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit-day').first().textContent()).includes('Acme Corp / Website'), 'search results name the canvas with its full path')
  await page.locator('.topbar-search').fill('')

  // 3d-surface. The canvas surface: read mode by default, editor on demand, autosaved into canvas.md.
  await page.locator('.canvas-tree .canvas-link', { hasText: 'Acme Corp' }).first().click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Acme Corp")', { timeout: 10_000 })
  check((await page.locator('.canvas-children .child-chip').count()) >= 1, 'a canvas lists the canvases inside it')
  await page.locator('.page-head button', { hasText: 'Add surface' }).click()
  await page.waitForSelector('.surface .composer-document .composer-editor', { timeout: 10_000 })
  const surfaceEditor = page.locator('.surface .composer-editor')
  await surfaceEditor.click()
  await page.keyboard.type('# Links')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Issue tracker: https://issues.example.com/acme')
  await page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved', null, { timeout: 10_000 })
  const acmeCanvasText = await fs.readFile(path.join(canvasFolder(acmeId), 'canvas.md'), 'utf8')
  check(acmeCanvasText.includes('title: Acme Corp') && acmeCanvasText.includes('# Links') && acmeCanvasText.includes('issues.example.com'), 'surface autosaves into the canvas.md')
  await page.locator('.page-head button', { hasText: 'Done' }).click()
  await page.waitForSelector('.surface-read', { timeout: 10_000 })
  check((await page.locator('.surface-read a').count()) === 1, 'surface read mode renders the link as a hyperlink')
  check((await page.locator('.surface .composer-editor').count()) === 0, 'surface read mode hides the editor')
  await page.screenshot({ path: path.join(shots, '02c2-surface.png') })
  await page.locator('.page-head button', { hasText: 'Edit surface' }).click()
  await page.waitForSelector('.surface .composer-editor', { timeout: 10_000 })
  check((await page.locator('.surface .composer-editor').textContent()).includes('Links'), 'Edit surface reopens the editor with its content')

  // 3d-archive. Archive the project: it and its tasks leave the tree, stay searchable, come back.
  await page.locator('.canvas-children .child-chip', { hasText: 'Website' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")')
  await page.locator('.page-head button', { hasText: 'Archive' }).click()
  await page.locator('.page-head button.btn-danger', { hasText: 'Archive' }).click()
  await page.waitForSelector('.archived-banner', { timeout: 10_000 })
  const visible = await page.locator('.canvas-tree .canvas-name').allTextContents()
  check(visible.join('>') === 'Acme Corp>Scratch', `archived project and its tasks leave the sidebar tree (${visible.join(' > ')})`)
  check((await page.locator('.composer-new').count()) === 0, 'archived canvas has no composer')
  check((await page.locator('.sidebar-archived').textContent()).includes('Archived (4)'), 'sidebar shows an Archived section with the project and its three tasks')
  await page.locator('.topbar-search').fill('first note for acme')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit-day').first().textContent()).includes('archived'), 'search still finds blocks on the archived canvas and says so')
  await page.locator('.topbar-search').fill('issues.example')
  await page.waitForSelector('.hit-wiki', { timeout: 10_000 })
  check(true, 'search finds surface content')
  await page.locator('.topbar-search').fill('')
  await page.locator('.sidebar-archived .archived-toggle').click()
  await page.locator('.sidebar-archived .view-link', { hasText: /Website$/ }).first().click()
  await page.waitForSelector('.archived-banner')
  await page.locator('.page-head button', { hasText: 'Unarchive' }).click()
  await page.locator('.page-head button.btn-primary', { hasText: 'Unarchive' }).click()
  await page.waitForFunction(() => !document.querySelector('.archived-banner'), null, { timeout: 10_000 })
  check((await page.locator('.canvas-tree .canvas-name').count()) === 6, 'unarchived project and its tasks return to the sidebar tree')

  // 3e. Weekly review rolls blocks up by client → project → task.
  await page.locator('.sidebar-views .view-link', { hasText: 'Weekly review' }).click()
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  const rowLabels = await page.locator('.review-table tbody th').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(rowLabels[0] === 'Acme Corp' && rowLabels[1] === 'Website' && rowLabels.at(-2) === 'Scratch' && rowLabels.at(-1) === 'Total', `review rows nest client → project → task, busiest first (${rowLabels.join(' | ')})`)
  check(rowLabels.some((l) => l.includes('Fix the login redirect')), 'task canvases appear as rows')
  const acmeTotal = await page.locator('.review-category.depth-0 .review-total .cell-notes').first().textContent()
  check(Number(acmeTotal) >= 8, `client row sums its blocks for the week (${acmeTotal})`)
  // (≥ 1: a run that straddles midnight writes blocks on two days.)
  check((await page.locator('.review-day-section').count()) >= 1, 'per-day detail lists the days with blocks')
  check((await page.locator('.review-group-label').first().textContent()) === 'Acme Corp', 'day detail groups by top-level canvas')
  check((await page.locator('.review-segments li').count()) >= 1, 'review shows tracked task segments for today')
  // Correct tracked time: remove a stretch, see it listed as removed, restore it.
  const segCount = await page.locator('.review-segments .seg-row').count()
  check((await page.locator('.review-segments .seg-row', { hasText: '✎' }).locator('button', { hasText: 'Remove' }).count()) === 0, 'explicit [45m] time offers no Remove; the marker is the source of truth')
  const firstSeg = page.locator('.review-segments .seg-row').filter({ has: page.locator('button', { hasText: 'Remove' }) }).first()
  await firstSeg.hover()
  await firstSeg.locator('button', { hasText: 'Remove' }).click()
  await page.waitForSelector('.review-removed li', { timeout: 10_000 })
  check((await page.locator('.review-segments .seg-row').count()) === segCount - 1, 'Remove takes the stretch out of task time')
  const excl = await page.evaluate(async () => {
    const d = new Date().toISOString().slice(0, 10)
    return (await window.devlog.activity.range(d, d)).filter((e) => e.type === 'exclude').length
  })
  check(excl >= 1, 'the removal is recorded as a correction in the activity log; raw events are untouched')
  await page.locator('.review-removed button', { hasText: 'Restore' }).first().click()
  await page.waitForFunction((n) => document.querySelectorAll('.review-segments .seg-row').length === n && !document.querySelector('.review-removed li'), segCount, { timeout: 10_000 })
  check(true, 'Restore puts the stretch back')
  await page.screenshot({ path: path.join(shots, '02d-review.png') })

  // 3f. Day timeline merges blocks, task switches, git events and commits.
  await page.locator('.sidebar-views .view-link', { hasText: 'Timeline' }).click()
  await page.waitForSelector('.tlb', { timeout: 10_000 })
  const tlText = await page.locator('.tlb-list').textContent()
  check(tlText.includes('Fix the login redirect'), 'timeline bucket names the active task')
  check((await page.locator('.tlb-commit').count()) >= 2, 'timeline shows the captured commits')
  check((await page.locator('.tlb-notes .tl-link').count()) >= 5, 'timeline lists the blocks written in the interval')
  const gitLines = await page.locator('.tlb-git li').allTextContents()
  check(gitLines.some((t) => t.includes('switched to feature/widget')) && gitLines.some((t) => t.includes('created branch feature/widget')), `timeline lists branch events (${gitLines.join(' | ')})`)
  check((await page.locator('.composer-dock .composer-target select').count()) === 1, 'composer stays available on the timeline with a canvas picker')
  await page.screenshot({ path: path.join(shots, '02e-timeline.png') })
  await page.locator('.tlb-notes .tl-link').last().click()
  await page.waitForSelector('.composer-new .composer-editor', { timeout: 10_000 })
  check(true, 'clicking a timeline block opens its canvas')

  // 3g. Summary: hours per top-level item, rounded to the chosen granularity.
  // The Summary is the time extension's page (a view in a sandboxed frame), listed with the app's views.
  await timePage('summary')
  const sum = page.frameLocator('iframe.ext-page-view')
  await sum.locator('.sum-list').waitFor({ timeout: 20_000 })
  const sumLabels = await sum.locator('.sum-list > .sum-row > .sum-top > .sum-label').allTextContents()
  check(sumLabels[0].trim() === 'Acme Corp' && sumLabels.includes('Total'), `summary lists top-level items (${sumLabels.join(' | ')})`)
  check(/^\d+(\.\d+)? h$/.test((await sum.locator('.sum-list > .sum-row > .sum-top > .sum-hours').first().textContent()).trim()), 'summary shows rounded hours')
  await sum.locator('.sum-toggle').first().click()
  check((await sum.locator('.sum-children .sum-label').first().textContent()).includes('Website'), 'summary rows expand into projects')
  await page.screenshot({ path: path.join(shots, '02f-summary.png') })

  // 3g'. Speed: with a busy day of window switching from a second machine, the review and summary still open quickly.
  const busyDir = path.join(repo, 'activity', 'busy-machine-0000', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'))
  await fs.mkdir(busyDir, { recursive: true })
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const span = Math.max(60_000, Date.now() - dayStart - 60_000)
  const busy = [JSON.stringify({ t: new Date(dayStart).toISOString(), type: 'start', canvasId: null })]
  for (let i = 0; i < 6000; i++) {
    const t = new Date(dayStart + Math.floor((span * (i + 1)) / 6001)).toISOString()
    busy.push(JSON.stringify(i % 50 ? { t, type: 'focus', app: `app${i % 7}`, title: `window ${i % 23}` } : { t, type: 'heartbeat' }))
  }
  await fs.writeFile(path.join(busyDir, `${ymd}.jsonl`), `${busy.join('\n')}\n`)
  for (const [label, open] of [
    [
      'Weekly review',
      async () => {
        await page.locator('.sidebar-views .view-link', { hasText: 'Weekly review' }).click()
        await page.waitForSelector('.review-table', { timeout: 60_000 })
      }
    ],
    [
      'Summary',
      async () => {
        await timePage('summary')
        await page.frameLocator('iframe.ext-page-view').locator('.sum-list').waitFor({ timeout: 60_000 })
      }
    ]
  ]) {
    await openCanvasNamed('Scratch')
    const t0 = Date.now()
    await open()
    const took = Date.now() - t0
    check(took < 3000, `${label} opens quickly with a busy day of activity from two machines (${took} ms)`)
  }
  await fs.rm(path.join(repo, 'activity', 'busy-machine-0000'), { recursive: true, force: true })

  // 3g''. Back and forward: Alt+← / Alt+→ walk the places visited (Scratch → Weekly review → Summary).
  await openCanvasNamed('Scratch')
  await page.locator('.sidebar-views .view-link', { hasText: 'Weekly review' }).click()
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  await timePage('summary')
  await page.frameLocator('iframe.ext-page-view').locator('.sum-list').waitFor({ timeout: 10_000 })
  await page.keyboard.press('Alt+ArrowLeft')
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  check(true, 'Alt+← goes back to the weekly review')
  await page.keyboard.press('Alt+ArrowLeft')
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Scratch")', { timeout: 10_000 })
  check(true, 'Alt+← again goes back to the canvas')
  await page.keyboard.press('Alt+ArrowRight')
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  check(true, 'Alt+→ goes forward again')
  await openCanvasNamed('Scratch')
  await page.locator('.composer-new .composer-editor').click()
  await page.keyboard.press('Alt+ArrowLeft')
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  check(true, 'Alt+← works while typing in the composer')
  await openCanvasNamed('Scratch')


  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('websit')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")', { timeout: 10_000 })
  check(true, 'quick switcher opens a canvas by fuzzy name')

  // 3i. Pasting a stack trace becomes a code block without any markup.
  const before = await page.locator('.entry').count()
  const traceEditor = page.locator('.composer-new .composer-editor')
  await traceEditor.click()
  await page.evaluate(() => {
    const trace = 'System.NullReferenceException: Object reference not set to an instance of an object.\n   at Acme.Web.Controllers.HomeController.Index() in C:\\src\\HomeController.cs:line 42\n   at lambda_method(Closure , Object , Object[] )'
    const dt = new DataTransfer()
    dt.setData('text/plain', trace)
    document.querySelector('.composer-new .ProseMirror').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelector('.composer-new .ProseMirror pre') !== null, null, { timeout: 5_000 })
  check(true, 'pasted stack trace lands in a code block')
  await page.keyboard.press('Control+Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.entry pre')].some((el) => el.textContent.includes('NullReferenceException')), null, { timeout: 10_000 })
  check((await page.locator('.entry').count()) >= before + 1, 'stack trace block renders as a code block')

  // 3j. Theme: picking a preset recolours the sidebar and top bar at once.
  await openSettings('appearance')
  check(await page.locator('.settings-save').isDisabled(), 'Save stays off until something changes')
  await page.locator('.theme-swatch[title="Ocean"]').click()
  check(!(await page.locator('.settings-save').isDisabled()) && (await page.locator('.paged-link[data-page="appearance"] .paged-badge.is-dirty').count()) === 1, 'a change turns Save on and marks its page')
  await page.locator('.settings-save').click()
  await page.waitForSelector('.modal-settings .state-saved', { timeout: 10_000 })
  check(await page.locator('.settings-save').isDisabled(), 'saved, Save is off again')
  await closeSettings()
  const sidebarBg = await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).backgroundColor)
  check(sidebarBg === 'rgb(21, 48, 72)', `theme preset applies to the sidebar (${sidebarBg})`)
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'))
  check(saved.theme?.preset === 'ocean', 'theme is persisted in settings')

  // 3k. Todos are blocks: the panel gathers them; each opens as a page; ticking marks it where it is.
  await page.locator('.canvas-tree .canvas-link', { hasText: 'Website' }).first().click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")')
  await page.waitForSelector('.todo-panel .todo-add textarea', { timeout: 10_000 })
  const todoInput = page.locator('.todo-panel .todo-add textarea')
  await todoInput.click()
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '- [ ] Send Dana the redirect list\n- [ ] Check the CDN rules\n3. Renew the staging certificate')
    document.querySelector('.todo-panel .todo-add textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.querySelectorAll('.todo-panel .todo:not(.is-done)').length === 3, null, { timeout: 10_000 })
  const todoTexts = await page.locator('.todo-panel .todo .todo-text').allTextContents()
  check(todoTexts.map((t) => t.trim()).join('|') === 'Send Dana the redirect list|Check the CDN rules|Renew the staging certificate', `pasting a list adds one todo per line, markers stripped (${todoTexts.join(' | ')})`)
  const websiteToday = path.join(canvasFolder(websiteId), 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(websiteToday, 'utf8')).match(/kind=todo/g)?.length === 3, "todos are blocks in the canvas's day file")
  await page.waitForFunction(() => document.querySelectorAll('.feed .entry-todo').length === 3, null, { timeout: 10_000 })
  check(true, 'and they show in the stream with a checkbox')
  await todoInput.fill('Ask Priya about launch copy')
  await todoInput.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.todo-panel .todo:not(.is-done)').length === 4, null, { timeout: 10_000 })
  check(true, 'typing a todo and pressing Enter adds it')

  // A todo opens as a page: notes about it, and further todos, go inside it.
  await page.locator('.todo-panel .todo .todo-text', { hasText: 'Send Dana' }).click()
  await page.waitForFunction(() => document.querySelector('.block-page-head .crumb.is-current')?.textContent === 'Send Dana the redirect list', null, { timeout: 10_000 })
  check((await page.locator('.block-surface .entry-todo .entry-check').count()) === 1, "clicking a todo in the panel opens its page, with its checkbox at the top")
  await editor.click()
  await page.keyboard.type('Waiting on their ops team')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.note-slot .entry-body')].some((e) => e.textContent.includes('Waiting on their ops team')), null, { timeout: 10_000 })
  await editor.click()
  await page.keyboard.type('[ ] Chase the DNS change')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.note-slot .entry-todo').length === 1, null, { timeout: 10_000 })
  check((await page.locator('.note-slot .entry-todo .entry-body').textContent()).trim() === 'Chase the DNS change', 'a "[ ] …" line posts a todo, here inside the todo')
  await page.waitForFunction(() => document.querySelectorAll('.todo-panel .todo:not(.is-done)').length === 1, null, { timeout: 10_000 })
  check(true, '"Here" on a page lists the todos inside that page')
  check((await page.locator('.todo-panel .todo', { hasText: 'Chase the DNS change' }).count()) === 1, 'the todo written inside another shows in the panel')
  await page.keyboard.press('Alt+ArrowUp')
  await page.waitForSelector('.page-head:not(.block-page-head) .crumb.is-current:has-text("Website")', { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelectorAll('.todo-panel .todo:not(.is-done)').length === 5, null, { timeout: 10_000 })
  check((await page.locator('.todo-panel .todo-group-label', { hasText: 'Send Dana the redirect list' }).count()) === 1, 'on the canvas, a todo inside another is grouped under it')
  check((await page.locator('.todo-panel .todo', { hasText: 'Send Dana' }).locator('.todo-count').textContent()) === '2', 'the panel counts what is inside a todo')
  await page.locator('.todo-panel .todo-group-caret').first().click()
  check((await page.locator('.todo-panel .todo', { hasText: 'Chase the DNS change' }).count()) === 0, 'a heading folds away what is under it')
  await page.locator('.todo-panel .todo-group-caret').first().click()

  // Tick it off: it moves to Done and is marked done where it is; nothing new is written to the stream.
  const streamBefore = await page.locator('.entry').count()
  await page.locator('.todo-panel .todo', { hasText: 'Send Dana' }).locator('.todo-check').first().click()
  await page.waitForFunction(() => document.querySelector('.feed .entry-todo.is-done') !== null, null, { timeout: 10_000 })
  check((await page.locator('.entry').count()) === streamBefore && (await page.locator('.feed .entry-todo.is-done .entry-body').textContent()).includes('Send Dana'), 'ticking a todo marks it done in the stream; no block is added')
  check((await page.locator('.todo-panel .todo:not(.is-done)', { hasText: 'Send Dana' }).count()) === 0, 'the ticked todo leaves the open list')
  await page.locator('.todo-panel .todo-done-toggle').click()
  check((await page.locator('.todo-panel .todo.is-done').count()) === 1, 'it is listed under Done')
  // The stream's checkbox ticks it too, and unticking from Done brings it back.
  await page.locator('.feed .entry-todo', { hasText: 'Renew the staging certificate' }).locator('.entry-check').click()
  await page.waitForFunction(() => [...document.querySelectorAll('.todo-panel .todo.is-done')].some((e) => e.textContent.includes('Renew the staging certificate')), null, { timeout: 10_000 })
  check(true, "a todo's checkbox in the stream ticks it off")
  await page.locator('.todo-panel .todo.is-done', { hasText: 'Renew the staging certificate' }).locator('.todo-check').click()
  await page.waitForFunction(() => document.querySelectorAll('.feed .entry-todo.is-done').length === 1, null, { timeout: 10_000 })
  check(true, 'unticking brings it back')

  // Scope: "Here" is this canvas and what is inside it; "All" shows everything.
  await page.evaluate((id) => window.devlog.todos.add(id, ['Water the plants']), scratchId)
  await page.locator('.todo-panel .todo-scope').click()
  await page.waitForFunction(() => [...document.querySelectorAll('.todo-panel .todo-text')].some((e) => e.textContent.includes('Water the plants')), null, { timeout: 10_000 })
  check((await page.locator('.todo-panel .todo-group-label', { hasText: 'Scratch' }).count()) === 1, '"All" shows todos from every canvas, under a heading each')
  await page.locator('.todo-panel .todo-scope').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.todo-panel .todo-text')].some((e) => e.textContent.includes('Water the plants')), null, { timeout: 10_000 })
  check(true, '"Here" limits the list to this canvas and what is inside it')

  // Make a todo a task: the Make task action on its block.
  const cdn = page.locator('.feed .entry-todo', { hasText: 'Check the CDN rules' })
  await cdn.hover()
  await cdn.locator('button', { hasText: 'Make task' }).click()
  await timeStatus().locator('.tt-label', { hasText: 'Check the CDN rules' }).waitFor({ timeout: 10_000 })
  check(true, 'the Make task action turns a todo into an active task')
  await stopClock()

  // The panel stays put while the stream scrolls, and collapses to a strip.
  await page.locator('.feed').evaluate((el) => el.scrollTo({ top: 0 }))
  check(await page.locator('.todo-panel .todo').first().isVisible(), 'the todo panel stays visible whatever the stream scroll position')
  await page.screenshot({ path: path.join(shots, '02g-todos.png') })
  await page.locator('.todo-panel .todo-collapse').click()
  await page.waitForSelector('.todo-panel.is-collapsed', { timeout: 5_000 })
  check((await page.locator('.todo-expand-count').textContent()) === '3', 'collapsed, the panel still shows the open count')
  await page.locator('.todo-expand').click()
  await page.waitForSelector('.todo-panel:not(.is-collapsed)')
  // Resizing: drag the panel's left edge; double-click resets it.
  const panelWidth = async () => Math.round((await page.locator('.todo-panel').boundingBox()).width)
  const panelBefore = await panelWidth()
  const handle = await page.locator('.todo-resize').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 - 60, handle.y + 200, { steps: 6 })
  await page.mouse.up()
  const wider = await panelWidth()
  check(wider >= panelBefore + 50 && wider <= panelBefore + 70, `dragging the left edge widens the todo panel (${panelBefore} → ${wider} px)`)
  check((await page.evaluate(() => localStorage.getItem('devlog:todos:width'))) === String(wider), 'the width is remembered')
  await page.locator('.todo-resize').dblclick()
  check((await panelWidth()) === 300, 'double-clicking the edge resets the width')

  await openCanvasNamed('Scratch')

  // 4. Sync runs (debounce is 2s) and pushes to the bare remote.
  await page
    .waitForFunction(() => [...document.querySelectorAll('.statusbar > .status-text')].at(-1)?.textContent === 'Up to date', null, { timeout: 30_000 })
    .catch(async (err) => {
      const texts = await page.locator('.statusbar > .status-text').allTextContents()
      throw new Error(`sync never reported "Up to date" (status: ${texts.join(' | ')}; git: ${git(['status', '--porcelain']).replace(/\n/g, ', ')})`, { cause: err })
    })
  const remoteLog = git(['log', '--oneline', 'main'], bare)
  check(remoteLog.split('\n').length >= 1 && remoteLog.includes(`devlog: ${ymd}`), `changes pushed to the remote (${remoteLog.split('\n')[0]})`)
  check(git(['status', '--porcelain']) === '', 'working tree clean after sync')
  await page.screenshot({ path: path.join(shots, '03-synced.png') })

  // 5. Search.
  await page.locator('.topbar-search').fill('edited')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit').count()) === 1, 'search finds the edited entry')
  await page.locator('.topbar-search').fill('')

  // 6. Settings open from the foot of the sidebar, on the repository page.
  await openSettings()
  check((await page.locator('#remote').inputValue()) === bare, 'settings show the remote url')
  const navGroups = await page.locator('.modal-settings .paged-group-name').allTextContents()
  check(navGroups.join(',') === 'Devlog,Extensions', `settings have their own navigation, in groups (${navGroups.join(', ')})`)
  await page.screenshot({ path: path.join(shots, '04-settings.png') })
  await page.keyboard.press('Escape')

  // 6a. Extensions: add, review and allow with a scope, run commands, canvas fields, sandbox.
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('extensions')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.modal-settings .ext-manage', { timeout: 5_000 })
  check((await page.locator('.ext-manage .ext-item[data-ext]').count()) === 1 && (await page.locator('.ext-manage .ext-item[data-ext="devlog-time"]').count()) === 1, 'Settings → Extensions opens from the quick switcher, with only the time extension so far')
  await page.locator('.ext-add input[aria-label="Source"]').fill('probe')
  await page.locator('.ext-add input[aria-label="Version"]').fill('builtin')
  await page.locator('.ext-add button', { hasText: 'Add' }).click()
  const probeItem = page.locator('[data-ext-page="probe"]')
  await probeItem.locator('.ext-state', { hasText: 'Not allowed yet' }).waitFor({ timeout: 15_000 })
  check((await probeItem.locator('.ext-source').textContent()).includes('Development folder'), 'an added extension installs and waits to be allowed')
  const manifestJson = JSON.parse(await fs.readFile(path.join(repo, 'devlog.json'), 'utf8'))
  check(manifestJson.extensions?.probe === 'builtin' && manifestJson.format === 4, 'devlog.json names the extension')
  await probeItem.locator('button', { hasText: 'Review and allow' }).click()
  await page.waitForSelector('.modal-consent', { timeout: 5_000 })
  check((await page.locator('.modal-consent').textContent()).includes('example.com'), 'the consent dialog shows what it says it talks to')
  await page.screenshot({ path: path.join(shots, '04b-consent.png') })
  await page.locator('.scope-picker[data-scope="read"] .scope-canvases label', { hasText: 'Website' }).locator('input').check()
  await page.locator('.scope-picker[data-scope="write"] .scope-canvases label', { hasText: 'Website' }).locator('input').check()
  await page.locator('.modal-consent button', { hasText: 'Allow' }).click()
  await probeItem.locator('.ext-state', { hasText: 'Running' }).waitFor({ timeout: 20_000 })
  check((await probeItem.locator('.ext-perms').textContent()).includes('Reads: Website'), 'allowed with a scope, it runs')
  check((await page.locator('.modal-settings .paged-link[data-page="ext:probe"]').count()) === 1, 'each extension gets its own page in the settings navigation')
  check(await probeItem.locator('.page-actions button', { hasText: /^Save$/ }).isDisabled(), "an extension page's Save stays off until something changes")
  await page.locator('#set-probe-greeting').fill('Howdy')
  await probeItem.locator('.page-actions button', { hasText: /^Save$/ }).click()
  await probeItem.locator('.page-actions .state-saved').waitFor({ timeout: 5_000 })
  await page.screenshot({ path: path.join(shots, '04a-extension-page.png') })
  await closeSettings()

  // Its commands are in the quick switcher; ui.notify shows as a toast.
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('say hello')
  check((await page.locator('.switcher-item.is-active .switcher-label').textContent()) === 'Probe: Say hello', 'extension commands appear in the quick switcher')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.toast:has-text("Probe: Howdy #1")', { timeout: 10_000 })
  check(true, 'a command runs and its notification shows')

  // Views (1.5): a status bar item, a popover it opens, and a page, each a sandboxed frame talking to the extension.
  const statusFrame = page.frameLocator('.status-ext[data-ext-view="probe/status"] iframe')
  await statusFrame.locator('#n', { hasText: '1' }).waitFor({ timeout: 15_000 })
  check(true, "an extension's status bar item renders and asks its extension for data")
  const slotWidth = Math.round((await page.locator('.status-ext[data-ext-view="probe/status"]').boundingBox()).width)
  check(slotWidth === 90, `the item gets the width it asked for (${slotWidth} px)`)
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('say hello')
  await page.keyboard.press('Enter')
  await statusFrame.locator('#n', { hasText: '2' }).waitFor({ timeout: 10_000 })
  check(true, 'the extension can push updates to its views')
  await statusFrame.locator('#b').click()
  await page.waitForSelector('.ext-popover[data-ext-view="probe/pop"]', { timeout: 10_000 })
  const popFrame = page.frameLocator('.ext-popover iframe')
  await popFrame.locator('li button', { hasText: 'Website' }).waitFor({ timeout: 10_000 })
  check(true, 'a status bar item opens its popover, which lists what the extension can see')
  await popFrame.locator('li button', { hasText: 'Website' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")', { timeout: 10_000 })
  check((await page.locator('.ext-popover').count()) === 0, 'a view can open a canvas in the app (and the popover closes)')
  await page.locator('.sidebar-ext-pages .view-link', { hasText: 'Probe page' }).click()
  const pageFrame = page.frameLocator('.ext-page-view')
  await pageFrame.locator('#greet', { hasText: 'Howdy, page' }).waitFor({ timeout: 10_000 })
  check(true, 'an extension page is listed in the sidebar and shows what its extension answers')
  check((await pageFrame.locator('#fail').textContent()) === 'refused: asked to fail', 'errors from the extension reach the page')
  await pageFrame.locator('#net', { hasText: 'network:' }).waitFor({ timeout: 10_000 })
  check((await pageFrame.locator('#net').textContent()) === 'network: blocked' && (await pageFrame.locator('#parent').textContent()) === 'parent: blocked', 'a view cannot reach the network or the window around it')
  await page.screenshot({ path: path.join(shots, '04g-extension-page.png') })
  await openCanvasNamed('Scratch')
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('probe the sandbox')
  await page.keyboard.press('Enter')
  const probeFile = path.join(repo, 'extensions', 'builtin.probe', 'probe.json')
  for (let i = 0; i < 50 && !(await fs.stat(probeFile).catch(() => null)); i++) await page.waitForTimeout(200)
  const probe = JSON.parse(await fs.readFile(probeFile, 'utf8'))
  check(probe.readFile?.error === 'ERR_ACCESS_DENIED' && probe.writeFile?.error === 'ERR_ACCESS_DENIED' && probe.spawn?.error === 'ERR_ACCESS_DENIED', `the extension cannot touch files or start programs (${JSON.stringify([probe.readFile, probe.spawn])})`)
  const seen = new Map(probe.canvases.map((c) => [c.id, c]))
  const underWebsite = (c) => c.id === websiteId || (c.parentId && seen.has(c.parentId) && underWebsite(seen.get(c.parentId)))
  const outside = probe.canvases.filter((c) => c.title !== 'Acme Corp' && !underWebsite(c))
  check(seen.has(websiteId) && probe.canvases.some((c) => c.title === 'Acme Corp') && outside.length === 0, `it sees only the granted canvas, what is inside it, and its parents (outside: ${outside.map((c) => c.title).join(', ') || 'none'})`)
  check(probe['add:Website']?.ok === true && probe['add:Acme Corp']?.ok === false, 'it writes only where allowed')
  check((await fs.readFile(path.join(repo, '.gitattributes'), 'utf8')).includes('extensions/builtin.probe/log/*.jsonl merge=union'), 'its append-only files union-merge in git')

  // Window tracking is a built-in extension: listed under Extensions, it asks for window titles.
  await page.keyboard.press('Control+k')
  await page.waitForSelector('.switcher input', { timeout: 5_000 })
  await page.keyboard.type('extensions')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.modal-settings .ext-manage', { timeout: 5_000 })
  const focusBuiltin = page.locator('.ext-builtins .ext-item[data-builtin="devlog-focus"]')
  // The built-ins list loads after the dialog opens.
  check(await focusBuiltin.waitFor({ timeout: 10_000 }).then(() => true, () => false), 'window tracking is offered as a built-in extension')
  await focusBuiltin.locator('button', { hasText: 'Add' }).click()
  const focusItem = page.locator('[data-ext-page="devlog-focus"]')
  await focusItem.locator('button', { hasText: 'Review and allow' }).waitFor({ timeout: 15_000 })
  await focusItem.locator('button', { hasText: 'Review and allow' }).click()
  await page.waitForSelector('.modal-consent .consent-trust', { timeout: 5_000 })
  const allowButton = page.locator('.modal-consent button', { hasText: 'Allow' })
  check(await allowButton.isDisabled(), 'an unrestricted extension cannot be allowed without saying you trust it')
  await page.locator('.consent-trust input').check()
  await allowButton.click()
  await focusItem.locator('.ext-state', { hasText: 'Running' }).waitFor({ timeout: 20_000 })
  check((await focusItem.locator('.ext-perms').textContent()).includes('Runs unrestricted (trusted)'), 'window tracking runs once trusted')
  await closeSettings()
  // Focus changes it keeps in its own files reach the app's views through activity.range.
  const machineFolder = JSON.parse(await fs.readFile(path.join(userData, 'machine.json'), 'utf8')).folder
  const focusDir = path.join(repo, 'extensions', 'builtin.devlog-focus', machineFolder, ymd.slice(0, 4), ymd.slice(5, 7))
  await fs.mkdir(focusDir, { recursive: true })
  const focusAt = new Date(Date.now() - 60_000).toISOString()
  await fs.appendFile(path.join(focusDir, `${ymd}.jsonl`), JSON.stringify({ t: focusAt, app: 'SmokeEditor', title: 'smoke.mjs' }) + '\n')
  const ranged = await page.evaluate((d) => window.devlog.activity.range(d, d), ymd)
  check(ranged.some((e) => e.type === 'focus' && e.app === 'SmokeEditor' && e.machine === machineFolder), 'the timeline, review and summary get focus events from the extension')

  // Canvas properties: right-click a canvas in the sidebar; each extension's fields get a page; they land in canvas.md.
  await page.locator('.canvas-tree .canvas-row', { hasText: 'Website' }).first().click({ button: 'right' })
  await page.waitForSelector('.context-menu', { timeout: 5_000 })
  const menuLabels = await page.locator('.context-menu .context-item').allTextContents()
  check(menuLabels.includes('Properties…') && menuLabels.includes('New task inside…') && menuLabels.includes('Archive'), `right-clicking a canvas in the sidebar offers its properties (${menuLabels.join(', ')})`)
  await page.locator('.context-menu .context-item', { hasText: 'Properties…' }).click()
  await page.waitForSelector('.modal-page', { timeout: 5_000 })
  check((await page.locator('#canvasTitle').inputValue()) === 'Website', 'Properties opens on the canvas page')
  check(await page.locator('.modal-page button[type="submit"]').isDisabled(), 'Save stays off until something changes')
  await page.locator('.modal-page .paged-link[data-page="ext:probe"]').click()
  await page.waitForSelector('.ext-fields', { timeout: 5_000 })
  await page.locator('.ext-fields input').fill('WEB-42')
  await page.screenshot({ path: path.join(shots, '04f-canvas-properties.png') })
  await page.locator('.modal-page button[type="submit"]').click()
  await page.waitForSelector('.modal-page', { state: 'detached', timeout: 5_000 })
  check((await fs.readFile(canvasFile, 'utf8')).includes('ext.builtin.probe.code: WEB-42'), 'extension canvas fields are saved in canvas.md')
  await openCanvasNamed('Scratch')

  // 6c. Timesheet: a draft from tracked time, adjusted in 15-minute steps, saved in the Timesheets canvas, marked final.
  const nowMs = Date.now()
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  // An hour of tracked time before this run started: today if the day is old enough, else yesterday (same week only).
  const seedStart = nowMs - todayStart > 3.5 * 3600_000 ? nowMs - 3 * 3600_000 : today.getDay() !== 1 ? todayStart - 12 * 3600_000 : null
  if (seedStart !== null) {
    const seedDay = new Date(seedStart)
    const seedYmd = `${seedDay.getFullYear()}-${String(seedDay.getMonth() + 1).padStart(2, '0')}-${String(seedDay.getDate()).padStart(2, '0')}`
    // From another machine, so nothing this run tracks overlaps it.
    const sheetDir = path.join(repo, 'activity', 'sheet-machine-0000', seedYmd.slice(0, 4), seedYmd.slice(5, 7))
    await fs.mkdir(sheetDir, { recursive: true })
    const s0 = seedStart
    const lines = [JSON.stringify({ t: new Date(s0).toISOString(), type: 'start', canvasId: websiteId })]
    for (let m = 5; m < 60; m += 5) lines.push(JSON.stringify({ t: new Date(s0 + m * 60_000).toISOString(), type: 'heartbeat' }))
    lines.push(JSON.stringify({ t: new Date(s0 + 60 * 60_000).toISOString(), type: 'stop' }))
    await fs.writeFile(path.join(sheetDir, `${seedYmd}.jsonl`), `${lines.join('\n')}\n`)
    const dow = (today.getDay() + 6) % 7
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow)
    const week = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`

    // The Timesheet is the time extension's page, in a sandboxed frame.
    await timePage('timesheet')
    const ts = page.frameLocator('iframe.ext-page-view')
    await ts.locator('.timesheet .ts-grid').waitFor({ timeout: 20_000 })
    const tsFrame = page.frames().find((f) => f.url().endsWith('/timesheet.html'))
    check((await ts.locator('.ts-state').textContent()).includes('not saved yet'), 'the timesheet opens as a draft from tracked time, not saved yet')
    const minutesOf = (t) => {
      const m = /(\d+):(\d{2})/.exec(t ?? '')
      return m ? Number(m[1]) * 60 + Number(m[2]) : 0
    }
    const cell = ts.locator(`.ts-cell-btn[data-canvas="${websiteId}"][data-date="${seedYmd}"]`)
    const dayTotal = ts.locator(`.ts-total-row .ts-day-total[data-date="${seedYmd}"]`)
    const cellBefore = minutesOf(await cell.textContent())
    const totalBefore = minutesOf(await dayTotal.textContent())
    check(cellBefore >= 60 && totalBefore >= cellBefore, `the grid shows Website's time that day in its cell, and the day's total (${cellBefore} of ${totalBefore} min)`)
    check((await ts.locator(`.ts-client-row .ts-client-label`, { hasText: 'Acme Corp' }).count()) === 1, 'tasks roll up under their client')
    await cell.click()
    await ts.locator('.ts-detail .ts-row').first().waitFor({ timeout: 5_000 })
    const rowId = await tsFrame.evaluate(() => [...document.querySelectorAll('.ts-detail .ts-row')].find((r) => r.querySelector('.ts-worked').textContent.includes('1:00'))?.getAttribute('data-entry') ?? null)
    check(rowId !== null, 'an hour tracked on Website becomes a 1:00 entry')
    if (rowId) {
      const row = ts.locator(`.ts-row[data-entry="${rowId}"]`)
      check((await row.locator('.ts-hours').textContent()) === '1:00', 'the entry reports 1:00')
      await row.locator('button[aria-label="15 minutes more"]').click()
      check((await row.locator('.ts-hours').textContent()) === '1:15', 'durations change in 15-minute steps')
      check(minutesOf(await cell.textContent()) === cellBefore + 15 && minutesOf(await dayTotal.textContent()) === totalBefore + 15, 'the cell and the day total follow')
      await ts.locator('.ts-state.state-saved').waitFor({ timeout: 10_000 })
      const tsCanvas = (await page.evaluate(() => window.devlog.canvases.list())).find((c) => c.title === 'Timesheets')
      const tsFile = path.join(canvasFolder(tsCanvas.id), 'entries', week.slice(0, 4), week.slice(5, 7), `${week}.md`)
      const tsText = await fs.readFile(tsFile, 'utf8')
      check(tsText.includes('kind=timesheet') && tsText.includes('| 1:15 |') && tsText.includes('```devlog-timesheet'), 'the change is saved: a readable table in the Timesheets canvas, with its data')
      check(tsText.includes('ext=builtin.devlog-time') && (await fs.readFile(path.join(canvasFolder(tsCanvas.id), 'canvas.md'), 'utf8')).includes('devlog.managed: timesheets'), 'the time extension writes it, in the canvas it keeps')
      await ts.locator('.ts-actions button', { hasText: 'Mark final' }).click()
      await ts.locator('.ts-state.is-final').waitFor({ timeout: 10_000 })
      check((await ts.locator('.ts-add').count()) === 0 && (await row.locator('button[aria-label="15 minutes more"]').isDisabled()), 'a final timesheet is read-only until reopened')
      await page.screenshot({ path: path.join(shots, '04c-timesheet.png') })

      // Send the final week to Jira (a fake one on localhost) through the built-in extension.
      const jiraRequests = []
      const jira = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          jiraRequests.push({ method: req.method, url: req.url, body })
          res.setHeader('Content-Type', 'application/json')
          if (req.url === '/rest/api/2/myself') return res.end(JSON.stringify({ displayName: 'Smoke Test' }))
          if (req.method === 'POST') {
            res.statusCode = 201
            return res.end(JSON.stringify({ id: String(500 + jiraRequests.length) }))
          }
          res.end('{}')
        })
      })
      await new Promise((r) => jira.listen(0, '127.0.0.1', r))
      await page.evaluate((id) => window.devlog.canvases.update(id, { fields: { 'ext.builtin.devlog-jira.issue': 'WEB-42' } }), websiteId)
      // A shortcut pressed in an extension's page (the Timesheet has the focus) still reaches the app.
      await page.keyboard.press('Control+k')
      await page.waitForSelector('.switcher input', { timeout: 5_000 })
      await page.keyboard.type('extensions')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.modal-settings .ext-manage', { timeout: 5_000 })
      await page.locator('.ext-builtins .ext-item[data-builtin="devlog-jira"] button', { hasText: 'Add' }).click()
      const jiraItem = page.locator('[data-ext-page="devlog-jira"]')
      await jiraItem.locator('button', { hasText: 'Review and allow' }).click()
      await page.locator('.modal-consent button', { hasText: 'Allow' }).click()
      await jiraItem.locator('.ext-state', { hasText: 'Running' }).waitFor({ timeout: 20_000 })
      check((await jiraItem.locator('.ext-missing').textContent()).includes('Jira address'), 'an extension that needs setting up says what is missing')
      check((await page.locator('.paged-link[data-page="ext:devlog-jira"] .paged-badge.is-attention').count()) === 1, 'and its page is marked in the settings navigation')
      await page.locator('#set-devlog-jira-baseurl').fill('not an address')
      await jiraItem.locator('.page-actions button', { hasText: /^Save$/ }).click()
      check((await jiraItem.locator('.ext-field-problem').count()) === 1, 'the settings page checks values before saving')
      await page.locator('#set-devlog-jira-baseurl').fill(`http://127.0.0.1:${jira.address().port}`)
      await page.locator('#set-devlog-jira-email').fill('me@example.com')
      await page.locator('#sec-devlog-jira-token').fill('t0ken')
      await jiraItem.locator('.page-actions button', { hasText: 'Save and test' }).click()
      await page.waitForSelector('[data-ext-page="devlog-jira"] .ext-check-ok, [data-ext-page="devlog-jira"] .form-error', { timeout: 15_000 })
      check((await jiraItem.locator('.ext-check-ok').count()) === 1, `Save and test runs the extension's own check (${await jiraItem.locator('.ext-check-ok, .form-error').first().textContent()})`)
      check((await jiraItem.locator('.ext-secret-dots').count()) === 1, 'the token is kept on this computer and not shown again')
      await page.screenshot({ path: path.join(shots, '04e-extension-settings.png') })
      await closeSettings()
      await ts.locator('.ts-actions .ts-send', { hasText: 'Send to Jira' }).waitFor({ timeout: 10_000 })
      check(true, "the time extension offers the Jira extension's destination")
      await ts.locator('.ts-actions .ts-send', { hasText: 'Send to Jira' }).click()
      await ts.locator('.modal-send .send-counts').waitFor({ timeout: 20_000 })
      check((await ts.locator('.modal-send .send-line.action-create .send-target').allTextContents()).includes('WEB-42'), 'the send preview (through the app, from the Jira extension) lists a new worklog on the issue set on the canvas')
      await page.screenshot({ path: path.join(shots, '04d-send-to-jira.png') })
      await ts.locator('.modal-send button', { hasText: /^Send \d/ }).click()
      await ts.locator('.modal-send .send-result, .modal-send .form-error').first().waitFor({ timeout: 30_000 })
      const sendText = await ts.locator('.modal-send .send-result, .modal-send .form-error').first().textContent()
      check(/worklogs? created/.test(sendText) && jiraRequests.some((r) => r.method === 'POST' && r.url === '/rest/api/2/issue/WEB-42/worklog'), `sending creates the worklogs in Jira (${sendText})`)
      await ts.locator('.modal-send button', { hasText: 'Nothing to send' }).waitFor({ timeout: 10_000 })
      check(true, 'afterwards there is nothing left to send')
      check((await fs.readFile(tsFile, 'utf8')).includes('Sent to Jira: '), 'what was sent is written inside the week, in the Timesheets canvas')
      await ts.locator('.modal-send button', { hasText: 'Close' }).click()
      jira.close()
    }
    await fs.rm(path.join(repo, 'activity', 'sheet-machine-0000'), { recursive: true, force: true })
    await openCanvasNamed('Scratch')
  } else console.log('skip timesheet check: early on a Monday, no earlier day this week to track an hour on')

  // 6b. A long run of completed todos folds into one line and expands to every item.
  const bigList = await page.evaluate(async () => {
    const c = await window.devlog.canvases.create({ title: 'Big list' })
    const { date, entries } = await window.devlog.todos.add(c.id, Array.from({ length: 12 }, (_, i) => `Item ${i + 1}`))
    for (const t of entries) await window.devlog.todos.setDone(c.id, date, t.id, true)
    // Enough blocks after them for the stream to scroll.
    for (let i = 1; i <= 30; i++) await window.devlog.blocks.add(c.id, `Filler ${String(i).padStart(2, '0')}\n\nsome text so the block has a little height`)
    return c.id
  })
  // Created through the API, so reload for the sidebar to list it.
  await page.reload()
  await page.waitForSelector('.composer-editor', { timeout: 30_000 })
  await page.locator('.canvas-tree .canvas-link', { hasText: 'Big list' }).click()
  await page.waitForSelector('.done-stub', { timeout: 10_000 })
  check((await page.locator('.done-stub .done-count').textContent()).includes('12 todos done') && (await page.locator('.done-run .entry').count()) === 0, 'twelve completed todos fold into one line')
  await page.locator('.done-stub').click()
  await page.waitForFunction(() => document.querySelectorAll('.done-run .entry').length === 12, null, { timeout: 5_000 })
  const items = await page.locator('.done-run .entry .entry-body').allTextContents()
  check(items[0].includes('Item 1') && items[11].includes('Item 12'), 'expanded, every completed todo is listed in order')

  // Deleting a block near the top leaves the stream where it was.
  const feed = page.locator('.feed')
  await feed.evaluate((el) => (el.scrollTop = 0))
  const filler = page.locator('.entry', { hasText: 'Filler 01' })
  await filler.scrollIntoViewIfNeeded()
  const topBefore = await feed.evaluate((el) => el.scrollTop)
  await filler.hover()
  await filler.locator('.entry-actions button', { hasText: 'Delete' }).click()
  await filler.locator('.entry-actions .btn-danger').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.entry')].some((e) => e.textContent.includes('Filler 01')), null, { timeout: 10_000 })
  await page.waitForTimeout(600)
  const topAfter = await feed.evaluate((el) => el.scrollTop)
  const maxTop = await feed.evaluate((el) => el.scrollHeight - el.clientHeight)
  check(maxTop > 400 && Math.abs(topAfter - topBefore) < 40, `deleting a block does not scroll the stream to the end (${topBefore} → ${topAfter}, end ${maxTop})`)

  // Typing with nothing focused starts a note in the canvas's note box.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.type('typed from nowhere')
  const dockText = await page.locator('.composer-dock .composer-editor').textContent()
  check(dockText.includes('typed from nowhere'), `typing with nothing focused goes to the note box (${JSON.stringify(dockText)})`)
  check(await page.evaluate(() => Boolean(document.activeElement?.closest('.composer-dock'))), 'and the note box keeps focus')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => [...document.querySelectorAll('.entry')].some((e) => e.textContent.includes('typed from nowhere')), null, { timeout: 10_000 })
  await page.evaluate((id) => window.devlog.canvases.remove(id), bigList)
  await openCanvasNamed('Scratch')

  // 7. Quit commits anything pending.
  await editor.click()
  await page.keyboard.type('last words before quit')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 3, null, { timeout: 10_000 })
  await app.close()
  const machine = JSON.parse(await fs.readFile(path.join(userData, 'machine.json'), 'utf8')).folder
  check(/^[a-z0-9-]+-[0-9a-f]{4}$/.test(machine ?? ''), `this install has a machine folder name (${machine})`)
  const actDir = path.join(repo, 'activity', machine)
  const actFiles = (await fs.readdir(actDir, { recursive: true })).filter((f) => f.endsWith('.jsonl'))
  check(actFiles.length === 1, "the app's activity log (git events, locks) is written into the repository, in this machine folder, one file per day")
  const actText = await fs.readFile(path.join(actDir, actFiles[0]), 'utf8')
  check(actText.includes('"type":"git"') && !actText.includes('"type":"task"'), 'the app logs git events; the clock is no longer its to log')
  const clockDir = path.join(repo, 'extensions', 'builtin.devlog-time', machine)
  const clockFiles = (await fs.readdir(clockDir, { recursive: true })).filter((f) => f.endsWith('.jsonl'))
  const clockText = await fs.readFile(path.join(clockDir, clockFiles[0]), 'utf8')
  check(clockFiles.length === 1 && clockText.includes('"type":"start"') && clockText.includes('"type":"task"') && clockText.trim().endsWith('"type":"stop"}'), "devlog-time's log in its own folder records start, task and stop (on quit)")
  const finalLog = git(['log', '--format=%s', 'main'], bare)
  check(git(['status', '--porcelain']) === '', 'quit committed the last entry')
  check(finalLog.split('\n').length >= 2, `quit pushed the last commit (${finalLog.split('\n').length} commits on remote)`)
} catch (err) {
  console.error(err)
  failures.push(String(err))
  await app.close().catch(() => undefined)
}

console.log(`\nscreenshots: ${shots}`)
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall smoke checks passed')
