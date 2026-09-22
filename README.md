# Devlog

A desktop app for keeping a running developer log. Posts are written in a
Slack-style WYSIWYG Markdown composer, stored as plain Markdown files in a git
repository, and committed and pushed automatically.

Three words cover the model. A **canvas** is anything you write about: a
client, a project, a topic, a task. Every canvas has a *surface* (free
markdown: links, how-tos, a research scratchpad) and a *stream* of dated
**blocks**. Canvases nest. A canvas marked as a **task** is something time is
tracked against; any block can become one.

- **WYSIWYG Markdown, no chrome.** Bold, italic, strikethrough, inline code,
  syntax-highlighted code blocks, lists, quotes, headings and links render as
  you type, with the usual shortcuts (`**bold**`, `- ` for a list, ```` ```ts ````
  for a code block, ⌘B / ⌘I / ⌘K…). The composer is a bare input: the only
  formatting UI is a small bubble menu that appears when you select text.
  Enter posts, Shift+Enter starts a new line.
- **Every block is a node.** Reply to a block to start a thread, hover
  between two blocks and press **+** to insert one there, double-click a
  block (or press ↑ in the empty composer) to edit it. Blocks on past days
  work the same way.
- **Canvases nest however you slice your work.** Besides the journal, make a
  canvas per client, with project canvases inside it, with task canvases
  inside those; or flatter, or deeper. The sidebar is the tree. "Website"
  under two clients is two different canvases. Blocks can be moved between
  canvases, and search covers all of them.
- **Every canvas has a surface.** Above the stream sits free-form markdown
  that is not a dated note: links to the issue tracker, environments,
  contacts, credentials, how-tos, or the evolving write-up of whatever you are
  researching. It opens read-only so links just work; **Edit surface** (or a
  double-click) turns it into the editor, which saves as you type.
- **Notes are notes until you say otherwise.** Posting on a client or
  project canvas is just a note. A block becomes a **task** with
  ⌘⇧Enter, with `#task` anywhere on its first line, or with the **Task**
  action on hover: Devlog creates a task canvas beneath the current one,
  titled from the block, links the block to it, and starts the clock. The
  task canvas has its own surface and stream for everything that follows.
- **One active task, tracked for you.** Posting on a task canvas (or
  pressing **Start** in its header) makes it the active task; it stays active
  until you post on another task, press Stop, lock the machine, go idle or
  sleep. Devlog keeps running in the tray to watch. A block with an explicit
  duration like `[2h]` or `[45m]` overrides tracking for that window when
  you know better.
- **Archive what you're done with.** Archive a canvas, with everything
  beneath it, to get it out of the sidebar. Archived things stay readable
  and searchable, and one click brings them back.
- **Activity timeline.** Alongside your notes, Devlog records lock/unlock,
  idle, sleep and which window was in front (app and title, so a browser tab
  or a Teams call shows up). A per-day **Timeline** view lays it all out next
  to your notes; the weekly review adds screen time by kind (coding, meetings,
  browser…).
- **Commits become blocks, branches become events.** Map a canvas to the git
  repositories you use for it and every commit you make there is added to the
  canvas as a read-only block you can reply to, move or delete. Creating or
  switching branches, pushing, merging, rebasing and stashing show up on the
  timeline without cluttering the stream.
- **Weekly review and summary.** The review rolls the week up by day and by
  client → project → task with tracked time, plus a per-day breakdown of what
  you wrote, task time and screen time. The **Summary** view answers the
  timesheet question directly: hours per client for any range, rounded to
  the nearest 15 minutes (or whatever you set), with projects and tasks one
  click away. Made for Friday.
- **Pasted evidence just works.** Paste or drop an image into the composer
  and it is saved into the repository next to the day's entry and linked
  relatively, so the log also renders on GitHub; click an image in the feed to
  see it full size. Paste a stack trace, a diff, a log excerpt or a shell
  session and it lands in a code block instead of being mangled into
  paragraphs.
- **Jot from anywhere.** The composer stays at the bottom of every view, with
  a picker for which canvas the block goes to, and ⌘P / ⌘K opens a quick
  switcher that jumps to any canvas or view by fuzzy name.
- **Its own chrome.** No menu bar: the app draws the title bar Slack-style,
  with a hamburger menu on the left and search in the middle. Pick a colour
  theme in Settings (Graphite by default; Ocean, Forest, Ember, Aubergine,
  Paper) or set your own sidebar and accent colours; everything else is
  derived from those two.
- **Updates itself.** Releases are checked for in the background, downloaded
  silently, and installed by restarting at a quiet moment (screen locked,
  window hidden, or input idle), never mid-edit and never with a dialog.
- **Git is the database.** One Markdown file per day, one folder per month.
  Nothing proprietary: the repo is readable and editable with any tool.
- **Automatic save, commit and push.** Every post is written to disk
  immediately, committed shortly afterwards, and pushed on a schedule and when
  the app quits. If another machine pushed first, the app pulls and rebases
  before pushing.

## Getting started

Requirements: Node 20+, and `git` on your PATH. Pushing uses whatever
credentials git already has (SSH agent, credential helper).

```sh
npm install
npm run dev        # run with hot reload
npm run build      # production build into out/
npm run package    # build installers into release/ (mac/win/linux variants exist too)
```

On first launch choose **Create a new devlog** (picks a folder, runs
`git init`, makes the first commit; optionally set a remote) or **Open an
existing devlog** (a clone from another machine).

## Repository layout

```
README.md
entries/                          ← the journal
  2026/
    09/
      2026-09-19.md
      assets/
        2026-09-19-143201-a1b2.png
canvases/
  acme-corp/                      ← a canvas (a client)
    canvas.md                     ← title, parent, task flag, repos, archived flag + the surface
    assets/                       ← images pasted into the surface
    entries/2026/09/2026-09-19.md ← its stream, same day-file format
  website/                        ← another canvas, parent: acme-corp
    canvas.md
    entries/…
  fix-the-login-redirect/         ← a task canvas, parent: website
    canvas.md                     ← task: true
    entries/…
```

Canvas folders are flat and named by a slug of the title (made unique with
`-2`, `-3`…); the hierarchy is the `parent` line in `canvas.md`, so renaming
or moving a canvas never moves files or breaks history. `canvas.md` is a
short front-matter block followed by the surface:

```markdown
---
title: Website
parent: acme-corp
created: 2026-09-19T10:00:00.000Z
repo: C:\src\acme-site
---

Marketing site rebuild. Weekly sync on Tuesdays.

- Tracker: https://issues.example.com/acme
```

A devlog written by Devlog 0.2 (with `pages/` and `categories/`) is migrated
into this layout the first time it is opened; nothing is thrown away.

## Canvases, surfaces and tasks

Click a canvas in the sidebar to open it. The header shows its breadcrumbs,
the canvases inside it as chips, and actions: **Edit** (rename, move under
another canvas, mark as a task, repositories), **Archive**, and for tasks
**Start** / **Stop**.

The **surface** sits above the stream. It opens rendered: links open in the
browser, images open full size. **Add surface** / **Edit surface** (or a
double-click) switches to a full-height editor with the same Markdown and
image support as blocks, but no posting: Enter is just a new line and every
change is saved a moment later (the header says "Saved"); **Done** switches
back. Surfaces are searched along with blocks.

A **task** is a canvas with the task flag. Three ways to make one from a
block you are writing or have written:

- press ⌘⇧Enter instead of Enter when posting,
- put `#task` anywhere on the block's first line (it is stripped on save),
- hover an existing block and choose **Task**.

Each creates a task canvas beneath the block's canvas (top-level for journal
blocks), titled from the block's first sentence, marks the block as the link
to it (a chip opens the task), and makes it the active task. Blocks inside a
task canvas can be anything: more notes, pasted evidence, further tasks. A
canvas can also be flagged as a task, or unflagged, in **Edit**.

