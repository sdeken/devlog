# Devlog design notes

## Goals

1. Writing a post should feel like typing a Slack message: rich text as you
   type, Enter to post, paste an image and move on.
2. The data must outlive the app. Plain Markdown in a git repository that
   renders on GitHub and can be edited with any editor.
3. Nothing is ever lost and nothing needs a manual save. Disk first, git
   shortly after, remote on a schedule.

## Process model

```
┌───────────── renderer (sandboxed, no Node) ─────────────┐
│ React UI                                                 │
│  Composer = TipTap (ProseMirror) + @tiptap/markdown      │
│  Feed     = marked + DOMPurify                           │
│  window.devlog (contextBridge)  ◄──── preload            │
└──────────────────────────┬───────────────────────────────┘
                           │ ipcRenderer.invoke / events
┌──────────────────────────▼───────────────────────────────┐
│ main                                                      │
│  DevlogStore   reads/writes day files + assets            │
│  SyncManager   simple-git: commit / fetch / rebase / push │
│  protocol      devlog://asset/<repo path>  → file bytes   │
│  SettingsStore userData/settings.json                     │
└───────────────────────────────────────────────────────────┘
```

The renderer never touches the file system. It sends Markdown strings and
image bytes over IPC; the main process owns all paths, git and the asset
server. `contextIsolation`, `sandbox` and a CSP are on; `devlog://` is the
only way for the page to load a file, and the handler refuses anything
outside the open repository.

## Storage format

- `entries/YYYY/MM/YYYY-MM-DD.md` – the journal, one file per local day.
- `entries/YYYY/MM/assets/<date>-<hhmmss>-<rand>.<ext>` – pasted images.
- `pages/<slug>/page.md` + `pages/<slug>/entries/…` – every other page, in
  the same day-file layout (see **Pages** below).

Each note is delimited by
`<!-- devlog:entry id=… [parent=…] created=… [updated=…] -->`.
Reasons for this over alternatives:

- **One file per day, not per post.** Reads naturally on GitHub and in an
  editor; commits are "today's page changed" rather than a pile of tiny
  files. Per-post metadata still needs to live somewhere, hence the marker.
- **HTML comment marker, not a heading convention.** Headings are user
  content; a comment is invisible when rendered and unlikely to be typed by
  hand. The `### HH:MM` line after it is purely cosmetic and regenerated.
- **Day-relative image paths on disk, repo-relative in memory.** On disk
  `![shot](assets/x.png)` renders on GitHub. In memory everything is
  normalised to `entries/2026/09/assets/x.png` so the renderer and the asset
  protocol can resolve an image without knowing which file it came from, and
  an image pasted at 23:59 still resolves when the post lands in the next
  day's file (`../09/assets/x.png`).
- Parsing tolerates hand edits: missing ids get generated, missing time
  headings are fine, CRLF is fine, dangling `parent` links become top-level
  notes, and anything before the first marker is ignored rather than
  destroyed.

### Notes as nodes

Notes form a tree: a flat, ordered list where a reply carries `parentId`.
File order is display order; nothing is sorted by time. The helpers in
`src/shared/entries.ts` (`insertEntry`, `removeSubtree`, `buildTree`) are the
only code that reasons about positions:

- **Reply** → appended after the last descendant of the parent, so a thread
  stays contiguous in the file.
- **Insert after X** → placed after X's whole thread, as X's sibling.
- **Insert before X** → placed directly before X, inheriting X's parent.
- **Delete** removes the note and its whole thread (the UI says how many).

A reply written on a later day is stored in the parent's day file, so a
thread never splits across files. Replies render with `↳` and a deeper
heading level so GitHub shows the nesting without breaking Markdown.

### Pages and categories

A page is a separate stream of notes: a client, a project, a topic. The
journal is the built-in page rooted at `entries/`; everything else lives
under `pages/<slug>/`, where the slug is derived from the title and made
unique. `page.md` holds a tiny `key: value` front matter (title, category,
created) and a markdown description rendered at the top of the page. No
YAML library: the parser accepts `key: value` lines and quoted values only.

A category is a path string on the page, `Acme Corp / Web`, normalised on
save. The sidebar nests pages by path (clients → projects → pages), and the
page dialog offers every existing path and prefix as a suggestion, so a new
level costs nothing and an empty one disappears. Because the hierarchy is a
path, "Website" under Acme and "Website" under Globex are different nodes by
construction; the page folder is slugged from path plus title
(`acme-corp-web-website`) so the repository reads the same way.

Every store operation takes a page id; the helpers in `entries.ts` take the
page's entries base so day files and image links are computed the same way
everywhere. Root-relative image paths start with `entries/` or `pages/`,
which is how `toDayRelative` recognises them.

