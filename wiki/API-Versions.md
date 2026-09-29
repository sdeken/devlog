# API versions

The extension API is versioned separately from the app
(`EXTENSION_API_VERSION` in `packages/core/src/extensions.ts`, `API_VERSION`
in `@devlog/extension-api`). Every change so far has been **additive**: there
has been no 2.0, and an extension built for 1.0 still loads in an app that
provides 1.7.

- Declare the **lowest** version you need in the manifest: `"api": "^1.6.0"`.
- `ctx.apiVersion` tells you what the running app provides, for optional
  features.

| API | Devlog | Headline |
|---|---|---|
| 1.7 | 0.18 | Activity and ranges, managed canvases, sending through destinations, `openPage`, non-inherited fields |
| 1.6 | 0.17 | Node types, canvas writes, command context/keys/menus/post, events, pick/open/highlight, tray, time providers, canvas-header views |
| 1.5 | 0.16 | Views and `@devlog/ui` |
| 1.4 | — | Todos; blocks inside blocks |
| 1.3 | — | Timesheet destinations |
| 1.2 | — | Unrestricted (trusted) extensions, `packageDir` |
| 1.1 | — | `machine`, focus providers |
| 1.0 | — | The base API |

## 1.7

- `devlog.activity(from, to)`: what the app recorded, merged with providers.
- `devlog.range(from, to)`: day files with blocks written in a range.
- `devlog.managedCanvas(key, { title })`: a canvas the extension keeps;
  `addBlock` gains `kind` and free `date` there, and `editBlock` works on any
  block there.
- `ui.openPage(viewId)`.
- `permissions.send`; `destinations.list()`, `preview(to, sheet)`,
  `send(to, sheet)`; types `DestinationInfo`, `SheetToSend`.
- Canvas fields may say `"inherited": false`.
- Views send `key` messages for shortcuts they did not use.
- Types: `ActivityRecord`, `ExtensionDayBlocks`.

## 1.6

- **Node types**: `contributes.nodeTypes`; `ExtensionCanvas.type`.
- `devlog.createCanvas`, `updateCanvas`, `editBlock`, `promote`.
- `devlog.onBlockAdded(cb)`.
- Commands: a `CommandContext` argument (`source`, `canvasId`, `date`,
  `blockId`); manifest `keybinding`, `menus` (`canvas`, `block`, `tray`),
  `nodeType`, `post`, `tag`.
- `ui.pick`, `ui.open`, `ui.highlight`.
- `app.setTrayLabel`, `app.keepRunning`.
- `activity.idleAfter(minutes)`.
- `provide.activity(fn)` and `TimeEvent`.
- Views: `canvasHeader` placement, `nodeType` on views, the `context`
  message and `ViewContext`.

## 1.5

- `contributes.views` with placements `page`, `statusbar`, `popover`.
- `views.handle`, `views.post`.
- The view message protocol (`@devlog/extension-api/view`) and `@devlog/ui`.

## 1.4

- `devlog.todos({ doneSince })` and `ExtensionTodo`.
- `addBlock` options `parentId` + `date` (inside a block) and `todo`.

## 1.3

- `contributes.destinations`, `destinations.register(id, { preview, send })`.
- Types `DestinationSheet`, `DestinationEntry`, `DestinationLine`,
  `SendResult`, `Destination`.

## 1.2

- `permissions.unrestricted` and `ctx.packageDir`.

## 1.1

- `ctx.machine`.
- `provide.focus(fn)` and `FocusEvent`.

## 1.0

- `ctx.id`, `ctx.apiVersion`.
- `devlog.canvases`, `field`, `days`, `blocks`, `search`, `addBlock`.
- `settings.get` / `onChange`; `secrets.get` / `set` / `delete`.
- `files.repo` / `files.local`.
- `activity.on`.
- `ui.notify`, `ui.confirm`.
- `commands.register`.
- Manifest: `canvasFields`, `settings`, `secrets`, `commands`, `check`,
  `permissions.read` / `write` / `network`, `appendOnly`.

## Changing the API (for Devlog contributors)

1. Add the member to `packages/extension-api/src/index.ts` with a comment
   naming the new version, and to `APP_METHODS` in `protocol.ts` if the
   extension calls the app.
2. Implement it in the host process (`src/main/extensions/hostProcess.ts`)
   and the manager (`src/main/extensions/manager.ts`), filtered by the grant.
3. Mirror it in the test harness (`packages/extension-api/src/testing.ts`).
4. Bump `API_VERSION` and `EXTENSION_API_VERSION` together, and the version
   in `docs/EXTENSIONS.md` and `packages/extension-api/README.md`.
5. Cover it in `tests/extensions.test.ts` through the real host (the
   `probe` or `shaper` fixture).
6. Update this wiki: the [API reference](Extension-API-Reference), the
   [types](Extension-Types) and this page.
