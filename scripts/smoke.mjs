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
  JSON.stringify({ repoPath: repo, syncIntervalMinutes: 60, commitDebounceSeconds: 2, autoPush: true, pullOnStart: false, commitOnQuit: true, authorName: 'Smoke Test', authorEmail: 'smoke@example.com', trackingEnabled: true, trackFocus: false, idleMinutes: 0, activityInRepo: false, captureCommits: true })
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
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('  [renderer]', m.type(), m.text())
  })
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
  await page.waitForSelector('.composer-editor', { timeout: 30_000 })
  check((await page.locator('.topbar-title').textContent()) === 'Devlog', 'window renders its own title bar')
  check((await page.locator('.hamburger').count()) === 1, 'title bar has the hamburger menu button')
  check((await page.locator('.sidebar-views .view-link').first().textContent()).includes('Journal'), 'journal listed in the sidebar')
  await page.screenshot({ path: path.join(shots, '01-empty.png') })

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
  const dayFile = path.join(repo, 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  const text1 = await fs.readFile(dayFile, 'utf8')
  check(text1.includes('<!-- devlog:entry id=') && text1.includes('**git sync**'), 'entry written to the day file')
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
  await page.waitForSelector('.entry-edited', { timeout: 10_000 })
  const text3 = await fs.readFile(dayFile, 'utf8')
  check(text3.includes('(edited!)') && text3.includes(' updated='), 'edit persisted with an updated timestamp')

  // 3b. Reply in a thread, then insert a note between the two top-level notes.
  await first.hover()
  await first.locator('button', { hasText: 'Reply' }).click()
  const replyEditor = page.locator('.composer-reply .composer-editor')
  await replyEditor.waitFor()
  await replyEditor.click()
  await page.keyboard.type('a threaded reply')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.thread .entry', { timeout: 10_000 })
  check((await page.locator('.thread .entry .markdown-body').first().textContent()).includes('a threaded reply'), 'reply renders nested under its parent')
  const text4 = await fs.readFile(dayFile, 'utf8')
  check(/<!-- devlog:entry id=\w+ parent=\w+ created=/.test(text4) && text4.includes('#### ↳'), 'reply stored with parent link and nested heading')

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
  await page.screenshot({ path: path.join(shots, '02b-thread-and-insert.png') })

  // 3c. Up arrow in the empty composer edits the last note.
  await editor.click()
  await page.keyboard.press('ArrowUp')
  await page.waitForSelector('.entry-editing', { timeout: 5_000 })
  check(true, 'Up arrow in the empty composer opens the last note for editing')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.entry-editing'), null, { timeout: 5_000 })

  // 3d. Canvases: a client canvas, a project canvas inside it, blocks on it.
  await page.locator('.sidebar-add').click()
  await page.waitForSelector('.modal-page')
  await page.locator('#canvasTitle').fill('Acme Corp')
  await page.locator('.modal-page button[type=submit]').click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Acme Corp")', { timeout: 10_000 })
  check((await fs.stat(path.join(repo, 'canvases', 'acme-corp', 'canvas.md'))).isFile(), 'canvas ids are slugs; canvas.md written')
  await page.locator('.sidebar-add').click()
  await page.waitForSelector('.modal-page')
  check((await page.locator('#canvasParent').inputValue()) === 'acme-corp', 'new canvas from inside a canvas is pre-filed under it')
  await page.locator('#canvasTitle').fill('Website')
  await page.locator('#canvasParent').selectOption('acme-corp')
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
  const treeLabels = await page.locator('.canvas-tree .canvas-name').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(treeLabels.join('>') === 'Acme Corp>Website', `sidebar nests client → project (${treeLabels.join(' > ')})`)
  check((await page.locator('.breadcrumbs .crumb').first().textContent()) === 'Acme Corp', 'canvas header shows the parent as a breadcrumb')
  check((await page.locator('.entry').count()) === 0, 'new canvas starts empty')
  const canvasFile = path.join(repo, 'canvases', 'website', 'canvas.md')
  check((await fs.readFile(canvasFile, 'utf8')).includes('parent: acme-corp'), 'canvas.md carries the parent')

  const pageEditor = page.locator('.composer-new .composer-editor')
  await pageEditor.click()
  await page.keyboard.type('first note for acme')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  const acmeFile = path.join(repo, 'canvases', 'website', 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(acmeFile, 'utf8')).includes('first note for acme'), 'block stored under canvases/website/entries')
  await page.waitForTimeout(300)
  check((await page.locator('.task-status').textContent()).includes('No active task'), 'posting on a non-task canvas is just a note; no task starts')

  // 3d'. Tasks: Mod+Shift+Enter, "#task", and the hover action each turn a block into a task canvas.
  await pageEditor.click()
  await page.keyboard.type('Fix the login redirect. It loops on Safari.')
  await page.keyboard.press('Control+Shift+Enter')
  await page.waitForSelector('.entry-task', { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.task-status .status-text')?.textContent?.includes('Fix the login redirect'), null, { timeout: 10_000 })
  check(true, 'Mod+Shift+Enter posts the block as a task and makes it the active task')
  check((await page.locator('.entry-task .task-chip').first().textContent()).includes('Fix the login redirect'), 'the task block links to its canvas')
  check((await page.locator('.canvas-tree .canvas-node.is-task .canvas-name').first().textContent()) === 'Fix the login redirect', 'the task canvas appears under its project in the sidebar')
  check((await fs.readFile(acmeFile, 'utf8')).includes('kind=task canvas=fix-the-login-redirect'), 'task block stored with kind=task and its canvas id')
  check((await fs.readFile(path.join(repo, 'canvases', 'fix-the-login-redirect', 'canvas.md'), 'utf8')).includes('task: true'), 'task canvas.md carries task: true')
  await page.locator('.task-status button', { hasText: 'Stop' }).click()
  await page.waitForFunction(() => document.querySelector('.task-status')?.textContent?.includes('No active task'), null, { timeout: 10_000 })
  check(true, 'Stop clears the active task')

  await pageEditor.click()
  await page.keyboard.type('#task Write the launch checklist')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.task-status .status-text')?.textContent?.includes('Write the launch checklist'), null, { timeout: 10_000 })
  check(true, '"#task" on the first line turns a block into a task')
  check(!(await fs.readFile(acmeFile, 'utf8')).includes('#task'), 'the #task tag is stripped from the stored block')
  await page.locator('.task-status button', { hasText: 'Stop' }).click()
  await page.waitForFunction(() => document.querySelector('.task-status')?.textContent?.includes('No active task'), null, { timeout: 10_000 })

  await pageEditor.click()
  await page.keyboard.type('[45m] retro-logged call')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.duration-chip', { timeout: 10_000 })
  check((await page.locator('.entry .duration-chip').first().textContent()) === '45m', 'explicit duration marker renders as a chip')

  // Timestamps stay out of the way until hover.
  const firstTime = page.locator('.entry time').first()
  check((await firstTime.evaluate((el) => getComputedStyle(el).opacity)) === '0', 'timestamps are hidden until hover')
  await page.locator('.entry').first().hover()
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.entry time')).opacity === '1', null, { timeout: 5_000 })
  check(true, 'hovering a block reveals its timestamp')

  // Open the task canvas; Start lives in the status bar and offers the canvas on screen first.
  await page.locator('.entry-task .task-chip').first().click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Fix the login redirect")', { timeout: 10_000 })
  check((await page.locator('.breadcrumbs').textContent()).includes('Acme Corp') && (await page.locator('.breadcrumbs').textContent()).includes('Website'), 'task canvas breadcrumbs run client / project / task')
  check((await page.locator('.page-head button', { hasText: 'Start' }).count()) === 0, 'no Start button in the canvas header; the status bar owns it')
  await page.locator('.statusbar button', { hasText: 'Start' }).click()
  await page.waitForSelector('.start-menu', { timeout: 5_000 })
  check((await page.locator('.start-menu .start-item').first().textContent()).includes('Fix the login redirect'), 'the Start menu lists the task on screen first')
  await page.locator('.start-menu .start-item').first().click()
  await page.waitForFunction(() => document.querySelector('.task-badge.is-active') !== null, null, { timeout: 10_000 })
  check(true, 'Start from the status bar makes the task active')
  await page.locator('.composer-new .composer-editor').click()
  await page.keyboard.type('Reproduced it: the redirect keeps the hash.')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  const taskFile = path.join(repo, 'canvases', 'fix-the-login-redirect', 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(taskFile, 'utf8')).includes('Reproduced it'), 'blocks on a task canvas are stored under its own folder')
  await page.locator('.task-status button', { hasText: 'Stop' }).click()
  await page.waitForFunction(() => document.querySelector('.task-status')?.textContent?.includes('No active task'), null, { timeout: 10_000 })
  await page.locator('.breadcrumbs .crumb', { hasText: 'Website' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Website")', { timeout: 10_000 })

  // Link the repo to the canvas (the folder picker is native; set repos through the API path the header button uses).
  check((await page.locator('.canvas-repos .repo-add').count()) === 1, 'canvas header offers "Link a repository"')
  await page.evaluate((dir) => window.devlog.canvases.update('website', { repos: [dir] }), proj)
  await page.waitForSelector('.entry-commit', { timeout: 30_000 })
  check((await page.locator('.entry-commit .entry-body').first().textContent()).includes('initial'), 'linking a repository imports its recent commits as blocks')
  await page.waitForSelector('.repo-chip', { timeout: 10_000 })
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
  await page.evaluate(() => window.devlog.tracker.setTask('fix-the-login-redirect'))
  await fs.writeFile(path.join(proj, 'a.txt'), '3')
  git(['add', '-A'], proj)
  git(['-c', 'user.name=Dev', '-c', 'user.email=d@e.com', 'commit', '-m', 'Route to the task'], proj)
  await page.waitForFunction(async () => {
    const d = await window.devlog.blocks.getDay('fix-the-login-redirect', new Date().toISOString().slice(0, 10))
    return d.entries.some((e) => e.kind === 'commit' && e.markdown.includes('Route to the task'))
  }, null, { timeout: 30_000 })
  check(true, 'a commit made while a task under the linked canvas is active lands on that task')
  check((await page.locator('.entry-commit').count()) === 2, 'the routed commit does not also land on the canvas')
  await page.evaluate(() => window.devlog.tracker.setTask(null))
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

  // Drag the last block above the first one: order changes, timestamps do not.
  const beforeOrder = (await fs.readFile(acmeFile, 'utf8')).match(/^### .*\n\n(.+)$/gm).map((m) => m.split('\n\n')[1])
  const lastEntry = page.locator('.note-slot').last()
  await lastEntry.locator('.entry').first().hover()
  await lastEntry.locator('.entry-grip').first().dragTo(page.locator('.note-slot').first(), { targetPosition: { x: 200, y: 8 } })
  await page.waitForFunction((first) => {
    const bodies = [...document.querySelectorAll('.note-slot > .note > .entry .entry-body')].map((e) => e.textContent.trim())
    return bodies[0] !== first
  }, beforeOrder[0], { timeout: 10_000 })
  const afterText = await fs.readFile(acmeFile, 'utf8')
  const afterOrder = afterText.match(/^### .*\n\n(.+)$/gm).map((m) => m.split('\n\n')[1])
  check(afterOrder[0] === beforeOrder[beforeOrder.length - 1] && afterOrder.length === beforeOrder.length, `drag and drop reorders blocks within the day (${afterOrder.map((t) => t.slice(0, 12)).join(' | ')})`)
  check(afterText.split('created=').length === (await fs.readFile(acmeFile, 'utf8')).split('created=').length, 'reordering keeps every timestamp')

  // The hover "Task" action promotes an existing block.
  const plain = page.locator('.entry:not(.entry-task):not(.entry-commit)').first()
  await plain.hover()
  await plain.locator('button', { hasText: 'Task' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.entry-task').length === 3, null, { timeout: 10_000 })
  check(true, 'the Task action turns an existing block into a task')
  await page.locator('.task-status button', { hasText: 'Stop' }).click()
  await page.waitForFunction(() => document.querySelector('.task-status')?.textContent?.includes('No active task'), null, { timeout: 10_000 })

  await page.locator('.sidebar-views .view-link', { hasText: 'Journal' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Journal")')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 4, null, { timeout: 10_000 })
  const journalLast = page.locator('.note-slot > .note > .entry').last()
  await journalLast.hover()
  await journalLast.locator('button', { hasText: 'Move' }).click()
  await page.locator('.move-select').selectOption('website')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 3, null, { timeout: 10_000 })
  check((await fs.readFile(acmeFile, 'utf8')).includes('Screenshot:'), 'block moved from the journal into the canvas file')
  check((await fs.readFile(acmeFile, 'utf8')).includes('![shot](../../../../../entries/'), 'moved block keeps its image via a relative link')
  check((await fs.readFile(dayFile, 'utf8')).includes('Screenshot:') === false, 'moved block removed from the journal file')

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
  const acmeCanvasText = await fs.readFile(path.join(repo, 'canvases', 'acme-corp', 'canvas.md'), 'utf8')
  check(acmeCanvasText.includes('title: Acme Corp') && acmeCanvasText.includes('# Links') && acmeCanvasText.includes('issues.example.com'), 'surface autosaves into canvases/acme-corp/canvas.md')
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
  check(visible.join('>') === 'Acme Corp', `archived project and its tasks leave the sidebar tree (${visible.join(' > ')})`)
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
  check((await page.locator('.canvas-tree .canvas-name').count()) === 5, 'unarchived project and its tasks return to the sidebar tree')

  // 3e. Weekly review rolls blocks up by client → project → task.
  await page.locator('.sidebar-views .view-link', { hasText: 'Weekly review' }).click()
  await page.waitForSelector('.review-table', { timeout: 10_000 })
  const rowLabels = await page.locator('.review-table tbody th').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(rowLabels[0] === 'Acme Corp' && rowLabels[1] === 'Website' && rowLabels.at(-2) === 'Journal' && rowLabels.at(-1) === 'Total', `review rows nest client → project → task, journal last (${rowLabels.join(' | ')})`)
  check(rowLabels.some((l) => l.includes('Fix the login redirect')), 'task canvases appear as rows')
  const acmeTotal = await page.locator('.review-category.depth-0 .review-total .cell-notes').first().textContent()
  check(Number(acmeTotal) >= 8, `client row sums its blocks for the week (${acmeTotal})`)
  check((await page.locator('.review-day-section').count()) === 1, 'per-day detail lists today')
  check((await page.locator('.review-group-label').first().textContent()) === 'Acme Corp', 'day detail groups by top-level canvas')
  check((await page.locator('.review-segments li').count()) >= 1, 'review shows tracked task segments for today')
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
  await page.locator('.sidebar-views .view-link', { hasText: 'Summary' }).click()
  await page.waitForSelector('.sum-list', { timeout: 10_000 })
  const sumLabels = await page.locator('.sum-list > .sum-row > .sum-top > .sum-label').allTextContents()
  check(sumLabels[0].trim() === 'Acme Corp' && sumLabels.includes('Total'), `summary lists top-level items (${sumLabels.join(' | ')})`)
  check(/^\d+(\.\d+)? h$/.test((await page.locator('.sum-list > .sum-row > .sum-top > .sum-hours').first().textContent()).trim()), 'summary shows rounded hours')
  await page.locator('.sum-toggle').first().click()
  check((await page.locator('.sum-children .sum-label').first().textContent()).includes('Website'), 'summary rows expand into projects')
  await page.screenshot({ path: path.join(shots, '02f-summary.png') })

  // 3h. Quick switcher jumps to a canvas by fuzzy name.
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
  await page.locator('.statusbar button[title^="Settings"]').click()
  await page.waitForSelector('.modal')
  await page.locator('.theme-swatch[title="Ocean"]').click()
  await page.locator('.modal-actions .btn-primary').click()
  await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 10_000 })
  const sidebarBg = await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).backgroundColor)
  check(sidebarBg === 'rgb(21, 48, 72)', `theme preset applies to the sidebar (${sidebarBg})`)
  const saved = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'))
  check(saved.theme?.preset === 'ocean', 'theme is persisted in settings')

  await page.locator('.sidebar-views .view-link', { hasText: 'Journal' }).click()
  await page.waitForSelector('.page-head .crumb.is-current:has-text("Journal")')

  // 4. Sync runs (debounce is 2s) and pushes to the bare remote.
  await page.waitForFunction(() => [...document.querySelectorAll('.statusbar > .status-text')].at(-1)?.textContent === 'Up to date', null, { timeout: 30_000 })
  const remoteLog = git(['log', '--oneline', 'main'], bare)
  check(remoteLog.split('\n').length >= 1 && remoteLog.includes(`devlog: ${ymd}`), `changes pushed to the remote (${remoteLog.split('\n')[0]})`)
  check(git(['status', '--porcelain']) === '', 'working tree clean after sync')
  await page.screenshot({ path: path.join(shots, '03-synced.png') })

  // 5. Search.
  await page.locator('.topbar-search').fill('edited')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit').count()) === 1, 'search finds the edited entry')
  await page.locator('.topbar-search').fill('')

  // 6. Settings dialog opens from the status bar.
  await page.locator('.statusbar button[title^="Settings"]').click()
  await page.waitForSelector('.modal')
  check((await page.locator('#remote').inputValue()) === bare, 'settings show the remote url')
  await page.screenshot({ path: path.join(shots, '04-settings.png') })
  await page.keyboard.press('Escape')

  // 7. Quit commits anything pending.
  await editor.click()
  await page.keyboard.type('last words before quit')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 4, null, { timeout: 10_000 })
  await app.close()
  const actDir = path.join(userData, 'activity')
  const actFiles = (await fs.readdir(actDir, { recursive: true })).filter((f) => f.endsWith('.jsonl'))
  check(actFiles.length === 1, 'activity log written locally as one file per day')
  const actText = await fs.readFile(path.join(actDir, actFiles[0]), 'utf8')
  check(actText.includes('"type":"start"') && actText.includes('"type":"task"') && actText.trim().endsWith('"type":"stop"}'), 'activity log records start, task and stop events')
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
