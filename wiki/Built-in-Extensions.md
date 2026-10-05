# Built-in extensions

Four extensions ship inside the app, in
[`builtin-extensions/`](https://github.com/sdeken/devlog/tree/main/builtin-extensions).
They use the same API as anyone else's, so they are the best worked examples.
A devlog enables one with `"<name>": "builtin"` in `devlog.json`; it still
asks before it starts, and keeps its grant when the app updates it.

| Extension | Id | Version | API | Runs | Read it for |
|---|---|---|---|---|---|
| [devlog-time](#devlog-time-time-tracking) | `builtin.devlog-time` | 1.2.0 | `^1.8.0` | sandboxed | Almost everything: node types, commands in menus, keys and the note box, every view placement, a managed canvas, providing time, sending through destinations. TypeScript + `@devlog/ui`. |
| [devlog-focus](#devlog-focus-window-tracking) | `builtin.devlog-focus` | 1.1.0 | `^1.2.0` | unrestricted | A small unrestricted extension with a platform helper, per-machine JSON-lines files, providing focus. |
| [devlog-jira](#devlog-jira-jira-worklogs) | `builtin.devlog-jira` | 1.1.0 | `^1.3.0` | sandboxed | A complete destination: settings, a secret, a canvas field, a `check` command, a ledger, `fetch`. |
| [devlog-cms](#devlog-cms-cms-timesheets) | `builtin.devlog-cms` | 1.0.1 | `^1.3.0` | sandboxed | A destination that drives a web app with no API (form login, HTML parsing). |

## How built-ins are built

A built-in written in plain JavaScript is a folder with
`devlog-extension.json` and `main.js`. One written in TypeScript keeps its
sources in `src/`, and `scripts/build-builtins.mjs` (run by `npm run build`,
`dev`, `package`, `smoke` and `screens`) bundles:

- `src/main.ts` → `dist/main.js` (CommonJS for Node 20, Node built-ins only);
- each `src/views/<view>.tsx` → `dist/views/<view>.{html,js,css}` (one IIFE
  script and one stylesheet, React and `@devlog/ui` included).

`dist/` is not committed and `src/` is not packaged. The same esbuild
settings work for an extension of your own.

## devlog-time (Time tracking)

Everything about time: without it there is no task type, no Start button, no
Timesheet or Summary, and nothing about time is recorded.

| Piece | API used |
|---|---|
| The **task** node type (`◉`, "posting here makes it the active task") | `contributes.nodeTypes` |
| The clock: one active task, paused while locked, idle or asleep; `start`/`task`/`stop` and a heartbeat every five minutes in `extensions/builtin.devlog-time/<machine>/…` (or on the machine only) | `activity.on`, `activity.idleAfter`, `files.repo` / `files.local`, `provide.activity` |
| Posting on a task starts it | `devlog.onBlockAdded` |
| Status bar item, task picker popover, Start/Stop in task headers | `views` (`statusbar`, `popover`, `canvasHeader` with `nodeType: task`), `views.handle` / `post` |
| Stop (`Mod+Shift+.`, tray), Start a task… (tray), Start this task (canvas menu on tasks) | `commands` with `keybinding`, `menus`, `nodeType` |
| Post as task (`Mod+Shift+Enter`, `#task`), **Make task** on a block | `commands` with `post`/`tag` and `menus: ["block"]`; `devlog.promote` |
| New task from the picker | `devlog.createCanvas` with `type` |
| Tray label, sidebar highlight, keep running in the tray | `app.setTrayLabel`, `ui.highlight`, `app.keepRunning` |
| Timesheet and Summary pages (`Mod+Shift+H`) | `views` (`page`), `ui.openPage`, `devlog.activity`, `devlog.range` |
| Corrections to tracked time (**Reassign time…**, and changing tracked entries on the Timesheet): `assign` events in its log | `provide.activity` (1.8) |
| The Timesheets canvas (kept out of the app's lists): one `kind=timesheet` block per week, with your changes beside the entries | `devlog.managedCanvas`, `addBlock` with `kind` and `date`, `editBlock` |
| Sending to Jira or CMS | `permissions.send`, `destinations.list` / `preview` / `send` |
| Hour targets per canvas (weekly, monthly) | `canvasFields` with `inherited: false` |

Settings: `idle_minutes` (pause after this many minutes without input) and
`in_repo` (keep time in the devlog, synced, or on this machine only).

Sources: `src/main.ts` (activation, commands, view handlers), `src/tracker.ts`
(the clock), `src/timesheets.ts` (the Timesheets canvas and sending),
`src/targets.ts`, `src/views/*.tsx`, `src/ui/*.tsx`. Background:
[`docs/TIME-EXTENSION.md`](https://github.com/sdeken/devlog/blob/main/docs/TIME-EXTENSION.md),
[`docs/TIMESHEETS.md`](https://github.com/sdeken/devlog/blob/main/docs/TIMESHEETS.md).

## devlog-focus (Window tracking)

Records which window is in front (app and title) while the machine is
unlocked, for screen time on the timeline and in the review.

- Runs **unrestricted** (asks to be trusted) to start a platform helper:
  PowerShell with `GetForegroundWindow` on Windows, an `osascript` loop on
  macOS (titles need the Accessibility permission), `xdotool` on Linux.
- Appends `{"t","app","title"}` lines to
  `extensions/builtin.devlog-focus/<machine>/YYYY/MM/YYYY-MM-DD.jsonl`
  (`appendOnly: ["**/*.jsonl"]`), nothing while paused.
- Gives the events back through `provide.focus`.

## devlog-jira (Jira worklogs)

A destination (`worklogs`, "Jira"): one worklog per timesheet entry on the
entry's Jira issue.

- Canvas field `issue` (e.g. `ACME-123`), usually on task canvases, inherited
  down the tree.
- Settings `baseurl`, `email`; secret `token`. Basic auth with email and API
  token (Cloud), or a Bearer personal access token with no email (Data
  Center). REST API v2.
- `check` command tests the connection from the settings page.
- Ledger in `extensions/builtin.devlog-jira/sent/<week>.json` (entry id →
  issue, worklog id and what was sent), so sending again sends only
  creates, updates and deletes.
- `permissions.network: ["*.atlassian.net"]`, no read or write grant needed.

## devlog-cms (CMS timesheets)

A destination (`hours`, "CMS") for a consultancy timesheet web app that has
no API, so it drives the web pages:

- form login (`j_security_check`; cookies kept in memory for the send),
  the week page parsed for assignment rows and each day's `timesheet_id`, and
  each day's form submitted with `hrs_worked` in decimal hours;
- hours per assignment (canvas field `assignment`, usually on the client)
  per day; the preview compares with what CMS shows so only differing days
  are sent;
- ledger `sent/<week>.json` (assignment and day → hours) so days it filled
  that no longer have time go back to 0;
- settings `username`, `baseurl`; secret `password`; commands `check` and
  `assignments`.