**Moving** a note (with its thread) to another page rewrites nothing but the
file it lives in: assets stay put and the serialised link becomes
`../../../../../entries/2026/09/assets/x.png`, which still renders on
GitHub. Ids are re-generated only on collision in the target day.

The feed is a continuous timeline per page: the newest ten non-empty days,
oldest first with day dividers, and older days load on scroll or via "Show
earlier notes" while preserving the scroll position. Search runs across all
pages and each hit links to its page and day.

### Category wikis and archiving

A category is a path, so its wiki lives at `categories/<slug>/<slug>/wiki.md`
with the same tiny front matter (`path`, `updated`, `archived`) and a Markdown
body; images go in an `assets/` folder beside it and use the same
root-relative-in-memory, file-relative-on-disk rule as notes (`toRootRelativeFrom`
/ `toRelativeFrom`). The editor is the note Composer in a `document` mode:
Enter is a paragraph break, there is no submit, and changes are debounced
800 ms into `writeWiki`, with a flush on unmount so switching views never
loses the last keystrokes.

Archiving is a flag, not a move: `archived: true` in `page.md` or `wiki.md`.
Everything that reads pages still sees archived ones; the sidebar tree,
move targets, commit watchers and the active task simply filter them out.
Search returns archived hits with a badge. Archiving a category flags every
page whose path starts with it (case-insensitive segments) and every wiki
beneath it, writing a wiki file if none existed so the category itself
carries the flag; unarchiving reverses the same set. Keeping it a flag means
git history stays linear and a mistaken archive is a one-line change.

### Active task and the activity log

The model is deliberately small: **one active task at a time, and the task
is a page**. Posting a user note on any page but the journal makes that page
the active task (`task` event). Stop (status bar, menu, tray) records
`task` with no page. The task survives restarts (persisted in user data and
re-announced with a `start` event) but time only accrues while Devlog is
running, which is why the window closes to the tray when tracking is on.

Signals come from Electron's `powerMonitor`: `lock-screen`/`unlock-screen`,
`suspend`/`resume`, and a 15-second poll of `getSystemIdleState` for idle.
Each is written as an event. Foreground windows come from a long-running
helper process per platform (`src/main/activity/foreground.ts`): PowerShell
with `GetForegroundWindow` on Windows, an `osascript` loop on macOS, `xdotool`
on Linux. They emit only on change; the tracker writes a `focus` event with
process name and title. There are no native modules.

Events go to `ActivityLog`: JSON lines, one file per local day, under
`activity/` in user data or, by setting, in the repository. Writes never
trigger the sync debounce (they would cause a commit every 30 s); the
interval sync picks them up when they live in the repo. A `heartbeat` every
five minutes is the liveness signal: segment building treats a gap of more
than two heartbeats as "the app was not running", so a crash cannot inflate a
task by a weekend.

`src/shared/activity.ts` is pure and replays the stream into **task
segments** (task → next task/stop/pause, resumed on unpause) and **focus
segments** (focus → next focus/pause/stop). Explicit durations are applied
afterwards: `[2h]` on a note means "the last two hours were this page", so
tracked segments overlapping that window are cut and an `explicit` segment is
inserted. Notes carrying a marker do not switch the task; they describe the
past. Segments are split at local midnight before rolling up.

Commit capture (`commits.ts`) watches `.git/logs/HEAD` of every repository
mapped to a page (via `fs.watch` on the directory plus a 15 s poll), reads
only bytes appended since the watch began, filters reflog lines to commits,
resolves each hash with `git show` and emits it. The main process turns it
into a `kind=commit` note with `repo`/`hash`/`branch`/`author` attributes in
the marker; the store refuses `updateEntry` on such notes and de-duplicates
by hash. The devlog repository itself is excluded so auto-sync commits do not
feed back into the log.

### Weekly review

`src/shared/review.ts` is pure and unit-tested: `weekStart` (Monday),
`computeWeekTime`, and `buildReviewRows`. The main process supplies
`getRange(from, to)` (every day file across every page) and the activity log
for the same range. Notes are attributed to the local date of their
timestamp, not the file they sit in, so a reply written on Wednesday under
Monday's thread counts for Wednesday.

Minutes per page per day come from task segments (tracked and explicit). A
day with no events and no markers falls back to the old timestamp heuristic
(each note owns the gap to the next, capped) and is marked `~` in the grid so
the two are never confused.

Rows are a tree: category rows for each path prefix, page rows as leaves,
totals summed upward, journal last, siblings ordered by time. The same tree
drives the per-day detail, which also lists the day's task segments and its
screen time by app kind (`classifyApp`: a small rule table over process names
and titles) and by app with the top titles on hover.

