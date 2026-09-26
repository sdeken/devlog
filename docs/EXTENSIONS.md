# Extensions: design (draft)

Status: **draft for discussion**, nothing built yet. Tracks issue #1 (with #2
time export and #3 custom block types). Open questions are collected at the
end.

## Goals

- Let a devlog opt into integrations (pushing tracked time to Jira and CMS,
  Outlook-backed blocks, custom renderers) without growing the core app.
- **The devlog stays Just A Notebook.** It *names* the extensions it wants
  and holds their non-secret settings; it never contains their code, their
  secrets, or anything they need at runtime besides that.
- Opening or pulling a devlog must never run code that arrived through git.
- A leaked or public devlog repository must not leak any credential.
- Extensions go through the same data layer as the app (`@devlog/core`), so
  they cannot break the file-format rules (append-only block files, marker
  escaping, image paths).
- **Extensions cannot see each other's data.** Each one has its own files,
  in whatever format it likes, that no other extension can read or write.
- Features that not everyone wants live in extensions, even first-party
  ones. Window tracking is the first to move (see *Window tracking as an
  extension*).

Non-goals: two-way sync with trackers (Devlog records what happened; it is
not a project-management tool), a public extension marketplace, running
untrusted third-party code safely (see *Trust*).

## What an extension is

An npm package whose `package.json` has a `devlog` field:

```jsonc
{
  "name": "@sdeken/devlog-jira",
  "version": "1.2.0",
  "main": "dist/main.js",            // one bundled file, no runtime dependencies
  "engines": { "devlog": "^1.0.0" }, // extension API version it was built for
  "devlog": {
    "displayName": "Jira time export",
    "renderer": "dist/renderer.js",  // optional: block renderers (sandboxed)
    "contributes": {
      "destinations": [{ "id": "jira", "label": "Jira worklogs" }],
      "canvasFields": [{ "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }],
      "settings": [{ "key": "baseUrl", "label": "Jira URL" }],
      "secrets": [{ "key": "token", "label": "API token" }]
    },
    "permissions": { "network": ["*.atlassian.net"], "writeBlocks": false },
    "appendOnly": ["**/*.jsonl"]           // in its own repo folder: union-merged in git
  }
}
```

- **Bundled, dependency-free.** Authors bundle with esbuild or similar; the
  app refuses a package with runtime `dependencies`. Installing is then
  "fetch one tarball, check its hash, unpack", with no dependency tree to
  resolve, audit or trust.
- **`contributes`** declares everything the app shows (destinations in the
  review, fields in the canvas dialog, settings, secret prompts) so the UI can
  be built without running the extension.
- **`permissions`** are shown to the user before first activation and
  enforced where the API allows (see *Runtime*).
- Authors write against `@devlog/extension-api`: types plus a small test
  harness, published from this repo (`packages/extension-api`). The runtime
  object is injected by the app at activation.

## Data: two channels

An extension touches data in exactly two ways.

1. **Contributing to the devlog** through the API (below): blocks, canvas
   fields, timesheet destinations. These go through `@devlog/core` like
   the app's own writes, need the matching permission (`writeBlocks`), and
   are marked with the extension that made them (an `ext=<id>` attribute on
   the record, and the automatic-block brace), so they can be told apart and
   survive the extension going away as plain markdown.
2. **Its own files**, managed however it likes (JSON, JSON lines, SQLite,
   markdown), in two private folders:

   | Store | Where | Synced | For |
   |---|---|---|---|
   | `ctx.files.repo` | `extensions/<id>/` in the devlog | yes, committed with everything else | data every machine should see: logs, caches of sent timesheets, mappings |
   | `ctx.files.local` | `userData/extension-data/<id>/<devlog>/` | no | machine-only state: cursors, caches, anything bulky or noisy |

   `<id>` is the package name made path-safe (`@sdeken/devlog-jira` →
   `sdeken.devlog-jira`). Secrets are neither: they go through
   `ctx.secrets` (OS keychain).

The core ignores `extensions/` when listing, indexing and searching; the
extension's files are its own business. For git, the manifest can declare
which of its files are append-only (`"appendOnly": ["**/*.jsonl"]`); the app
writes a `merge=union` line for them into `.gitattributes`, as it does for
activity logs, so two machines appending never conflict. Like activity logs,
extension writes don't count as unsaved work and ride along with the next
interval commit instead of triggering one.

Uninstalling an extension leaves its folders alone (the devlog keeps the
data; git has it anyway). Removing the data is a separate, explicit action.

## Isolation between extensions

Isolation is **between extensions**, and between an extension and the rest of
the devlog. It is not secrecy from you: everything in the repository is
plain files you can read.

- **No paths.** An extension never learns where the devlog, its own
  folders or anyone else's are on disk. `ctx.files.repo` and
  `ctx.files.local` are handles to a broker in the app: `read`, `write`
  (atomic), `append`, `list`, `remove`, `stat` on relative paths. The
  broker normalises every path, refuses absolute paths, `..`, and anything
  resolving outside the extension's folder (symlinks included: it checks
  with `lstat` and opens with no-follow), and caps file and folder sizes.