Like everything else in the repository, canvases are plain files; treat the
repository as sensitive, because it is.

## Archiving

**Archive** in a canvas header hides the canvas and everything beneath it
from the sidebar. They keep their blocks, stay searchable (results are marked
"archived"), can still be opened and read, and come back with **Unarchive**.
Archived canvases cannot become the active task or receive commits. The
sidebar's collapsible **Archived** section lists everything archived so it is
never lost.

## Time tracking

There is one active task at a time, and a task is a canvas with the task
flag. The workflow: write a line or two to wrap up what you were doing, then
either post on the task you are picking up (that makes it active), press
**Start** in its header, or write the next thing as a new block and post it
with ⌘⇧Enter so it becomes a task of its own. The status bar shows the active
task with a running clock and a **Stop** button (also ⌘⇧. and in the tray
menu). Posting on the journal or on a canvas that is not a task never
touches the clock: those are just notes.

Time stops accruing while the screen is locked, the machine sleeps, or there
has been no input for a while (default 10 minutes, adjustable), and resumes on
the same task afterwards. Quitting Devlog stops the clock, so it keeps
running in the tray when you close the window.

When you know better than the tracker, say so in the block: `[2h] Acme sync`
or `[45m] code review` counts exactly that much for the block's canvas,
ending at the block's time, and replaces whatever was tracked in that window.
Such blocks do not switch the active task.

