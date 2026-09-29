# Extension API reference

API version **1.7.0**. Source of truth:
[`packages/extension-api/src/index.ts`](https://github.com/sdeken/devlog/blob/main/packages/extension-api/src/index.ts),
where every member is commented with the version that added it. Types used
below are described in [Extension Types](Extension-Types).

## Contents

- [The module](#the-module)
- [Conventions](#conventions)
- [`ctx` properties](#ctx-properties)
- [`ctx.devlog`](#ctxdevlog): [reading](#reading), [writing blocks](#writing-blocks), [canvases](#canvases), [activity and ranges](#activity-and-ranges), [managed canvases](#managed-canvases), [events](#events)
- [`ctx.settings`](#ctxsettings)
- [`ctx.secrets`](#ctxsecrets)
- [`ctx.files`](#ctxfiles)
- [`ctx.activity`](#ctxactivity)
- [`ctx.ui`](#ctxui)
- [`ctx.app`](#ctxapp)
- [`ctx.commands`](#ctxcommands)
- [`ctx.views`](#ctxviews)
- [`ctx.destinations`](#ctxdestinations)
- [`ctx.provide`](#ctxprovide)
- [Timeouts and limits](#timeouts-and-limits)

## The module

`main.js` is CommonJS and exports `activate`, and optionally `deactivate`:

```ts
export interface ExtensionModule {
  activate(ctx: DevlogContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

```js
exports.activate = async (ctx) => { /* register things */ }
exports.deactivate = async () => { /* flush, close */ }
```

A bundle whose `module.exports.default` holds them (an ES module compiled to
CommonJS) works too.

- `activate` must finish within **30 seconds**; until it returns the
  extension is "starting" and nothing is routed to it.
- Register commands, view handlers, destinations and providers in
  `activate`. They can be registered later, but the app only routes to a
  handler once it has been registered.
- `deactivate` runs when the app stops the extension (quit, revoke, removal,
  a grant change, an update). The process exits right after it settles.

## Conventions

- **Everything that talks to the app is asynchronous** and returns a
  promise, except the fire-and-forget calls marked *(no reply)* below
  (`ui.notify`, `ui.open`, `app.*`, `views.post`, …), which return
  immediately.
- **Errors are `Error`s with a readable message** (`No write access to that
  canvas`). They are meant to be shown: throw them on from a command and the
  user sees them.
- **Dates** are local calendar dates, `YYYY-MM-DD`. **Times** are ISO-8601
  strings.
- **Where a block lives** is always `(canvasId, date)`: its canvas and the
  day file it is stored in (for a block inside another, the root block's
  day).
- **Values cross a process boundary** with structured clone: return plain
  data (objects, arrays, strings, numbers, `Uint8Array`), not class instances
  or functions.
- **Grants** filter everything. "Readable" below means inside the read
  scope; "writable" inside the write scope; a canvas the extension keeps
  (`managedCanvas`) is both, whatever it was granted.

## `ctx` properties

| Member | Type | Since | Description |
|---|---|---|---|
| `ctx.id` | `string` | 1.0 | The extension's id, from where it was installed: `sdeken.devlog-jira`, `url.my-ext`, `builtin.devlog-time`. |
| `ctx.apiVersion` | `string` | 1.0 | The app's extension API version, e.g. `1.7.0`. |
| `ctx.machine` | `string` | 1.1 | This machine's folder name in the devlog (`<host>-<short id>`), for per-machine files. |
| `ctx.packageDir` | `string \| null` | 1.2 | The extension's unpacked folder, for helper scripts it ships. Only when running unrestricted; `null` in the sandbox. |

Feature-detect newer members by version when you support older apps:

```js
const [maj, min] = ctx.apiVersion.split('.').map(Number)
if (maj > 1 || min >= 7) await ctx.devlog.range(from, to)
```

## `ctx.devlog`

The devlog, filtered by the grant.

### Reading

#### `canvases(): Promise<ExtensionCanvas[]>` (1.0)

Every canvas it may read or write, plus their ancestors (so it can name
them), plus canvases it keeps. Archived canvases are included (check
`archived`). `fields` holds only this extension's own canvas fields set on
each canvas. The retired journal is not listed.

#### `field(canvasId, key): Promise<string | null>` (1.0)

One of its own canvas fields, from the canvas or the nearest ancestor that
sets it (unless the field is `inherited: false`). `null` when none does.

- Throws `No access to that canvas` for a canvas `canvases()` would not list.

```js
const issue = await ctx.devlog.field(canvasId, 'issue') // "ACME-123", inherited from the project
```

#### `days(canvasId): Promise<string[]>` (1.0)

The dates of the day files that have blocks on a canvas.
Throws `No read access to that canvas` outside the read scope.

#### `blocks(canvasId, date): Promise<ExtensionBlock[]>` (1.0)

A day file's blocks, in display order (depth-first; a block inside another
has `parentId`). Throws `No read access to that canvas` outside the read
scope.

#### `search(query): Promise<ExtensionSearchResult>` (1.0)

Full-text (substring) search over blocks, limited to readable canvases.
Surfaces are not included. With no read grant it returns `{ blocks: [] }`.

#### `todos(opts?): Promise<ExtensionTodo[]>` (1.4)

Open todos on readable canvases, plus those ticked off since
`opts.doneSince` (an ISO time). Each comes with its canvas, day file and the
blocks it sits inside (`trail`). With no read grant, `[]`.

### Writing blocks

#### `addBlock(canvasId, markdown, opts?): Promise<{ date, block }>` (1.0, 1.4, 1.7)

Adds a block to a writable canvas. By default at the end of **today**'s day
file.

| Option | Since | Meaning |
|---|---|---|
| `meta` | 1.0 | String attributes stored on the block. Keys `^[a-z][a-z0-9_-]{0,31}$`, not `id at parent pos kind hidden updated ext`; values are flattened to one line and cut to 500 characters. |
| `parentId` + `date` | 1.4 | Add it inside that block (the last child). `date` is the day file the parent lives in; required with `parentId`. |
| `todo` | 1.4 | Add it as a todo (`kind: 'todo'`). |
| `kind` | 1.7 | Only on a canvas it keeps: a kind of its own, `^[a-z][a-z0-9-]{0,31}$`, not `note todo task commit done`. |
| `date` alone | 1.7 | Only on a canvas it keeps: the day file to add to. Elsewhere `date` without `parentId` is ignored (today is used). |

The block gets `meta.ext = ctx.id`. Its text is read-only in the app (a todo
can still be ticked). Markdown must be non-blank and at most 100 000
characters.

Errors: `No write access to that canvas`; `devlog.addBlock: a block added
inside another needs that block's date`; `devlog.addBlock: a kind only on a
canvas it keeps`; `devlog.addBlock: not a kind it may use: …`; `Not a
metadata key: …`; `Cannot add an empty block`; `That block is too long`.

Blocks it adds do **not** fire other extensions' `onBlockAdded`
listeners (those are for blocks people post).

```js
const { date, block } = await ctx.devlog.addBlock(canvasId, 'Deployed **v2.3** to staging', { meta: { env: 'staging' } })
await ctx.devlog.addBlock(canvasId, 'Check the error rate tomorrow', { parentId: block.id, date, todo: true })
```

#### `editBlock(canvasId, date, blockId, markdown): Promise<ExtensionBlock>` (1.6)

Changes the text of a block **it added** (any block on a canvas it keeps).
Throws `Only blocks it added`, `Entry … not found on …`, `No write access to
that canvas`.

#### `promote(canvasId, date, blockId, { type }): Promise<{ canvas, block }>` (1.6)

Turns a block into a canvas of one of its own node types, just inside the
block's canvas: the new canvas is titled from the block's first sentence,
what was written inside the block moves there, and the block becomes the
link to it (`kind: 'task'`, `meta.canvas`). A block that already links to a
canvas returns that canvas. Needs write access to `canvasId`.

`type` is one of its node type ids (`task`) or the full name
(`builtin.devlog-time/task`); anything else throws `"…" is not one of its
node types (contributes.nodeTypes)`.

### Canvases

#### `createCanvas({ title, parentId?, type? }): Promise<ExtensionCanvas>` (1.6)

Makes a canvas inside a writable canvas, or at the top level if its write
scope is the whole devlog. `type` is one of its own node types.

Errors: `devlog.createCanvas: give it a title`; `No write access to that
canvas`; `Only an extension that may write everywhere can make a top-level
canvas`.

#### `updateCanvas(canvasId, patch): Promise<ExtensionCanvas>` (1.6)

Changes a writable canvas. `patch` may hold:

| Key | Meaning |
|---|---|
| `title` | A new title. |
| `parentId` | Move it: into another writable canvas, or `null` for the top level (only with write access everywhere). |
| `type` | One of its own node types, or `null` for a plain canvas. It may not change a canvas that has another extension's type. |
| `archived` | Archive or unarchive it, with everything beneath it. |

Errors: `No write access to that canvas`; `No write access to where it would
go`; `That canvas has another extension's type`.

### Activity and ranges

#### `activity(fromDate, toDate): Promise<ActivityRecord[]>` (1.7)

What the app recorded between two local dates, inclusive: its own log
(locks, idle, sleep, git events, corrections) merged with what extensions
provide (time, focus).

- Needs a read grant (throws `No read access` otherwise).
- Events on canvases it may not read show `canvasId: null`; git events on
  them are dropped.
- `focus` events (window titles) only with read access to the **whole
  devlog**.
- At most 400 days per call; dates must be `YYYY-MM-DD` and in order.

#### `range(fromDate, toDate): Promise<ExtensionDayBlocks[]>` (1.7)

The day files with blocks written between two local dates, inclusive, on
readable canvases (a day file is included when a block in it was written in
the range, or a todo in it was ticked in the range). With no read grant,
`[]`. Same date rules as `activity`.

### Managed canvases

#### `managedCanvas(key, opts?): Promise<ExtensionCanvas>` (1.7)

A canvas this extension keeps: found by `key` (`^[a-z][a-z0-9_-]{0,63}$`),
made on first use with `opts.title` (default: the key) at the top level. It
carries `devlog.managed: <id>/<key>` in its `canvas.md`. On it the extension
may, whatever it was granted:

- read every block (`days`, `blocks`);
- add blocks with kinds of its own and on any `date`;
- `editBlock` any block.

devlog-time keeps its **Timesheets** canvas this way.

```js
const log = await ctx.devlog.managedCanvas('deploys', { title: 'Deploys' })
await ctx.devlog.addBlock(log.id, 'v2.3 → production', { kind: 'deploy', date: '2026-09-28' })
```

### Events

#### `onBlockAdded(cb: (ev: BlockAddedEvent) => void): void` (1.6)

Blocks posted **in the app** (by the user), as they are posted, on canvases
it may read. Not called for blocks extensions add. Listeners get
`{ canvasId, date, block }`.

```js
ctx.devlog.onBlockAdded(({ canvasId, block }) => {
  if (/#deploy\b/.test(block.markdown)) void recordDeploy(canvasId, block)
})
```

## `ctx.settings`

Devlog-wide settings (`contributes.settings`), stored in `devlog.json`.
Synchronous: the process keeps a copy.

| Method | Since | Description |
|---|---|---|
| `get(key): string \| undefined` | 1.0 | The current value. All values are strings (`"true"` for a ticked checkbox). |
| `onChange(cb: (settings: Record<string, string>) => void): void` | 1.0 | Called with every setting when the user saves. |

## `ctx.secrets`

Secrets kept on this machine, encrypted with the OS keychain (Electron
`safeStorage`), never in the devlog. Keys are `^[a-z][a-z0-9_-]{0,63}$`.
The user sets declared secrets on the extension's settings page; an
extension may also set them itself (after an OAuth flow, say).

| Method | Since | Description |
|---|---|---|
| `get(key): Promise<string \| undefined>` | 1.0 | |
| `set(key, value): Promise<void>` | 1.0 | |
| `delete(key): Promise<void>` | 1.0 | |

## `ctx.files`

Two private folders, reached only through relative paths:

| Folder | Where | Synced | For |
|---|---|---|---|
| `ctx.files.repo` | `extensions/<id>/` in the devlog | yes, with the next commit | Data every machine should see: logs, ledgers of what was sent |
| `ctx.files.local` | `userData/extension-data/<id>/<devlog>/` | no | Machine-only state: cursors, caches, preferences |

Both implement `ExtensionFiles`:

| Method | Description |
|---|---|
| `read(path): Promise<Uint8Array \| undefined>` | Bytes, or `undefined` if missing. |
| `readText(path): Promise<string \| undefined>` | UTF-8 text, or `undefined`. |
| `write(path, data: string \| Uint8Array): Promise<void>` | Replace a file atomically (temp file, then rename). Folders are made as needed. |
| `append(path, text): Promise<void>` | Append text. Pair with `appendOnly` in the manifest for synced logs. |
| `list(dir?): Promise<ExtensionFileInfo[]>` | Files under a folder (the whole folder by default). |
| `stat(path): Promise<ExtensionFileInfo \| undefined>` | `{ path, size, mtime }`, or `undefined`. |
| `remove(path): Promise<void>` | Delete a file. |

Path rules: relative, `/`-separated, at most 400 characters; no absolute
paths, drive letters, `.` or `..` segments, backslashes, `< > : " | ? *` or
control characters, Windows device names (`con`, `nul`, `com1`, …), segments
ending in `.` or space, or segments over 128 characters. Symlinks anywhere on
the way are refused. Limits: **16 MB per file, 256 MB per folder, 20 000
files**.

The core ignores `extensions/` when listing, indexing and searching. Writes
there don't count as unsaved work and don't trigger the commit debounce; they
ride along with the next interval commit.

```js
await ctx.files.repo.append(`${ctx.machine}/2026/09/2026-09-28.jsonl`, JSON.stringify({ t: new Date().toISOString(), ok: true }) + '\n')
const state = JSON.parse((await ctx.files.local.readText('state.json')) ?? '{}')
```

## `ctx.activity`

The machine's state as the app sees it. See
[Activity and Time Data](Activity-and-Time-Data).

| Method | Since | Description |
|---|---|---|
| `on(cb: (n: ActivityNotice) => void): void` | 1.0 | `pause` (with `reason`: `locked`, `idle`, `suspended`) and `resume`, as they happen. |
| `idleAfter(minutes): void` | 1.6 | Ask the app to count the machine idle after this many minutes without input (0: never; at most 1440). The app uses the shortest any extension asks for. *(no reply)* |

## `ctx.ui`

| Method | Since | Description |
|---|---|---|
| `notify(message): void` | 1.0 | A toast, prefixed with its display name; cut to 300 characters. *(no reply)* |
| `confirm(message): Promise<boolean>` | 1.0 | A yes/no dialog titled with its display name; cut to 1000 characters. |
| `pick(items: PickItem[], opts?: { placeholder? }): Promise<string \| null>` | 1.6 | A quick pick like the switcher. Returns the chosen item's `id`, or `null` if dismissed. Up to 5000 items; labels cut to 300, hints to 200 characters. |
| `open({ canvasId, date?, blockId? }): void` | 1.6 | Show a canvas, or a block's page (`date` and `blockId` together). Throws `No access to that canvas` for a canvas it cannot see. *(no reply)* |
| `openPage(viewId): void` | 1.7 | Show one of its `page` views. *(no reply)* |
| `highlight(canvasId \| null): void` | 1.6 | Mark one canvas as its current one (the running task): the sidebar highlights it, and commits from a linked repository land on it when it is inside the linked canvas. `null` clears it. *(no reply)* |

```js
const id = await ctx.ui.pick(
  [{ id: 'a', label: 'Staging', hint: 'eu-west' }, { id: 'b', label: 'Production' }],
  { placeholder: 'Deploy to…' }
)
if (id && (await ctx.ui.confirm(`Deploy to ${id}?`))) ctx.ui.notify('Deploying')
```

## `ctx.app`

The app around the window (1.6).

| Method | Description |
|---|---|
| `setTrayLabel(label \| null): void` | Text beside the tray icon and in its tooltip (trimmed, at most 60 characters); `null` clears it. *(no reply)* |
| `keepRunning(on: boolean): void` | Keep the app running in the tray when its window is closed, so the extension keeps going. *(no reply)* |

## `ctx.commands`

#### `register(id, run: (context: CommandContext) => unknown): void` (1.0, 1.6)

Registers a command declared in `contributes.commands`. It appears in the
quick switcher, and in the menus, keybindings and note box the manifest
names.

- `context` (1.6) says where it ran from (`source`: `switcher`,
  `keybinding`, `menu`, `post`, `view`, `tray`) and on what: `canvasId` (the
  canvas on screen, or the one whose menu it was) and, when the extension may
  read that canvas, `date` and `blockId` (the block whose menu it was, the
  block page on screen, or the block just posted). Canvases it cannot see are
  left out.
- A **string** it returns is shown to the user (first 500 characters); a
  `check` command's result is shown on the settings page.
- A thrown error is shown to the user.
- Commands time out after 10 minutes.

```js
ctx.commands.register('copy-link', async ({ canvasId, date, blockId }) => {
  if (!blockId) throw new Error('Run this on a block')
  return `devlog block ${canvasId}/${date}/${blockId}`
})
```

## `ctx.views`

Views declared in `contributes.views` (1.5). See [Views and UI](Views-and-UI).

| Method | Description |
|---|---|
| `handle(viewId, handler: (method: string, args: unknown[]) => unknown): void` | Answer calls from the view's page (`devlog.call(method, ...args)` in the page). The handler's return value (or thrown error) is the page's reply. 60-second timeout. Throws for a view not declared in the manifest. |
| `post(viewId, message): void` | Send a message to every open copy of the view (the page's `devlog.onMessage` / `useMessages`). *(no reply)* |

```js
ctx.views.handle('status', async (method, args) => {
  switch (method) {
    case 'status': return clock.status()
    case 'start': await clock.start(String(args[0])); return clock.status()
    default: throw new Error(`No method ${method}`)
  }
})
clock.onChange((st) => ctx.views.post('status', st))
```

## `ctx.destinations`

Timesheet destinations. See [Timesheet Destinations](Timesheet-Destinations).

| Method | Since | Description |
|---|---|---|
| `register(id, { preview, send }): void` | 1.3 | Register a destination declared in `contributes.destinations`. |
| `list(): Promise<DestinationInfo[]>` | 1.7 | Destinations registered by running extensions (including its own). |
| `preview(to: { extension, id }, sheet: SheetToSend): Promise<DestinationLine[]>` | 1.7 | What sending would do. Needs `permissions.send`. |
| `send(to: { extension, id }, sheet: SheetToSend): Promise<SendResult>` | 1.7 | Send a **final** week. Needs `permissions.send`. |

## `ctx.provide`

Data the app draws in its own views (1.1). See
[Activity and Time Data](Activity-and-Time-Data).

| Method | Since | Description |
|---|---|---|
| `focus(fn: (fromDate, toDate) => Promise<FocusEvent[]>): void` | 1.1 | Window focus changes between two local dates (inclusive), for the timeline, review and summary. |
| `activity(fn: (fromDate, toDate) => Promise<TimeEvent[]>): void` | 1.6 | Time-tracking events (`start`, `task`, `stop`, `heartbeat`), for the review, summary, timeline and timesheet. While any extension provides time, the app also logs lock/idle/sleep and git events. |

Providers must answer within 20 seconds; at most 500 000 events per call are
used.

## Timeouts and limits

| What | Limit |
|---|---|
| `activate` | 30 s, or the extension is stopped as failed |
| A command | 10 min |
| A view call | 60 s |
| Destination preview / send | 2 min / 10 min |
| Focus / activity provider | 20 s |
| Event delivery (`onBlockAdded`, `activity.on`) | 10 s per listener round |
| Process heap | 256 MB |
| Block text | 100 000 characters |
| Metadata value | 500 characters, one line |
| Files | 16 MB per file, 256 MB and 20 000 files per folder |
| `activity` / `range` | 400 days per call |
| Command result shown | 500 characters |
