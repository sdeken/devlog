# Extensions

Features beyond notes come as extensions a devlog opts into: time tracking
(devlog-time), window tracking (devlog-focus), Jira worklogs (devlog-jira)
and CMS timesheets (devlog-cms) ship with the app. The extension API is at
1.7 (`EXTENSION_API_VERSION` in `packages/core/src/extensions.ts`); each
member says in `packages/extension-api/src/index.ts` which version it
arrived in. How to write one: `packages/extension-api/README.md`.

## Principles

- **The devlog stays Just A Notebook.** It *names* the extensions it wants
  and holds their non-secret settings; it never contains their code, their
  secrets, or anything they need at runtime besides that.
- Opening or pulling a devlog never runs code that arrived through git.
- A leaked or public devlog repository must not leak any credential.
- Extensions go through the same data layer as the app (`@devlog/core`), so
  they cannot break the file-format rules (append-only block files, marker
  escaping, image paths).
- **Extensions cannot see each other's data**, and see the devlog itself
  only where you let them.
- **Safe without containers**: no Docker, no VM. Safety comes from what the
  runtime and the API allow (see *Sandbox*).
- Features not everyone wants live in extensions, even first-party ones.

Non-goals: two-way sync with trackers (Devlog records what happened; it is
not a project-management tool), a public marketplace, a package manager,
network sandboxing (for now).

## Packages and the manifest

An extension is a folder (shipped as one `.zip`) with a manifest,
`devlog-extension.json`, and bundled code:

```jsonc
{
  "name": "devlog-jira",
  "displayName": "Jira worklogs",
  "version": "1.2.0",
  "api": "^1.3.0",                   // the extension API range it was built for
  "main": "main.js",                 // one bundled file, no dependencies
  "contributes": {
    "destinations": [{ "id": "worklogs", "label": "Jira" }],
    "canvasFields": [{ "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }],
    "settings": [{ "key": "baseurl", "label": "Jira address", "type": "url", "required": true }],
    "secrets": [{ "key": "token", "label": "API token", "required": true }],
    "commands": [{ "id": "check", "label": "Check the Jira connection" }],
    "check": "check"                 // a command that tests the settings
  },
  "permissions": {
    "read": false,                   // read blocks; you choose the scope
    "write": false,                  // add blocks; you choose the scope
    "network": ["*.atlassian.net"]   // declared and shown; not enforced
  },
  "appendOnly": ["**/*.jsonl"]       // its own repo files that git should union-merge
}
```

- **Not an npm package, bundled and dependency-free.** One `main.js`, no
  `node_modules`: installing is "download one zip, check its hash, unpack".
  Authors can use npm and a bundler (esbuild) to *build* one.
- **`contributes`** declares what the app shows without running the
  extension: `canvasFields`, `settings`, `secrets`, `commands`,
  `destinations`, `views`, `nodeTypes`, and a settings `check` command.
  Field keys are lowercase (`[a-z][a-z0-9_-]*`); fields take a `type`
  (text, url, email, number, select, checkbox, password), `required`,
  `description`, and for canvas fields `"inherited": false` (1.7).
- **`permissions`**: `read`, `write` (each granted with a scope you pick),
  `network` (shown, not enforced), `unrestricted` (runs outside the sandbox
  if you trust it), `send` (sends timesheets through other extensions'
  destinations, 1.7). All are shown before it first runs.

## Sources, ids and the lockfile

Named in `devlog.json`:

```json
{
  "format": 4,
  "extensions": {
    "sdeken/devlog-jira": "^1.2.0",
    "my-ext": "https://example.com/my-ext.devlog-ext.zip",
    "devlog-time": "builtin"
  }
}
```

- `owner/repo` with a version range: the app lists the repository's GitHub
  releases, picks the newest tag matching the range, and downloads the
  release's `*.devlog-ext.zip` asset. Private repositories work with a
  GitHub token kept on this computer (Extensions page).
- `"name": "https://…/x.zip"` pins one exact file.
- `builtin` names an extension that ships inside the app.
- **Ids** come from where an extension was fetched, not from its manifest:
  `sdeken/devlog-jira` → `sdeken.devlog-jira`, a URL entry → `url.<name>`,
  a built-in → `builtin.<name>`. The id names its folders, secrets and
  settings, so one extension cannot claim another's name to read its data.
- **`devlog.lock.json`** records the exact version, URL and SHA-256 of each
  GitHub or URL entry (built-ins and development folders are not locked),
  so every machine runs byte-identical code. It is committed with the next
  commit like any other change.
- **Check for updates** (Extensions page) re-checks the ranges, downloads
  what changed, rewrites the lockfile and says what was updated; changed
  code must be allowed again. A lockfile updated on another machine is
  used, and asks for consent, the next time the devlog is opened here.