Window tracking records every focus change, and if you alt-tab a lot that is
a lot of sub-second flips. The raw log keeps all of them; the views clean
them up: the Windows task switcher, Start menu, search box, lock screen and
the like are dropped outright, and any focus shorter than a threshold
(**Settings → Ignore window switches shorter than**, default 5 seconds) is
folded into the window you were actually working in. So a 20-minute Outlook
session that you alt-tabbed out of and back into five times shows as 20
minutes of Outlook.

Everything the tracker sees goes to an append-only activity log, one JSON
file per day (`activity/YYYY/MM/YYYY-MM-DD.jsonl`). By default it lives in the
app's data folder; Settings can move it into the devlog repository so it syncs
(window titles included, so consider what they contain). Recorded events:
task switches, lock/unlock, idle/active, sleep/wake, app start/stop, a
heartbeat, foreground-window changes (process name and window title, which
for browsers is the active tab), and git events from watched repositories. Focus tracking uses a small PowerShell helper
on Windows, `osascript` on macOS (window titles need the Accessibility
permission) and `xdotool` on Linux if present.

## Working copies: commits as blocks, branches as events

Give a canvas its repositories (**Edit → Git repositories**); these are the
working copies you code in, not the devlog repository. Devlog watches each
repository's reflogs and, on every commit, adds a read-only block to the
canvas: repo, branch, short hash and message. Reply to it, move it or delete
it, but not edit it.

Everything else git records is captured as an activity event rather than a
block, so the stream stays readable: creating a branch, switching branches
(with where from), pushing, merging, rebasing, pulling, resetting and
stashing. They appear on the day's Timeline with the repo name. Commits in
the devlog repository itself are ignored.

## Weekly review

**Weekly review** in the sidebar (⌘⇧R) shows a Monday–Sunday grid: one row
per top-level canvas (client), nested rows for the canvases beneath it
(projects, tasks), one column per day, and a week total. Each cell shows
tracked time and the number of blocks. Below the grid, every day is broken
down by client → project → task with the blocks you wrote, the task time
segments, and screen time by kind (coding, terminal, meetings, email & chat,
browser) and by app.

Days with no tracking data at all are marked `~` and estimated from note
timestamps instead (each note counts until the next one, capped at an hour).

## Summary

**Summary** (⌘⇧H) is the timesheet view: one row per top-level canvas
(client) with hours for the chosen range (this week, last week, this month,
last month, or any two dates), a share bar, the block count and the exact
tracked minutes. Hours are rounded to the nearest 15 minutes by default;
change the granularity in the header and it is remembered. Expand a client to
see its projects and tasks rounded the same way; click a name to open the
canvas. Rounding happens per row, so the rounded rows may not add up to the
rounded total.

## Timeline

**Timeline** (⌘⇧T) shows one day sliced into fixed intervals (5, 15, 30 or 60
minutes, your choice). Each interval shows the task that was active, the notes
and captured commits written in it, git events from watched repositories
(branch created, switched, pushed…), system events such as lock or sleep, and
the apps that were in front with minutes each; click the app chips to see the
window titles behind them. Quiet intervals are collapsed into a "nothing
recorded" line. Click a block to open it on its canvas.

A day file looks like this:

```markdown
# 2026-09-19

<!-- devlog:entry id=k3j9d2ab created=2026-09-19T14:32:01.000Z -->
### 14:32

Started on the git sync. Pull before push, rebase on conflicts.

![shot](assets/2026-09-19-143201-a1b2.png)

<!-- devlog:entry id=p0q1r2s3 parent=k3j9d2ab created=2026-09-19T15:02:00.000Z -->
#### ↳ 15:02

A reply in the thread under the first note.

<!-- devlog:entry id=q8v1m0zz created=2026-09-19T17:45:00.000Z updated=2026-09-19T17:50:12.000Z -->
### 17:45

Done. **Ship it.**
```

