/**
 * Screenshot tour for visual QA: seeds a throwaway devlog and captures every
 * view in light and dark mode, plus a narrow window.
 *
 *   npm run build && xvfb-run -a node scripts/screens.mjs [outDir]
 */
import { _electron as electron } from 'playwright-core'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname)
const appRoot = path.resolve(here, '..')
const out = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'devlog-screens'))
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-screens-'))
const repo = path.join(tmp, 'repo')
const userData = path.join(tmp, 'userData')
await fs.mkdir(repo, { recursive: true })
await fs.mkdir(userData, { recursive: true })
await fs.mkdir(out, { recursive: true })
execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo })
await fs.writeFile(
  path.join(userData, 'settings.json'),
  JSON.stringify({ repoPath: repo, syncIntervalMinutes: 60, commitDebounceSeconds: 600, autoPush: false, pullOnStart: false, commitOnQuit: false, authorName: 'Dev', authorEmail: 'd@e.com', trackingEnabled: true, trackFocus: false, idleMinutes: 0, activityInRepo: false, captureCommits: false })
)

const app = await electron.launch({ args: [appRoot, '--no-sandbox', '--disable-gpu'], env: { ...process.env, DEVLOG_USER_DATA: userData } })
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))
await page.waitForSelector('.composer-editor', { timeout: 30_000 })
await page.setViewportSize({ width: 1180, height: 800 })

// Seed through the preload API so timestamps spread over the day.
await page.evaluate(async () => {
  const d = window.devlog
  const acme = await d.pages.create({ title: 'Website', category: 'Acme Corp / Web', description: 'Marketing site rebuild. Weekly sync on Tuesdays.' })
  const app = await d.pages.create({ title: 'Mobile app', category: 'Acme Corp / Mobile' })
  const glob = await d.pages.create({ title: 'Data pipeline', category: 'Globex / Platform' })
  const old = await d.pages.create({ title: 'Legacy migration', category: 'Globex / Platform' })
  await d.pages.archive(old.id, true)
  await d.entries.add('journal', 'Morning: triage inbox, planned the week. Three things on the list:\n\n- Acme site launch checklist\n- Globex pipeline backfill\n- write up the incident from Friday')
  const a = await d.entries.add(acme.id, 'Kicked off the **launch checklist**. Blockers so far:\n\n1. CDN cache rules\n2. Redirect map from the old site\n\n```ts\nexport const redirects: Record<string, string> = {\n  "/about-us": "/about",\n  "/blog/*": "/journal/*",\n}\n```')
  await d.entries.add(acme.id, 'Talked to their ops team; CDN rules are theirs to set. Sent the list.', { parentId: a.entry.id })
  await d.entries.add(acme.id, '[45m] Launch sync with Acme (Teams)')
  await d.entries.add(app.id, 'Reviewed the beta feedback. Most of it is onboarding copy.')
  await d.entries.add(glob.id, 'Backfill job runs at ~4k rows/s; needs ~3h for the full table. Kicked it off.')
  await d.wiki.set(['Acme Corp'], '# Acme Corp\n\n- Issue tracker: https://issues.example.com/acme\n- Staging: https://staging.acme.example\n- Main contact: Dana (ops), Priya (marketing)\n\n## Access\n\nVPN profile `acme-prod`, credentials in the vault under *Acme*.')
  await d.wiki.set(['Acme Corp', 'Web'], '# Web\n\nNext.js 15 on Vercel. Deploy previews on every PR.')
})
await page.reload()
await page.waitForSelector('.composer-editor', { timeout: 30_000 })

const shot = async (name, scheme) => {
  await page.emulateMedia({ colorScheme: scheme })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) })
}
const both = async (name) => {
  await shot(name, 'light')
  await shot(name, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
}

await both('01-journal')
await page.locator('.sidebar-tree .page-link', { hasText: 'Website' }).click()
await page.waitForSelector('.page-head h2:has-text("Website")')
await page.locator('.entry').first().hover()
await both('02-page')
await page.locator('.composer-new .composer-editor').click()
await page.keyboard.type('Select this to see the bubble menu')
await page.keyboard.press('Shift+Home')
await page.waitForSelector('.bubble-menu')
await both('03-composer-selection')
await page.keyboard.press('Control+A')
await page.keyboard.press('Backspace')
await page.locator('.sidebar-tree .category-label').first().click()
await page.waitForSelector('.category-view')
await both('04-wiki')
await page.locator('.page-review').click()
await page.waitForSelector('.review-table')
await both('05-review')
await page.locator('.page-timeline').click()
await page.waitForSelector('.tlb')
await both('06-timeline')
await page.locator('.sidebar-search input').fill('acme')
await page.waitForSelector('.hit')
await both('07-search')
await page.locator('.sidebar-search input').fill('')
await page.locator('.page-new').click()
await page.waitForSelector('.modal-page')
await both('08-new-page')
await page.keyboard.press('Escape')
await page.locator('.statusbar button[title^="Settings"]').click()
await page.waitForSelector('.modal')
await both('09-settings')
await page.keyboard.press('Escape')
await page.setViewportSize({ width: 760, height: 600 })
await page.locator('.page-journal').click()
await page.waitForSelector('.page-head h2:has-text("Journal")')
await both('10-narrow')
await app.close()
console.log(`screens: ${out}`)