- Downloads are unpacked into `userData/extensions/<sha256>/`, shared by
  every devlog that pins the same bytes; nothing is written into the devlog.
- **Development:** a machine-local override (`extension-dev.json` in user
  data, never in the devlog) maps a devlog.json key to a folder, for working
  on one without releasing it.

## Consent, grants and trust

The model: **you trust what you install**, like a VS Code extension, but
with limits enforced by the runtime, and trust is explicit:

- An extension runs only once allowed, per machine and per devlog (consent
  is keyed by the devlog folder). The dialog shows its name, version,
  source and permissions, and lets you set the **read** and **write**
  scopes: the whole devlog, or chosen canvases (each with everything inside
  it).
- Consent is per build: a new build of a downloaded extension asks again.
  A **built-in** keeps its grant (and trust) when the app brings a new
  build, since it is part of the app you updated.
- Changing a grant restarts the extension with the new one; revoking stops
  it until you allow it again. **Remove** takes it out of `devlog.json` and
  forgets this machine's consent.
- Grants are kept on this machine with the consent, not in the repository,
  so nothing that arrives through git can widen them.
- **Unrestricted (trusted).** An extension that needs what the sandbox
  forbids (start a platform helper, read files) says
  `"permissions": { "unrestricted": true }`. It runs only if you tick "I
  trust it" when allowing it, and then without the permission model: full
  file-system and process access, the app's environment, and
  `ctx.packageDir` (its own unpacked folder). Window tracking is one.

## Settings, secrets and canvas fields

- **Per devlog** (the Jira address): in `devlog.json` under
  `"settings": { "<id>": { … } }`, edited on the extension's page in
  Settings, checked by type when saved. `required` settings and secrets
  mark the extension as needing setup until set.