The HTML comment carries each block's id, optional `parent`, kind
(`commit`, or `task` with the task canvas's id) and timestamps, and is
invisible when rendered; the time heading is regenerated from the timestamp
(`↳` and a deeper heading level mark replies). File order is display order,
so inserted blocks stay where you put them.

## Sync behaviour

| Trigger                       | What happens                                                  |
| ----------------------------- | ------------------------------------------------------------- |
| Post / edit / delete / paste  | File written immediately; a commit is scheduled (default 30s) |
| Every N minutes (default 5)   | Commit if dirty, fetch, pull `--rebase` if behind, push        |
| **Sync now** (⌘⇧S)            | Same, immediately                                             |
| App start                     | Pull (if a remote is configured)                              |
| App quit                      | Commit and push pending changes (up to 20s)                   |

The status bar shows the current state (uncommitted changes, committing,
pushing, up to date, error) and the branch. Errors such as a failed push are
shown and retried on the next tick; nothing is ever lost because the files are
already on disk.

All settings (sync interval, debounce, push/pull toggles, commit author,
remote URL) live under **Settings** (⌘,).

## Updates and releases

Installed builds check GitHub Releases shortly after launch and every four
hours, download a newer version in the background, and restart into it when
the app is not in use: the screen is locked, the window is hidden or
unfocused and there has been no input for a while, or an update has been
waiting for a day and you pause typing. An open edit, reply, insert or an
unsaved surface change always holds the restart. There is no prompt; Settings
shows the version and update state and has a switch to turn it off. The
active task survives the restart, so tracking loses only a few seconds.

To cut a release, bump the version and tag it:

```sh
npm version minor      # or patch / major; commits and tags vX.Y.Z
git push --follow-tags
```

CI then runs typecheck, unit tests, the build and the Playwright smoke test;
only if all pass does it package Windows and macOS builds and publish a GitHub
release with the installers and the `latest*.yml` manifests that installed
apps read. macOS apps must be code-signed for auto-update to apply; unsigned
macOS builds still run but will not self-update.

## Development

```sh
npm run typecheck   # main + renderer
npm test            # unit tests: file format, store, git sync (uses a local bare remote)
npm run smoke       # builds, then drives the real app with Playwright (needs a display; use xvfb-run on Linux)
npm run screens     # builds, seeds a demo devlog and screenshots every view in light and dark mode
```

The window remembers its size and position, closes to the tray while tracking
is on, and shows the current canvas in its title. Failed background actions
(a move, an archive, a sync) surface as a toast in the corner rather than
disappearing into the console.

Code map:

| Path                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `src/shared/entries.ts`           | Day-file format: parse/serialize, path helpers, image rewriting |
| `src/shared/canvases.ts`          | Canvas files, slugs, hierarchy helpers, legacy layout parsing |
| `src/shared/theme.ts`             | Colour presets and derived theme variables                     |
| `src/shared/activity.ts`          | Pure event → segment logic, app classification, roll-ups       |
| `src/shared/review.ts`            | Weekly roll-up: week math, tracked/explicit/estimated time     |
| `src/main/activity/`              | Activity log, tracker (lock/idle/focus), commit watcher         |
| `src/main/updates.ts`             | Silent auto-update via electron-updater and GitHub Releases    |
| `src/shared/updates.ts`           | Pure "is now a good moment to restart" policy                  |
| `src/main/devlog/store.ts`        | Reads/writes entries and assets inside the repo                |
| `src/main/devlog/sync.ts`         | Commit / pull / push scheduler on top of `simple-git`          |
| `src/main/protocol.ts`            | `devlog://asset/…` scheme serving images from the repo         |
| `src/main/ipc.ts`, `src/preload/` | IPC surface exposed to the renderer as `window.devlog`         |
| `src/renderer/src/components/`    | React UI: top bar, sidebar tree, canvas view, composer, settings |
| `src/renderer/src/editor/`        | TipTap extensions: highlighted code, asset images, Slack keys  |
| `docs/DESIGN.md`                  | Design notes and rationale                                     |
