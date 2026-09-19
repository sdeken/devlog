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
- **Pages and categories.** Besides the journal, create a page per client,
  project, or whatever you want to slice by, and group pages under free-form
  categories in the sidebar. Each page is its own stream with a description
  at the top; notes can be moved between pages, and search covers all of them.
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
  acme-corp/                      ← a page (client, project, …)
    page.md                       ← title, category, description
    entries/2026/09/2026-09-19.md ← same day-file format
```

`page.md` is a short front-matter block followed by the description:

```markdown
---
title: Acme Corp
category: Clients
created: 2026-09-19T10:00:00.000Z
---

Retainer client. Weekly sync on Tuesdays.
```

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
```

Code map:

| Path                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `src/shared/entries.ts`           | Day-file format: parse/serialize, path helpers, image rewriting |
| `src/shared/pages.ts`             | Page metadata (`page.md`), slugs, category grouping             |
| `src/main/devlog/store.ts`        | Reads/writes entries and assets inside the repo                |
| `src/main/devlog/sync.ts`         | Commit / pull / push scheduler on top of `simple-git`          |
| `src/main/protocol.ts`            | `devlog://asset/…` scheme serving images from the repo         |
| `src/main/ipc.ts`, `src/preload/` | IPC surface exposed to the renderer as `window.devlog`         |
| `src/renderer/src/components/`    | React UI: sidebar, threaded feed, composer (TipTap), settings  |
| `src/renderer/src/editor/`        | TipTap extensions: highlighted code, asset images, Slack keys  |
| `docs/DESIGN.md`                  | Design notes and rationale                                     |
