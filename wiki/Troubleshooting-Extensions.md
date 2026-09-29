# Troubleshooting extensions

Error messages come from the app and are meant to be read by people; most
say what to fix. This page groups the common ones.

## Seeing what happened

- **Console output.** `console.log` / `console.error` in the extension
  process go to the app's stdout/stderr, each line prefixed `[ext <id>]`.
  Run the app from a terminal (`npm run dev` in a Devlog checkout, or the
  installed binary from a shell) to see them.
- **The Extensions page** shows each extension's state (starting, running,
  failed, stopped) and the error that stopped it.
- **Unit tests** with `@devlog/extension-api/testing` reproduce most API
  errors without the app ([Testing Extensions](Testing-Extensions)).

## It does not load

| Symptom / message | Cause and fix |
|---|---|
| `Invalid extension manifest: …` | The manifest is rejected; the message lists every problem. See [Extension Manifest → Common manifest errors](Extension-Manifest#common-manifest-errors). |
| `The extension does not export activate(ctx)` | `main.js` must be CommonJS setting `exports.activate` (or `module.exports.default.activate`). Bundle with `--format=cjs`. |
| `Extensions are bundled: cannot load "…"` | `require` of a package. Bundle your dependencies (esbuild `--bundle --platform=node`). |
| `Did not start within 30 seconds` | `activate` must only register things; move slow work (network, reading big files) into the background: `void warmUp()`. |
| `… runs unrestricted; it can only run if you say you trust it` | The manifest says `unrestricted: true`; tick **I trust it** when allowing it, or drop the permission. |
| `ERR_ACCESS_DENIED` | The sandbox refused `fs`, `child_process`, `worker_threads` or a native addon. Use `ctx.files`, or (only if you must) `unrestricted`. |
| `Not installed` / download errors | Check the `devlog.json` entry: `owner/repo` with a range that matches a release tag, a release asset named `*.devlog-ext.zip`, under 20 MB zipped and 100 MB unpacked. Private repositories need a GitHub token on the Extensions page. |
| It keeps asking for consent | Consent is per build. Every change to a development folder, and every new downloaded version, asks again. |
| `… needs extension API ^1.8.0; this Devlog provides 1.7.0` | The app loads an extension only if its version satisfies the manifest's `api` range. Declare the lowest version you need (`^1.6.0`), and feature-detect newer members with `ctx.apiVersion`. |

## Permission errors

| Message | Meaning |
|---|---|
| `No access to that canvas` | The canvas is outside both scopes (and not an ancestor of one). `ui.open`, `ui.highlight` and `devlog.field` need a canvas `canvases()` lists. |
| `No read access to that canvas` | `days` / `blocks` outside the read scope. |
| `No read access` | `devlog.activity` with no read grant. |
| `No write access to that canvas` | A write outside the write scope. |
| `No write access to where it would go` | `updateCanvas` moving a canvas somewhere it may not write. |
| `Only an extension that may write everywhere can make a top-level canvas` | `createCanvas` without `parentId` needs a whole-devlog write scope. |
| `That canvas has another extension's type` | `updateCanvas` may only set or clear its own node types. |
| `Only blocks it added` | `editBlock` on someone else's block (allowed only on a canvas it keeps). |
| `Sending through destinations needs "permissions": { "send": true }` | Add `send` to the manifest's permissions. |

Remember that the user chooses the scope: code for the case where
`canvases()` returns only part of the devlog, and `search` / `range` return
nothing.

## API usage errors

| Message | Fix |
|---|---|
| `devlog.addBlock: a block added inside another needs that block's date` | Pass the parent's day file as `date` with `parentId`. |
| `devlog.addBlock: a kind only on a canvas it keeps` | Custom kinds are for `managedCanvas` canvases. |
| `devlog.addBlock: not a kind it may use: …` | Kinds are `^[a-z][a-z0-9-]{0,31}$` and not `note`, `todo`, `task`, `commit` or `done`. |
| `Not a metadata key: …` | Meta keys are `^[a-z][a-z0-9_-]{0,31}$`, not `id at parent pos kind hidden updated ext`. |
| `Cannot add an empty block` / `That block is too long` | Markdown must be non-blank and at most 100 000 characters. |
| `devlog.createCanvas: give it a title` | |
| `"…" is not one of its node types (contributes.nodeTypes)` | `promote` / `createCanvas` / `updateCanvas` with a type it did not declare. |
| `…: not a date: …` / `the range ends before it starts` / `at most 400 days at a time` | `activity` and `range` take `YYYY-MM-DD`, in order, at most 400 days apart. |
| `devlog.managedCanvas: the key is lowercase letters, digits, "_" or "-"` | |
| `View "…" is not declared in contributes.views` | Declare the view before `views.handle` / `post`. |
| `Destination "…" is not declared in contributes.destinations` | Declare it before `destinations.register`. |
| `"…" is not one of its page views` | `ui.openPage` takes a view with `placement: "page"`. |
| `Not allowed in a path: …` / `Not a relative path: …` / `Not allowed in a file name: …` | `ctx.files` paths are relative and `/`-separated; see [the path rules](Extension-API-Reference#ctxfiles). |
| `Secret names are lowercase letters, digits, "_" or "-"` | |
| `Mark the timesheet final before sending it` | `destinations.send` takes only `status: 'final'` sheets. |
| `… is not ready to send` | The destination's extension is not running, or has not registered that destination. |

## Views

| Symptom / message | Cause and fix |
|---|---|
| Blank frame | The extension is not running (views load only while it runs), the `entry` path is wrong, or the page uses an inline `<script>` (blocked by the CSP; load a file). |
| `The view "…" has no handler yet` | The page called before `ctx.views.handle` ran. Register handlers in `activate`. |
| `fetch` fails in the page | Views have `connect-src 'none'`. Do network calls in the extension process and expose them with `views.handle`. |
| `localStorage` throws | Frames are sandboxed without same origin. Keep state in the extension (`ctx.files.local`). |
| Keyboard shortcuts stop working inside the view | Use `@devlog/ui` (or `@devlog/ui/bridge`), which forwards unused shortcuts to the app with a `key` message. |
| The status bar item is cut off | Call `devlog.resize({ width })` when content changes; widths are clamped to 24–360 px. |
| Colours don't follow the theme | Use the theme variables (`var(--fg)`, …), applied by the bridge from the `theme` message. |

## Timeouts

A command has 10 minutes, a view call 60 seconds, a destination preview 2
minutes and send 10 minutes, a provider 20 seconds. A call that times out
fails with an error; for long work, return early and report progress with
`ui.notify` or `views.post`.
