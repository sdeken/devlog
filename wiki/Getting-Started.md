# Getting started

## Install

Installed builds for Windows and macOS are attached to each
[GitHub release](https://github.com/sdeken/devlog/releases). They update
themselves in the background and restart into a new version when you are not
using the app (macOS builds from CI are not code-signed, so they run but do
not update themselves).

To run from source you need Node 20+ and `git` on your `PATH`:

```sh
npm install
npm run dev        # run with hot reload
npm run build      # production build into out/
npm run package    # installers into release/ (package:mac, package:win, package:linux)
```

Pushing uses whatever credentials git already has (SSH agent, credential
helper). Devlog never prompts for git credentials.

## Create or open a devlog

A **devlog** is a git repository Devlog writes into. On first launch choose:

- **Create a new devlog**: pick a folder; Devlog runs `git init`, writes
  `devlog.json` and makes the first commit. You can set a remote now or later
  (Settings → Repository).
- **Open an existing devlog**: a clone of one you made on another machine.

Devlog opens on the canvas you last had open.

## Write

1. Make a canvas (a client, a project, a topic) from the sidebar.
2. Type in the note box at the bottom and press **Enter** to post.
   **Shift+Enter** starts a new line. Markdown shortcuts work as you type
   (`**bold**`, `- ` for a list, ```` ```ts ```` for a code block, ⌘B, ⌘I, ⌘K).
3. Paste or drop an image: it is saved next to the day's file and linked
   relatively, so the log renders on GitHub too.
4. Double-click a block (or **Alt+Enter** when posting) to open it as a page
   and write inside it.

Everything is written to disk immediately and committed shortly after (30
seconds by default); with a remote, Devlog pulls and pushes every five
minutes, on **Sync now** (⌘⇧S), on start and on quit.

## Turn on extensions

Open **Extensions** from the quick switcher (⌘P) or Settings. The built-ins
are added with version `builtin`:

| Extension | What it adds |
|---|---|
| `devlog-time` (Time tracking) | Task canvases, the clock, Timesheet and Summary pages, hour targets |
| `devlog-focus` (Window tracking) | Which window was in front, for the timeline and review (asks to be trusted) |
| `devlog-jira` (Jira worklogs) | A timesheet destination that writes Jira worklogs |
| `devlog-cms` (CMS timesheets) | A timesheet destination for the CMS web timesheet |

Each extension asks before it runs, on each machine, and you choose what it
may read and write. See [Extensions Overview](Extensions-Overview).

## Next

- [Concepts](Concepts): canvases, blocks, tasks and todos.
- The repository's [README](https://github.com/sdeken/devlog#readme) walks
  through every feature in detail.
