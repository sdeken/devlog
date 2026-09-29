# Activity and time data

Devlog keeps no clock of its own. The machine's state (locked, idle, asleep)
is the app's; **time** and **window focus** come from extensions. This page
covers the four pieces of API around that:

| API | Direction | Since |
|---|---|---|
| `ctx.activity.on(cb)` | app → extension: pause and resume notices | 1.0 |
| `ctx.activity.idleAfter(minutes)` | extension → app: when to count the machine idle | 1.6 |
| `ctx.provide.activity(fn)` | extension → app views: time-tracking events | 1.6 |
| `ctx.provide.focus(fn)` | extension → app views: window focus events | 1.1 |
| `ctx.devlog.activity(from, to)` | app → extension: everything recorded, merged | 1.7 |

The design is in
[`docs/DESIGN.md` → Time](https://github.com/sdeken/devlog/blob/main/docs/DESIGN.md#time-devlog-time-and-the-activity-log)
and [`docs/TIME-EXTENSION.md`](https://github.com/sdeken/devlog/blob/main/docs/TIME-EXTENSION.md).

## Machine state: pause and resume

```js
ctx.activity.on((n) => {
  if (n.type === 'pause') clock.pause(n.reason, n.t) // 'locked' | 'idle' | 'suspended'
  if (n.type === 'resume') clock.resume(n.t)
})
```

- The app watches Electron's `powerMonitor` (lock/unlock, suspend/resume)
  and polls the system idle state every 15 seconds.
- Pauses are tracked **per reason**: waking from sleep clears only
  "suspended", input after idle clears only "idle", and unlocking clears
  everything. `resume` is sent when no reason is left.
- **Idle detection is opt-in.** Call `ctx.activity.idleAfter(minutes)`; the
  app uses the shortest time any extension asks for (0 means never; at most
  1440). Without any request, idleness never pauses.

```js
const idle = () => Number(ctx.settings.get('idle_minutes') ?? '10')
ctx.activity.idleAfter(idle())
ctx.settings.onChange(() => ctx.activity.idleAfter(idle()))
```

## Providing time: `provide.activity`

An extension that tracks time gives the app its events, and the app's
Timeline, Weekly review, Summary and Timesheet are drawn from them.

```js
ctx.provide.activity(async (fromDate, toDate) => {
  // Every machine's events between two local dates, inclusive.
  const out = []
  for (const date of datesBetween(fromDate, toDate)) {
    for (const f of await ctx.files.repo.list()) {
      if (!f.path.endsWith(`${date}.jsonl`)) continue
      const text = (await ctx.files.repo.readText(f.path)) ?? ''
      for (const line of text.split('\n')) if (line) out.push(JSON.parse(line))
    }
  }
  return out // TimeEvent[]
})
```

`TimeEvent`:

| `type` | Fields | Meaning |
|---|---|---|
| `start` | `canvasId?` | The clock started with the app (and the task it restored). |
| `task` | `canvasId` (or `null`), `blockId?` | The active canvas changed; `null` stops it. |
| `stop` | — | The clock stopped with the app. |
| `heartbeat` | — | Still running. |

Every event carries `t` (ISO) and `machine` (`ctx.machine` where it was
recorded). Events of other types are ignored; so are events without a valid
`t`.

How the app uses them:

- It **replays** your events together with its own record of locks, idle and
  sleep into task segments (task → next task, stop or pause; resumed on
  unpause), per machine, then flattens overlaps between machines (the later
  start wins), so time is never counted twice.
- **Heartbeats are the liveness signal.** A gap of more than two heartbeats
  is read as "the app was not running", so a crash cannot book a weekend.
  devlog-time writes one every five minutes, and none while paused.
- While **any** extension provides time, the app also writes lock/idle/sleep
  and git events to the devlog's `activity/<machine>/…` log. Without one, it
  records nothing about time.
- Explicit durations (`[2h]` on a block) and user corrections (`exclude`
  events) are applied on top.

Keep per-machine logs in per-machine files
(`ctx.files.repo`, `${ctx.machine}/YYYY/MM/YYYY-MM-DD.jsonl`) and declare
them `appendOnly`; machines then never conflict in git.

Also relevant for a time tracker:

- `ctx.ui.highlight(canvasId)`: mark the running task in the sidebar;
  commits from a linked repository then land on it when it sits inside the
  linked canvas.
- `ctx.app.keepRunning(true)`: time accrues only while Devlog runs, so close
  to the tray instead of quitting.
- `ctx.app.setTrayLabel(label)`: show the running task in the tray.
- `ctx.devlog.onBlockAdded(cb)`: devlog-time starts a task when the user
  posts on it.

## Providing focus: `provide.focus`

```js
ctx.provide.focus(async (fromDate, toDate) => readFocusLog(fromDate, toDate)) // FocusEvent[]
```

`FocusEvent` is `{ t, app, title, machine }`: the window that came to the
front. The app cleans the stream for its views (drops shell windows such as
the task switcher, folds flips shorter than a few seconds, merges repeats)
but you should record it raw. `app` is cut to 200 characters and `title` to
1000.

Reading the foreground window needs a platform helper, which the sandbox
forbids, so a focus provider normally runs **unrestricted**. devlog-focus is
the complete example (see [Built-in Extensions](Built-in-Extensions)).

## Reading it back: `devlog.activity` (1.7)

```js
const records = await ctx.devlog.activity('2026-09-21', '2026-09-27')
const tracked = records.filter((r) => r.type === 'task')
```

Returns the app's own log merged with what providers return (time and
focus), as `ActivityRecord`s. Filtered by the grant:

- needs a read grant (`No read access` otherwise);
- events on canvases it may not read show `canvasId: null` (git events on
  them are dropped);
- `focus` events only with read access to the whole devlog;
- at most 400 days per call.

Providers have 20 seconds to answer and at most 500 000 events per call are
used. A provider that throws is logged and skipped; the views show what the
others gave.
