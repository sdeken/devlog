# Extension types

Every type an extension sees, from
[`packages/extension-api/src/index.ts`](https://github.com/sdeken/devlog/blob/main/packages/extension-api/src/index.ts)
(`@devlog/extension-api`) and
[`view.ts`](https://github.com/sdeken/devlog/blob/main/packages/extension-api/src/view.ts)
(`@devlog/extension-api/view`). All of them are plain data; times are ISO-8601
strings and dates are local `YYYY-MM-DD`.

```ts
import type { DevlogContext, ExtensionCanvas, ExtensionBlock } from '@devlog/extension-api'
import { API_VERSION } from '@devlog/extension-api' // '1.8.0'
```

## Canvases and blocks

### `ExtensionCanvas`

```ts
interface ExtensionCanvas {
  id: string
  title: string
  parentId: string | null
  task: boolean
  type?: string                       // (1.6) "<extension id>/<type id>"
  archived: boolean
  fields: Record<string, string>      // this extension's own canvas fields set on this canvas
}
```

| Field | Meaning |
|---|---|
| `id` | Stable random id; renames and moves keep it. |
| `parentId` | The enclosing canvas, or `null` at the top level. |
| `task` | Whether it is devlog-time's task type (same as `type === 'builtin.devlog-time/task'`). |
| `type` | Its node type, if any. |
| `fields` | Keys as declared in `contributes.canvasFields`, values set **on this canvas** only (use `devlog.field` for the inherited value). |

### `ExtensionBlock`

```ts
interface ExtensionBlock {
  id: string
  createdAt: string
  updatedAt?: string
  markdown: string
  parentId?: string
  kind?: string
  hidden?: boolean
  meta?: Record<string, string>
}
```

| Field | Meaning |
|---|---|
| `id` | Unique within its day file. |
| `createdAt` / `updatedAt` | When written, and last edited. |
| `markdown` | The text. Image sources are repo-root-relative (`canvases/k3/k3m9x2q7vd/entries/2026/09/assets/x.png`). |
| `parentId` | The block it sits inside, if any. |
| `kind` | Absent for a note; else `commit`, `task`, `todo`, `done`, `timesheet`, or an extension's own kind on a canvas it keeps. |
| `hidden` | Collapsed in the stream (still there, still searchable). |
| `meta` | Attributes: `ext` (the extension that wrote it), `canvas` (a task block's canvas), `done` (when a todo was ticked), `repo`/`hash`/`branch`/`author` (commits), and whatever an extension set. |

### `ExtensionTodo` (1.4)

```ts
interface ExtensionTodo {
  canvasId: string
  date: string                               // the day file it lives in
  block: ExtensionBlock                      // kind: 'todo'; meta.done once ticked
  trail: Array<{ id: string; title: string }> // blocks it sits inside, outermost first
}
```

### `ExtensionDayBlocks` (1.7)

```ts
interface ExtensionDayBlocks { canvasId: string; date: string; blocks: ExtensionBlock[] }
```

### `ExtensionSearchResult`

```ts
interface ExtensionSearchResult {
  blocks: Array<{ canvasId: string; date: string; block: ExtensionBlock }>
}
```

## Inputs

### `AddBlockOptions` (1.4, 1.7)

```ts
interface AddBlockOptions {
  meta?: Record<string, string>
  parentId?: string   // add inside this block (needs date)
  date?: string       // the parent's day file; or, on a kept canvas, any day
  todo?: boolean      // add as a todo
  kind?: string       // on a kept canvas: its own kind
}
```

### `NewCanvas` (1.6)

```ts
interface NewCanvas { title: string; parentId?: string | null; type?: string }
```

### `CanvasPatch` (1.6)

```ts
interface CanvasPatch {
  title?: string
  parentId?: string | null
  type?: string | null     // one of its own types, or null for a plain canvas
  archived?: boolean
}
```

### `PickItem` (1.6)

```ts
interface PickItem { id: string; label: string; hint?: string }
```

## Commands and events

### `CommandContext` (1.6)

```ts
interface CommandContext {
  source: 'switcher' | 'keybinding' | 'menu' | 'post' | 'view' | 'tray'
  canvasId?: string   // the canvas on screen, or the one whose menu it was
  date?: string       // with blockId: the block's day file
  blockId?: string    // the block whose menu it was, the page on screen, or the block just posted
}
```

`date` and `blockId` are given only when the extension may read `canvasId`.

### `BlockAddedEvent` (1.6)

```ts
interface BlockAddedEvent { canvasId: string; date: string; block: ExtensionBlock }
```

### `ActivityNotice`

```ts
interface ActivityNotice {
  t: string
  type: 'pause' | 'resume' | 'task'
  reason?: 'locked' | 'idle' | 'suspended'
  canvasId?: string | null
}
```

`task` notices came from the app's own tracker before 1.6 and are no longer
sent now that time tracking is an extension.

## Activity and time

### `ActivityRecord` (1.7)

What `devlog.activity` returns.

```ts
interface ActivityRecord {
  t: string
  type: 'start' | 'stop' | 'heartbeat' | 'lock' | 'unlock' | 'idle' | 'active'
      | 'suspend' | 'resume' | 'task' | 'focus' | 'git' | 'exclude' | 'assign'
  canvasId?: string | null
  entryId?: string
  app?: string; title?: string                                   // focus
  repo?: string; action?: string; branch?: string; from?: string; detail?: string // git
  start?: string; end?: string; id?: string; cancels?: string     // exclude, assign
  at?: string                                                    // assign (1.8): when it was made
  machine?: string
}
```

| `type` | Meaning |
|---|---|
| `start` / `stop` | The clock started or stopped with the app (from a time provider). |
| `task` | The active task changed (`canvasId`, or `null`: stopped). |
| `heartbeat` | Still running (the app counts time up to the last one when a log just ends). |
| `lock` / `unlock` | Screen locked / unlocked. |
| `idle` / `active` | No input for the idle threshold / input again. |
| `suspend` / `resume` | Sleep / wake. |
| `focus` | The window in front changed (`app`, `title`). |
| `git` | Something in a linked repository: `action` is `commit`, `branch`, `checkout`, `push`, `merge`, `rebase`, `pull`, `stash` or `reset`. |
| `exclude` | A correction from the review: no task time between `start` and `end`; or undoes the exclusion whose id is `cancels`. |
| `assign` (1.8) | A correction from a time provider: the time between `start` and `end` was `canvasId` (`null`: not worked); or undoes the one whose id is `cancels`. Later ones (by `at`) win. |

### `TimeEvent` (1.6, 1.8)

What a time provider returns.

```ts
interface TimeEvent {
  t: string                  // for assign: the window's start
  type: 'start' | 'task' | 'stop' | 'heartbeat' | 'assign'
  canvasId?: string | null   // task/start: the active canvas; assign: what the window was (null: not worked)
  blockId?: string           // the block that started it, if one did
  machine: string            // ctx.machine where it was recorded
  start?: string; end?: string; id?: string // assign (1.8): the window and its id
  at?: string                // assign: when the correction was made
  cancels?: string           // assign: undoes the correction with this id
}
```

### `FocusEvent` (1.1)

What a focus provider returns.

```ts
interface FocusEvent { t: string; app: string; title: string; machine: string }
```

## Destinations

### `DestinationSheet` (1.3)

What a destination receives.

```ts
interface DestinationSheet {
  week: string                // the Monday, YYYY-MM-DD
  status: 'draft' | 'final'
  entries: DestinationEntry[]
}
```

### `DestinationEntry` (1.3)

```ts
interface DestinationEntry {
  id: string                    // stable within the week's timesheet
  date: string
  start: string                 // ISO, on a local quarter hour
  minutes: number               // a multiple of 15
  note?: string
  canvasId: string
  task: string                  // "Client / Project / Task"
  client: string                // the top-level canvas's title
  fields: Record<string, string> // this extension's canvas fields, inherited
}
```

### `DestinationLine` (1.3)

One line of what a destination would do.

```ts
interface DestinationLine {
  id: string
  entryIds: string[]      // the timesheet entries it covers
  date: string
  start?: string
  minutes: number
  target: string          // an issue key, an assignment…
  description?: string
  action: 'create' | 'update' | 'delete' | 'unchanged' | 'skip'
  reason?: string         // why, for skip
}
```

### `SendResult` (1.3)

```ts
interface SendResult {
  done: string[]                                  // line ids that went through
  failed: Array<{ lineId: string; error: string }>
  summary: string                                 // "3 worklogs created, 1 updated"
}
```

### `Destination` (1.3)

```ts
interface Destination {
  preview(sheet: DestinationSheet): Promise<DestinationLine[]>
  send(sheet: DestinationSheet): Promise<SendResult>
}
```

### `DestinationInfo` (1.7)

```ts
interface DestinationInfo {
  extension: string   // the extension's devlog.json key
  from: string        // its display name
  id: string
  label: string
}
```

### `SheetToSend` (1.7)

What a sender passes to `destinations.preview` / `send`; the app turns it
into each destination's `DestinationSheet`.

```ts
interface SheetToSend {
  week: string
  status: 'draft' | 'final'
  entries: Array<{
    id: string; date: string; start: string; minutes: number; canvasId: string
    note?: string; worked?: number; source?: string
  }>
}
```

## Files

### `ExtensionFileInfo`

```ts
interface ExtensionFileInfo { path: string; size: number; mtime: string }
```

### `ExtensionFiles`

```ts
interface ExtensionFiles {
  read(path: string): Promise<Uint8Array | undefined>
  readText(path: string): Promise<string | undefined>
  write(path: string, data: string | Uint8Array): Promise<void>
  append(path: string, text: string): Promise<void>
  list(dir?: string): Promise<ExtensionFileInfo[]>
  stat(path: string): Promise<ExtensionFileInfo | undefined>
  remove(path: string): Promise<void>
}
```

## Views (`@devlog/extension-api/view`)

### `ViewContext` (1.6)

```ts
interface ViewContext { canvasId?: string; date?: string; blockId?: string }
```

### `ViewToApp` and `AppToView`

The `postMessage` messages between a view and the app; every message carries
`devlog: 1`. Listed in full in
[Views and UI → Message protocol](Views-and-UI#message-protocol).

## The context

`DevlogContext` is the `ctx` passed to `activate`; see
[Extension API Reference](Extension-API-Reference). `ExtensionModule` is the
shape of `main.js`'s exports:

```ts
interface ExtensionModule {
  activate(ctx: DevlogContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```
