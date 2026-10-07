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
│  @devlog/core/node (packages/core) — the only code that   │
│  touches the repository:                                  │
│    DevlogStore   canvases, blocks, todos, assets          │
│    RepoIndex     SQLite cache: listings + full-text search│
│    SyncManager   simple-git: commit / fetch / rebase / push│
│    ActivityLog   per-machine JSON-lines log               │
│    manifest      storage format, extensions, lockfile     │
│  ExtensionManager (each extension in its own process),    │
│  machine state, CommitWatcher, protocol, settings, updater│
└───────────────────────────────────────────────────────────┘
```

The data layer is its own package, `@devlog/core`, with no Electron
dependency: a pure entry (types, file formats, hierarchy helpers, also used
by the renderer) and a Node entry (store, index, sync, activity log,
manifest). The desktop app is one client of it; an API server or CLI could
be another. Keeping every file-format rule and every write in one unit-tested
package is the point: nothing else opens a day file. Extensions build on two
more packages: `@devlog/extension-api` (the API they are written against)
and `@devlog/ui` (the React kit for their views).

The renderer never touches the file system. It sends Markdown strings and
image bytes over IPC; the main process owns all paths, git and the asset
server. `contextIsolation`, `sandbox` and a CSP are on; `devlog://` is the
only way for the page to load a file, and the handler refuses anything
outside the open repository. Extension views load from `devlog-ext://`
in sandboxed frames (see `EXTENSIONS.md`).

## Storage format

- `devlog.json` – `{ "format": 4 }`, the storage format version, plus the
  devlog's extensions and their settings.
- `devlog.lock.json` – the exact version of each extension (see
  `EXTENSIONS.md`).
- `.gitattributes` – `merge=union` for block files and activity logs.
- `canvases/<xx>/<id>/canvas.md` + `…/entries/YYYY/MM/YYYY-MM-DD.md` –
  every canvas: its properties and surface, and its stream, one file per
  local day (see **Canvases** below).
- `…/entries/YYYY/MM/assets/<date>-<hhmmss>-<rand>.<ext>` – pasted images.
- `entries/…` – the journal, the old built-in root canvas. Retired in
  0.13.0: the app no longer offers it as a place to write, and lists it
  (read-only, under Archived) only while it still holds blocks.
- `activity/<machine>/YYYY/MM/YYYY-MM-DD.jsonl` – the activity log, written
  only while an extension provides time (see below).
- `extensions/<id>/…` – each extension's own files (for example
  devlog-time's clock, the destinations' ledgers).

Each block file starts with `<!-- devlog:format 3 -->` (the block file
format; it did not change when the storage format went to 4) and is an
append-only log of records (`packages/core/src/format/oplog.ts`):

```
<!-- devlog:add id=… [parent=…] pos=… at=… [updated=…] [kind=…] [hidden=1] [key=value…] -->
body
<!-- devlog:edit id=… at=… -->
body
<!-- devlog:set id=… [pos=… [parent=…]] at=… [hidden=0|1] [kind=…] [key=value | key=""] -->
<!-- devlog:delete id=… at=… -->
```

Reasons for this over alternatives:

- **One file per day, not per post.** Reads naturally on GitHub and in an
  editor; commits are "today's page changed" rather than a pile of tiny
  files. Per-post metadata still needs to live somewhere, hence the marker.
- **HTML comment marker, not a heading convention.** Headings are user
  content; a comment is invisible when rendered. The marker is the *only*
  structure: format 1 also wrote a cosmetic `### HH:MM` heading after each
  marker, which meant a user's own H3 at the top of a block could be taken
  for it. Formats 2 and 3 drop the heading, and any body line that looks like a
  marker (`<!-- devlog:…`, possibly after backslashes) gets one more leading
  backslash on disk and loses it on reading, so no text can split or merge
  blocks. A seeded fuzz test round-trips hostile bodies.
