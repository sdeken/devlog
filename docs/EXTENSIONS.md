# Extensions: design (draft)

Status: **milestone 1 built** (0.7.0): manifests and sources, the lockfile,
installing from GitHub releases / URLs / built-ins, consent with read and
write scopes, the sandboxed extension process, the file broker, secrets,
settings, canvas fields, commands and notifications. Cards, destinations and
devlog-focus are later milestones. Tracks issue #1 (with #2 time export, #3
custom block types and #16 window tracking). How to write one:
`packages/extension-api/README.md`.

## Goals

- Let a devlog opt into integrations (pushing tracked time to Jira and CMS,
  Outlook-backed blocks, link previews) without growing the core app.
- **The devlog stays Just A Notebook.** It *names* the extensions it wants
  and holds their non-secret settings; it never contains their code, their
  secrets, or anything they need at runtime besides that.
- Opening or pulling a devlog must never run code that arrived through git.
- A leaked or public devlog repository must not leak any credential.
- Extensions go through the same data layer as the app (`@devlog/core`), so
  they cannot break the file-format rules (append-only block files, marker
  escaping, image paths).
- **Extensions cannot see each other's data**, and see the devlog itself
  only where you let them.
- **Safe without containers**: no Docker, no VM. Safety comes from what the
  runtime and the API allow (see *Safety in v1*).
- Features that not everyone wants live in extensions, even first-party
  ones. Window tracking is the first to move (see *Window tracking as an
  extension*).

Non-goals: two-way sync with trackers (Devlog records what happened; it is
not a project-management tool), a public extension marketplace, a package
manager, network sandboxing in v1.

## What an extension is

A folder (shipped as one `.zip`) with a manifest, `devlog-extension.json`,
and bundled code:

```jsonc
{
  "name": "devlog-jira",
  "displayName": "Jira time export",
  "version": "1.2.0",
  "api": "^1.0.0",                   // extension API version it was built for
  "main": "main.js",                 // one bundled file, no dependencies
  "cards": { "worklog": "cards/worklog.json" }, // Adaptive Card templates (see Cards)
  "contributes": {
    "destinations": [{ "id": "jira", "label": "Jira worklogs" }],
    "canvasFields": [{ "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }],
    "settings": [{ "key": "baseUrl", "label": "Jira URL" }],
    "secrets": [{ "key": "token", "label": "API token" }],
    "unfurl": ["*.atlassian.net"]    // links it can turn into cards
  },
  "permissions": {
    "read": true,                    // wants to read blocks; you choose the scope
    "write": false,                  // add blocks; you choose the scope
    "network": ["*.atlassian.net"]   // declared and shown; not enforced in v1
  },
  "appendOnly": ["**/*.jsonl"]       // its own repo files that git should union-merge
}
```

- **Not an npm package.** Extensions are not JavaScript libraries and no
  JavaScript project would ever depend on one, so they are not published to
  npm. Authors can still use npm and a bundler (esbuild) to *build* one;
  what ships is the bundle.
- **Bundled, dependency-free.** One `main.js`, no `node_modules`. Installing
  is "download one zip, check its hash, unpack", with no dependency tree to
  resolve, audit or trust, and nothing that resembles a package manager.
- **`contributes`** declares everything the app shows (destinations, canvas
  fields, settings, secret prompts, link handlers) so the UI can be built
  without running the extension.
- **`permissions`** are shown before first activation. Read and write are
  granted with a scope you pick (see *Reading and writing the devlog*).
- Authors write against the extension API's types and a small test
  harness, kept in this repository (`packages/extension-api`) and consumed
  from git. The runtime object is injected by the app at activation.

## Where extensions come from

Releases on GitHub (or any HTTPS URL), not a registry:

```json
{
  "format": 3,
  "extensions": {
    "sdeken/devlog-jira": "^1.2.0",
    "sdeken/devlog-cms": "0.3.1",
    "devlog-focus": "builtin"
  }
}
```

