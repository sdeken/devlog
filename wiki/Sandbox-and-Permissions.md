# Sandbox and permissions

The model: **you trust what you install**, like a VS Code extension, but
with limits enforced by the runtime, and trust is explicit. No Docker, no
VM: safety comes from what the runtime and the API allow.

## The sandbox

An extension runs in **its own process**: a Node child of the Devlog binary
(`ELECTRON_RUN_AS_NODE`) started with Node's permission model
(`--permission`), allowed to read exactly one file, the host script. Its
code is sent over the message channel and evaluated, so it needs no file
access to load.

| An extension… | Because |
|---|---|
| **cannot touch files** | The permission model allows reading only the host script. Its own folders are reached through `ctx.files`, a broker in the app. |
| **cannot start programs, load native code or spawn workers** | The permission model denies them. Node built-ins can be required, but the calls fail with `ERR_ACCESS_DENIED`. |
| **cannot `require` packages** | Only Node built-ins resolve; anything else throws `Extensions are bundled: cannot load "…"`. |
| **sees the devlog only through its grant** | Every `ctx.devlog` call is filtered by the app. |
| **cannot reach other extensions, the app's windows or Electron** | Each has its own message channel to the app and nothing else. (The exception: sending a timesheet through another extension's destination, with `permissions.send`, through the app.) |
| **cannot take the app down** | A crash kills only its process. The heap is capped at 256 MB; the environment is stripped to a few locale variables (`TZ`, `LANG`, `LC_ALL`, and `SystemRoot`/`windir` on Windows); one that does not start within 30 seconds is stopped; calls that take too long fail. |
| **shows UI only in sandboxed frames** | Views run in `sandbox="allow-scripts"` frames with a CSP that forbids network, frames and forms ([Views and UI](Views-and-UI#how-a-view-is-served)). |

**The network is not restricted.** An extension can make any request with
`fetch`; the domains it declares in `permissions.network` are shown at
consent but not enforced. So an extension can send out whatever it can read,
which is one reason read access is scoped.

Electron's `utilityProcess` silently ignores `--permission`, hence the Node
child; the builds must keep Electron's `RunAsNode` fuse on. The test suite
runs a probe extension (`tests/fixtures/extensions/probe`) in that process
and checks that file access, child processes and workers are refused.

## Permissions

Declared in the manifest, shown before the extension first runs:

| Permission | The user chooses | Effect |
|---|---|---|
| `read: true` | A read scope: the whole devlog, or chosen canvases (each with everything inside) | `days`, `blocks`, `search`, `todos`, `range`, `activity`, `onBlockAdded` and command block context work within the scope. |
| `write: true` | A write scope, the same way | `addBlock`, `editBlock`, `promote`, `createCanvas`, `updateCanvas` work within the scope. Top-level canvases need write access to the whole devlog. |
| `network: [...]` | — | Shown only. |
| `send: true` | — | May send timesheets through other extensions' destinations (1.7). |
| `unrestricted: true` | Whether to tick **I trust it** | Runs outside the sandbox (below). |

What an extension gets **with no grant at all**: its own settings, secrets
and files; the canvas fields it declared (for canvases it can list); its
destinations receiving sheets the user sends; its views, commands and
providers.

### What the grant hides

- `canvases()` lists canvases in the read or write scope plus their
  ancestors (so they can be named), plus canvases it keeps; nothing else.
- `search`, `todos` and `range` return nothing outside the read scope (and
  empty results with no read grant).
- `days`, `blocks` and `activity` throw outside it.
- Writes outside the write scope fail.
- Command contexts leave out canvases it cannot see, and blocks on canvases
  it cannot read.
- `activity` shows task time on unreadable canvases as `canvasId: null`, and
  window titles only with read access to the whole devlog.
- Canvases it keeps (`managedCanvas`) are its own whatever the grant.

### Consent is per machine, per devlog, per build

- Consent is keyed by the devlog folder and stored on the machine, **never
  in the repository**, so nothing arriving through git can widen it.
- A new build of a downloaded extension (or any change to a development
  folder) asks again. A **built-in** keeps its grant and trust when the app
  brings a new build.
- Changing a grant restarts the extension; revoking stops it until allowed
  again; **Remove** takes it out of `devlog.json` and forgets consent here.

## Unrestricted extensions

An extension that needs what the sandbox forbids (start a platform helper,
read files) declares:

```json
"permissions": { "unrestricted": true }
```

It runs only if the user ticks **I trust it** when allowing it (otherwise:
`… runs unrestricted; it can only run if you say you trust it`), and then runs
**without the permission model**: full file-system and process access, the
app's environment, and `ctx.packageDir` (its own unpacked folder, for scripts
it ships). The API calls are still filtered by its grant, but nothing stops
it reading the repository directly, so ask for it only when you must.
devlog-focus (window tracking) is one.

## The file broker

`ctx.files.repo` and `ctx.files.local` go through `ExtensionFileStore`
(`packages/core/src/node/extensionFiles.ts`), which:

- takes relative, `/`-separated paths only and refuses absolute paths,
  drive letters, `.`/`..`, backslashes, reserved characters, Windows device
  names and alternate data streams;
- refuses to go through a symlink anywhere between the devlog root and the
  target (git can commit links);
- writes atomically (temp file, then rename) and serialises writes;
- caps sizes: 16 MB per file, 256 MB per folder, 20 000 files.

## Secrets

`ctx.secrets` values are stored per extension in user data, encrypted with
the OS keychain (Electron `safeStorage`). They are never written to the
devlog, so a leaked or public devlog repository leaks no credential. Each
machine has its own copy; the user enters them on each machine.

## Blocks written by extensions

Blocks an extension adds carry `ext=<id>` in their marker and are automatic
blocks: read-only in the app (a todo can still be ticked), shown with a
muted brace. They go through the same data layer as the app
(`@devlog/core`), so an extension cannot break the file format (marker
escaping, append-only files, image paths). They are ordinary Markdown in the
day files and survive the extension going away.

## Downloads

- GitHub and URL extensions are pinned by SHA-256 in `devlog.lock.json`, so
  every machine runs byte-identical code.
- Zips are capped at 20 MB, unpacked contents at 100 MB.
- Unpacked into `userData/extensions/<sha256>/`, never into the devlog.

## Not built yet

- Enforcing the declared network domains.
- A command to delete an extension's data.
