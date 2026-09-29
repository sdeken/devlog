# @devlog/core

The data model, file format and storage engine behind Devlog. Everything that
reads or writes a devlog repository goes through this package; the desktop
app is one client of it, and an API server or CLI could be another.

Two entry points:

| Import              | Contents                                                      | Runs in          |
| ------------------- | ------------------------------------------------------------- | ---------------- |
| `@devlog/core`      | Types, block and canvas file formats, pure hierarchy helpers  | Anywhere         |
| `@devlog/core/node` | `DevlogStore`, `RepoIndex`, `SyncManager` (git), `ActivityLog`, `assertSupportedFormat` | Node 22.13+ only |

## Rules

- **The files are the source of truth.** Canvases, blocks, todos and surfaces
  are Markdown with a little front matter and HTML-comment markers. Any cache
  (the local index) can be deleted and rebuilt from them.
- **Only this package writes them.** Applications ask the store to add, move,
  hide or delete a block; they never open a day file themselves. That keeps
  format rules (marker escaping, relative image links, ordering) in one place
  and under test.
- **Block files are append-only.** Every change to a block or todo is a
  record appended to its file (`format/oplog.ts`); the store never rewrites
  one, except `compact()`, which rewrites quiet files to their current
  state after checking the result replays to the same blocks (not used by
  the app yet). Other files (`canvas.md`, the manifest) are written atomically (temp
  file, then rename). The store emits `change` events so a sync manager can
  commit shortly after.
- **The index is a cache.** `RepoIndex` lives outside the repository (the app
  keeps it in user data) and can be deleted at any time.

## Typical use

```ts
import { DevlogStore, RepoIndex, SyncManager, assertSupportedFormat } from '@devlog/core/node'

const store = new DevlogStore(root)
await store.initLayout()
await assertSupportedFormat(root) // format 3 only; throws with a message otherwise
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

## Storage

See the main README (*Repository layout*) and `docs/DESIGN.md` for the
format. The index uses
`node:sqlite`, which prints an experimental warning on Node 22; Electron 44
(Node 24) is the target.

## Tests

The tests cover the file formats (including a fuzz test of marker escaping),
every store operation, indexed-vs-scanned equivalence, git sync against local
bare remotes and the per-machine activity log.

```sh
npx vitest run packages/core
```
