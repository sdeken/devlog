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
- `canvases/<id>/canvas.md` + `canvases/<id>/entries/…` – every other
  canvas, in the same day-file layout (see **Canvases** below).

Each block is delimited by
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

### Canvases, surfaces, tasks

There is one container type. A **canvas** has a title, an optional parent,
a task flag, a list of repositories, an archived flag, a *surface* (free
markdown) and a *stream* (day files of blocks). The journal is the built-in
root canvas whose stream lives at `entries/`; every other canvas lives under
`canvases/<id>/` with `canvas.md` holding a tiny `key: value` front matter
followed by the surface markdown. No YAML library: the parser accepts
`key: value` lines and quoted values only.

Ids are slugs of the title made unique (`website`, `website-2`), and the
hierarchy is `parent: <id>` in the front matter, not the folder path. This
was a deliberate trade against a nested directory tree: ids are what the
activity log, task blocks and tracker state point at, and a rename or a move
under a different client must not invalidate a month of time records or
relocate files in git. `canvasPath` / `canvasLabel` in
`src/shared/canvases.ts` walk parents for display, `buildCanvasTree` nests
for the sidebar (non-tasks before tasks, then by title), and a canvas whose
parent has gone simply shows at the top level.

Every store operation takes a canvas id; the helpers in `entries.ts` take
the canvas's entries base so day files and image links are computed the same
way everywhere. Root-relative image paths start with `entries/` or
`canvases/`, which is how `toDayRelative` recognises them. Surfaces use the
same root-relative-in-memory, file-relative-on-disk rule with the canvas
folder as the base and an `assets/` folder beside `canvas.md`.

**Tasks** are canvases with `task: true`, and that flag is the whole
tracking model: posting a user block on a task canvas makes it the active
task; posting anywhere else is just a note. This replaced the earlier
"posting on any page starts a task" rule, which made every jotted note start
a clock. A block turns into a task through `promoteToTask`: a new canvas is
created beneath the block's canvas (top-level for journal blocks) titled
from the block (`titleFromMarkdown`: first sentence, markup and duration
markers stripped, capped), the block's kind becomes `task` with
`meta.canvas` pointing at it, and the tracker is pointed at the new canvas.
The block keeps its text and stays editable; it is the record of when and
where the task began, and the chip on it is the link. `#task` on the first
line and ⌘⇧Enter are the same operation performed at post time
(`hasTaskTag` / `stripTaskTag`), so the round trip is one keystroke.

**Hiding** is a flag on the block (`hidden=1` in the marker). The stream
collapses each run of consecutive hidden top-level blocks into one stub and
reveals them on click; search, review and summary still see them. It is a
reading aid, not a deletion, so it never touches the tree.

**Reordering** within a day is drag-and-drop over `moveSubtree`: the block
and its thread are lifted out of the list and spliced back after or before
the anchor's thread. Timestamps are untouched, which is the answer to the
"how does this work with timestamps" question: a block's time is when it was
written and its position is where it is kept; the file already separated the
two. Dropping is refused across days because a day is a file.

**Moving** a block (with its thread) to another canvas rewrites nothing but
the file it lives in: assets stay put and the serialised link becomes
`../../../../../entries/2026/09/assets/x.png`, which still renders on
GitHub. Ids are re-generated only on collision in the target day.

The stream is a continuous timeline per canvas: the newest ten non-empty
days, oldest first with day dividers, and older days load on scroll or via
"Show earlier blocks" while preserving the scroll position. Search runs
across every canvas (blocks and surfaces) and each hit links to its canvas
and day.

Archiving is a flag, not a move: `archived: true` in `canvas.md`. Everything
that reads canvases still sees archived ones; the sidebar tree, move
targets, commit watchers and the active task simply filter them out. Search
returns archived hits with a badge. Archiving a canvas flags every canvas
beneath it; unarchiving reverses the same set. Keeping it a flag means git
history stays linear and a mistaken archive is a one-line change.

**Migration.** Devlog 0.2 stored `pages/<slug>/page.md` with a category path
string, and `categories/<slugs>/wiki.md` per path node. `migrateLegacyLayout`
runs once when such a repository is opened: each category path becomes a
chain of canvases (ids slugged from the full path, `acme-corp-web`), wiki
text and assets become that canvas's surface, and each page folder moves to
`canvases/<slug>/` with its parent set to the deepest category canvas and
its description as the surface. Day files move untouched; their relative
image links are the same depth in both layouts. The activity log keeps its
old `pageId` field and is read as `canvasId`.

### Active task and the activity log

