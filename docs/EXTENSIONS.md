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
      "exporters": [{ "id": "jira", "label": "Jira worklogs" }],
      "canvasFields": [{ "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }],
      "settings": [{ "key": "baseUrl", "label": "Jira URL" }],
      "secrets": [{ "key": "token", "label": "API token" }]
    },
    "permissions": { "network": ["*.atlassian.net"], "writeBlocks": false }
  }
}
```

- **Bundled, dependency-free.** Authors bundle with esbuild or similar; the
  app refuses a package with runtime `dependencies`. Installing is then
  "fetch one tarball, check its hash, unpack", with no dependency tree to
  resolve, audit or trust.
- **`contributes`** declares everything the app shows (exporters in the
  review, fields in the canvas dialog, settings, secret prompts) so the UI can
  be built without running the extension.
- **`permissions`** are shown to the user before first activation and
  enforced where the API allows (see *Runtime*).
- Authors write against `@devlog/extension-api`: types plus a small test
  harness, published from this repo (`packages/extension-api`). The runtime
  object is injected by the app at activation.

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
Extensions get `ctx.secrets.get/set` and `ctx.local` (a small JSON store)
and nothing else on disk.

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

- **Main half** (`main`): exporters, commands, anything that talks to
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
    week(start: string): Promise<TimeRow[]>            // the review's rows: date × canvas, minutes, source
    blocks(canvasId: string, date: string): Promise<Entry[]>
    addBlock?(canvasId: string, markdown: string, opts: { kind: string; meta?: Record<string, string> }): Promise<Entry> // needs writeBlocks
  }
  settings: { get<T>(key: string): T | undefined }     // devlog-level, from devlog.json
  secrets: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> }
  local: { get<T>(key: string): T | undefined; set(key: string, value: unknown): Promise<void> }
  ui: { notify(message: string): void; confirm(message: string): Promise<boolean> }
  exporters: { register(id: string, exporter: Exporter): void }
  commands: { register(id: string, label: string, run: () => Promise<void>): void }
}

interface Exporter {
  /** Rows this exporter can take, with the target each maps to (issue key, project…). */
  plan(rows: TimeRow[], ledger: LedgerEntry[]): Promise<PlannedExport[]>
  /** Send; return the external id per row so the ledger can prevent resubmission. */
  submit(planned: PlannedExport[]): Promise<ExportResult[]>
}
```

## Time export (#2)

1. In the weekly review, **Export** lists the exporters this devlog enables.
2. The app gives the exporter the review's rows (same rounding as the review)
   and the ledger; the exporter plans rows → targets, subtracting what was
   already sent.
3. Preview: day, target, hours, and optionally a comment built from that
   day's blocks. Nothing is sent before the user confirms.
4. Submit; the result per row goes into the **export ledger**, which is
   non-secret and lives in the devlog as append-only JSON lines
   (`exports/<extension>/YYYY/MM.jsonl`, union-merged like the activity
   log): target, day, minutes, external id. Pressing Export again, or on
   another machine, sends only the difference (or nothing).

Jira: `POST /rest/api/3/issue/{key}/worklog` with an API token. CMS: depends
on what it accepts (API, form post, or browser automation as a last resort);
its exporter is where that knowledge lives.

## Custom block kinds (#3)

- Kinds are namespaced by extension (`x-outlook-meeting`), stored as normal
  blocks: a `kind`, metadata on the record, readable markdown as the body.
  Search and the index keep working, and nothing is lost if the extension
  goes away.
- Blocks an extension creates are automatic blocks (read-only, muted brace),
  like commit blocks today.

## Milestones

1. Core plumbing: `devlog.json` extensions + lockfile, preserving unknown
   `canvas.md` keys, `safeStorage` secret store, `pacote` install into user
   data, consent prompt, `utilityProcess` host, `@devlog/extension-api` with
   a test harness. A trivial example extension (CSV exporter, #4) proves the
   loop end to end.
2. Export flow in the review: preview, ledger, retries. Jira exporter.
3. CMS exporter.
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
4. **Ledger granularity.** One ledger line per day × target (proposed), or
   per submission batch?
5. **Scheduled exports.** Only by button (proposed), or also "every Friday
   at 17:00, ask me"?
