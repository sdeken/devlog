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

- `entries/YYYY/MM/YYYY-MM-DD.md` – one file per local calendar day.
- `entries/YYYY/MM/assets/<date>-<hhmmss>-<rand>.<ext>` – pasted images.

Each post is delimited by `<!-- devlog:entry id=… created=… [updated=…] -->`.
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
  headings are fine, CRLF is fine, and anything before the first marker is
  ignored rather than destroyed.

## Editor

TipTap 3 with StarterKit, the official `@tiptap/markdown` extension for
Markdown in/out, and two custom extensions:

- `DevlogImage` keeps `src` as the repo-relative path (which is what gets
  serialised) but renders through `devlog://asset/…`.
- `SubmitKeymap` implements the Slack contract: Enter posts unless the caret
  is in a code block or a list; Shift+Enter starts a new paragraph (so `- `,
  `1. `, `>` and ``` shortcuts work on every line), a hard break inside a list
  item, or a newline inside a code block; Mod+Enter always posts; Escape
  cancels an edit.

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

- Syntax highlighting in code blocks.
- Multiple devlogs open at once (switching is supported).
- Conflict resolution UI; git's own tooling is the fallback.
- Tags/categories. Search is full-text over all entries.