- **Day-relative image paths on disk, repo-relative in memory.** On disk
  `![shot](assets/x.png)` renders on GitHub. In memory everything is
  normalised to `canvases/k2/k2x9…/entries/2026/09/assets/x.png` so the renderer and the asset
  protocol can resolve an image without knowing which file it came from, and
  an image pasted at 23:59 still resolves when the post lands in the next
  day's file (`../09/assets/x.png`).
- **Append-only, replayed.** The store never rewrites a block file: every
  change is a record appended at the end, and the current blocks are a
  replay. That makes the store's worst possible bug an extra record rather
  than lost text, gives every file a complete history even between commits,
  and makes concurrent appends from two machines mergeable without
  conflicts (git's union driver keeps both sides). Replay rules, chosen so
  the result does not depend on the order two machines' records were
  merged in:
  - each field (body, placement, hidden, kind, each metadata key) is a
    last-writer-wins register on `at`; equal timestamps go to the later
    record, so one machine's own records apply in order. New records are
    stamped no earlier than the newest one in the file, so a slow clock
    cannot make a fresh edit lose;
  - `delete` is final; records for unknown ids are ignored; `add` records
    are applied first, so a record merged in above its block still applies;
  - replies whose parent is missing or deleted show at the top level, and a
    parent cycle (two concurrent moves) is cut at its smallest id;
  - a line that starts like a marker but is not a complete record (a torn
    write, a record type from a newer version, a second header stacked by a
    merge) ends the previous body and is otherwise skipped.
- **Order keys, not file order.** Siblings sort by `pos`, a fractional
  index (`a0`, `a1`, `a0V`, …; `format/order.ts`): there is always a key
  between two keys, and appends only grow the integer part, so keys stay a
  few characters long. A move or insert writes one key; if two machines
  picked the same key (both appended at once), ties sort by creation time
  then id, and the next insert between them renumbers the siblings with a
  few `set` records. Predecessor pointers were the alternative; they break
  on concurrent inserts after the same block and on deleted predecessors.
- **Compaction, built but not applied.** Files grow with every edit.
  `DevlogStore.compact({ quietSince, dryRun })` rewrites a file as one `add`
  per live block carrying its current state, dropping superseded edits,
  moves and deleted blocks. It is the only operation that rewrites a block
  file, so it only touches block files (format 3 header) whose newest record
  is older than `quietSince` (another machine must not still be appending to
  a file rewritten under it), replays the result and refuses to write unless
  it gives exactly the same blocks, is deterministic (two machines
  compacting the same file agree), holds the file's lock, and keeps the
  index current. Git history keeps every dropped record. The app does not
  call it yet.
- Parsing tolerates hand edits: CRLF is fine, and anything before the first
  record is ignored rather than destroyed. Records without an id are
  skipped.

### Blocks as a tree

Blocks form a tree: a block inside another carries `parentId`, and siblings
are ordered by their order keys; replay returns them depth-first, children
contiguous. The planners in `packages/core/src/format/oplog.ts` (`planAdd`,
`planMove`, `planNest`, `planDelete`, …) turn each operation into records;
a property test checks them against plain list operations:

- **Add inside** → the last child of the parent.
- **Insert after X** → placed after X and everything inside it, as X's
  sibling.
- **Insert before X** → placed directly before X, inheriting X's parent.
- **Move inside or beside** (`planNest`) → one `set` with a new parent and
  order key.
- **Delete** removes the block and everything inside it (the UI says how
  many).

A block written inside another on a later day is stored in its root block's
day file, so a subtree never splits across files. Every block is also a
page: the stream shows a chip for the blocks inside one, and opening it
shows them (see `BLOCK-PAGES.md`).

### Canvases, surfaces, node types

There is one container type. A **canvas** has a title, an optional parent,
an optional node type, a list of repositories, an archived flag, fields
from extensions, a *surface* (free markdown) and a *stream* (day files of
blocks). Every canvas lives under `canvases/<xx>/<id>/` with `canvas.md`
holding a tiny `key: value` front matter followed by the surface markdown.
(The journal, the old built-in root canvas at `entries/`, is retired and
read-only.) No YAML library: the parser accepts
`key: value` lines and quoted values only.

Ids are random: 10 characters from `0-9a-z` minus `i l o u` (about 50
bits), so two machines creating canvases offline never collide, and a
canvas folder lives in a shard named after the id's first two characters,
which keeps every directory small for decades of task canvases. (Format 1
used title slugs in one flat folder: readable, but they collided across
machines and made `canvases/` one enormous directory.) The hierarchy is
`parent: <id>` in the front matter, not the folder path. This was a
deliberate trade against a nested directory tree: ids are what the activity
log, task blocks and the time extension's clock point at, and a rename or a move under a
different client must not invalidate a month of time records or relocate
files in git. `alias: <old id>` lines keep older ids resolvable. `canvasPath` / `canvasLabel` in
`packages/core/src/format/canvases.ts` walk parents for display, `buildCanvasTree` nests
for the sidebar (non-tasks before tasks, then by title), and a canvas whose
parent has gone simply shows at the top level.

Every store operation takes a canvas id; the helpers in `format/blocks.ts`
take the canvas's entries base so day files and image links are computed the same
way everywhere. Root-relative image paths start with `entries/` or
`canvases/`, which is how `toDayRelative` recognises them. Surfaces use the
same root-relative-in-memory, file-relative-on-disk rule with the canvas
folder as the base and an `assets/` folder beside `canvas.md`.

**Node types** come from extensions: `type: <extension>/<type>` in
`canvas.md` (the task type is written `task: true`, as before node types
existed). The app has no types of its own. **Tasks** are the time
extension's (devlog-time): posting a user block on a task canvas makes it
the active task; posting anywhere else is just a note. A block turns into a
canvas of a type through `promoteBlock` (the extension's **Make task**, via
`devlog.promote`): a new canvas is created beneath the block's canvas,
titled from the block (`titleFromMarkdown`: first sentence, markup and
duration markers stripped, capped), the blocks inside it move there, and
the block's kind becomes `task` with `meta.canvas` pointing at it. The
block keeps its text and stays editable; it is the record of when and where
the task began, and the chip on it is the link. `#task` on the first line
and Ctrl+Shift+Enter are devlog-time's post command doing the same at post
time.

**Hiding** is a flag on the block (`hidden=1` in the marker). The stream
collapses each run of consecutive hidden top-level blocks into one stub and
reveals them on click; search, review and summary still see them. It is a
reading aid, not a deletion, so it never touches the tree.

**Reordering** within a day is drag-and-drop over `planMove`: one `set`
record with a new order key (and parent). Dropping on the middle of a block
puts the dragged block inside it, from any day. Timestamps are untouched,
which is the answer to the "how does this work with timestamps" question: a
block's time is when it was written and its position is where it is kept;
the file already separated the two. Reordering is refused across days
because a day is a file.

**Todos** are blocks of kind `todo` in the day files, at any depth (storage
format 4; see `BLOCK-PAGES.md`). `meta.done` is when one was ticked off; the
date range query finds day files by that time too, so the timeline shows
ticks on the day they happened. The panel asks the index for the day files
holding a todo (`todoDays`), reads those, and groups the open todos under the
canvases and blocks above them. Format 3 kept a per-canvas `todos.md`;
`upgradeStorage` moves each old todo (with its comments) into the day file
of the day it was written. "✓" blocks written by earlier versions when a
todo was ticked stay as history.

**Moving** a block (with everything inside it) to another canvas or file
appends `add` records to the target and `delete` records to the source;
nothing is rewritten. Assets stay put and the serialised link becomes
relative to the new file, which still renders on GitHub. Ids are
re-generated only on collision in the target day.

The stream is a continuous timeline per canvas: the newest ten non-empty
days, oldest first with day dividers, and older days load on scroll or via
"Show earlier blocks" while preserving the scroll position. Search runs
across every canvas (blocks and surfaces) and each hit links to its canvas
and day.

Archiving is a flag, not a move: `archived: true` in `canvas.md`. Everything
that reads canvases still sees archived ones; the sidebar tree, move
targets, commit watchers and the task picker simply filter them out. Search
returns archived hits with a badge. Archiving a canvas flags every canvas
beneath it; unarchiving reverses the same set. Keeping it a flag means git
history stays linear and a mistaken archive is a one-line change.

**Older formats.** Devlog 0.5 upgraded formats 1 and 2 (and 0.2's `pages/`
+ `categories/`) to format 3 when it opened a repository; that code was
removed once every devlog had been upgraded (it is in git history, up to
release 0.5.3). On open the app upgrades format 3 to 4
(`upgradeStorage`: todos move out of `todos.md` into the streams), then
checks `devlog.json` (`assertSupportedFormat`) and refuses anything but
format 4 with a message saying what to do. Canvases that had slug ids keep
them as `alias` lines, which the store (`resolveCanvasId`, `aliasMap`) and
the activity reader still follow.

### The local index

`RepoIndex` is a SQLite database (Node's built-in `node:sqlite`, so no native
module to rebuild per Electron version) in user data, keyed by the
repository path. Tables: files (path, size, mtime), canvases (+ aliases),
days (canvas, date, count), blocks (the parsed entry as JSON plus a
lower-cased copy) and a contentless FTS5 table with the trigram tokenizer, so
search is substring search like the file scan it replaced; queries under
three characters fall back to `instr` over the lower-cased column. The store
writes through to it synchronously after every file write, and serves
listings and search from it once a first refresh has completed; before that
it reads files. `refresh()` stats the known layout (not the whole repo) and
re-parses what changed, skipping any file the store rewrote while it was
reading. A schema version or repository change, or a corrupt file, just
rebuilds it. The tests compare every listing and search answer from an
indexed store with one that scans the files.

### Time: devlog-time and the activity log

Time tracking is the built-in extension devlog-time (see
`TIME-EXTENSION.md`); the app itself keeps no clock. The model is
deliberately small: **one active task at a time, and the task is a canvas
of the task type**. Posting a user block on a task canvas, pressing Start
in its header, or making a block a task makes it the active task. Stop
(status bar, Ctrl+Shift+., tray) stops it. The clock writes `start`,
`task`, `stop` and a `heartbeat` every five minutes to
`extensions/builtin.devlog-time/<machine>/…`, keeps the active task in its
local `state.json` (so it survives restarts), and marks the task for the
app with `ui.highlight`. Time only accrues while Devlog is running, which
is why the window closes to the tray while the extension asks it to keep
running.

The machine's state is the app's: Electron's `powerMonitor`
(`lock-screen`/`unlock-screen`, `suspend`/`resume`) and a 15-second poll of
`getSystemIdleState`, against the idle minutes the extension asked for
(`activity.idleAfter`). The main process keeps the paused reasons
(`machinePaused`), tells extensions (pause/resume), and writes
lock/idle/sleep events to `activity/` **only while an extension provides
time** (`provide.activity`). Foreground windows are not the core's either:
the devlog-focus extension keeps `focus` events in its own folder. The
views read one merged stream (`activityRange`): the core log, the time
provider's events and the focus provider's, replayed together. There are
no native modules.

Event files are JSON lines, one file per local day, one folder per machine
(`<host>-<id>`, the name kept in `userData/machine.json`), in the
repository by default or on the machine only by setting. A machine only
ever appends to its own files, so logs never conflict in git. Reading
merges every machine (and the pre-0.4 shared `activity/YYYY/…` layout) and
tags each event with its machine; the segment builders replay each machine
separately (a lock on the laptop must not pause the desktop) and then
flatten overlaps, the later-starting segment winning, so time is never
counted twice. Exclusions apply globally. Writes to `activity/` and
`extensions/` never trigger the sync debounce (they would cause a commit
every 30 s) and do not count as unsaved work in the status (`quietPaths`);
the interval sync commits them. The heartbeat is the liveness signal:
segment building treats a gap of more than two heartbeats as "the app was
not running", so a crash cannot inflate a task by a weekend. Heartbeats are
skipped while paused: the lock/idle/suspend event already closed the
segment, and a locked machine that kept writing would also commit and push
every five minutes.

Pauses are tracked per reason (locked, idle, suspended) both in the main
process and in the replay. The clock runs only when none applies: waking from sleep
clears only "suspended", input after idle clears only "idle", and unlocking
clears everything because the user is demonstrably back. An earlier version
kept a single paused flag, so a laptop that woke in the background while
locked restarted the task and booked the whole night; since time is always
recomputed from the raw log, fixing the replay fixed past days too.

**Corrections** say what a stretch of time was, whatever was tracked. The
review's **Trim** and **Remove** write `exclude` events (`start`, `end`,
`id`) to the app's log; the Timesheet's corrections are devlog-time's
`assign` events (a window and the canvas it was, or null for not worked;
extension API 1.8), in its own log. Both are filed on the day they correct
(their `t` is the window's start, and the replay never reads them as the
app being alive), and both are undone by a later event with `cancels:
<id>`. `buildTrackedSegments` replays, then applies the corrections still
in force in the order they were made (`at`): an exclusion cuts tracked and
assigned time (an explicit `[2h]` segment is the user's own statement and
stays); an assignment replaces everything in its window. Time outside a
window is untouched, so a running task keeps counting past a correction.
The raw events are never edited, so any correction can be reversed.

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

