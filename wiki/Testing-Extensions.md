# Testing extensions

`@devlog/extension-api/testing` gives you an in-memory `ctx`, so an
extension's logic can be unit-tested without Devlog, Electron or a git
repository. Source:
[`packages/extension-api/src/testing.ts`](https://github.com/sdeken/devlog/blob/main/packages/extension-api/src/testing.ts).

```ts
import { expect, test } from 'vitest'
import { createTestContext } from '@devlog/extension-api/testing'
import * as ext from '../src/main'

test('hello counts', async () => {
  const t = createTestContext({ settings: { greeting: 'Hi' } })
  await ext.activate(t.ctx)
  await t.run('hello')
  await t.run('hello')
  expect(t.notifications).toEqual(['Hi #1', 'Hi #2'])
  expect(new TextDecoder().decode(t.files.local.get('count'))).toBe('2')
})
```

It follows the real rules where they matter to an extension: files are
reached by relative paths only, reads and writes respect the grant you give
it, blocks it adds are marked `meta.ext = <id>`, a kind is only allowed on a
kept canvas, and sending needs a final sheet.

## `createTestContext(options)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | `test.extension` | `ctx.id` |
| `machine` | `string` | `test-machine-0000` | `ctx.machine` |
| `packageDir` | `string \| null` | `null` | `ctx.packageDir` (non-null: as if unrestricted) |
| `canvases` | `TestCanvas[]` | `[]` | Canvases, each with `days: { [date]: ExtensionBlock[] }`. Mutated as the extension adds blocks. |
| `settings` | `Record<string, string>` | `{}` | `ctx.settings` |
| `secrets` | `Record<string, string>` | `{}` | Initial secrets |
| `read` | `string[] \| 'all' \| null` | all | Canvas ids it may read (with what is beneath them) |
| `write` | `string[] \| 'all' \| null` | all | Canvas ids it may write to |
| `activity` | `ActivityRecord[]` | `[]` | What `devlog.activity` answers, filtered to the dates asked for (1.7) |
| `destinations` | `Array<DestinationInfo & { destination }>` | `[]` | Other extensions' destinations it can send through (1.7) |
| `confirm` | `boolean` | `true` | The answer to every `ui.confirm` |
| `now` | `() => Date` | `() => new Date()` | The clock used for block times, dates and file mtimes |

`TestCanvas` is an `ExtensionCanvas` plus optional `days`. Give each test its
own copies (for example with `structuredClone`), since the harness adds
blocks to them.

## What it records

| Property | Contents |
|---|---|
| `ctx` | The `DevlogContext` to pass to `activate` |
| `notifications` | Messages passed to `ui.notify`, in order |
| `confirmations` | Questions passed to `ui.confirm` |
| `added` | `{ canvasId, date, block }` for every `devlog.addBlock` |
| `created` | Ids of canvases made with `devlog.createCanvas` (1.6) |
| `files` | `{ repo, local }`: `Map<path, Uint8Array>` for the two folders |
| `secrets` | `Map<key, value>` |
| `picks` | `{ items, placeholder }` for every `ui.pick` (1.6) |
| `opened` | `ui.open` targets (1.6) |
| `openedPages` | `ui.openPage` view ids (1.7) |
| `app` | `{ trayLabel, keepRunning, idleMinutes, highlight }`: what it asked of the app (1.6) |
| `viewMessages` | `Map<viewId, unknown[]>`: messages sent with `views.post` |

## What it drives

| Method | Does what the app would |
|---|---|
| `run(commandId, context?)` | Runs a registered command with a `CommandContext` (default `source: 'switcher'`); resolves with its return value. |
| `post(canvasId, date, block)` | Someone posted a block in the app: it is added to that day and `onBlockAdded` listeners hear it (1.6). |
| `notice(n)` | Delivers an `ActivityNotice` (pause/resume) to `activity.on` listeners. |
| `setSettings(s)` | Replaces the settings and calls `settings.onChange` listeners. |
| `answerPick` | Assignable: `(items) => id \| null` decides what `ui.pick` returns (default: the first item). |
| `viewCall(viewId, method, ...args)` | Calls a view's handler, as its page would (1.5). |
| `preview(destinationId, sheet)` / `send(destinationId, sheet)` | Calls a registered destination, as the Send dialog would (1.3). |
| `focus(from, to)` | Asks the registered focus provider. |
| `timeEvents(from, to)` | Asks the registered activity provider (1.6). |
| `commands()` | The ids of registered commands. |

## Recipes

### Grants

```ts
const t = createTestContext({ canvases, read: ['acme'], write: [] })
await ext.activate(t.ctx)
await expect(t.run('post', { canvasId: 'acme' })).rejects.toThrow('No write access')
```

### A command on a block

```ts
await t.run('maketask', { source: 'menu', canvasId: 'acme', date: '2026-09-22', blockId: 'b1' })
expect(t.created).toHaveLength(1)
```

### Reacting to posts and pauses

```ts
t.post('task1', '2026-09-22', { id: 'n1', createdAt: '2026-09-22T09:00:00Z', markdown: 'Started on it' })
t.notice({ t: '2026-09-22T09:30:00Z', type: 'pause', reason: 'locked' })
expect(await t.timeEvents('2026-09-22', '2026-09-22')).toMatchObject([{ type: 'task', canvasId: 'task1' }])
```

### Views

```ts
expect(await t.viewCall('status', 'status')).toEqual({ active: null })
await t.run('start', { canvasId: 'task1' })
expect(t.viewMessages.get('status')?.at(-1)).toMatchObject({ active: 'task1' })
```

### A fixed clock

```ts
let clock = new Date('2026-09-22T09:00:00Z')
const t = createTestContext({ now: () => clock })
// …
clock = new Date('2026-09-22T10:00:00Z')
```

### Network calls

Stub `fetch` with your test runner (`vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))`
in Vitest) and assert on the requests.

## Testing in the real host

The harness does not run the sandbox. Devlog's own tests start real
extensions in the real host process: `tests/extensions.test.ts` with the
fixtures in `tests/fixtures/extensions/` (`probe` exercises the API and
checks that the sandbox refuses files, child processes and workers; `shaper`
covers node types and commands; `trusted` runs unrestricted). To try yours in
the app, use the development override described in
[Extension Quickstart → Run it in Devlog](Extension-Quickstart#6-run-it-in-devlog).
