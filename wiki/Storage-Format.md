# Storage format

A devlog is a git repository of plain Markdown with a little front matter
and HTML-comment markers. **The files are the source of truth**: every cache
can be deleted and rebuilt from them, and they render on GitHub and open in
any editor. This page describes **storage format 4** (block file format 3).
Only `@devlog/core` writes these files; see [Core Library](Core-Library).

## Repository layout

```
devlog.json                       { "format": 4, … }: storage format, extensions, their settings
devlog.lock.json                  exact extension builds, pinned by SHA-256
.gitattributes                    union merge for block files and activity logs
.gitignore
entries/…                         the old journal (retired; only in devlogs that used it)
canvases/
  k3/                             shard: the first two characters of the id
    k3m9x2q7vd/                   a canvas ("Acme Corp")
      canvas.md                   its properties + its surface
      assets/                     images pasted into the surface
      entries/2026/09/
        2026-09-19.md             its stream: one file per local day
        assets/2026-09-19-143201-a1b2.png   images pasted into blocks
  7w/
    7wq0dz4hbe/                   "Website", parent: k3m9x2q7vd
activity/
  desktop-4f1a/2026/09/2026-09-19.jsonl   the app's activity log, one folder per machine
extensions/
  builtin.devlog-time/…           each extension's own synced files
```

## `devlog.json`

```json
{
  "format": 4,
  "extensions": {
    "devlog-time": "builtin",
    "sdeken/devlog-jira": "^1.2.0",
    "my-ext": "https://example.com/my-ext.devlog-ext.zip"
  },
  "settings": {
    "builtin.devlog-time": { "idle_minutes": "10", "in_repo": "true" },
    "sdeken.devlog-jira": { "baseurl": "https://acme.atlassian.net" }
  }
}
```

- `format`: the storage format. The app upgrades format 3 to 4 when it opens
  a devlog, and refuses anything else (older or newer) with a message
  (`assertSupportedFormat`).
