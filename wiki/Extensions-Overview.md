# Extensions overview

An extension adds something to Devlog without growing the app: time
tracking, sending time to Jira, fields on canvases, commands, pages of its
own. This page is the model; [Extension Quickstart](Extension-Quickstart)
builds one, and [Extension API Reference](Extension-API-Reference) is the
reference.

## At a glance

```
my-extension.devlog-ext.zip
├── devlog-extension.json   the manifest: what it contributes and asks for
├── main.js                 one bundled CommonJS file exporting activate(ctx)
└── views/…                 optional HTML pages for its views
```

- **One bundled file, no dependencies.** `main.js` exports
  `activate(ctx)` (and optionally `deactivate()`). Use npm and a bundler to
  *build* it; ship one file.
- **It runs in its own process**, a Node child of the Devlog binary, with no
  access to files, other programs or other extensions (unless the user trusts
  it; see [Sandbox and Permissions](Sandbox-and-Permissions)).
- **Everything goes through `ctx`**, a `DevlogContext`, filtered by what the
  user allowed.
- **Its views are HTML pages** in sandboxed frames that talk to it only
  through the app ([Views and UI](Views-and-UI)).
- **The manifest is read without running any code**: fields, settings,
  commands, views and node types show up in the app even before the user
  allows it to run.

## Principles

- **The devlog stays Just A Notebook.** A devlog *names* the extensions it
  wants and holds their non-secret settings. It never contains their code,
  their secrets or anything else they need at runtime.
- **Opening or pulling a devlog never runs code that arrived through git.**
  Every extension build is allowed explicitly, on each machine.
- **A leaked devlog leaks no credential.** Secrets live in the OS keychain on
  each machine.
- **Extensions go through the same data layer as the app** (`@devlog/core`),
  so they cannot break the file format.
- **Extensions cannot see each other's data**, and see the devlog only where
  the user lets them.
- **Safe without containers.** Safety comes from what the runtime and the API
  allow, not from Docker or a VM.

Non-goals: two-way sync with trackers, a public marketplace, a package
manager, network sandboxing (for now).

## Lifecycle

```
devlog.json names it ─► app resolves & downloads ─► pinned in devlog.lock.json
        │                                                  │
        ▼                                                  ▼
manifest parsed (contributions shown)        user allows it on this machine
                                               (read/write scope, trust)
                                                           │
                                                           ▼
                                   process started, code sent over IPC,
                                   activate(ctx) called (30 s to finish)
                                                           │
                                   ┌───────────────────────┴───────────┐
                                   ▼                                   ▼
                    commands, views, destinations,          grant changed → restart
                    providers, events served                revoked / removed → stop
                                   │                                   │
                                   ▼                                   ▼
                          app quits → deactivate() ◄──────────────────┘
```

1. **Named.** An entry in `devlog.json` under `extensions`.
2. **Resolved and pinned.** The app downloads the build and records its exact
   version, URL and SHA-256 in `devlog.lock.json`, so every machine runs
   byte-identical code.
3. **Allowed.** The consent dialog shows its name, version, source and
   permissions and lets the user set the read and write scopes. Consent is
   per machine, per devlog and per build.
4. **Activated.** The app starts the process, sends the code and calls
   `activate(ctx)`. Registration calls (`commands.register`,
   `views.handle`, `destinations.register`, `provide.*`) belong here.
5. **Running.** The app calls into it when a command runs, a view calls, a
   block is posted, the machine pauses, a timesheet is sent, or a view needs
   data.
6. **Stopped.** On quit, revoke, removal, or before a restart with a new
   grant, the app sends `stop`; `deactivate()` runs if exported, then the
   process exits.

## Sources

Extensions are named in `devlog.json`:

```json
{
  "format": 4,
  "extensions": {
    "sdeken/devlog-jira": "^1.2.0",
    "my-ext": "https://example.com/my-ext.devlog-ext.zip",
    "devlog-time": "builtin"
  },
  "settings": {
    "sdeken.devlog-jira": { "baseurl": "https://acme.atlassian.net" }
  }
}
```

