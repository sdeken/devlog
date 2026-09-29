# Core library (`@devlog/core`)

The data model, file format and storage engine behind Devlog. **Everything
that reads or writes a devlog repository goes through this package**; the
desktop app is one client of it, and a CLI or API server could be another.
Extensions do not use it directly (they go through `ctx`), but built-ins may
import its pure helpers (devlog-time uses `parseDurationMarker`).

Source: [`packages/core`](https://github.com/sdeken/devlog/tree/main/packages/core).

| Import | Contents | Runs in |
|---|---|---|
| `@devlog/core` | Types, block and canvas file formats, order keys, hierarchy helpers, timesheet rules, extension manifests, sources, versions and grants | Anywhere (pure; the renderer uses it) |
| `@devlog/core/node` | `DevlogStore`, `RepoIndex`, `SyncManager`, `ActivityLog`, `devlog.json` and lockfile helpers, `ExtensionFileStore` | Node 22.13+ |
| `@devlog/core/types` | The types alone | Anywhere |

## Rules

- **The files are the source of truth.** The index is a cache that can be
  deleted and rebuilt.
- **Only this package writes them.** Applications ask the store to add,
  move, hide or delete a block; they never open a day file themselves.
- **Block files are append-only.** Every change is a record appended to its
  file; only `compact()` rewrites one. Other files (`canvas.md`, the
  manifest) are written atomically (temp file, then rename).
- The store emits `change` events so a sync manager can commit shortly
  after.

## Typical use

```ts
import { DevlogStore, RepoIndex, SyncManager, assertSupportedFormat } from '@devlog/core/node'

const store = new DevlogStore(root)
await store.initLayout()
await store.upgradeStorage()        // 3 → 4: todo lists move into the streams
await assertSupportedFormat(root)   // format 4 only; throws with a message otherwise

const sync = new SyncManager(root, { intervalMinutes: 5, debounceSeconds: 30, autoPush: true, pullOnStart: true })
const index = RepoIndex.open(dbPath, root) // optional cache; files stay the truth
store.attachIndex(index)
void index.refresh()
store.on('change', () => sync.noteChange())
await sync.start()

const acme = await store.createCanvas({ title: 'Acme Corp' })
await store.addEntry(acme.id, 'Kickoff with Dana')
const hits = await store.search('dana')
```

## `DevlogStore`

`new DevlogStore(root)`. An `EventEmitter`: `'change'` fires after every
write with `{ kind, canvasId?, … }`. Methods that write take an optional
`now: Date` last, for tests.

### Setup

| Method | Description |
|---|---|
| `initLayout()` | Create the layout (`devlog.json`, `.gitattributes`, …) if missing. |
| `upgradeStorage(): Promise<number \| null>` | Upgrade format 3 to 4; returns the old format if it upgraded. |
| `attachIndex(index \| null)` | Serve listings and search from a `RepoIndex` once built, and keep it current. |
| `resolve(repoRel)`, `resolveAsset(repoRel)` | Map a repo-relative path to an absolute one, refusing anything outside. |

### Canvases

| Method | Description |
|---|---|
| `listCanvases(): Promise<CanvasMeta[]>` | Every canvas, archived included. |
| `readCanvas(id): Promise<Canvas>` | Properties and surface. |
| `resolveCanvasId(id)`, `aliasMap()` | Follow `alias` lines to current ids. |
| `createCanvas(input: CanvasInput)` | `title`, `parentId`, `task` or `type`, `repos`, `fields`. |
| `updateCanvas(id, patch)` | Any of the same; a field set to `''` or `null` is removed. |
| `setCanvasArchived(id, archived): Promise<string[]>` | Archive or restore it with everything beneath; returns the ids changed. |
| `deleteCanvas(id): Promise<number>` | |
| `writeSurface(id, markdown)`, `saveSurfaceAsset(id, bytes, mime, name?)` | The surface and its images. |
| `managedCanvas(owner, title?)` | Find (or with a title, make) the canvas whose `devlog.managed` field is `owner`. |

### Blocks

| Method | Description |
|---|---|
| `listDays(canvasId): Promise<DaySummary[]>` | Day files with their block counts. |
| `readDay(canvasId, date): Promise<Day>` | One day file's blocks, in display order. |
| `getTimeline(canvasId, { beforeDate?, days? }): Promise<Timeline>` | Newest non-empty days, oldest first, with `hasMore`. |
| `getRange(from, to)` | Every day file (across canvases) with blocks written, or todos ticked, in the range. |
| `search(query, limit = 200): Promise<SearchResult>` | Substring search over blocks and surfaces. |
| `addEntry(canvasId, markdown, position?, now?, system?)` | Add a block: `position` is `{ date?, parentId?, afterId?, beforeId? }`; `system` sets a kind and meta (commits are de-duplicated by hash). |
| `addExtensionBlock(canvasId, extensionId, markdown, meta?, now?, opts?)` | A block marked `ext=<id>` (what `ctx.devlog.addBlock` uses). |
| `updateEntry(canvasId, date, id, markdown)` | Edit a user block (automatic blocks are refused). |
| `updateExtensionBlock(canvasId, date, id, extensionId, markdown, now?, { any? })` | Edit a block an extension added. |
| `setEntryHidden(canvasId, date, id, hidden)` | Hide or reveal. |
| `reorderEntry(canvasId, date, id, { afterId?, beforeId? })` | Move within a day. |
| `moveEntry(fromCanvasId, date, id, toCanvasId)`, `moveBlock(…)` | Move a block (with its subtree) to another canvas, or inside another block. |
| `deleteEntry(canvasId, date, id): Promise<number>` | Delete it and everything inside; returns how many. |
| `promoteBlock(canvasId, date, id, type)` | Turn a block into a canvas of a node type (`promoteToTask` for the task type). |
| `saveAsset(…)` | Save a pasted image next to a day file. |
| `compact({ quietSince, dryRun? }): Promise<CompactionReport>` | Rewrite quiet block files to their current state (not used by the app yet). |

### Todos

| Method | Description |
|---|---|
| `addTodos(canvasId, texts, { date?, parentId? })` | Add todo blocks. |
| `setTodoDone(canvasId, date, id, done)` | Tick or untick. |
| `listTodos({ doneSince? }): Promise<TodoRef[]>` | Open todos (and those ticked since). |

## `RepoIndex`

`RepoIndex.open(dbPath, root)`: a SQLite cache (Node's built-in
`node:sqlite`) outside the repository, with a trigram FTS5 table for
substring search. `refresh()` re-parses what changed on disk; a schema or
repository change, or a corrupt file, just rebuilds it. The store writes
through to it after every file write. Tests compare every indexed answer with
a file scan.

## `SyncManager`

`new SyncManager(root, options)`, an `EventEmitter`.

| Option | Meaning |
|---|---|
| `intervalMinutes` | Full sync interval |
| `debounceSeconds` | Commit this long after the last change |
| `autoPush` | Fetch, pull and push when a remote exists |
| `pullOnStart` | Pull on `start()` |
| `authorName`, `authorEmail` | Commit author |
| `quietPaths` | Path prefixes committed with every sync but not counted as unsaved work (`activity/`, `extensions/`) |

Methods: `start()`, `stop()`, `noteChange()`, `syncNow()`, `commitAll()`,
`setRemote(url)`, `getStatus(): SyncStatus`, `updateOptions(o)`, `idle()`.
Events: `status` (a `SyncStatus`), `synced` (a `SyncResult`),
`remote-changes` (a pull changed the tree).

## `ActivityLog`

`new ActivityLog(() => root, machine)`: `append(event)` writes to this
machine's file for the event's local day; `read(from, to)` merges every
machine (and the pre-0.4 shared layout) and tags each event with its
`machine`; `machines()` lists them. Helpers: `machineFolder(host, id)`,
`datesBetween(from, to)`, `ACTIVITY_DIR`.

## Manifest and lockfile

| Function | Description |
|---|---|
| `readStorageFormat(root)` | The `format` in `devlog.json`, or null. |
| `assertSupportedFormat(root)` | Throws a readable message for anything but format 4. |
| `readManifest(root)`, `updateManifest(root, fn)` | Read and atomically update `devlog.json` (`DevlogManifest`). |
| `readLockFile(root)`, `writeLockFile(root, lock)` | `devlog.lock.json` (`LockFile`, `LockEntry`). |
| `ensureExtensionAttributes(root, id, globs)` | Add `merge=union` lines for an extension's `appendOnly` globs. |

## `ExtensionFileStore`

`new ExtensionFileStore(base, { maxFileBytes?, maxTotalBytes?, maxFiles?, anchor? })`:
the broker behind `ctx.files` (`read`, `write`, `append`, `list`, `stat`,
`remove`). See [Sandbox and Permissions → The file broker](Sandbox-and-Permissions#the-file-broker).

## Pure helpers (`@devlog/core`)

| Module | Highlights |
|---|---|
| `format/blocks.ts` | `localDate`, `dayFilePath`, `newEntryId`, image path conversion (`toRootRelative`, `toDayRelative`), marker escaping, tree helpers (`buildTree`, `descendantIds`), `parseDurationMarker` / `normalizeDurationMarker` (`[2h]`, `[45m]`), `titleFromMarkdown`, `hasTag` / `stripTag`, `splitTodoLines` |
| `format/canvases.ts` | `STORAGE_FORMAT`, `TASK_TYPE`, `NODE_TYPE_RE`, `newCanvasId`, `canvasDir`, `canvasPath` / `canvasLabel` (walk parents for display), `ancestorIds`, `descendantCanvasIds`, `topLevelCanvasId`, `buildCanvasTree`, `inheritedField`, `parseCanvasFile` / `serializeCanvasFile` |
| `format/oplog.ts` | `parseOps`, `replayOps`, `parseDayFile`, `serializeDayFile`, the planners (`planAdd`, `planMove`, `planNest`, `planDelete`, `planSet`, `planEdit`), `compactOps`, `BLOCK_FORMAT` |
| `format/order.ts` | `keyBetween`, `keysBetween`, `isValidOrderKey` |
| `timesheet.ts` | `roundToQuarterHour`, `buildSessions`, `draftEntries`, `balanceDays`, `sanitizeTimesheet`, `serializeTimesheet` / `parseTimesheet`, `MANAGED_FIELD` |
| `extensions.ts` | `EXTENSION_API_VERSION`, `parseExtensionManifest`, `fieldProblem`, `normalizeKeybinding`, `parseExtensionEntry`, `extensionId`, `parseVersion` / `parseRange` / `satisfies` / `newestMatching`, `scopeCanvasIds`, `visibleCanvases`, `describeScope`, `sanitizeGrant` |

## Tests

```sh
npx vitest run packages/core
```

They cover the file formats (including a fuzz test of marker escaping),
every store operation, indexed-versus-scanned equivalence, git sync against
local bare remotes, the per-machine activity log, compaction, extension
manifests and `devlog.json`, and the timesheet rules.
