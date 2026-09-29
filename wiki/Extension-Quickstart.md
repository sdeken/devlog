# Extension quickstart

This page builds **Standup**, a small extension that posts yesterday's and
today's work as one block on the canvas you are looking at. On the way it uses
a manifest, a command with a keybinding, a setting, the read and write API,
a private file, a unit test, the development override and a release.

Read [Extensions Overview](Extensions-Overview) first if you have not.

## 1. Lay out the project

```
devlog-standup/
├── devlog-extension.json
├── package.json
├── src/
│   └── main.ts
└── tests/
    └── main.test.ts
```

The shipped extension is only `devlog-extension.json` and the bundled
`main.js`; `src/`, `tests/` and `node_modules/` stay out of the zip.

### Types

`@devlog/extension-api` is not published to npm. Take it from a checkout of
the Devlog repository, for example:

```sh
git clone https://github.com/sdeken/devlog ../devlog
npm install --save-dev ../devlog/packages/extension-api esbuild typescript vitest
```

It exports TypeScript sources (`@devlog/extension-api`,
`@devlog/extension-api/testing`, `/view`, `/protocol`), so use
`"moduleResolution": "bundler"` in your `tsconfig.json`. The types are for
building only; nothing from the package is needed at runtime, because the app
provides `ctx`.

## 2. Write the manifest

`devlog-extension.json`:

```json
{
  "name": "devlog-standup",
  "displayName": "Standup",
  "version": "0.1.0",
  "description": "Posts what you wrote yesterday and today as one block.",
  "api": "^1.7.0",
  "main": "main.js",
  "contributes": {
    "settings": [
      {
        "key": "heading",
        "label": "Heading",
        "placeholder": "Standup",
        "description": "The first line of the block it posts."
      }
    ],
    "commands": [
      { "id": "post", "label": "Post a standup here", "keybinding": "Mod+Alt+U", "menus": ["canvas"] }
    ]
  },
  "permissions": { "read": true, "write": true }
}
```

- `api` is the lowest API version you need, as a range. `^1.7.0` because
  `devlog.range` arrived in 1.7.
- Commands must be declared here *and* registered in code.
- `read` and `write` make the consent dialog ask the user for a scope.

Every field is described in [Extension Manifest](Extension-Manifest).

## 3. Write the code

`src/main.ts`:

```ts
import type { CommandContext, DevlogContext } from '@devlog/extension-api'

/** Local calendar date, YYYY-MM-DD. */
const day = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export async function activate(ctx: DevlogContext): Promise<void> {
  ctx.commands.register('post', async (context: CommandContext) => {
    if (!context.canvasId) throw new Error('Open a canvas first')

    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const names = new Map((await ctx.devlog.canvases()).map((c) => [c.id, c.title]))

    // Every day file with blocks written in the range, on canvases it may read.
    const lines: string[] = []
    for (const { canvasId, blocks } of await ctx.devlog.range(day(yesterday), day(today))) {
      for (const b of blocks) {
        if (b.meta?.ext === ctx.id) continue // skip our own standups
        const first = b.markdown.split('\n')[0].slice(0, 120)
        lines.push(`- **${names.get(canvasId) ?? canvasId}**: ${first}`)
      }
    }
    if (!lines.length) return 'Nothing written yesterday or today'

    const heading = ctx.settings.get('heading') || 'Standup'
    await ctx.devlog.addBlock(context.canvasId, `**${heading}**\n\n${lines.join('\n')}`, { meta: { source: 'standup' } })

    // Remember when we last posted, on this machine only.
    await ctx.files.local.write('last.json', JSON.stringify({ at: today.toISOString(), count: lines.length }))
    return `Posted ${lines.length} lines`
  })
}
```

What to notice:

- `activate` only **registers** things. The app waits for it to return (30
  seconds at most) before it counts the extension as running.
- `context.canvasId` is the canvas on screen (or the canvas whose menu was
  used). Canvases outside the grant are left out.
