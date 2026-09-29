# Architecture

Devlog is an Electron app over a git repository. The one rule that shapes
everything: **only `@devlog/core` touches the repository's files**. The
renderer never touches the file system, and extensions reach the devlog only
through the app.

The long-form rationale is
[`docs/DESIGN.md`](https://github.com/sdeken/devlog/blob/main/docs/DESIGN.md).

## Processes

```
┌──────────── renderer (sandboxed, no Node) ────────────┐
│ React UI                                               │
│  Composer = TipTap (ProseMirror) + @tiptap/markdown    │
│  Feed     = marked + DOMPurify                         │
│  Extension views: <iframe sandbox> from devlog-ext://  │
│  window.devlog (contextBridge) ◄──── preload           │
└──────────────────────────┬─────────────────────────────┘
                           │ ipcRenderer.invoke / events
┌──────────────────────────▼─────────────────────────────┐
│ main                                                    │
│  @devlog/core/node: the only code that touches the repo │
│    DevlogStore   canvases, blocks, todos, assets        │
│    RepoIndex     SQLite cache: listings + full-text     │
│    SyncManager   simple-git: commit/fetch/rebase/push   │
│    ActivityLog   per-machine JSON-lines log             │
│    manifest      storage format, extensions, lockfile   │
│  ExtensionManager ── one ExtensionHost per extension    │
│  machine state, CommitWatcher, protocols, settings,     │
│  updater, tray, menu                                    │
└──────────────┬──────────────────────────────────────────┘
               │ fork (ELECTRON_RUN_AS_NODE, --permission), IPC
┌──────────────▼───────────────┐  ┌──────────────────────┐
│ extension process            │  │ extension process    │  …
│  extensionHost.js            │  │                      │
│  evaluates main.js, ctx API  │  │                      │
└──────────────────────────────┘  └──────────────────────┘
```

- **Renderer**: `contextIsolation`, `sandbox` and a CSP are on. It sends
  Markdown strings and image bytes over IPC; the main process owns all paths,
  git and the asset server. `devlog://asset/…` is the only way the page loads
  a file from the repository, and the handler refuses anything outside it.
- **Main**: owns the store, the index, sync, the activity log, the extension
  manager, machine state (lock, idle, sleep), the commit watcher, settings,
  the tray and auto-update.
- **Extension processes**: one per running extension, a Node child of the
  app binary under Node's permission model. See
  [Extension Host Protocol](Extension-Host-Protocol) and
  [Sandbox and Permissions](Sandbox-and-Permissions).

## Packages

| Package | Path | Role |
|---|---|---|
| `@devlog/core` | `packages/core/` | Data model, file formats, storage engine. A pure entry (types, formats, hierarchy helpers, timesheet rules, extension manifests and grants; used by the renderer too) and a Node entry (`@devlog/core/node`). No Electron dependency, so a CLI or API server could be another client. See [Core Library](Core-Library). |
| `@devlog/extension-api` | `packages/extension-api/` | What extensions are written against: types, the wire protocol, view messages, the test harness. |
| `@devlog/ui` | `packages/ui/` | React kit for extension views. |
| the app | `src/` | Electron main (`src/main`), preload (`src/preload`), renderer (`src/renderer`), shared pure logic (`src/shared`). |
| built-in extensions | `builtin-extensions/` | devlog-time, devlog-focus, devlog-jira, devlog-cms. |

## Code map

| Path | Purpose |
|---|---|
| `packages/core/src/format/` | Block and canvas file formats, ids, order keys, hierarchy helpers |
| `packages/core/src/node/store.ts` | `DevlogStore`: canvases, blocks, todos, assets |
| `packages/core/src/node/repoIndex.ts` | `RepoIndex`: SQLite cache for listings and full-text search |
| `packages/core/src/node/sync.ts` | `SyncManager`: commit / pull / push scheduler on `simple-git` |
| `packages/core/src/node/activityLog.ts` | Per-machine append-only activity log |
| `packages/core/src/node/manifest.ts` | `devlog.json` (format check, extensions, settings) and `devlog.lock.json` |
| `packages/core/src/node/extensionFiles.ts` | The file broker behind an extension's private folders |
| `packages/core/src/extensions.ts` | Extension manifests, sources and ids, version ranges, grants |
| `packages/core/src/timesheet.ts` | Timesheet rules: sessions, quarter-hour rounding, trims, the week's block format |
| `packages/extension-api/src/` | `index.ts` (the API), `protocol.ts` (host wire protocol), `view.ts` (view messages), `testing.ts` (harness) |
| `packages/ui/src/` | `bridge.ts`, `index.tsx` (hooks, components), `styles.css` |
| `src/main/extensions/` | `install.ts` (resolve, download, verify, unpack), `host.ts` (process), `hostProcess.ts` (inside the process), `manager.ts` (consent, grants, the API as seen from the app), `localState.ts` |
| `src/main/protocol.ts` | `devlog://asset/…` (images from the repo) and `devlog-ext://` (extension views) |
| `src/main/ipc.ts`, `src/preload/`, `src/shared/ipc.ts` | The IPC surface exposed to the renderer as `window.devlog` |
| `src/main/activity/commits.ts` | Commit watcher: reflogs of linked repositories → commit blocks and git events |
| `src/main/updates.ts`, `src/shared/updates.ts` | Silent auto-update and the pure "good moment to restart" policy |
| `src/shared/activity.ts` | Pure event → segment replay, focus cleaning, app classification, day buckets |
| `src/shared/review.ts` | Weekly roll-up: week math, tracked / explicit / estimated time |
| `src/shared/theme.ts` | Colour presets and derived theme variables |
| `src/renderer/src/components/` | React UI: top bar, sidebar, canvas view, composer, settings, extension views |
| `src/renderer/src/editor/` | TipTap extensions: highlighted code, asset images, Slack keys, smart paste |
| `scripts/` | Built-in extension bundler, Playwright smoke test, screenshots |

## The renderer's IPC surface

The preload script exposes `window.devlog` (typed in
`src/preload/index.d.ts`); channel names live in `src/shared/ipc.ts` so main,
preload and renderer agree. Groups:

| Group | Channels |
|---|---|
| Settings | `settings:get`, `settings:set` |
| Repository | `repo:info`, `repo:open`, `repo:create`, `repo:setRemote`, `repo:close`, `repo:chooseDirectory`, `repo:inspectWorkingCopy`, `repo:importHistory`, `repo:reveal` |
| Canvases | `canvases:list`, `canvas:get`, `canvas:create`, `canvas:update`, `canvas:delete`, `canvas:archive`, `surface:set`, `surface:assetSave` |
| Blocks | `days:list`, `day:get`, `timeline:get`, `range:get`, `entry:add`, `entry:update`, `entry:delete`, `entry:move`, `entry:hide`, `entry:reorder`, `entry:search`, `asset:save` |
| Todos | `todos:list`, `todos:add`, `todo:setDone` |
| Activity | `activity:range`, `activity:exclude`, `activity:restore` |
| Extensions | `ext:list`, `ext:add`, `ext:remove`, `ext:allow`, `ext:revoke`, `ext:restart`, `ext:update`, `ext:setSettings`, `ext:setSecret`, `ext:run`, `ext:githubToken`, `ext:builtins`, `ext:viewCall`, `ext:appState`, `ext:answerPick` |
| Sync, updates, window | `sync:now`, `sync:status`, `updates:status`, `updates:check`, `updates:install`, `editor:busy`, `shell:openExternal`, `window:menuPopup`, `window:control` |
| Events (main → renderer) | `ev:syncStatus`, `ev:entriesChanged`, `ev:repoChanged`, `ev:menu`, `ev:attachImages`, `ev:updateStatus`, `ev:extensionsChanged`, `ev:notify`, `ev:extViewMessage`, `ev:extAppState`, `ev:extPick`, `ev:extOpen` |

This surface is internal to the app and changes freely; extensions never
see it.

## How a post flows

1. The composer serialises TipTap's document to Markdown and calls
   `entry:add` (images were already saved with `asset:save`).
2. Main calls `DevlogStore.addEntry`, which appends an `add` record to the
   day file (under a per-file lock), updates the index, and emits `change`.
3. The `change` event nudges `SyncManager.noteChange()`; a commit follows
   after the debounce (30 s by default).
4. Main tells extensions listening with `onBlockAdded` that may read that
   canvas (devlog-time starts the task if it is one).
5. Main sends `ev:entriesChanged`; the renderer reloads the day.

## Machine state and time

The main process watches `powerMonitor` (lock/unlock, suspend/resume) and
polls the idle state every 15 seconds against the idle minutes extensions
asked for. It tells extensions (`activity.on`) and, while some extension
provides time, writes those events to `activity/<machine>/…`. The views read
one merged stream: the core log plus the time and focus providers' events.
See [Activity and Time Data](Activity-and-Time-Data).

## Sync

`SyncManager` serialises every git run so timers, the debounce, **Sync now**
and quit never overlap. One run: `git status` → `add -A` + commit (the
subject names the days touched) → if a remote exists and pushing is on,
`fetch`, `pull --rebase --autostash` if behind, `push --set-upstream` if
ahead. A conflicting rebase is aborted and reported; the app never
force-pushes. `GIT_TERMINAL_PROMPT=0` stops git from blocking on credentials
and a 90 s silence timeout kills a stalled network call.

| Trigger | What happens |
|---|---|
| A store change | Commit after a debounce (default 30 s); writes under `activity/` and `extensions/` excepted |
| Every N minutes (default 5) | Commit if dirty, fetch, pull if behind, push |
| **Sync now** (⌘⇧S) | The same, immediately |
| App start | Pull |
| App quit | Commit and push (bounded to 20 s) |