The **Timeline** view merges notes, system events and focus runs for one day
into a single list; consecutive focus events for the same app collapse into
one row that expands to the individual titles.

### Auto-update

`electron-updater` against GitHub Releases, `autoDownload` on, no UI. The
only decision the app makes is *when* to restart, and that lives in
`src/shared/updates.ts` as a pure function over signals the main process
samples once a minute: screen locked (`powerMonitor`), window visible and
focused, system idle seconds, sync in flight, and an "editor busy" count the
renderer maintains for edit/reply/insert composers with text and pending
wiki saves. Locked, or hidden and idle, or unfocused and idle for ten
minutes, or idle for fifteen, means install now; an update older than a day
installs at the first minute without input. The first two minutes after
launch and any moment with a sync or an unsaved edit are always off-limits.

Installing runs the same shutdown work as quitting (tracker `stop` event,
final commit and push), then `quitAndInstall(silent, runAfter)`, so the new
version relaunches by itself and restores the active task from user data.
`autoInstallOnAppQuit` covers the case where the user quits first. Releases
are gated in CI on the smoke test, which is the practical guarantee behind
"the new version is working": a build that cannot post a note, sync, or
show the review never gets a `latest.yml`.

## Editor

TipTap 3 with StarterKit, the official `@tiptap/markdown` extension for
Markdown in/out, and two custom extensions:

- `DevlogImage` keeps `src` as the repo-relative path (which is what gets
  serialised) but renders through `devlog://asset/…`.
- `DevlogCodeBlock` is `CodeBlockLowlight` with lowlight's common grammars;
  the feed highlights the same languages with highlight.js inside `marked`.
  Both use one `.hljs-*` theme with light and dark tokens.
- `SubmitKeymap` implements the Slack contract: Enter posts unless the caret
  is in a code block, a list, or on a ```` ``` ```` fence line (which must fall
  through to the input rule); Shift+Enter starts a new paragraph (so `- `,
  `1. `, `>` and ``` shortcuts work on every line), a hard break inside a list
  item, or a newline inside a code block; Mod+Enter always posts; Escape
  cancels; ↑ in an empty composer edits the previous note.

There is deliberately no toolbar. Formatting is discoverable through the
placeholder hint, the markdown shortcuts, and a bubble menu (bold, italic,
strike, code, link) that only appears over a text selection. The same
`Composer` component is reused for new notes, edits, replies and inserts;
the Attach Image menu item routes to whichever composer was focused last.

Paste and drop are intercepted in `editorProps`: image files are sent to
the main process as bytes, saved, and inserted as image nodes at the cursor
(or drop point). Non-image pastes fall through to TipTap, which understands
pasted Markdown.

Posting clears the editor optimistically before the write completes, so
keystrokes typed immediately after Enter are kept; the draft is restored if
the write fails. The unsent draft is mirrored to `localStorage` so it
survives a restart.

The feed renders with `marked` + `DOMPurify` instead of a second TipTap
instance per post; a post switches to a TipTap instance only while it is
being edited.

## Sync

`SyncManager` serialises every git run through a promise chain so timers,
the debounce, "Sync now" and quit can never overlap. One run is:

1. `git status`; if dirty → `add -A` + commit. The subject names the day(s)
   touched (`devlog: 2026-09-19`), the body lists the files.
2. If a remote exists and pushing is enabled: `fetch`; if behind (or no
   upstream yet and the remote branch exists) → `pull --rebase --autostash`;
   then `push --set-upstream` if ahead or untracked.
3. Refresh status; emit `remote-changes` if the pull changed the tree so the
   UI reloads.

Triggers: a debounce after each store change (default 30 s), an interval
(default 5 min), startup pull, manual, and `before-quit` (bounded to 20 s so
quitting can't hang on a dead network).

Failure handling is deliberately boring: any error becomes
`state: 'error'` with a short message in the status bar, and the next tick
tries again. Rebase conflicts are reported with a hint to resolve in the
repo; the app never force-pushes or rewrites history. `GIT_TERMINAL_PROMPT=0`
guarantees git cannot block on a credential prompt, and a 90 s silence
timeout kills a stalled network call.

## Things intentionally left out (for now)

- Multiple devlogs open at once (switching is supported).
- Conflict resolution UI; git's own tooling is the fallback.
- Tags inside notes for cross-cutting slices; pages/categories cover the
  main use, and search is full-text across every page.
- A calendar or day picker; the timeline plus search stand in for now.
- Drag-to-reorder or re-parenting notes; insert/reply cover the common cases.