- `range` and `canvases` return only what the grant allows. `addBlock` fails
  with `No write access to that canvas` outside the write scope.
- Throwing from a command shows the error to the user; returning a string
  shows the string.
- The block it adds is marked `ext=<id>` and is read-only in the app.

## 4. Bundle it

```sh
npx esbuild src/main.ts --bundle --platform=node --format=cjs --target=node20 --outfile=main.js
```

The result must be one CommonJS file. `require` of anything but a Node
built-in fails at runtime ("Extensions are bundled"), so bundle every
dependency. `fetch` is available.

## 5. Test it without Devlog

`tests/main.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTestContext, type TestCanvas } from '@devlog/extension-api/testing'
import { activate } from '../src/main'

const now = new Date()
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const acme: TestCanvas = {
  id: 'acme', title: 'Acme', parentId: null, task: false, archived: false, fields: {},
  days: { [today]: [{ id: 'b1', createdAt: now.toISOString(), markdown: 'Fixed the login bug' }] }
}
const notes: TestCanvas = { id: 'notes', title: 'Notes', parentId: null, task: false, archived: false, fields: {} }

describe('standup', () => {
  it('posts what was written', async () => {
    const t = createTestContext({ settings: { heading: 'Daily' }, canvases: [structuredClone(acme), structuredClone(notes)] })
    await activate(t.ctx)
    expect(await t.run('post', { canvasId: 'notes' })).toBe('Posted 1 lines')
    expect(t.added[0].block.markdown).toContain('**Acme**: Fixed the login bug')
  })

  it('cannot write outside its grant', async () => {
    const t = createTestContext({ write: [], canvases: [structuredClone(acme), structuredClone(notes)] })
    await activate(t.ctx)
    await expect(t.run('post', { canvasId: 'notes' })).rejects.toThrow('No write access')
  })
})
```

The harness follows the real rules (relative paths only, grants enforced,
blocks marked as yours) and adds blocks to the canvases you pass in, so give
each test its own copy. See [Testing Extensions](Testing-Extensions).

## 6. Run it in Devlog

Point Devlog at your folder without releasing anything. In the app's **user
data folder** create `extension-dev.json`, mapping a `devlog.json` key to your
folder:

```json
{ "devlog-standup": "/home/me/src/devlog-standup" }
```

The user data folder is typically `%APPDATA%\Devlog` (Windows),
`~/Library/Application Support/Devlog` (macOS) or `~/.config/Devlog`
(Linux); `devlog` rather than `Devlog` when running from source; or whatever
`DEVLOG_USER_DATA` points to.

Then in **Extensions** add `devlog-standup` with version `builtin`. The
folder is used as is (its id is `builtin.devlog-standup`). Every change to
the folder is new code, so it asks for consent again; rebuild, then allow.

The extension's `console.log` and `console.error` output goes to the app's
stdout/stderr, prefixed `[ext <id>]`, so run the app from a terminal
(`npm run dev` in a Devlog checkout) to see it.

## 7. Release it

1. Zip the folder's shipped files (the manifest at the top of the zip, or
   inside one folder) as `<anything>.devlog-ext.zip`.
2. Create a GitHub release tagged with the version (`v0.1.0`) and attach the
   zip.
3. Users add `your-name/devlog-standup` with a range such as `^0.1.0`.
   Devlog picks the newest matching release, pins its SHA-256 in
   `devlog.lock.json`, and asks before running it.

Private repositories work: users add a GitHub token on the Extensions page.
Alternatively host the zip anywhere over HTTPS and add it by URL.

## Next steps

- Add a status bar item or a page: [Views and UI](Views-and-UI).
- Send timesheets somewhere: [Timesheet Destinations](Timesheet-Destinations).
- React to posts: `ctx.devlog.onBlockAdded` in the
  [API reference](Extension-API-Reference#events).
- Read a real one: [Built-in Extensions](Built-in-Extensions).
