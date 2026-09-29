# Concepts

Three words cover the model: **canvas**, **block** and **task**. Extension
authors meet all of them through the API, so the terms here are the ones the
[API reference](Extension-API-Reference) uses.

## Canvas

A canvas is anything you write about: a client, a project, a topic, a task.

- It has a **title**, an optional **parent** (canvases nest: client →
  project → task, or however you slice your work), an optional **node type**,
  a list of linked git **repositories**, an **archived** flag and
  **fields** from extensions.
- It has a **surface**: free Markdown above the stream (links, contacts,
  how-tos, a research scratchpad). The surface is not dated.
- It has a **stream**: dated blocks, one file per local day.
- Its **id** is random (10 characters of `0-9a-z` without `i l o u`) and never
  changes. Renaming or moving a canvas only edits its `canvas.md`.
- **Archiving** is a flag on the canvas and everything beneath it: archived
  canvases leave the sidebar but stay readable and searchable.

In the API a canvas is an [`ExtensionCanvas`](Extension-Types#extensioncanvas).

## Block

A block is one post in a stream.

- It has an **id** (unique within its day file), a creation time, Markdown,
  and optionally an update time, a **kind**, a **hidden** flag and **meta**
  (string key/value attributes).
- **Kinds**: `note` (the default: something you wrote), `commit` (captured
  from a linked repository, read-only), `task` (a block that was turned into a
  task; `meta.canvas` points at the task canvas), `todo` (a block with a
  checkbox; `meta.done` is set once ticked), `done`, `timesheet`, plus kinds of
  an extension's own on a canvas it keeps.
- **Every block is a page.** Blocks nest: a block written inside another has
  a `parentId`. A block inside another is stored in its root block's day
  file, whenever it was written, so a subtree never splits across files.
- Blocks written by an extension carry `meta.ext = <extension id>` and are
  read-only in the app.

In the API a block is an [`ExtensionBlock`](Extension-Types#extensionblock);
where a block lives is always the pair `(canvasId, date)`, where `date` is the
day file (`YYYY-MM-DD`, local time).

## Node type

A node type is a kind of canvas that an extension gives meaning to. The app
has no types of its own: the one that ships, **task**, belongs to the time
extension. A canvas carries its type as `type: <extension id>/<type id>` (the
task is written `task: true` for compatibility). A type whose extension is
gone reads as a plain canvas. See
[Extension Manifest → nodeTypes](Extension-Manifest#nodetypes-16).

## Task

A task is a canvas of the time extension's task type: something time is
tracked against. There is **one active task** at a time. Posting on a task
canvas, pressing Start, or making a block a task (⌘⇧Enter, `#task`, **Make
task**) makes it active; it stays active until you start another or stop.
Locking the machine, going idle or sleeping pauses the clock.

A block with an explicit duration such as `[2h]` or `[45m]` says "the last
two hours were this", and overrides tracked time for that window.

## Todo

A todo is a block of kind `todo`, at any depth. `[ ] Call Dana` posts one.
A panel on the right gathers the open todos for the page on screen and
everything inside it.

## Activity

Alongside blocks, Devlog records what happened on the machine: lock/unlock,
idle, sleep, git events (branches, pushes, merges) and, with extensions,
time-tracking events and the window in front. The **Timeline**, the **Weekly
review**, the **Summary** and the **Timesheet** are drawn from it. See
[Activity and Time Data](Activity-and-Time-Data).

## Devlog, machine, sync

- A **devlog** is one git repository. `devlog.json` at its root names its
  storage format, its extensions and their settings.
- A **machine** is one computer using the devlog. Per-machine data lives in a
  folder named `<host>-<short id>` (`ctx.machine` in the API), so machines
  only ever append to their own files and never conflict.
- **Sync** commits, pulls (rebase) and pushes on a schedule. Nothing is ever
  lost: files are on disk before git sees them.