- **No file system.** The main half runs in its own `utilityProcess` started
  with Node's permission model (`--permission`), allowed to read only its
  own unpacked code and to write nothing, with no child processes, workers
  or native addons unless its manifest asks for them and you agreed. So
  even code that ignores the broker and calls `fs` directly is stopped by
  the runtime, not by convention.
- **No shared channel.** Each extension gets its own message port to the
  app. There is no API to reach another extension, list them, or read
  their settings, files or secrets; `ctx.secrets` is keyed by extension.
- **Renderer halves** run in sandboxed iframes with an opaque origin (no
  cookies, storage or network unless granted), one per extension, and can
  talk only to their own main half, through the app.

To verify in milestone 1: that Electron's `utilityProcess` honours
`--permission` through `execArgv`. If it does not, the fallback is running
extension code in a Node `vm` context whose `require` only resolves the
extension's own bundle and the injected API, which is weaker against a
determined author but still keeps honest extensions apart. Since the
extensions you install are ones you trust (see *Trust*), isolation is
mostly about bugs and least privilege, not about hostile code.

## Window tracking as an extension

Recording the foreground window is useful to some people and noise to
others, and it is the most privacy-sensitive thing Devlog does. It moves out
of the core into a first-party extension, **devlog-focus**, bundled with the
app (nothing to download) but off until a devlog enables it.

- **What stays core:** the task clock. Task switches, start/stop,
  lock/unlock, idle/active, sleep/wake and heartbeats stay in the core
  activity log, because tracked time, the review and timesheets depend on
  them.
- **What moves:** the foreground watcher (PowerShell / `osascript` /
  `xdotool` helpers), `focus` events, screen-time in the review and the
  Summary, the focus lane on the Timeline, and the `trackFocus` /
  `focusMinSeconds` settings.
- **Its data** goes to `ctx.files.repo`: per-machine JSON-lines files
  (`<machine>/YYYY/MM/<date>.jsonl`, append-only, union merge), in the same
  shape as today's `focus` events. Machine-local state (the helper's last
  window) goes to `ctx.files.local`.
- **What it needs:** permission to start a helper process
  (`"permissions": { "childProcess": true }`, shown at consent), and a
  read-only feed of the core's pause events (`ctx.activity.on('pause' |
  'resume')`) so it records nothing while the machine is locked or asleep.
- **What it contributes:** a Timeline lane and a review/Summary section
  (renderer half, new contribution points `timelineLanes` and
  `reviewSections`), fed from its own files through its own main half.
- **Existing data:** `focus` events already in core activity logs stay
  where they are. The extension gets them once, read-only, through
  `ctx.devlog.activity(range, { types: ['focus'] })`, and the core stops
  showing them itself when the extension is enabled.

This is also the proof that the model works: a real feature, with native
helpers, its own synced files, UI contributions and a permission prompt,
built only on the public API.

## How a devlog declares extensions

In the existing manifest, `devlog.json`, with npm version specs:

```json
{
  "format": 3,
  "extensions": {
    "@sdeken/devlog-jira": "^1.2.0",
    "devlog-cms": "github:sdeken/devlog-cms#v0.3.1"
  }
}
```

Plus a lockfile, `devlog.lock.json`, written by the app: the exact version,
tarball URL and integrity hash each spec resolved to. Every machine runs
byte-identical extension code, and an update is a visible, committed change
("devlog: update extensions"), never a silent drift.

Why not a `package.json` in the devlog root: it would make the notebook look
like a JavaScript project, and anyone (or any tool) running `npm install`
there would put a `node_modules/` inside the notebook. `devlog.json` is
already the notebook's manifest.

### Non-secret settings

- **Per devlog** (Jira base URL, CMS project list): in `devlog.json` under
  `"settings": { "@sdeken/devlog-jira": { … } }`, edited through the app.
- **Per canvas** (this client's Jira issue, CMS project): as namespaced
  front-matter keys in the canvas's `canvas.md`, e.g.
  `ext.@sdeken/devlog-jira.issue: ACME-123`. They follow the canvas through
  renames and moves, and the canvas dialog shows them as ordinary fields
  (from `contributes.canvasFields`). Task canvases inherit from the nearest
  ancestor that sets one, like time already rolls up in the review.
  *Prerequisite:* the `canvas.md` parser currently drops unknown keys; it
  must preserve them.

### Secrets and machine-local state

Never in the repository. Kept in the app's user-data folder per extension,
encrypted with the OS keychain (Electron `safeStorage`: DPAPI on Windows,
Keychain on macOS, libsecret on Linux). The CMS password lives only there.
Extensions get `ctx.secrets.get/set` for these, and `ctx.files` (see *Data*)
for everything else; nothing else on disk.

## Installing and updating

- The app resolves specs and downloads tarballs itself with `pacote` (npm's
  own fetcher: registry, scoped/private registries, `github:` and tarball
  URLs), install scripts off, integrity verified against the lockfile. No
  npm CLI needed on the machine.
- Packages are unpacked into `userData/extensions/<integrity>/`, shared by
  every devlog that pins the same bytes; nothing is written into the devlog.
- **Update extensions** (a command) re-resolves the ranges, shows what
  changed, rewrites the lockfile and commits it. Pulling a lockfile another
  machine updated leads to a download plus a consent prompt, since the code
  is new.
- **Development:** a machine-local override (in user data, never in the
  devlog) maps a package name to a folder, for working on an extension
  without publishing it.

## Trust

The honest model: **you trust what you install**, like a VS Code extension.
The app makes that trust explicit and hard to grant by accident:

- The first activation of a given package *hash* in a given devlog asks,
  showing the name, version, source, publisher and requested permissions.
  Approvals are stored locally, so a devlog pulled onto a new machine, or a
  lockfile changed by another machine, asks again.
- The API only exposes what was granted (no block writes without
  `writeBlocks`, only the extension's own secrets). Main-process code
  runs in a separate process (below), started with Node's permission model
  so it has no file-system or child-process access beyond its own
  directory. Network is allow-listed where the runtime can enforce it and
  shown to the user either way.

## Runtime

Two halves, both optional:

- **Main half** (`main`): destinations, commands, anything that talks to
  the network. Runs in an Electron `utilityProcess` per extension: a crash
  or hang cannot take the app down, and it can be restarted or disabled. It
  talks to the app over a message channel exposing the API below.
- **Renderer half** (`devlog.renderer`): renderers for custom block kinds.
  Runs in a sandboxed iframe (no Node, strict CSP, no network unless
  granted), receives a block's markdown and metadata, and renders into its
  own frame. If the extension is missing or disabled, the block falls back
  to plain markdown.

### API sketch (v1)

```ts
export function activate(ctx: DevlogContext): void | Promise<void>

