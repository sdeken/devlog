# @devlog/core

The data model, file format and storage engine behind Devlog. Everything that
reads or writes a devlog repository goes through this package; the desktop
app is one client of it, and an API server or CLI could be another.

Two entry points:

| Import              | Contents                                                      | Runs in          |
| ------------------- | ------------------------------------------------------------- | ---------------- |
| `@devlog/core`      | Types, block and canvas file formats, pure hierarchy helpers  | Anywhere         |
| `@devlog/core/node` | `DevlogStore`, `SyncManager` (git), `ActivityLog`             | Node 22.13+ only |

## Rules

- **The files are the source of truth.** Canvases, blocks, todos and surfaces
  are Markdown with a little front matter and HTML-comment markers. Any cache
  (the local index) can be deleted and rebuilt from them.
- **Only this package writes them.** Applications ask the store to add, move,
  hide or delete a block; they never open a day file themselves. That keeps
  format rules (marker escaping, relative image links, ordering) in one place
  and under test.
- **Writes are atomic per file** (write to a temp file, then rename) and the
  store emits `change` events so a sync manager can commit shortly after.

## Tests

```sh
npx vitest run packages/core
```