- `owner/repo` with a version range: the app lists the repository's
  releases (GitHub's API), picks the newest tag matching the range, and
  downloads the release's `*.devlog-ext.zip` asset. Private repositories
  work with a GitHub token from the secret store.
- A plain `https://…/x.zip` pins one exact file.
- `builtin` names a first-party extension that ships inside the app (no
  download), like devlog-focus.
- A lockfile, `devlog.lock.json`, written by the app, records the exact
  version, URL and SHA-256 each entry resolved to. Every machine runs
  byte-identical code, and an update is a visible, committed change
  ("devlog: update extensions"), never a silent drift.
- **Update extensions** (a command) re-checks the ranges, shows what
  changed, rewrites the lockfile and commits it. Pulling a lockfile that
  another machine updated leads to a download and a consent prompt, since
  the code is new.
- Unpacked into `userData/extensions/<sha256>/`, shared by every devlog that
  pins the same bytes; nothing is written into the devlog.
- **Development:** a machine-local override (in user data, never in the
  devlog) maps an extension to a folder, for working on one without
  releasing it.

An extension's **id** comes from where it was fetched, not from its
manifest (`sdeken/devlog-jira` → `sdeken.devlog-jira`; built-ins are
`builtin.<name>`). The id names its folders, secrets and settings, so one
extension cannot claim another's name to read its data.

## Settings

- **Per devlog** (Jira base URL, CMS project list): in `devlog.json` under
  `"settings": { "sdeken.devlog-jira": { … } }`, edited through the app.
- **Per canvas** (this client's Jira issue, CMS client): in the canvas's own
  `canvas.md`, as namespaced front-matter keys, e.g.
  `ext.sdeken.devlog-jira.issue: ACME-123`. They follow the canvas through
  renames and moves, and the canvas dialog shows them as ordinary fields
  (from `contributes.canvasFields`). Task canvases inherit from the nearest
  ancestor that sets one, as time already rolls up in the review.
  *Prerequisite:* the `canvas.md` parser currently drops unknown keys; it
  must keep them.
- **Secrets** (tokens, the CMS password): never in the repository. Kept in
  user data per extension, encrypted with the OS keychain (Electron
  `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret on Linux),
  through `ctx.secrets`.

## Reading and writing the devlog

Reading is a permission, like writing. When an extension asks for `read` or
`write`, you grant it one of:

- **the whole devlog**, or
- **specific canvases** (each with everything beneath it), picked in the
  consent dialog and changeable later from the extension's settings.

Everything the API returns is filtered by the grant: `canvases()` lists only
granted canvases (and the ancestors needed to name them), `blocks()` and
search return nothing outside them, `timesheet()` only entries on them, and
writes outside them fail. With no read grant an extension still gets what
it needs to work: its own settings, the canvas fields it declared on the
canvases it was granted, and its own files.

Grants are kept on this machine with the consent (see *Trust*), not in the
repository, so nothing that arrives through git can widen them.

Blocks an extension writes carry an `ext=<id>` attribute and are automatic
blocks (read-only, muted brace), like captured commits. They are ordinary
markdown in the day files, so they survive the extension going away.

## Its own files

Besides the devlog, each extension has two private folders it manages
however it likes (JSON, JSON lines, SQLite, markdown):

| Store | Where | Synced | For |
|---|---|---|---|
| `ctx.files.repo` | `extensions/<id>/` in the devlog | yes, committed with everything else | data every machine should see: logs, the record of what was sent |
| `ctx.files.local` | `userData/extension-data/<id>/<devlog>/` | no | machine-only state: cursors, caches, anything bulky or noisy |

The core ignores `extensions/` when listing, indexing and searching. For
git, the manifest's `appendOnly` globs get a `merge=union` line in
`.gitattributes` (as activity logs do), so two machines appending never
conflict. Like activity logs, extension writes don't count as unsaved work
and ride along with the next interval commit.

Uninstalling leaves both folders alone (the devlog keeps the data, and git
has it anyway). Removing the data is a separate, explicit action.

## Safety in v1

The v1 line is: **no direct access to the file system**, and nothing else
that would get around it. An extension:

- **cannot touch files.** Its main half runs in its own process, started
  with Node's permission model (`--permission`) and *no* file allowances:
  every `fs` call, from any code in the bundle, fails in the runtime. The
  code itself is sent over the message channel and evaluated, so the
  process needs no read access even to load it. Its own folders are reached
  only through `ctx.files`, a broker in the app that takes relative paths,
  refuses absolute paths, `..` and symlinks out of the folder, writes
  atomically and caps sizes.
- **cannot start programs, load native code or spawn workers** (the same
  permission model denies child processes, addons, workers and WASI). The
  things that need them stay in the app and are offered as narrow
  capabilities instead, or the extension asks to run unrestricted (below).
- **sees the devlog only through its grant**, and only its own folders,
  settings and secrets.
- **cannot reach other extensions, the app's windows or Electron.** Each
  extension has its own message channel to the app and nothing else; there
  is no API to list or talk to other extensions.
- **cannot take the app down**: a crash or hang kills only its process
  (memory is capped, and an unresponsive one is stopped and reported).
- **UI without code**: what extensions show inside the notebook is Adaptive
  Cards (below), rendered by the app. No extension code runs in the
  notebook's window.

**Unrestricted extensions (trusted).** An extension that needs to do what
the sandbox forbids (start a platform helper, read files) says so with
`"permissions": { "unrestricted": true }`. It then runs only if you say, in
the consent dialog, that you trust it and its author, and it runs without
the permission model: full file-system and process access, the app's
environment, and `ctx.packageDir` (its own unpacked folder, for scripts it
ships). Everything else (consent per build, a new build asks again, its
private folders, grants for the devlog API) stays the same. This is the
middle ground: the sandbox is the default, and leaving it is an explicit,
per-extension decision you make, not something the app grants itself.

**Not in v1: the network.** An extension can make any request; the domains
it declares are shown at consent but not enforced (enforcing needs all
traffic to go through the app). The consequence to keep in mind: an
extension can send out whatever it can read, which is one reason read
access is scoped.

**How it is run.** Electron's `utilityProcess` silently ignores
`--permission` (checked: file reads, child processes and workers all
succeed in it), so each extension runs as a Node child of the app binary
(`ELECTRON_RUN_AS_NODE`) with `--permission`, read access to exactly one
file (the host script, copied out of `app.asar` into user data), a heap cap,
and an environment stripped to a few locale and Windows variables. The
builds must keep Electron's `RunAsNode` fuse on. Tests run a probe
extension in that process and check that file access, child processes and
workers are refused with `ERR_ACCESS_DENIED`.

## Cards: rich blocks and link previews

Slack and Teams don't share a card format: Teams (and Outlook, Webex,
Windows widgets) use **Adaptive Cards**, an open JSON format from
Microsoft; Slack uses its own Block Kit. What both do share is unfurling
links from a page's Open Graph / oEmbed metadata. Since Outlook is a likely
extension, Devlog uses Adaptive Cards:

- **Templates in the extension, data in the block.** An extension ships card
  templates (`cards` in the manifest). A block it writes has a namespaced
  kind (`x-sdeken.devlog-outlook.meeting`), a readable markdown body, and the
  card's data as a trailing fenced block (```` ```card ````). The app renders
  the template with that data (Adaptive Cards templating) in the notebook's
  theme; without the extension, the block shows its markdown and the data
  fence stays folded away. Search and the index read the markdown.
- **Actions** go back to the extension: `Action.Execute` calls its main
  half, which can answer with new card data (written as an `edit` record);
  `Action.OpenUrl` opens the browser after the app checks the link.
- **Link previews**: an extension that declares `unfurl` domains is asked to
  turn a pasted link on them into card data (a Jira issue key, title and
  status), stored with the block like any other card. Generic Open Graph
  previews for any link could be a small first-party extension of their own.
- A sandboxed-iframe renderer for things cards cannot express is possible
  later, but not planned: cards keep extension code out of the window.

## Window tracking as an extension

Recording the foreground window is useful to some people and noise to
others, and it is the most privacy-sensitive thing Devlog records. It is a
first-party extension, **devlog-focus** ("Window tracking"), built into the
app (nothing to download) and off until a devlog adds it (#16).

- **Nothing about windows is in the core.** devlog-focus runs unrestricted
  (you are asked whether you trust it) and starts its own platform helper:
  PowerShell with `GetForegroundWindow` on Windows, an `osascript` loop on
  macOS, `xdotool` on Linux. 0.8 had the app run the helper and pass a
  window feed to the extension; 0.9 moved it into the extension and removed
  the feed from the API (1.2).
- **What stays core:** the task clock. Task switches, start/stop,
  lock/unlock, idle/active, sleep/wake and heartbeats stay in the core
  activity log, because tracked time, the review and timesheets depend on
  them. Extensions hear about locks and sleep through `ctx.activity`,
  straight from the OS whether or not time is tracked; devlog-focus records
  nothing while paused.
- **Its data** is in its own synced folder, one JSON-lines file per machine
  and day: `extensions/builtin.devlog-focus/<machine>/YYYY/MM/<date>.jsonl`,
  `{"t", "app", "title"}` per line, append-only and union-merged.
- **What it gives back:** `ctx.provide.focus(from, to)` returns its events,
  which the app merges into the activity it hands the timeline, review and
  summary. Those views draw focus exactly as before.
- **Existing data:** `focus` events already in the core activity logs stay
  there and still show. New ones come from the extension.

## Trust

The honest model: **you trust what you install**, like a VS Code extension,
but with the limits above enforced by the runtime rather than by
convention. The app makes that trust explicit and hard to grant by accident:

- The first activation of a given extension *hash* in a given devlog asks,
  showing name, version, source and requested permissions, and lets you set
  the read and write scopes. Approvals and scopes are stored on this
  machine, so a devlog pulled onto a new machine, or a lockfile changed by
  another machine, asks again.
- You can revoke or narrow a grant at any time; the extension is restarted
  without it.

## Runtime and API

One process per extension (the main half), talking to the app over a
message channel that carries the API below. What is built (milestone 1) is
defined in `packages/extension-api/src/index.ts`; the sketch also shows what
later milestones add (`timesheet`, `destinations`, `cards`, `unfurl`).

```ts
export function activate(ctx: DevlogContext): void | Promise<void>

interface DevlogContext {
  devlog: {                                             // everything filtered by the grant
    canvases(): Promise<CanvasMeta[]>                   // with this extension's canvas fields
    blocks(canvasId: string, date: string): Promise<Entry[]>   // needs read
    search(query: string): Promise<SearchResult>               // needs read
    timesheet(weekStart: string): Promise<Timesheet>    // the approved timesheet (see TIMESHEETS.md)
    addBlock(canvasId: string, markdown: string, opts: { kind?: string; card?: unknown; meta?: Record<string, string> }): Promise<Entry> // needs write
  }
  settings: { get<T>(key: string): T | undefined }      // devlog-level, from devlog.json
  secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  files: { repo: ExtensionFiles; local: ExtensionFiles }   // this extension's own folders
  activity: { on(event: 'pause' | 'resume' | 'task', cb: (ev: ActivityEvent) => void): void } // read-only
  ui: { notify(message: string): void; confirm(message: string): Promise<boolean> }
  destinations: { register(id: string, destination: Destination): void }
  commands: { register(id: string, label: string, run: () => Promise<void>): void }
  cards: { onAction(verb: string, run: (data: unknown) => Promise<unknown>): void }
  unfurl: { register(run: (url: string) => Promise<{ kind: string; markdown: string; card: unknown } | null>): void }
}

interface ExtensionFiles {
  read(path: string): Promise<Uint8Array | undefined>
  readText(path: string): Promise<string | undefined>
  write(path: string, data: string | Uint8Array): Promise<void> // atomic
  append(path: string, text: string): Promise<void>
  list(dir?: string): Promise<Array<{ path: string; size: number; mtime: string }>>
  remove(path: string): Promise<void>
}

interface Destination {
  /** Group a final timesheet's entries into this system's lines (mapping and grouping only). */
  lines(sheet: Timesheet, sent: SentRecord[]): Promise<DestinationPreview>
  /** Send the lines; return an external id per line for the record. */
  submit(lines: DestinationLine[]): Promise<SubmitResult[]>
}
```

## Destinations (built, API 1.3)

An extension declares `contributes.destinations` and registers each with
`ctx.destinations.register(id, { preview(sheet), send(sheet) })`. When you
press **Send to …** on a final week, the app builds the sheet: every entry
with its task and client names and this extension's own canvas fields,
inherited down the tree. Pressing Send is the consent for that week's
entries, so a destination needs no read grant. The app shows the preview
(new, changed, removed, already sent, not for this destination and why),
calls `send`, and records the summary as a reply under the week's
timesheet. The extension keeps its own ledger of what it sent.

**devlog-jira** (built in, sandboxed) is the first: one worklog per entry
on the entry's Jira issue (canvas field `issue`), REST v2, Basic auth with an
account email and API token (Cloud) or a personal access token (Data
Center), ledger in `sent/<week>.json`.

**devlog-cms** (built in, sandboxed) drives the CMS web pages: form login
(`j_security_check`, cookies kept in memory for the send), the week page
parsed for assignment rows and each day's `timesheet_id` link, and the
day's form submitted with `hrs_worked` in decimal hours. Hours per
assignment (canvas field `assignment`) per day; the preview compares with
what CMS shows, so only differing days are sent. Ledger in
`sent/<week>.json` (assignment|day → hours) so days it filled and that no
longer have time are set back to 0. The password is a secret, kept on the
computer.

## Time export (#2)

See `TIMESHEETS.md`. Time goes through a weekly **timesheet** (core): a
synopsis you review and shuffle, rounded once to quarter hours, stored in a
managed *Timesheets* canvas together with a record of every submission.
Extensions contribute **destinations** (Jira by task with start times,
built; CMS by assignment per day, built): mapping fields, grouping and
sending. No business
rules: you finalise the hours. **Sending is always something you do**, by
button, after a preview; there are no scheduled or automatic exports.

## Milestones

1. Core plumbing: `devlog.json` extensions + lockfile, GitHub-release
   fetching, keeping unknown `canvas.md` keys, `safeStorage` secret store,
   the file broker and per-extension folders, read/write grants and the
   consent prompt, the extension process (with the `--permission` check),
   built-in extensions, the API types and test harness.
2. **devlog-focus** (done, 0.8.0): window tracking moved out of the core,
   which proves the loop end to end on a real feature.
3. Timesheets in core and the app: draft, grid, managed canvas, send
   record (`TIMESHEETS.md`); CSV destination.
4. Jira and CMS destinations.
5. Cards: Adaptive Card blocks, actions and link unfurling; then Outlook as
   the first real card-based extension.

## Decided

- **Write grants** are scoped like read grants (the whole devlog or chosen
  canvases), chosen separately in the consent dialog.
- **Card data** lives in the block (a trailing ```` ```card ```` fence), so a
  day file is complete and readable in git on its own.