interface DevlogContext {
  devlog: {
    canvases(): Promise<CanvasMeta[]>                  // with this extension's canvas fields
    timesheet(weekStart: string): Promise<Timesheet>   // the approved timesheet (see TIMESHEETS.md)
    blocks(canvasId: string, date: string): Promise<Entry[]>
    addBlock?(canvasId: string, markdown: string, opts: { kind: string; meta?: Record<string, string> }): Promise<Entry> // needs writeBlocks
  }
  settings: { get<T>(key: string): T | undefined }     // devlog-level, from devlog.json
  secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  files: { repo: ExtensionFiles; local: ExtensionFiles } // this extension's own folders (see Data)
  activity: { on(event: 'pause' | 'resume' | 'task', cb: (ev: ActivityEvent) => void): void } // read-only feed
  ui: { notify(message: string): void; confirm(message: string): Promise<boolean> }
  destinations: { register(id: string, destination: Destination): void }
  commands: { register(id: string, label: string, run: () => Promise<void>): void }
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

## Time export (#2)

See `TIMESHEETS.md`. Time goes through a weekly **timesheet** (core): a
synopsis you review and shuffle, rounded once to quarter hours, stored in a
managed *Timesheets* canvas together with a record of every submission.
Extensions contribute **destinations** (Jira by task with start times, CMS
by client per day): mapping fields, grouping and sending. No business
rules: you finalise the hours in the timesheet.

## Custom block kinds (#3)

- Kinds are namespaced by extension (`x-outlook-meeting`), stored as normal
  blocks: a `kind`, metadata on the record, readable markdown as the body.
  Search and the index keep working, and nothing is lost if the extension
  goes away.
- Blocks an extension creates are automatic blocks (read-only, muted brace),
  like commit blocks today.

## Milestones

1. Core plumbing: `devlog.json` extensions + lockfile, preserving unknown
   `canvas.md` keys, `safeStorage` secret store, the file broker and
   per-extension folders, `pacote` install into user data, consent prompt,
   `utilityProcess` host (with the `--permission` spike), bundled
   first-party extensions, `@devlog/extension-api` with a test harness.
   Then **devlog-focus**: window tracking moved out of the core, which
   proves the loop end to end on a real feature.
2. Timesheets in core and the app: draft, grid, managed canvas, send
   record (`TIMESHEETS.md`); CSV destination.
3. Jira and CMS destinations.
4. Renderer half: sandboxed block renderers; then Outlook as the first real
   custom block kind.

## Open questions

1. **Where do per-canvas mappings live?** Namespaced keys in `canvas.md`
   (proposed) versus a mapping table in `devlog.json`. The former follows
   the canvas and needs no ids; the latter keeps all of an extension's
   settings in one place.
2. **Registry.** Public npm, GitHub Packages, or git URLs only? Your own
   extensions could simply be `github:` specs with version tags, with no
   registry at all.
3. **How strict is v1 isolation?** A separate process plus Node's
   permission model is cheap; hard network allow-listing is not (it needs
   the network to go through the app). Is "shown and consented, enforced
   where cheap" enough for extensions you write yourself?
4. **Scheduled exports.** Only by button (proposed), or also "every Friday
   at 17:00, ask me"?
5. **Can extensions read what they contributed?** Blocks an extension wrote
   are part of the devlog, readable by anything with read access. Should an
   extension be able to read *all* blocks (needed for "fill from notes"),
   or only its own unless granted `readBlocks`? Proposed: reading the
   devlog is a permission like writing it.