Git capture (`src/main/activity/commits.ts`) watches `.git/logs/` of every repository mapped to
a canvas, recursively (via `fs.watch` on the directory plus a 15 s poll), and
reads only bytes appended to each reflog since the watch began. Lines are
classified by which log they came from and their message: a commit or
cherry-pick on `HEAD` is resolved with `git show` and emitted as a commit;
`checkout: moving from A to B` on `HEAD`, `branch: Created` under
`refs/heads/`, `update by push` under `refs/remotes/`, and merge, rebase,
pull, reset and stash messages are emitted as events with a `GitAction`.
A repository is linked to a canvas, and the commit lands on the active task
(the canvas an extension highlights) when that task lies beneath the linked
canvas (`routeCommit`), otherwise on the canvas itself. This is what "link repositories to clients" means in
practice: one client is one branch at a time, and the task you are on is the
work the commit belongs to. Linking also imports the user's own commits from
the last N days (`listRecentCommits`, filtered by the repository's
`user.email`, dated at commit time, de-duplicated by hash) so a freshly
linked canvas already shows the recent work; the watcher then takes over
for anything new. The main process turns commits into `kind=commit` blocks with
`repo`/`hash`/`branch`/`author` attributes in the marker (the store refuses
`updateEntry` on such blocks and de-duplicates by hash) and everything else
into `type: 'git'` activity events tagged with the canvas (only while an
extension provides time), so they show on the timeline without becoming
blocks. The devlog repository itself is excluded so
auto-sync commits do not feed back into the log.

