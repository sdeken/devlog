# Timesheet destinations

A **destination** (API 1.3) is somewhere a finished weekly timesheet can be
sent: Jira worklogs, a CMS timesheet, an invoicing system, a CSV file. The
time extension (devlog-time) builds the timesheet; a destination extension
turns its entries into lines in the external system.

Two roles:

| Role | Needs | API |
|---|---|---|
| **Destination**: receives a week and sends it on | `contributes.destinations` | `ctx.destinations.register(id, { preview, send })` (1.3) |
| **Sender**: hands a week to destinations | `permissions.send` | `ctx.destinations.list()`, `preview(to, sheet)`, `send(to, sheet)` (1.7) |

devlog-jira and devlog-cms are destinations; devlog-time is the sender.
The full timesheet design (rounding, trims, storage) is in
[`docs/TIMESHEETS.md`](https://github.com/sdeken/devlog/blob/main/docs/TIMESHEETS.md).

## The flow

```
devlog-time Timesheet page
   │  user presses Send → picks a destination
   ▼
ctx.destinations.preview(to, sheet)  ──► app builds a DestinationSheet for that
                                          extension (labels + its canvas fields)
                                     ──► destination.preview(sheet) → DestinationLine[]
   │  user reviews the preview, confirms
   ▼
ctx.destinations.send(to, sheet)     ──► app refuses unless status === 'final'
                                     ──► destination.send(sheet) → SendResult
   │
   ▼
devlog-time writes "Sent to Jira: …" under the week's timesheet block
```

**Pressing Send is the user's consent for that week's entries**, so a
destination needs **no read grant**: everything it needs is in the sheet.

## Writing a destination

### 1. Declare it, and the fields it maps by

```json
{
  "name": "devlog-invoicer",
  "displayName": "Invoicer",
  "version": "1.0.0",
  "api": "^1.3.0",
  "main": "main.js",
  "contributes": {
    "destinations": [{ "id": "hours", "label": "Invoicer" }],
    "canvasFields": [{ "key": "project", "label": "Invoicer project id", "placeholder": "P-1042" }],
    "settings": [{ "key": "baseurl", "label": "Invoicer address", "type": "url", "required": true }],
    "secrets": [{ "key": "token", "label": "API token", "required": true }],
    "commands": [{ "id": "check", "label": "Check the Invoicer connection" }],
    "check": "check"
  },
  "permissions": { "network": ["invoicer.example.com"] }
}
```

The user sets the canvas field on the canvases that map to something (a
client, a project, a task); canvases inside inherit it.

### 2. Register it

```js
exports.activate = async (ctx) => {
  ctx.destinations.register('hours', {
    async preview(sheet) {
      return plan(sheet, await readLedger(ctx, sheet.week))
    },
    async send(sheet) {
      const ledger = await readLedger(ctx, sheet.week)
      const done = []
      const failed = []
      for (const line of plan(sheet, ledger)) {
        if (line.action === 'skip' || line.action === 'unchanged') continue
        try {
          ledger[line.id] = await push(ctx, line)       // your API call
          done.push(line.id)
        } catch (err) {
          failed.push({ lineId: line.id, error: err.message })
        }
      }
      await ctx.files.repo.write(`sent/${sheet.week}.json`, JSON.stringify(ledger, null, 2) + '\n')
      return { done, failed, summary: `${done.length} lines sent${failed.length ? `, ${failed.length} failed` : ''}` }
    }
  })
}

async function readLedger(ctx, week) {
  return JSON.parse((await ctx.files.repo.readText(`sent/${week}.json`)) ?? '{}')
}

function plan(sheet, ledger) {
  return sheet.entries.map((e) => {
    const project = e.fields.project // inherited from the nearest canvas that sets it
    const base = { id: e.id, entryIds: [e.id], date: e.date, start: e.start, minutes: e.minutes, target: project ?? '', description: e.note }
    if (!project) return { ...base, action: 'skip', reason: `No Invoicer project on ${e.task}` }
    const prev = ledger[e.id]
    if (!prev) return { ...base, action: 'create' }
    return { ...base, action: prev.minutes === e.minutes && prev.project === project ? 'unchanged' : 'update' }
  })
}
```

### What the destination receives: `DestinationSheet`

```ts
{
  week: '2026-09-21',            // the Monday
  status: 'final',               // send() is only ever called with 'final'
  entries: [{
    id: 'e3',                    // stable within the week: key your ledger by it
    date: '2026-09-22',
    start: '2026-09-22T07:00:00.000Z', // on a local quarter hour
    minutes: 90,                 // a multiple of 15
    note: 'Login bug',
    canvasId: 'k3m9x2q7vd',
    task: 'Acme / Website / Login bug',
    client: 'Acme',
    fields: { project: 'P-1042' } // this extension's canvas fields, inherited
  }]
}
```

### What it returns

- `preview(sheet)` → `DestinationLine[]`: one line per thing it would do
  (`create`, `update`, `delete`, `unchanged`, or `skip` with a `reason`),
  each listing the `entryIds` it covers. Lines with other actions or without
  an `id` are dropped; `description` is cut to 500 characters, `reason` to
  300. Preview must not change anything.
- `send(sheet)` → `SendResult`: `done` (line ids that went through),
  `failed` (`{ lineId, error }`), and a one-sentence `summary` for the record
  ("3 worklogs created, 1 updated"). Errors and the summary are cut to 500
  characters.

Throwing from either shows the error in the Send dialog. Preview has 2
minutes, send 10.

### Keep a ledger

The app does not remember what was sent; **each destination keeps its own
ledger** in `ctx.files.repo` (synced), keyed by entry id (or by whatever its
lines are). That makes sending idempotent:

- pressing Send twice, or on a second machine, sends only what changed;
- a correction after the fact becomes an `update`;
- an entry that disappeared becomes a `delete` (walk the ledger for ids no
  longer in the sheet).

devlog-jira's ledger is `sent/<week>.json`: entry id → issue, worklog id and
what was sent. devlog-cms keys by assignment and day, and compares with what
CMS shows.

## Sending through destinations (1.7)

An extension with `"permissions": { "send": true }` can drive destinations
itself, as devlog-time's Timesheet page does:

```js
const dests = await ctx.destinations.list()
// [{ extension: 'devlog-jira', from: 'Jira worklogs', id: 'worklogs', label: 'Jira' }, …]

const to = { extension: dests[0].extension, id: dests[0].id }
const sheet = {
  week: '2026-09-21',
  status: 'final',
  entries: [{ id: 'e1', date: '2026-09-22', start: '2026-09-22T07:00:00.000Z', minutes: 90, canvasId: 'k3m9x2q7vd', note: 'Login bug' }]
}
const lines = await ctx.destinations.preview(to, sheet)
const result = await ctx.destinations.send(to, sheet) // only for status 'final'
```

- `to.extension` is the destination extension's **devlog.json key** (as
  `list()` returns it), not its id.
- The app validates the sheet (the week must be a Monday, every entry's date
  inside it) and builds each destination's `DestinationSheet` from it, adding
  labels and that destination's own canvas fields.
- `send` throws `Mark the timesheet final before sending it` for a draft,
  and `… is not ready to send` if the destination extension is not running.
- Without `permissions.send`: `Sending through destinations needs
  "permissions": { "send": true }`.

## Testing a destination

```ts
import { createTestContext } from '@devlog/extension-api/testing'
import * as ext from '../src/main'

const t = createTestContext({ settings: { baseurl: 'https://invoicer.example.com' }, secrets: { token: 'x' } })
await ext.activate(t.ctx)
const lines = await t.preview('hours', { week: '2026-09-21', status: 'final', entries: [/* DestinationEntry[] */] })
expect(lines.map((l) => l.action)).toEqual(['create', 'skip'])
const res = await t.send('hours', { week: '2026-09-21', status: 'final', entries: [/* … */] })
expect(t.files.repo.has('sent/2026-09-21.json')).toBe(true)
```

Mock `fetch` (`vi.stubGlobal('fetch', …)`) for the network calls. See
[Testing Extensions](Testing-Extensions).
