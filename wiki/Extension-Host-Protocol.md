# Extension host protocol

How the app runs an extension and talks to it. Extension authors never deal
with this directly (`ctx` hides it); it matters when working on Devlog
itself, or when debugging an extension that will not start.

Types: [`packages/extension-api/src/protocol.ts`](https://github.com/sdeken/devlog/blob/main/packages/extension-api/src/protocol.ts).
Implementation: `src/main/extensions/host.ts` (the app side),
`src/main/extensions/hostProcess.ts` (inside the process),
`src/main/extensions/manager.ts` (the API, consent and grants).

## Starting the process

`ExtensionHost.start()` forks the host script (`out/main/extensionHost.js`,
copied into user data as `extension-host/host-<hash>.js`, outside any archive) with:

| Setting | Sandboxed | Unrestricted (trusted) |
|---|---|---|
| Executable | The app binary with `ELECTRON_RUN_AS_NODE=1` | same |
| `execArgv` | `--permission --allow-fs-read=<host script>` and `--max-old-space-size=256` | `--max-old-space-size=256` only |
| Environment | `ELECTRON_RUN_AS_NODE` plus `SystemRoot`, `windir`, `TZ`, `LANG`, `LC_ALL` if set | The app's full environment |
| `packageDir` | `null` | The unpacked folder |
| Serialisation | `advanced` (structured clone) over Node IPC | same |
| stdout / stderr | Piped to the app's, each line prefixed `[ext <id>]` | same |

Electron's `utilityProcess` ignores `--permission`, which is why this is a
plain Node child; the build keeps Electron's `RunAsNode` fuse on.

## Messages

App → extension (`ToExtension`):

| `t` | Fields | Meaning |
|---|---|---|
| `init` | `id`, `apiVersion`, `machine`, `packageDir`, `code`, `filename`, `settings` | Sent once. `code` is the bundle's source. |
| `call` | `id`, `method`, `args` | Run something in the extension (below). |
| `res` | `id`, `ok`, `value?`, `error?` | The answer to one of the extension's calls. |
| `settings` | `settings` | The devlog-wide settings changed. |
| `stop` | — | Run `deactivate()` if exported, then exit. |

Extension → app (`FromExtension`):

| `t` | Fields | Meaning |
|---|---|---|
| `ready` | `commands` | `activate` returned; the ids of commands registered so far. |
| `failed` | `error` | Evaluating the bundle or `activate` threw (the process then exits). |
| `call` | `id`, `method`, `args` | An API request (`APP_METHODS`). |
| `res` | `id`, `ok`, `value?`, `error?` | The answer to an app call. |
| `registered` | `command` | A command registered after `ready`. |

## Startup sequence

1. The app forks the process and sends `init`.
2. The process compiles `code` with `vm.compileFunction` as a CommonJS module
   (`exports`, `require`, `module`, `__filename`, `__dirname`). `require`
   resolves Node built-ins only.
3. It takes `activate` from `module.exports` (or `module.exports.default`)
   and calls it with a `DevlogContext` built from the init message.
4. When `activate` resolves, it sends `ready`. If that takes more than 30
   seconds the app stops the process as failed.

## Methods the extension calls (`APP_METHODS`)

Every `ctx` call becomes one of these, answered by `res`:

| Group | Methods |
|---|---|
| devlog | `devlog.canvases`, `field`, `days`, `blocks`, `search`, `addBlock`, `todos`, `createCanvas`, `updateCanvas`, `editBlock`, `promote`, `subscribe` (for `onBlockAdded`), `activity`, `range`, `managedCanvas` |
| destinations | `destinations.list`, `preview`, `send`, and `destination.register` |
| secrets | `secrets.get`, `set`, `delete` |
| files | `files.read`, `write`, `append`, `list`, `stat`, `remove` (first argument: `'repo'` or `'local'`) |
| activity | `activity.subscribe` (for `activity.on`), `activity.idleAfter` |
| ui | `ui.notify`, `confirm`, `pick`, `open`, `openPage`, `highlight` |
| app | `app.trayLabel`, `app.keepRunning` |
| registration | `provide.register` (`'focus'` or `'activity'`), `views.handle`, `views.post` |

`ctx.settings.get` never crosses the channel: the process keeps the last
settings it was sent. Registration methods tell the app what to route to the
extension; the handlers themselves stay in the process.

## Methods the app calls (`ExtensionSideMethod`)

| Method | Args | Timeout | Answer |
|---|---|---|---|
| `command.run` | `[commandId, context]` | 10 min | The command's return value (a string is shown, first 500 characters) |
| `activity.notice` | `[ActivityNotice]` | 10 s | — |
| `block.added` | `[BlockAddedEvent]` | 10 s | — |
| `provide.focus` | `[from, to]` | 20 s | `FocusEvent[]` |
| `provide.activity` | `[from, to]` | 20 s | `TimeEvent[]` |
| `destination.preview` | `[destinationId, DestinationSheet]` | 2 min | `DestinationLine[]` |
| `destination.send` | `[destinationId, DestinationSheet]` | 10 min | `SendResult` |
| `view.call` | `[viewId, method, args]` | 60 s | The handler's return value |

Answers are validated and trimmed by the manager before they reach the app's
views (unknown event types dropped, strings cut to length, at most 500 000
events).

## Where the grant is enforced

Always on the app side, in `ExtensionManager.handle`: every `devlog.*` call
checks the canvas against the read or write scope (`scopeCanvasIds`,
`visibleCanvases` from `packages/core/src/extensions.ts`), outgoing events
and command contexts are filtered the same way, and `files.*` goes through an
`ExtensionFileStore` rooted at the extension's own folders. Nothing the
process sends can widen what it sees.

## Lifecycle states

`ExtensionHost.state` is `starting`, `running`, `failed` or `stopped`, with
`error` holding the reason for a failure. The Extensions page shows it.
A process that exits unexpectedly is marked failed (`Stopped unexpectedly (…)`)
and its pending calls are rejected with `The extension stopped`.
