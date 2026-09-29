# Time tracking as an extension

Status: done. Todos became blocks in 0.15.0; views and `@devlog/ui`
(API 1.5) came in 0.16.0; the API 1.6 additions, `devlog-time` and its
Start/Stop views in 0.17.0; the Timesheet and Summary as its pages (API 1.7)
and hour targets in 0.18.0. There was no API 2.0: the additions came as
1.5, 1.6 and 1.7, all additive, so older extensions keep loading.

## What lives where

Time tracking is not part of the app. The built-in extension `devlog-time`
brings everything that goes with it; without it there is no task type, no
Start button, no Timesheet or Summary, and nothing about time is recorded.

| `devlog-time` | The app |
|---|---|
| The **task** node type (icon, label, posting on it starts it) | Canvases, blocks, pages, todos |
| The clock: one active task, paused while locked, idle or asleep, heartbeats | Machine state: it notes lock, idle and sleep, tells extensions, and logs them while an extension provides time |
| The status bar item, the Start/Stop button on task canvases, the task picker, the tray label, Stop (Ctrl+Shift+.) | The Weekly review and the Timeline, drawing their time from the extension's events |
| Post as task (Ctrl+Shift+Enter, `#task`), **Make task** on a block or todo | Git capture (commits as blocks; git events while time is tracked) |
| The Timesheet and Summary pages, the Timesheets canvas, sending through Jira and CMS | The destination registry (Jira and CMS register there; devlog-time sends through the app) |
| Hour targets | Canvas fields, settings pages, the sandbox |
| Its settings: idle minutes, whether its log is synced | |

Later, the same way: **machine state** (lock, idle, sleep) could become its
own extension, and **git** (commit capture, branch events) too, for people
who don't want it in their streams.

## What the API gained

- 1.5: views (pages, status bar items, popovers) and `@devlog/ui`.
- 1.6: node types; commands with keybindings, menus (canvas, block, tray)
  and note-box variants; canvas header views; canvas writes and `promote`;
  block events; pause/resume and idle detection; `ui.pick`, `ui.open`,
  `ui.highlight`; tray label and keep-running; `provide.activity` (time
  events the app replays with its own record of the machine's state).
- 1.7: `devlog.activity` and `devlog.range` (reading what the app recorded
  and the blocks in a range), canvases an extension keeps, sending through
  other extensions' destinations, `ui.openPage`, fields that are not
  inherited.

See `EXTENSIONS.md` for each.

## Data

- The clock's events go to `extensions/builtin.devlog-time/<machine>/`
  (or stay on this machine, with *Keep time in the devlog* off). The app
  logs locks, idle, sleep and git events in `activity/<machine>/` while an
  extension provides time. Time from before 0.17 stays in `activity/`; the
  app replays all of it together.
- Timesheets are blocks in the Timesheets canvas, which devlog-time keeps
  (the canvas the app made before is taken over as it is); it sends through
  the app to the Jira and CMS destinations, which are unchanged.
- Task-link blocks keep rendering as links without the extension, and task
  canvases read as plain canvases.
- One-time switch (0.17): on a machine that tracked time, the extension is
  added to the devlog and allowed, with the active task and idle setting
  carried over. A built-in extension keeps its grant when the app brings a
  new build, so an update never stops the clock.

## Hour targets

Weekly or monthly targets on any canvas, as canvas fields of the time
extension (*Hours per week*, *Hours per month*), shown on the Timesheet
against the timesheet hours (reported) under the canvas for its own period:
the week on screen, and each month the week touches (other weeks as saved,
or as drafted from tracked time). **Targets overlap and each applies on its
own**: 168 h for Globex in September and 20 h a week for a task under Globex
are two separate measures. A target is not inherited by the canvases below
it.
