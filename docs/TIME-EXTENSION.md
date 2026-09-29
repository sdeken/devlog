# Time tracking as an extension: design

Status: done. Steps 1–3 in 0.17.0 (API 1.6, `devlog-time`, its Start/Stop
views); step 4 (the Timesheet and Summary as its pages, sending through the
app, API 1.7) and step 5 (hour targets) in 0.18.0. What was built follows
this plan with these differences:

- The API stayed 1.x (1.6): everything is additive, so extensions written
  for 1.0–1.5 keep loading.
- The clock's events live in `extensions/builtin.devlog-time/<machine>/`;
  the app keeps logging locks, idle and sleep (and git events) in
  `activity/<machine>/` while an extension provides time, and its views
  replay both together with the older log.
- The Weekly review and the Timeline stay in the app, drawing their time
  from `provide.activity`; the Timesheet and Summary are devlog-time's
  pages, reading what the app recorded through `devlog.activity`.
- A built-in extension keeps its grant when the app brings a new build (it
  is part of the app you updated), so an update never stops the clock.
- Targets are measured against the timesheet hours (reported), the week's
  on screen and, for a month, the other weeks as saved or drafted.
- Quick pick is `ui.pick`; the canvas an extension considers current is
  `ui.highlight` (the sidebar marks it, and commits route to it).

## The idea

Time tracking stops being part of the app. A built-in extension,
`devlog-time`, brings everything that goes with it; without it there is no
task type, no Start button, no timesheet, nothing recorded and no heartbeat
commits.

| Moves to `devlog-time` | Stays in core |
|---|---|
| The **task** node type (icon, label, posting on it starts it) | Canvases, blocks, pages, todos |
| The active task, start/stop, idle/lock/sleep pauses, heartbeats | Notes counts in the Weekly review |
| The status bar Start/Stop, the tray label, the Stop hotkey | The Timeline's notes and git events |
| Post as task (Ctrl+Shift+Enter, `#task`), the Task block action, Make task on a todo | The destination registry (Jira and CMS are fed by the time extension instead of the app) |
| The Timesheet view, the managed Timesheets canvas, Send to… | Canvas fields, settings pages, the sandbox |
| Summary (hours per client), the Weekly review's time columns, task stretches on the Timeline | Machine state (lock, idle, sleep) for now |
| Tracking settings (idle minutes, activity log in the repository) | Git capture for now |

Later, the same way: **machine state** (lock, idle, sleep) becomes its own
extension, separate from both core and `devlog-time`; **git** (commit
capture, branch events) becomes an extension too, for people who don't want
it in their streams.

## Extension API 2.0

1. **Node types:** id, label, icon, a hint for the note box; stored as
   `type:` in canvas.md; a Type choice in canvas properties. `task: true`
   canvases count as the time extension's type when it is present and as
   plain canvases when not; no files rewritten.
2. **Status bar items are rendered, not described:** an item is a small
   view (below) in a slot of fixed height; it asks for a width and may not
   get it. Menus can't fit in the slot, so an item can ask for a **popover**
   anchored to it (another view) or a quick pick.
3. **Quick pick:** the quick-switcher list with items the extension gives.
4. **Keybindings and placements:** a keybinding on a command, optionally
   only on canvases of a given type; items in the canvas right-click menu
   and header; block actions; note-box post variants (Ctrl+Shift+Enter
   becomes the time extension's "post as task").
5. **Events and writes:** "block posted"; creating canvases and setting
   their type; editing blocks the extension wrote (a timesheet save is an
   edit).
6. **System state from the app:** lock, unlock, sleep, wake, idle past N
   minutes. The extension stays sandboxed.
7. **Time providers:** "minutes per canvas per day" and "task stretches for a
   day"; the Weekly review, Timeline and anything else draw their time parts
   from these and hide them when there is no provider.
8. **Views:** an extension ships HTML and script, shown in a sandboxed frame
   with no access to files, talking to its own process through the app.
   The app injects its theme. A shared **`@devlog/ui`** package (React
   components and the app's design tokens) that views bundle, so extensions
   look like the app; each frame carries its own React.
9. **Tray and keeping running:** set the tray label; ask to keep running in
   the tray when the window closes.

## Data

- Existing time lives in `activity/<machine>/` (task switches, locks,
  heartbeats). The extension reads it as history and writes its own events to
  `extensions/builtin.devlog-time/<machine>/` from then on; old files stay.
- Timesheets stay blocks in the managed Timesheets canvas (history in the
  notebook, clean merges); the extension becomes their author.
- Jira and CMS are unchanged; the send flow moves into the time extension's
  view with the app in between.
- Old task-link blocks keep rendering as links without the extension.
- One-time switch: with `trackingEnabled` on, the extension is added and
  allowed, so nothing changes for you.

## Hour targets

Weekly or monthly targets on any node, as canvas fields of the time
extension, shown against actual hours in the timesheet. **Targets overlap
and each applies on its own**: 168 h for Drury in September and 20 h a week
for a task under Drury are two separate measures, each compared with the
hours under its own node for its own period. A target is not inherited by
the nodes below it.

## Order

1. Todos as blocks (`BLOCK-PAGES.md` phase 2): the Task block action and
   Make task on a todo become the same hook.
2. Extension API 2.0, items 1–7 and 9, tested with a small made-up extension.
3. `devlog-time`, built in: tracker, task type, commands and hotkeys; the
   app becomes provider-driven. Tracking leaves core here.
4. Views and `@devlog/ui` (item 8); the timesheet and Summary as the
   extension's pages; status bar items as views; the send flow; smoke rewrite.
5. Hour targets.
