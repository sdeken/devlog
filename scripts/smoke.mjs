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
  JSON.stringify({ repoPath: repo, syncIntervalMinutes: 60, commitDebounceSeconds: 2, autoPush: true, pullOnStart: false, commitOnQuit: true, authorName: 'Smoke Test', authorEmail: 'smoke@example.com' })
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
  check(await page.locator('.sidebar h1').textContent() === 'Devlog', 'window renders the sidebar')
  check((await page.locator('.page-journal').count()) === 1, 'journal page listed in the sidebar')
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
  const feedImgOk = await page.locator('.entry .markdown-body img').first().evaluate((img) => img.complete && img.naturalWidth > 0)
  check(feedImgOk, 'posted image renders in the feed')
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

  // 3d. Pages: create a categorised page, post on it, move a journal note there.
  await page.locator('.page-new').click()
  await page.waitForSelector('.modal-page')
  await page.locator('#pageTitle').fill('Acme Corp')
  await page.locator('#pageCategory').fill('Clients')
  await page.locator('#pageDescription').fill('Retainer **client**')
  await page.locator('.modal-page button[type=submit]').click()
  await page.waitForSelector('.page-head h2:has-text("Acme Corp")', { timeout: 10_000 })
  check((await page.locator('.sidebar-group h2').first().textContent()) === 'Clients', 'page grouped under its category in the sidebar')
  check((await page.locator('.page-description').innerHTML()).includes('<strong>client</strong>'), 'page description renders as markdown')
  check((await page.locator('.entry').count()) === 0, 'new page starts empty')
  const pageEditor = page.locator('.composer-new .composer-editor')
  await pageEditor.click()
  await page.keyboard.type('first note for acme')
  await page.keyboard.press('Enter')
  await page.waitForSelector('.entry', { timeout: 10_000 })
  const acmeFile = path.join(repo, 'pages', 'acme-corp', 'entries', String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, '0'), `${ymd}.md`)
  check((await fs.readFile(acmeFile, 'utf8')).includes('first note for acme'), 'page note stored under pages/acme-corp/entries')
  check((await fs.readFile(path.join(repo, 'pages', 'acme-corp', 'page.md'), 'utf8')).includes('category: Clients'), 'page.md carries the category')
  await page.screenshot({ path: path.join(shots, '02c-page.png') })

  await page.locator('.page-journal').click()
  await page.waitForSelector('.page-head h2:has-text("Journal")')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 4, null, { timeout: 10_000 })
  const journalLast = page.locator('.note-slot > .note > .entry').last()
  await journalLast.hover()
  await journalLast.locator('button', { hasText: 'Move' }).click()
  await page.locator('.move-select').selectOption('acme-corp')
  await page.waitForFunction(() => document.querySelectorAll('.entry').length === 3, null, { timeout: 10_000 })
  check((await fs.readFile(acmeFile, 'utf8')).includes('Screenshot:'), 'note moved from the journal into the page file')
  check((await fs.readFile(acmeFile, 'utf8')).includes('![shot](../../../../../entries/'), 'moved note keeps its image via a relative link')
  check((await fs.readFile(dayFile, 'utf8')).includes('Screenshot:') === false, 'moved note removed from the journal file')

  await page.locator('.sidebar-search input').fill('acme')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit-day').first().textContent()).startsWith('Acme Corp'), 'search results name the page')
  await page.locator('.sidebar-search input').fill('')

  // 4. Sync runs (debounce is 2s) and pushes to the bare remote.
  await page.waitForFunction(() => document.querySelector('.status-text')?.textContent === 'Up to date', null, { timeout: 30_000 })
  const remoteLog = git(['log', '--oneline', 'main'], bare)
  check(remoteLog.split('\n').length >= 1 && remoteLog.includes(`devlog: ${ymd}`), `changes pushed to the remote (${remoteLog.split('\n')[0]})`)
  check(git(['status', '--porcelain']) === '', 'working tree clean after sync')
  await page.screenshot({ path: path.join(shots, '03-synced.png') })

  // 5. Search.
  await page.locator('.sidebar-search input').fill('edited')
  await page.waitForSelector('.hit', { timeout: 10_000 })
  check((await page.locator('.hit').count()) === 1, 'search finds the edited entry')
  await page.locator('.sidebar-search input').fill('')

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