The model is deliberately small: **one active task at a time, and the task
is a canvas flagged as one**. Posting a user block on a task canvas, pressing
Start in its header, or turning a block into a task makes it the active task
(`task` event with the canvas id). Stop (status bar, menu, tray) records
`task` with no canvas. The task survives restarts (persisted in user data and
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

Focus streams are noisy when the user alt-tabs a lot: a flip through the
task switcher produces three focus events in under a second. The raw log is
kept verbatim (it is the evidence); `cleanFocusSegments` is applied when
building views. It drops shell windows outright (`isIgnoredFocus`: task
switcher, Task View, Start, search, lock screen, the desktop, and their macOS
equivalents) by extending the previous segment over them, folds any segment
shorter than `focusMinSeconds` (a setting, default 5 s) into its predecessor,
and merges adjacent segments with the same app and title. Task segments are
untouched: a task is a deliberate act, a focus flip is not.

Git capture (`commits.ts`) watches `.git/logs/` of every repository mapped to
a canvas, recursively (via `fs.watch` on the directory plus a 15 s poll), and
reads only bytes appended to each reflog since the watch began. Lines are
classified by which log they came from and their message: a commit or
cherry-pick on `HEAD` is resolved with `git show` and emitted as a commit;
`checkout: moving from A to B` on `HEAD`, `branch: Created` under
`refs/heads/`, `update by push` under `refs/remotes/`, and merge, rebase,
pull, reset and stash messages are emitted as events with a `GitAction`.
The main process turns commits into `kind=commit` blocks with
`repo`/`hash`/`branch`/`author` attributes in the marker (the store refuses
`updateEntry` on such blocks and de-duplicates by hash) and everything else
into `type: 'git'` activity events tagged with the canvas, so they show on the
timeline without becoming blocks. The devlog repository itself is excluded so
auto-sync commits do not feed back into the log.

### Weekly review

`src/shared/review.ts` is pure and unit-tested: `weekStart` (Monday),
`computeWeekTime`, and `buildReviewRows`. The main process supplies
`getRange(from, to)` (every day file across every canvas) and the activity log
for the same range. Notes are attributed to the local date of their
timestamp, not the file they sit in, so a reply written on Wednesday under
Monday's thread counts for Wednesday.

Minutes per canvas per day come from task segments (tracked and explicit). A
day with no events and no markers falls back to the old timestamp heuristic
(each note owns the gap to the next, capped) and is marked `~` in the grid so
the two are never confused.

Rows are a tree that mirrors the canvas tree: one row per canvas with
blocks or time in the range plus every ancestor, totals summed upward,
journal last, siblings ordered by time. The same tree
drives the per-day detail, which also lists the day's task segments and its
screen time by app kind (`classifyApp`: a small rule table over process names
and titles) and by app with the top titles on hover.

The **Summary** view reuses `computeWeekTime` and `buildReviewRows` over an
arbitrary date range and shows only the totals column, rounded with
`roundMinutes` to a granularity the user picks (default 15 minutes). Rounding
is per row and the exact minutes sit beside the rounded hours, so the number
on the invoice and the number that produced it are both visible.

The **Timeline** view slices one day into fixed intervals (`bucketizeDay` in
`activity.ts`): per bucket, the overlap of every task and (cleaned) focus
segment, the notes written, the git events, and the system events. Overlap rather than "event inside
bucket" is what keeps a 3-hour Code session visible as 12 rows of "Code 15m"
rather than one row at its start. Empty buckets are dropped and rendered as
a gap line, so a lunch break is one line, not four empty ones.

### Window chrome and themes

The window is frameless in the Slack sense: `titleBarStyle: 'hidden'` with a
`titleBarOverlay` on Windows and Linux (native minimise/maximise/close drawn
over the app's own top bar, coloured to match) and `hiddenInset` on macOS.
The application menu still exists, for accelerators and for the hamburger
button, which asks the main process to `popup()` it; `autoHideMenuBar` keeps
it off-screen otherwise. The renderer's top bar is the drag region
(`-webkit-app-region: drag`, buttons and the search box opt out) and is
padded by `env(titlebar-area-width)` so it never sits under the overlay.

A theme is a preset name plus at most two overrides, sidebar and accent
(`src/shared/theme.ts`). Everything else, text, muted text, hover, the
darker top bar, the accent's foreground, is derived by mixing towards black
or white depending on the sidebar's luminance, so a custom colour never
needs six more inputs and light sidebars get dark text automatically. The
renderer sets the result as CSS custom properties on `:root`; the main
process uses the same function for the title-bar overlay colours, so both
change together when settings are saved. Content-area light/dark still
follows the system.

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
(or drop point). Plain-text pastes go through `detectCodePaste`
(`editor/smartPaste.ts`), a small set of shape rules for stack traces, .NET
and Python exceptions, diffs, shell transcripts, timestamped logs and JSON;
a match is inserted as a code block (with a language when one is obvious)
so the evidence survives verbatim instead of being re-flowed into
paragraphs. Everything else falls through to TipTap, which understands
pasted Markdown.

The composer is docked under every view, not just the page feed, with a
picker for the target page: the point of the app is to jot as things happen,
and the thing that happened is rarely on the page you are looking at. The
target follows the page you open and stays put while you look at the
timeline or summary. ⌘P / ⌘K opens a quick switcher over pages, categories
and views.

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
- Tags inside blocks for cross-cutting slices; canvases cover the main
  use, and search is full-text across every canvas.
- A calendar or day picker; the timeline plus search stand in for now.
- Drag-to-reorder across days. Within a day, order is file order and
  drag-and-drop simply rewrites it (`moveSubtree`); across days a block
  would have to change files, which is what Move is for.