- `extensions`: see [Extensions Overview → Sources](Extensions-Overview#sources).
- `settings`: per extension **id**, string values only. Never secrets.

## `devlog.lock.json`

```json
{
  "lockfileVersion": 1,
  "extensions": {
    "sdeken/devlog-jira": {
      "id": "sdeken.devlog-jira",
      "spec": "^1.2.0",
      "version": "1.2.3",
      "url": "https://github.com/sdeken/devlog-jira/releases/download/v1.2.3/devlog-jira.devlog-ext.zip",
      "sha256": "…"
    }
  }
}
```

Keyed by the `devlog.json` key; written sorted. Built-ins and development
folders are not locked.

## `.gitattributes`

```
# Devlog: append-only files merge by keeping both sides
**/entries/**/*.md merge=union
**/todos.md merge=union
activity/**/*.jsonl merge=union
extensions/<id>/<glob> merge=union      one line per appendOnly glob of each extension
```

Git's union driver keeps both sides of a conflicting hunk. That is safe
because these files are append-only logs whose readers tolerate records in
any order.

## Canvases: `canvas.md`

```markdown
---
title: Website
parent: k3m9x2q7vd
created: 2026-09-19T10:00:00.000Z
type: sdeken.devlog-kanban/board
repo: "C:\\src\\acme-site"
alias: website
ext.builtin.devlog-jira.issue: ACME-123
---

Marketing site rebuild. Weekly sync on Tuesdays.

- Tracker: https://issues.example.com/acme
```

- **Ids** are 10 random characters from `0123456789abcdefghjkmnpqrstvwxyz`
  (no `i l o u`), about 50 bits, so machines creating canvases offline never
  collide. The folder is `canvases/<first two characters>/<id>/`.
- **The hierarchy is `parent: <id>`**, not the folder path: renaming or
  moving a canvas edits one line and never moves files.
- Front matter is `key: value` lines (values optionally quoted); no YAML
  library.

| Key | Meaning |
|---|---|
| `title` | The canvas's name |
| `parent` | The enclosing canvas's id (absent at the top level) |
| `created`, `updated` | Creation time; last surface edit |
| `task: true` | devlog-time's task type (written this way for compatibility) |
| `type: <ext id>/<type id>` | Any other node type |
| `repo` | A linked git working copy (repeatable) |
| `archived: true` | Archived, with everything beneath it |
| `alias` | A former id that still resolves here (repeatable) |
| `ext.<extension id>.<key>` | An extension's canvas field |
| `devlog.managed` | The owner of a canvas an extension keeps (`<ext id>/<key>`) |

The **surface** is the Markdown after the front matter. Its images live in
`assets/` beside `canvas.md` and are linked relatively.

## Blocks: day files

Each canvas's stream is one file per **local** day:
`…/entries/YYYY/MM/YYYY-MM-DD.md`. A day file is an **append-only log of
records** (`packages/core/src/format/oplog.ts`):

```markdown
<!-- devlog:format 3 -->
<!-- devlog:add id=k2m4x9qa pos=a0 at=2026-09-19T14:32:01.000Z -->
Kickoff with **Dana**. Scope agreed.
<!-- devlog:add id=p7w2c0dd parent=k2m4x9qa pos=a0 at=2026-09-19T14:40:12.000Z kind=todo -->
Send the estimate
<!-- devlog:edit id=k2m4x9qa at=2026-09-19T15:02:44.000Z -->
Kickoff with **Dana**. Scope agreed; estimate by Friday.
<!-- devlog:set id=p7w2c0dd at=2026-09-20T09:00:00.000Z done=2026-09-20T09:00:00.000Z -->
<!-- devlog:add id=q1r8s2t0 pos=a1 at=2026-09-19T16:10:00.000Z ext=sdeken.devlog-deploys env=staging -->
Deployed **v2.3** to staging
```

| Record | Form | Meaning |
|---|---|---|
| `add` | `id= [parent=] pos= at= [updated=] [kind=] [hidden=1] [key=value…]` + body | A new block |
| `edit` | `id= at=` + body | New text |
| `set` | `id= [pos= [parent=]] at= [hidden=0\|1] [kind=] [key=value \| key=""]` | Move, hide, change kind or metadata (`key=""` removes one) |
| `delete` | `id= at=` | Delete (final) |

Block ids are 8 characters of `0-9a-z`, unique within the file.

### Replay rules

The current blocks are a replay of the records, designed so the result does
not depend on the order two machines' records were merged in:

- Each field (body, placement, hidden, kind, each metadata key) is a
  **last-writer-wins register on `at`**; equal timestamps go to the later
  record. New records are stamped no earlier than the newest in the file, so
  a slow clock cannot make a fresh edit lose.
- `delete` is final; records for unknown ids are ignored; `add` records apply
  first, so a record merged in above its block still applies.
- A block whose parent is missing or deleted shows at the top level; a
  parent cycle (two concurrent moves) is cut at its smallest id.
- A line that starts like a marker but is not a complete record (a torn
  write, a record type from a newer version) ends the previous body and is
  otherwise skipped.
- Anything before the first record is ignored, not destroyed; CRLF is fine.

### Order keys

Siblings sort by `pos`, a fractional index (`a0`, `a1`, `a0V`, …;
`format/order.ts`): there is always a key between two keys, and appends only
grow the integer part. Ties (two machines appending at once) sort by
creation time, then id.

### Marker escaping

Any body line that looks like a marker (`<!-- devlog:…`, possibly after
backslashes) gets one more leading backslash on disk and loses it on
reading, so no text can split or merge blocks. A seeded fuzz test round-trips
hostile bodies.

### Image paths

On disk, images are relative to the day file (`![shot](assets/x.png)`), so
the log renders on GitHub. In memory (and in the API) they are
repo-root-relative (`canvases/k3/k3m9x2q7vd/entries/2026/09/assets/x.png`).

### Trees across days

A block written inside another on a later day is stored in its **root
block's day file**, so a subtree never splits across files. Moving a block
to another canvas appends `add` records to the target and `delete` records
to the source.

### Compaction

`DevlogStore.compact({ quietSince, dryRun })` rewrites a quiet file as one
`add` per live block, after checking that the result replays to the same
blocks. It exists and is tested but the app does not call it yet.

## Activity log

`activity/<machine>/YYYY/MM/YYYY-MM-DD.jsonl`: one JSON object per line,
one file per local day, one folder per machine (`<host>-<short id>`, kept in
`userData/machine.json`). Written only while an extension provides time.

```json
{"t":"2026-09-19T09:02:11.000Z","type":"unlock"}
{"t":"2026-09-19T09:40:00.000Z","type":"git","canvasId":"k3m9x2q7vd","repo":"C:\\src\\acme-site","action":"checkout","branch":"feature/login","from":"main"}
{"t":"2026-09-19T12:00:00.000Z","type":"idle"}
{"t":"2026-09-19T13:00:00.000Z","type":"exclude","id":"x1","start":"2026-09-19T12:00:00.000Z","end":"2026-09-19T12:45:00.000Z"}
```

Types are those of [`ActivityRecord`](Extension-Types#activityrecord-17). A
machine only appends to its own files, so logs never conflict; readers merge
every machine and tag each event with it. Corrections are `exclude` events,
undone by a later event with `cancels: <id>`; raw events are never edited.

## Extension folders

`extensions/<id>/…` holds each extension's synced files (`ctx.files.repo`).
The core ignores this folder when listing, indexing and searching. Writes
there do not count as unsaved work; they are committed with the next interval
sync.

## Older devlogs

- Format 3 is upgraded on open (`upgradeStorage`: per-canvas `todos.md` lists
  move into the streams as `todo` blocks).
- Formats 1 and 2 (before Devlog 0.5) are refused: open the devlog once with
  Devlog 0.5, which upgrades it, then with this version.
- A newer format is refused rather than misread.
