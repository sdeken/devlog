# Devlog

A desktop app for keeping a running developer log. Posts are written in a
Slack-style WYSIWYG Markdown composer, stored as plain Markdown files in a git
repository, and committed and pushed automatically.

- **WYSIWYG Markdown, no chrome.** Bold, italic, strikethrough, inline code,
  syntax-highlighted code blocks, lists, quotes, headings and links render as
  you type, with the usual shortcuts (`**bold**`, `- ` for a list, ```` ```ts ````
  for a code block, ⌘B / ⌘I / ⌘K…). The composer is a bare input: the only
  formatting UI is a small bubble menu that appears when you select text.
  Enter posts, Shift+Enter starts a new line.
- **Every note is a node.** Reply to a note to start a thread, hover between
  two notes and press **+** to insert one there, double-click a note (or press
  ↑ in the empty composer) to edit it. Notes on past days work the same way.
- **Pages in a client / project hierarchy.** Besides the journal, create a
  page per client, project, task, or whatever you want to slice by. A page's
  category is a path like `Acme Corp / Website`, so the sidebar nests projects
  under clients (and a "Website" under two clients is two different projects).
  Each page is its own stream with a description at the top; notes can be
  moved between pages, and search covers all of them.
- **A wiki per category.** Click a client or project in the sidebar to open
  its wiki: a blank canvas that is not a task, for links to the issue tracker,
  environments, contacts, credentials, how-tos. It saves as you type and lives
  in the repo as `categories/<path>/wiki.md`.
- **Archive what you're done with.** Archive a page, or a whole category with
  everything beneath it, to get it out of the sidebar. Archived things stay
  readable and searchable, and one click brings them back.
- **One active task, tracked for you.** Posting on a page makes it the active
  task; it stays active until you post elsewhere, press Stop, lock the
  machine, go idle or sleep. Devlog keeps running in the tray to watch. A note
  with an explicit duration like `[2h]` or `[45m]` overrides tracking for that
  window when you know better.
- **Activity timeline.** Alongside your notes, Devlog records lock/unlock,
  idle, sleep and which window was in front (app and title, so a browser tab
  or a Teams call shows up). A per-day **Timeline** view lays it all out next
  to your notes; the weekly review adds screen time by kind (coding, meetings,
  browser…).
- **Commits become notes.** Map a page to the git repositories you use for
  it and every commit you make there is added to the page as a read-only note
  you can reply to, move or delete.
- **Weekly review.** One view rolls the week up by day and by client →
  project → page with tracked time, plus a per-day breakdown of what you
  wrote, task time and screen time. Made for Friday.
- **Pasted images just work.** Paste or drop an image into the composer and it
  is saved into the repository next to the day's entry and linked relatively,
  so the log also renders on GitHub.
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
pages/
  acme-corp-web-website/          ← a page; folder name = category path + title
    page.md                       ← title, category path, description, archived flag
    entries/2026/09/2026-09-19.md ← same day-file format
categories/
  acme-corp/
    wiki.md                       ← the "Acme Corp" wiki (front matter + markdown)
    assets/                       ← images pasted into it
    web/wiki.md                   ← the "Acme Corp / Web" wiki
```

`page.md` is a short front-matter block followed by the description:

```markdown
---
title: Website
category: Acme Corp / Web
created: 2026-09-19T10:00:00.000Z
---

Marketing site rebuild. Weekly sync on Tuesdays.
```

## Category wikis

Every category node (a client, a project) has a wiki. Open it by clicking the
category name in the sidebar, the category chip on a page, or a breadcrumb. It
is a full-height editor with the same Markdown and image support as notes,
but no posting: Enter is just a new line and every change is saved a moment
later (the header says "Saved"). Below the canvas the view lists the pages in
that category, including archived ones with an Unarchive button, and offers
"+ Page here" to create a page pre-filled with the category.

Wikis are searched along with notes. Like everything else in the repository,
they are plain files; treat the repository as sensitive, because it is.

## Archiving

**Archive** in a page header hides the page from the sidebar. It keeps its
notes, stays searchable (results are marked "archived"), can still be opened
and read, and comes back with **Unarchive**. Archived pages cannot become the
active task or receive commits. **Archive category…** in a wiki header does
the same for the category and every page beneath it; unarchiving restores
them all. The sidebar's collapsible **Archived** section lists everything
archived so it is never lost.

## Time tracking

There is one active task at a time. The workflow is: write a line or two to
wrap up what you were doing, then a short note on the page for the next thing;
that page is now the active task. The status bar shows it with a running clock
and a **Stop** button (also ⌘⇧. and in the tray menu).

Time stops accruing while the screen is locked, the machine sleeps, or there
has been no input for a while (default 10 minutes, adjustable), and resumes on
the same task afterwards. Journal notes never switch the task. Quitting Devlog
stops the clock, so it keeps running in the tray when you close the window.

When you know better than the tracker, say so in the note: `[2h] Acme sync`
or `[45m] code review` counts exactly that much for the note's page, ending at
the note's time, and replaces whatever was tracked in that window. Such notes
do not switch the active task.

Everything the tracker sees goes to an append-only activity log, one JSON
file per day (`activity/YYYY/MM/YYYY-MM-DD.jsonl`). By default it lives in the
app's data folder; Settings can move it into the devlog repository so it syncs
(window titles included, so consider what they contain). Recorded events:
task switches, lock/unlock, idle/active, sleep/wake, app start/stop, a
heartbeat, and foreground-window changes (process name and window title, which
for browsers is the active tab). Focus tracking uses a small PowerShell helper
on Windows, `osascript` on macOS (window titles need the Accessibility
permission) and `xdotool` on Linux if present.

## Commits as notes

Give a page its repositories (**Edit page → Git repositories**). Devlog watches
each repository's reflog and, on every commit, adds a read-only note to the
page: repo, branch, short hash and message. Reply to it, move it or delete it,
but not edit it. Commits in the devlog repository itself are ignored.

## Weekly review

**Weekly review** in the sidebar (⌘⇧R) shows a Monday–Sunday grid: one row
per top-level category (client), nested rows for sub-categories (projects) and
pages, one column per day, and a week total. Each cell shows tracked time and
the number of notes. Below the grid, every day is broken down by client →
project → page with the notes you wrote, the task time segments, and screen
time by kind (coding, terminal, meetings, email & chat, browser) and by app.

Days with no tracking data at all are marked `~` and estimated from note
timestamps instead (each note counts until the next one, capped at an hour).

## Timeline

**Timeline** (⌘⇧T) shows one day as a single chronological list: notes and
captured commits, task starts and stops, lock/idle/sleep, and foreground
windows grouped into runs per app that expand to show each window title with
its duration. Click a note to open it on its page.

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

The HTML comment carries each note's id, optional `parent`, and timestamps,
and is invisible when rendered; the time heading is regenerated from the
timestamp (`↳` and a deeper heading level mark replies). File order is display
order, so inserted notes stay where you put them.

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

## Development

```sh
npm run typecheck   # main + renderer
npm test            # unit tests: file format, store, git sync (uses a local bare remote)
npm run smoke       # builds, then drives the real app with Playwright (needs a display; use xvfb-run on Linux)
npm run screens     # builds, seeds a demo devlog and screenshots every view in light and dark mode
```

The window remembers its size and position, closes to the tray while tracking
is on, and shows the current page in its title. Failed background actions
(a move, an archive, a sync) surface as a toast in the corner rather than
disappearing into the console.

Code map:

| Path                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `src/shared/entries.ts`           | Day-file format: parse/serialize, path helpers, image rewriting |
| `src/shared/pages.ts`             | Page and wiki files, slugs, category paths and tree, archiving |
| `src/shared/activity.ts`          | Pure event → segment logic, app classification, roll-ups       |
| `src/shared/review.ts`            | Weekly roll-up: week math, tracked/explicit/estimated time     |
| `src/main/activity/`              | Activity log, tracker (lock/idle/focus), commit watcher         |
| `src/main/devlog/store.ts`        | Reads/writes entries and assets inside the repo                |
| `src/main/devlog/sync.ts`         | Commit / pull / push scheduler on top of `simple-git`          |
| `src/main/protocol.ts`            | `devlog://asset/…` scheme serving images from the repo         |
| `src/main/ipc.ts`, `src/preload/` | IPC surface exposed to the renderer as `window.devlog`         |
| `src/renderer/src/components/`    | React UI: sidebar, threaded feed, composer (TipTap), settings  |
| `src/renderer/src/editor/`        | TipTap extensions: highlighted code, asset images, Slack keys  |
| `docs/DESIGN.md`                  | Design notes and rationale                                     |