- **Per canvas** (this client's Jira issue): in the canvas's `canvas.md` as
  namespaced front-matter keys, `ext.<id>.<key>: value`. They follow the
  canvas through renames and moves, show as fields in canvas properties
  (a page per extension), and canvases inside use the value unless they set
  their own (a field with `"inherited": false` applies to its canvas only).
- **Secrets** (tokens, passwords): never in the repository. Kept in user
  data per extension, encrypted with the OS keychain (Electron
  `safeStorage`), through `ctx.secrets`.

## Reading and writing the devlog

Everything the API returns is filtered by the grant: `canvases()` lists the
granted canvases (and the ancestors needed to name them), `blocks()`,
`search()`, `todos()`, `range()` and `activity()` return nothing outside
them, and writes outside them fail. With no read grant an extension still
gets its own settings, the canvas fields it declared, and its own files. A
canvas the extension keeps (`managedCanvas`) is its own whatever it was
granted.

Blocks an extension writes carry an `ext=<id>` attribute and are automatic
blocks (read-only in the app, muted brace). They are ordinary markdown in
the day files, so they survive the extension going away.

## Its own files

Besides the devlog, each extension has two private folders:

| Store | Where | Synced | For |
|---|---|---|---|
| `ctx.files.repo` | `extensions/<id>/` in the devlog | yes, committed with everything else | data every machine should see: logs, the record of what was sent |
| `ctx.files.local` | `userData/extension-data/<id>/<devlog>/` | no | machine-only state: cursors, caches, preferences |

The core ignores `extensions/` when listing, indexing and searching. The
manifest's `appendOnly` globs get a `merge=union` line in `.gitattributes`,
so two machines appending never conflict. Extension writes don't count as
unsaved work and ride along with the next interval commit. Uninstalling
leaves both folders alone; there is no command to delete an extension's
data.

## Sandbox

An extension:

- **cannot touch files.** It runs in its own process, a Node child of the
  app binary (`ELECTRON_RUN_AS_NODE`) started with Node's permission model
  (`--permission`) and read access to exactly one file, the host script.
  Its code is sent over the message channel and evaluated, so it needs no
  read access to load. Its own folders are reached only through
  `ctx.files`, a broker in the app that takes relative paths, refuses
  absolute paths, `..` and symlinks out of the folder, writes atomically
  and caps sizes.
- **cannot start programs, load native code or spawn workers** (the same
  permission model denies them). Node built-ins can be required, but the
  calls fail with `ERR_ACCESS_DENIED`.
- **sees the devlog only through its grant**, and only its own folders,
  settings and secrets.
- **cannot reach other extensions, the app's windows or Electron.** Each
  has its own message channel to the app and nothing else. The one
  exception is sending a timesheet through another extension's destination,
  with `permissions.send`, through the app.
- **cannot take the app down**: a crash kills only its process (heap capped
  at 256 MB, environment stripped to a few locale variables); one that does
  not start within 30 seconds is stopped, and calls that take too long fail.
- **shows UI only in sandboxed frames**: its pages (views) run in frames
  sandboxed to scripts, with no network and no access to the window around
  them, and reach the extension only through the app (see *Views*).

**The network is not restricted.** An extension can make any request; the
domains it declares are shown at consent but not enforced. So an extension
can send out whatever it can read, which is one reason read access is
scoped.

Electron's `utilityProcess` silently ignores `--permission`, hence the Node
child; the builds must keep Electron's `RunAsNode` fuse on. Tests run a
probe extension in that process and check that file access, child processes
and workers are refused.

## What an extension can do

### Read and write (1.0, 1.4, 1.6, 1.7)

`devlog.canvases()`, `field()`, `days()`, `blocks()`, `search()`,
`addBlock(canvasId, markdown, { meta, parentId, date, todo, kind })`,
`todos({ doneSince })` (1.4). Todos are blocks (`kind: 'todo'`, `meta.done`
once ticked); `parentId` with the block's day-file `date` adds a block
inside another.

1.6: `createCanvas({ title, parentId, type })` (inside a canvas it may write
to; top level only with write access everywhere),
`updateCanvas(id, { title, parentId, type, archived })` (types: its own, and
it may clear only its own), `editBlock(…)` (blocks it added), and
`promote(canvasId, date, blockId, { type })`: the block becomes the link to
a new canvas of that type just inside its canvas, and what was written
inside the block moves there.

1.7: `activity(from, to)`: what the app recorded (its log of locks, idle,
sleep, git events and corrections, merged with what extensions provide:
time, focus); task time on canvases it may not read shows as none, window
titles only with read access to the whole devlog. `range(from, to)`: the
day files with blocks written in a range. `managedCanvas(key, { title })`:
a canvas it keeps (`devlog.managed: <id>/<key>`), where `addBlock` takes a
`kind` of its own (not todo, task, commit or done) and any `date`, and
`editBlock` works on every block. A kept canvas is the extension's storage:
the app leaves it out of the sidebar, the quick switcher, pickers, search,
the review and the timeline, and the extension shows it through its own
pages.

### Node types (1.6)

`contributes.nodeTypes` (`id`, `label`, `icon`, `placeholder`) declares
kinds of canvas. A canvas carries one as `type: <extension id>/<id>` in
canvas.md (the time extension's task keeps the older `task: true`); the app
shows its icon and label, offers it under **Type** in canvas properties and
as **New *label* inside…** on a canvas's menu, and adds the placeholder to
the note box. A type whose extension is gone reads as a plain canvas.

### Commands (1.0, 1.6)

`commands.register(id, (context) => …)`; commands appear in the quick
switcher, and a string one returns is shown (a `check` command's result).
The context (1.6) is `{ source, canvasId?, date?, blockId? }`: where it ran
from (switcher, keybinding, menu, note box, view, tray) and the canvas and
block it ran on, without canvases outside the grant. In
`contributes.commands`:

- `keybinding` (`Mod+Shift+S`; Mod is Ctrl, or Cmd on a Mac; a plain key or
  Shift+key is refused, F-keys excepted);
- `nodeType`: offered only on canvases of that type;
- `menus`: `canvas` (right-click menu), `block` (the actions on a block),
  `tray`;
- `post: true`: a way to post from the note box: its keybinding (or
  `#<tag>` on the first line, with `tag`, taken off before posting) posts
  the note, then runs the command on the new block.

### Events and the app around the window (1.0, 1.6, 1.7)

`devlog.onBlockAdded(cb)` hears blocks posted in the app, on canvases it may
read. `activity.on(cb)` hears pause (locked, idle, asleep) and resume;
`activity.idleAfter(minutes)` asks for idle detection (the app uses the
shortest any extension asks for). `ui.notify`, `ui.confirm`; `ui.pick(items)`
shows a quick pick; `ui.open({ canvasId, date?, blockId? })`;
`ui.openPage(viewId)` (1.7); `ui.highlight(canvasId)` marks its current
canvas (the running task) in the sidebar, and commits from a linked
repository land on it when it is inside the linked canvas;
`app.setTrayLabel(text)`, `app.keepRunning(true)` (close to the tray
instead of quitting).

### Views (1.5, 1.6)

Pages of its own, declared in `contributes.views` (`id`, `title`, `entry`:
an .html file in the package, `placement`, `icon`, `nodeType`):

- `page`: listed in the sidebar and quick switcher with the app's views;
  fills the main area.
- `statusbar`: a slot in the status bar, 22 px high; it asks for a width
  (`resize`) and gets it within 24–360 px.
- `popover`: opened by another of its views, anchored to it; closes on
  Escape, a click outside, or `close`.
- `canvasHeader` (1.6): beside a canvas's title (26 px high), optionally
  only for a `nodeType`.

Pages load from `devlog-ext://<the devlog.json key, as hex>/<file>`, only
from the extension's own folder and only while it runs, in a frame
sandboxed to scripts (no same origin) under a CSP with no network, frames
or forms. A view talks to its extension only through the app, by
`postMessage` (`ready`, `call`, `resize`, `popover`, `close`, `open`,
`command`, and `key` for a shortcut it did not use, so Ctrl+K and the like
still reach the app); the app answers (`reply`), relays what the extension
`views.post`s (`message`), and sends the app's colours (`theme`) and where
the view is (`context`: a header view's canvas, the canvas and block page
on screen for a status bar item, the opener's for a popover). The extension
answers with `ctx.views.handle(viewId, (method, args) => …)`. Message types:
`@devlog/extension-api/view`. `@devlog/ui` wraps them with React
components, hooks (`useCall`, `useMessages`, `useViewContext`…) and the
app's look.

### Destinations (1.3, 1.7)

An extension declares `contributes.destinations` and registers each with
`destinations.register(id, { preview(sheet), send(sheet) })`. The app builds
the sheet it gets: every entry of a week's timesheet with its task and
client names and this extension's own canvas fields, inherited down the
tree. Pressing Send is the consent for that week's entries, so a
destination needs no read grant. The extension keeps its own ledger of what
it sent.

With `permissions.send` (1.7), an extension can use other extensions'
destinations: `destinations.list()`, `preview(to, sheet)` and
`send(to, sheet)` (only final weeks), through the app. devlog-time's
Timesheet page does this and writes what was sent under the week.

### Providing data (1.1, 1.6, 1.8)

`provide.focus((from, to) => FocusEvent[])`: window focus for the timeline
and review. `provide.activity((from, to) => TimeEvent[])` (1.6): `start`,
`task`, `stop` and `heartbeat` events (per machine), which the app replays
with its own record of locks, idle and sleep; while some extension provides
time, the app logs those (and git events) in `activity/`. Since 1.8 it may
also provide corrections: `assign` events (`start`, `end`, `canvasId` or
null for not worked, `id`, and `at`, when it was made; `t` is the window's
start), or an undo of one (`cancels`). The app applies them after
replaying, in the order they were made, in every view (see
`TIMESHEETS.md`, *Corrections*).

## Built-in extensions

- **devlog-time** (Time tracking): the task node type, the clock, the
  status bar item, task header button and picker, post as task, Make task,
  the Timesheet and Summary pages, hour targets, sending through Jira and
  CMS. See `TIME-EXTENSION.md` and `TIMESHEETS.md`. Written in TypeScript
  (`src/`, bundled at build time) with views on `@devlog/ui`.
- **devlog-focus** (Window tracking): runs unrestricted to start a platform
  helper (PowerShell `GetForegroundWindow` on Windows, an `osascript` loop
  on macOS, `xdotool` on Linux) and records the window in front, per
  machine and day, in `extensions/builtin.devlog-focus/<machine>/…`
  (`{"t", "app", "title"}` per line), nothing while paused; it gives the
  events back through `provide.focus`. Focus events older than 0.8 stay in
  the app's activity log and still show.
- **devlog-jira** (Jira worklogs, sandboxed): one worklog per entry on the
  entry's Jira issue (canvas field `issue`), REST v2, Basic auth (email and
  API token, Cloud) or a Bearer personal access token (Data Center), ledger
  in `sent/<week>.json`.
- **devlog-cms** (CMS timesheets, sandboxed): drives the CMS web pages (it
  has no API): form login (`j_security_check`, cookies kept in memory for
  the send), the week page parsed for assignment rows and each day's
  `timesheet_id` link, and the day's form submitted with `hrs_worked` in
  decimal hours. Hours per assignment (canvas field `assignment`) per day;
  the preview compares with what CMS shows, so only differing days are
  sent. Its ledger (`sent/<week>.json`, assignment|day → hours) lets days it
  filled that no longer have time go back to 0. The password is a secret.

## API reference

- `packages/extension-api/src/index.ts`: `DevlogContext` and every type an
  extension sees, with the version each member arrived in.
- `protocol.ts`: the wire protocol between the app and the extension
  process; `view.ts`: view messages; `testing.ts`: an in-memory `ctx` for
  unit tests.
- `tests/fixtures/extensions/probe` and `shaper`: test extensions that
  exercise the API through the real host process.

## Not built yet

- **Cards**: Adaptive Card blocks rendered by the app from an extension's
  templates, with the card's data in the block, and actions going back to
  the extension; Outlook as a card-based extension.
- **Link previews**: an extension turning a pasted link on its domains
  into a card.
- A CSV destination.
- Enforcing the declared network domains.
- A command to delete an extension's data.
