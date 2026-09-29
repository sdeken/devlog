# Writing a Devlog extension

An extension adds something to Devlog without growing the app: time
tracking, sending time to Jira, fields on canvases, commands, pages of its
own. It runs in its own process with **no access to files, other programs
or other extensions** (unless the user trusts it; see below); everything
goes through the `ctx` object it is given, filtered by what the user
allowed. How it fits together is in `docs/EXTENSIONS.md`; the reference is
`src/index.ts`, every member commented with the API version that added it.
This version of Devlog provides API **1.7.0**; declare the lowest you need
(`"api": "^1.6.0"`) and newer apps keep loading it.

## The files

```
my-extension/
  devlog-extension.json   the manifest
  main.js                 one bundled CommonJS file exporting activate(ctx)
```

```jsonc
{
  "name": "devlog-jira",                 // lowercase, digits, . _ -
  "displayName": "Jira time export",
  "version": "1.2.0",
  "api": "^1.3.0",                       // the extension API it was built for
  "main": "main.js",
  "contributes": {
    "canvasFields": [{ "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }],
    "settings": [{ "key": "baseurl", "label": "Jira URL" }],
    "secrets": [{ "key": "token", "label": "API token" }],
    "commands": [{ "id": "send", "label": "Send this week's worklogs" }]
  },
  "permissions": { "read": true, "write": false, "network": ["*.atlassian.net"] },
  "appendOnly": ["log/*.jsonl"]          // its own repo files git should union-merge
}
```

- **Fields** (`settings`, `secrets`, `canvasFields`) take `key` (lowercase
  letters, digits, `_`), `label`, and optionally `description` (shown under
  the field), `placeholder`, and for settings and canvas fields a `type`:
  `text` (default), `url`, `email`, `number`, `select` (with
  `options: [{ value, label }]`), `checkbox` or `textarea`. Settings and
  secrets can be `required: true` (the extension's card says "Needs: …"
  until it is set), and settings are checked by type when saved. A canvas
  field is inherited by the canvases inside its canvas unless it says
  `inherited: false` (1.7).
- **`check`** names one of your commands that tests the settings (a login,
  say); the settings page offers **Test** / **Save and test** and shows the
  text the command returns, or its error.
- **`contributes`** is what the app shows without running your code:
  - `canvasFields` (in the canvas's Properties, stored in `canvas.md` as
    `ext.<id>.<key>`), `settings` (stored in `devlog.json`), `secrets` (the
    OS keychain on each machine);
  - `commands` (the quick switcher), each optionally with a `keybinding`
    (`Mod+Shift+S`), `menus` (`canvas`, `block`, `tray`), a `nodeType` it
    is offered on, and `post: true` / `tag` to make it a way to post from
    the note box (1.6);
  - `views` (1.5): HTML pages from your package, `placement` `page` (in the
    sidebar), `statusbar`, `popover` or `canvasHeader` (1.6, optionally for
    one `nodeType`);
  - `nodeTypes` (1.6): kinds of canvas, with a label and icon;
  - `destinations` (1.3): places a finished timesheet can be sent.
- **`permissions`**: `read` / `write` ask for access to notes; the user
  picks the whole devlog or chosen canvases. `send` (1.7) lets it send
  through other extensions' destinations. `network` lists the domains you
  talk to; it is shown to the user, not enforced. `unrestricted` asks to
  run outside the sandbox (below).

## The code

```js
exports.activate = async (ctx) => {
  ctx.commands.register('send', async () => {
    const base = ctx.settings.get('baseurl')
    const token = await ctx.secrets.get('token')
    for (const canvas of await ctx.devlog.canvases()) {
      const issue = await ctx.devlog.field(canvas.id, 'issue') // inherited from parents
      // …
    }
    await ctx.files.repo.append('log/sent.jsonl', JSON.stringify({ at: new Date().toISOString() }) + '\n')
    ctx.ui.notify('Sent')
  })
}
```

The full API, with comments, is `src/index.ts`. In short:

| | |
|---|---|
| `ctx.id`, `ctx.apiVersion`, `ctx.machine` | its id, the app's API version, this machine's folder name for per-machine files (1.1) |
| `ctx.packageDir` | the extension's unpacked folder, for scripts it ships; only when it runs unrestricted, else null (1.2) |
| `ctx.devlog` | `canvases()`, `field(canvasId, key)`, `days(canvasId)`, `blocks(canvasId, date)`, `search(q)`, `addBlock(canvasId, markdown, { meta, parentId, date, todo, kind })`, `todos({ doneSince })` (1.4); `createCanvas`, `updateCanvas`, `editBlock`, `promote(canvasId, date, blockId, { type })`, `onBlockAdded(cb)` (1.6); `activity(from, to)`, `range(from, to)`, `managedCanvas(key, { title })` (1.7). All limited to what the user granted |
| `ctx.files.repo` / `ctx.files.local` | private folders (synced with the devlog / this machine only): `read`, `readText`, `write`, `append`, `list`, `stat`, `remove`, relative paths only |
| `ctx.settings` | `get(key)`, `onChange(cb)` |
| `ctx.secrets` | `get`, `set`, `delete` |
| `ctx.activity` | `on(cb)`: pause (locked, idle, asleep) and resume; `idleAfter(minutes)` (1.6) |
| `ctx.ui` | `notify(message)`, `confirm(message)`; `pick(items)`, `open({ canvasId, date, blockId })`, `highlight(canvasId)` (1.6); `openPage(viewId)` (1.7) |
| `ctx.app` | `setTrayLabel(label)`, `keepRunning(on)` (1.6) |
| `ctx.commands.register(id, run)` | for commands declared in the manifest; `run(context)` says where it was run from and on which canvas or block (1.6) |
| `ctx.views.handle(viewId, (method, args) => …)`, `ctx.views.post(viewId, message)` | answer calls from your views' pages and push messages to them (1.5; see `docs/EXTENSIONS.md`, Views) |
| `ctx.destinations` | `register(id, { preview, send })` for those declared in `contributes.destinations` (1.3); `list()`, `preview(to, sheet)`, `send(to, sheet)` with `permissions.send` (1.7) |
| `ctx.provide` | `focus(fn)`: focus events for the timeline, review and summary (1.1); `activity(fn)`: time events the app replays in its views (1.6) |

Views are built with `@devlog/ui` (React components and the bridge to your
process); `builtin-extensions/devlog-time` is the complete example: a node
type, commands in menus and keys, status bar, popover, canvas header and
page views, a managed canvas, and sending through other extensions'
destinations.
`builtin-extensions/devlog-jira` is a complete destination (sandboxed:
settings, a secret, a canvas field, a ledger in its own files, fetch).
`builtin-extensions/devlog-focus` is a complete, small example (window
tracking): an unrestricted extension with its own platform helper,
per-machine JSON-lines files, and data given back to the app.

What does **not** work, by design: `fs`, `child_process`, `worker_threads`,
native addons (all refused by the runtime), and `require` of anything but
Node's built-ins, so bundle your dependencies (esbuild:
`esbuild src/main.ts --bundle --platform=node --format=cjs --outfile=main.js`).
`fetch` works. If your extension really needs files or programs (a platform
helper, say), declare `"permissions": { "unrestricted": true }`: it then
runs without the sandbox, but only after the user says they trust it.

## Testing

`@devlog/extension-api/testing` gives you an in-memory `ctx`:

```ts
import { createTestContext } from '@devlog/extension-api/testing'
import * as ext from '../src/main'

const t = createTestContext({ settings: { baseurl: 'https://acme.atlassian.net' }, secrets: { token: 'x' }, canvases: [/* … */], read: ['acme'] })
await ext.activate(t.ctx)
await t.run('send')
expect(t.notifications).toEqual(['Sent'])
```

Options also take `write`, `activity` (what `devlog.activity` returns),
`destinations`, `confirm` and `now`. The harness records what the extension
did (`added`, `created`, `files`, `secrets`, `opened`, `openedPages`,
`picks`, `app`: tray label, keep running, idle minutes, highlight;
`viewMessages`) and drives it: `run(command, context)`, `post(canvasId,
date, block)` (a block posted in the app), `notice(n)` (pause/resume),
`setSettings`, `answerPick`, `viewCall(view, method, …args)`,
`preview`/`send` on its destinations, and `focus`/`timeEvents` for what it
provides.

## Trying it in Devlog

Point Devlog at your folder without releasing anything: in the app's user
data folder, create `extension-dev.json`:

```json
{ "devlog-jira": "C:\\src\\devlog-jira" }
```

then add `devlog-jira` with version `builtin` in **Extensions** (quick
switcher → Extensions). The folder is used as is, and every change to it asks
for consent again (the code changed).

## Releasing

Zip the folder (the manifest at the top, or inside one folder) as
`<anything>.devlog-ext.zip` and attach it to a GitHub release tagged with the
version (`v1.2.0`). Users add `owner/repo` with a range (`^1.2.0`); Devlog
picks the newest matching release, pins its SHA-256 in `devlog.lock.json`,
and asks before running it. Private repositories work with a GitHub token
(Extensions → GitHub token).