| Entry | Source | Id |
|---|---|---|
| `"owner/repo": "<range>"` | GitHub releases: the newest tag matching the range; its `*.devlog-ext.zip` asset | `owner.repo` (lower-cased) |
| `"name": "https://…/x.zip"` | One exact file | `url.name` |
| `"name": "builtin"` | Ships inside the app | `builtin.name` |

**The id comes from where an extension was fetched, never from its
manifest**, so one extension cannot claim another's name to read its data.
The id names its folders, settings, secrets and grants.

Version ranges are a small subset of semver: `1.2.3` (exact), `^1.2.3`,
`~1.2.3`, `1.2.x`, `1.x`, `*`, `latest`. Pre-releases match only an exact
range. Private GitHub repositories work with a GitHub token kept on the
machine (Extensions page).

### The lockfile

`devlog.lock.json` records, for each GitHub or URL entry, the exact version,
URL and SHA-256 (built-ins and development folders are not locked). It is
committed with the next sync. **Check for updates** re-resolves the ranges,
downloads what changed and rewrites the lockfile; changed code must be
allowed again. A lockfile updated on another machine is used, and asks for
consent, the next time the devlog opens here.

Downloads are unpacked into `userData/extensions/<sha256>/`, shared by every
devlog that pins the same bytes. Nothing is written into the devlog.
Downloads are capped at 20 MB zipped and 100 MB unpacked.

## Consent and trust

- An extension runs only once allowed, **per machine and per devlog**.
- The user picks a **read** scope and a **write** scope: nothing, the whole
  devlog, or chosen canvases (each with everything inside it).
- **Consent is per build.** A new build of a downloaded extension asks
  again. A built-in keeps its grant when the app updates it.
- Changing a grant restarts the extension; revoking stops it; **Remove** takes
  it out of `devlog.json` and forgets consent on this machine (its data
  stays).
- Grants live on the machine, never in the repository, so nothing arriving
  through git can widen them.
- An extension that declares `"unrestricted": true` runs only if the user
  ticks **I trust it**, and then runs outside the sandbox.

## Where an extension's data goes

| Data | Where | Synced | API |
|---|---|---|---|
| Devlog-wide settings | `devlog.json` → `settings.<id>` | yes | `ctx.settings` |
| Per-canvas values | `canvas.md` → `ext.<id>.<key>: value` | yes | `ctx.devlog.field`, `ExtensionCanvas.fields` |
| Secrets | user data, encrypted with the OS keychain | no | `ctx.secrets` |
| Its own synced files | `extensions/<id>/` in the devlog | yes | `ctx.files.repo` |
| Its own machine-only files | `userData/extension-data/<id>/<devlog>/` | no | `ctx.files.local` |
| Blocks it writes | ordinary day files, marked `ext=<id>` | yes | `ctx.devlog.addBlock` |

Blocks an extension writes are ordinary Markdown in the day files, so they
survive the extension going away. Uninstalling leaves its folders alone.

## What an extension can contribute

| Contribution | Manifest | Code | Since |
|---|---|---|---|
| Canvas fields | `contributes.canvasFields` | `ctx.devlog.field` | 1.0 |
| Settings and secrets | `contributes.settings`, `secrets`, `check` | `ctx.settings`, `ctx.secrets` | 1.0 |
| Commands (switcher, keys, menus, note box) | `contributes.commands` | `ctx.commands.register` | 1.0 / 1.6 |
| Timesheet destinations | `contributes.destinations` | `ctx.destinations.register` | 1.3 |
| Views (page, status bar, popover, canvas header) | `contributes.views` | `ctx.views.handle` / `post` | 1.5 / 1.6 |
| Node types | `contributes.nodeTypes` | `ctx.devlog.createCanvas`, `promote` | 1.6 |
| Focus and time data | — | `ctx.provide.focus` / `activity` | 1.1 / 1.6 |
| Blocks, canvases, todos | `permissions.read` / `write` | `ctx.devlog.*` | 1.0 – 1.7 |

## Where to go next

- [Extension Quickstart](Extension-Quickstart): build and run one.
- [Extension Manifest](Extension-Manifest): every manifest field.
- [Extension API Reference](Extension-API-Reference): every `ctx` member.
- [Built-in Extensions](Built-in-Extensions): four real extensions to read.