### Weekly review

`src/shared/review.ts` is pure and unit-tested: `weekStart` (Monday),
`computeWeekTime`, and `buildReviewRows`. The main process supplies
`getRange(from, to)` (every day file across every canvas) and the activity
for the same range (`activityRange`: the core log merged with the time and
focus extensions' events). Notes are attributed to the local date of their
timestamp, not the file they sit in, so a reply written on Wednesday under
Monday's thread counts for Wednesday.

Minutes per canvas per day come from task segments (tracked and explicit). A
day with no events and no markers falls back to the old timestamp heuristic
(each note owns the gap to the next, capped) and is marked `~` in the grid so
the two are never confused.

Rows are a tree that mirrors the canvas tree: one row per canvas with blocks
or time in the range plus every ancestor, totals summed upward, journal
last, siblings ordered by time. The same tree drives the per-day detail,
which also lists the day's task segments and its screen time (with
devlog-focus) by app kind (`classifyApp`: a small rule table over process
names and titles) and by app with the top titles on hover.

The **Summary** page (devlog-time's, Ctrl+Shift+H) reuses `computeWeekTime`
and `buildReviewRows` over an arbitrary date range and shows only the totals
column, rounded with `roundMinutes` to a granularity the user picks (default
15 minutes). Rounding is per row and the exact minutes sit beside the
rounded hours, so the number on the invoice and the number that produced it
are both visible.

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

`electron-updater` against GitHub Releases, `autoDownload` on. The UI is
small: the status bar offers **Update now** once one is downloaded, and
Settings shows the version with **Check now**. Otherwise the only decision
the app makes is *when* to restart, and that lives in
`src/shared/updates.ts` as a pure function over signals the main process
samples once a minute: screen locked (`powerMonitor`), window visible and
focused, system idle seconds, sync in flight, and an "editor busy" count the
renderer maintains for edit/reply/insert composers with text and pending
wiki saves. Locked, or hidden and idle, or unfocused and idle for ten
minutes, or idle for fifteen, means install now; an update older than a day
installs at the first minute without input. The first two minutes after
launch and any moment with a sync or an unsaved edit are always off-limits.

Installing runs the same shutdown work as quitting (extensions stop first,
so the clock's `stop` is in the final commit; then commit and push), then
`quitAndInstall(silent, runAfter)`, so the new version relaunches by itself
and devlog-time restores the active task from its local state.
`autoInstallOnAppQuit` covers the case where the user quits first. Releases
are gated in CI on the smoke test, which is the practical guarantee behind
"the new version is working": a build that cannot post a note, sync, or
show the review never gets a `latest.yml`.

## Editor

TipTap 3 with StarterKit, the official `@tiptap/markdown` extension for
Markdown in/out, and three custom extensions:

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
  cancels; Alt+Enter posts and opens the new block's page; Mod+K adds a
  link; ↑ in an empty composer edits the previous note.

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

The composer is docked under the canvas, review and timeline views (not on
extension pages), with a picker for the target canvas: the point of the app
is to jot as things happen, and the thing that happened is rarely on the
page you are looking at. The target follows the canvas you open and stays
put while you look at the timeline or review. Ctrl+P (or Ctrl+K outside the
editor) opens a quick switcher over canvases, recent block pages, views,
extension pages and extension commands.

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
2. If a remote exists, pushing is enabled, and this is a sync (not the
   commit after an edit): `fetch`; if behind (or no upstream yet and the
   remote branch exists) → `pull --rebase --autostash`; then
   `push --set-upstream` if ahead or untracked.
3. Refresh status; emit `remote-changes` if the pull changed the tree so the
   UI reloads.

Triggers: a debounce after each store change (default 30 s; writes under
`activity/` and `extensions/` excepted), which only commits; an interval
(default 5 min), startup pull, manual, and `before-quit` (bounded to 20 s so
quitting can't hang on a dead network), which also pull and push. Until
0.19.1 the debounce pushed too, so steady typing pushed every half minute and
GitHub throttled it; now the remote sees at most one push per interval.

Failure handling is deliberately boring: any error becomes
`state: 'error'` with a short message in the status bar, and the next tick
tries again. A conflicting rebase is aborted (the tree is never left
mid-rebase) and reported with a hint to resolve in the repo; the app never
force-pushes or rewrites history. `GIT_TERMINAL_PROMPT=0`
guarantees git cannot block on a credential prompt, and a 90 s silence
timeout kills a stalled network call.

## Extensions

Anything beyond notes, canvases and git is an extension: time tracking
(devlog-time), window tracking (devlog-focus), and the Jira and CMS
destinations are built-ins that use the same API as anyone else's. Each
runs in its own Node process, sandboxed unless you trust it, listed in
`devlog.json` and pinned in `devlog.lock.json`, and it asks before it
starts. Its views run in sandboxed frames and talk to it through the app.
See `EXTENSIONS.md` for the model and `packages/extension-api` for the API.

## Things intentionally left out (for now)

- Multiple devlogs open at once (switching is supported).
- Conflict resolution UI; git's own tooling is the fallback.
- Tags inside blocks for cross-cutting slices; canvases cover the main
  use, and search is full-text across every canvas.
- A calendar or day picker; the timeline plus search stand in for now.
- Drag-to-reorder across days. Within a day, drag-and-drop appends one
  `set` with a new order key; across days a block would have to change
  files, which is what Move is for.
- Running compaction (it exists in the core package; see *Storage format*).
