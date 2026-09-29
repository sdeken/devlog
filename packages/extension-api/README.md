# Writing a Devlog extension

An extension adds something to Devlog without growing the app: sending time
to Jira, fields on canvases, commands in the quick switcher. It runs in its
own process with **no access to files, other programs or other extensions**;
everything goes through the `ctx` object it is given, filtered by what the
user allowed. The design is in `docs/EXTENSIONS.md`.

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

- **Fields** (`settings`, `secrets`, `canvasFields`) take `key`, `label`,
  and optionally `description` (shown under the field), `placeholder`,
  `required: true` (the extension's card says "Needs: …" until it is set),
  and for settings and canvas fields a `type`: `text` (default), `url`,
  `email`, `number`, `select` (with `options: [{ value, label }]`),
  `checkbox` or `textarea`. Values are checked by type when saved.
- **`check`** names one of your commands that tests the settings (a login,
  say); the settings page offers **Test** / **Save and test** and shows the
  text the command returns, or its error.
- **`contributes`** is what the app shows without running your code: canvas
  fields (in the canvas dialog, stored in `canvas.md` as
  `ext.<id>.<key>`), devlog-wide settings (stored in `devlog.json`), secrets
  (the OS keychain on each machine) and commands (the quick switcher).
- **`permissions`**: `read` / `write` ask for access to notes; the user
  picks the whole devlog or chosen canvases. `network` lists the domains you
  talk to; it is shown to the user (not enforced in v1).

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
| `ctx.devlog` | `canvases()`, `field(canvasId, key)`, `days(canvasId)`, `blocks(canvasId, date)`, `search(q)`, `addBlock(canvasId, markdown, { meta, parentId, date, todo })`, `todos({ doneSince })`: all limited to what the user granted. Adding inside a block, adding todos and `todos()` are 1.4 |
| `ctx.files.repo` / `ctx.files.local` | private folders (synced with the devlog / this machine only): `read`, `readText`, `write`, `append`, `list`, `stat`, `remove`, relative paths only |
| `ctx.settings` | `get(key)`, `onChange(cb)` |
| `ctx.secrets` | `get`, `set`, `delete` |
| `ctx.activity.on(cb)` | pause (locked, idle, asleep), resume, task changes |
| `ctx.ui` | `notify(message)`, `confirm(message)` |
| `ctx.commands.register(id, run)` | for commands declared in the manifest |
| `ctx.machine` | this machine's folder name, for per-machine files (1.1) |
| `ctx.packageDir` | the extension's unpacked folder, for scripts it ships; only when it runs unrestricted, else null (1.2) |
| `ctx.provide.focus(fn)` | focus events for the app's timeline, review and summary (1.1) |
| `ctx.views.handle(viewId, (method, args) => …)`, `ctx.views.post(viewId, message)` | answer calls from your views' pages and push messages to them (1.5; see docs/EXTENSIONS.md, Views) |
| `ctx.destinations.register(id, { preview, send })` | a place finished timesheets can be sent, declared in `contributes.destinations` (1.3) |

`builtin-extensions/devlog-jira` is a complete destination (sandboxed:
settings, a secret, a canvas field, a ledger in its own files, fetch).
`builtin-extensions/devlog-focus` is a complete, small example (window
tracking): an unrestricted extension with its own platform helper,
per-machine JSON-lines files, and data given back to the app.

What does **not** work, by design: `fs`, `child_process`, `worker_threads`,
native addons (all refused by the runtime), and `require` of anything but
Node's built-ins, so bundle your dependencies. If your extension really
needs files or programs (a platform helper, say), declare
`"permissions": { "unrestricted": true }`: it then runs without the sandbox,
but only after the user says they trust it (esbuild:
`esbuild src/main.ts --bundle --platform=node --format=cjs --outfile=main.js`).
`fetch` works.

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
