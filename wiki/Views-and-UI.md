# Views and UI

Views (API 1.5) are HTML pages from an extension's package that the app
shows in sandboxed frames: a page in the main area, an item in the status
bar, a popover, or a control beside a canvas's title. A view cannot reach the
network, the app's window or the extension's process directly; it talks to
its extension **through the app**, by `postMessage`.

```
┌──────── Devlog window ────────┐        ┌──── extension process ────┐
│  <iframe sandbox=allow-scripts│        │                            │
│   src=devlog-ext://…/x.html>  │        │ ctx.views.handle('x', fn)  │
│     devlog.call('status') ────┼──IPC──►│   fn('status', [])         │
│     ◄── reply ────────────────┼────────┤   return {...}             │
│     ◄── message ──────────────┼────────┤ ctx.views.post('x', data)  │
│     ◄── theme, context ───────┤        │                            │
└───────────────────────────────┘        └────────────────────────────┘
```

Other ways for an extension to show things without a view:
`ctx.ui.notify`, `confirm`, `pick`, `app.setTrayLabel`, `ui.highlight` and
blocks it writes. See [Extension API Reference](Extension-API-Reference#ctxui).

## Declaring views

```json
"contributes": {
  "views": [
    { "id": "summary", "title": "Summary", "entry": "dist/views/summary.html", "placement": "page", "icon": "Σ" },
    { "id": "status", "title": "Time tracking", "entry": "dist/views/status.html", "placement": "statusbar" },
    { "id": "picker", "title": "Start a task", "entry": "dist/views/picker.html", "placement": "popover" },
    { "id": "header", "title": "Start or stop this task", "entry": "dist/views/header.html", "placement": "canvasHeader", "nodeType": "task" }
  ]
}
```

Field rules are in [Extension Manifest → views](Extension-Manifest#views-15).

## Placements

| Placement | Since | Where | Size | Context it gets |
|---|---|---|---|---|
| `page` | 1.5 | Listed in the sidebar and quick switcher with the app's views; fills the main area. Open it from code with `ctx.ui.openPage(id)` (1.7). | The main area | — |
| `statusbar` | 1.5 | A slot in the status bar. | 22 px high; asks for a width with `resize`, clamped to 24–360 px | The canvas (and block page) on screen |
| `popover` | 1.5 | Opened by another of its views with `popover`, anchored to that view; closes on Escape, a click outside, or `close`. | Default 320 × 360; width clamped to 160–560 px, height to 640 px | The opener's context |
| `canvasHeader` | 1.6 | Beside a canvas's title, on every canvas or only those of `nodeType`. | 26 px high; starts 120 px wide and asks for a width with `resize`, clamped to 24–480 px | That canvas |

The composer (note box) is not shown on extension pages.

## How a view is served

- URL: `devlog-ext://<the devlog.json key, as hex>/<file>`, only from the
  extension's own folder and **only while the extension runs**.
- Served types: `.html`, `.htm`, `.js`, `.mjs`, `.css`, `.json`, `.svg`,
  `.png`, `.jpg`, `.woff2`. Anything else is a 404.
- The frame is `sandbox="allow-scripts"` (no same origin: no cookies,
  `localStorage` or access to the parent), with `referrerpolicy=no-referrer`.
- Content Security Policy:

  ```
  default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; font-src 'self' data:; connect-src 'none';
  frame-src 'none'; form-action 'none'; base-uri 'none'
  ```

  So: scripts from your package only (no inline `<script>`), no `fetch` or
  WebSocket, no frames, no form submission. Put network calls in the
  extension process and expose them through `views.handle`.

## Answering a view

In the extension:

```js
ctx.views.handle('status', async (method, args) => {
  switch (method) {
    case 'status': return clock.status()
    case 'start':  await clock.start(String(args[0])); return clock.status()
    default: throw new Error(`No method ${method}`)
  }
})

// Push updates to every open copy of the view.
clock.onChange((st) => ctx.views.post('status', st))
```

- One handler per view id (a later `handle` replaces it). One handler may
  serve several views: `for (const v of ['status', 'header']) ctx.views.handle(v, handler)`.
- A thrown error becomes a rejected `devlog.call` in the page, with the
  error's message.
- Calls time out after 60 seconds. A call made before the handler is
  registered fails with `The view "…" has no handler yet`.

## Writing a view with `@devlog/ui`

`@devlog/ui` is a small React kit: the bridge, hooks, a few components and
the app's look. Bundle it into the view's script. Full reference:
[UI Kit Reference](UI-Kit-Reference).

`src/views/status.tsx`:

```tsx
import '@devlog/ui/styles.css'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button, devlog, mount, useCall, useMessages, useViewContext } from '@devlog/ui'

interface Status { active: string | null; label: string | null }

function StatusItem(): React.JSX.Element {
  const initial = useCall<Status>('status')
  const [st, setSt] = useState<Status | undefined>()
  useMessages((d) => setSt(d as Status))            // ctx.views.post('status', …)
  const shown = st ?? initial.data
  const here = useViewContext().canvasId            // the canvas on screen

  // Ask for the width the content needs.
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) devlog.resize({ width: Math.ceil(ref.current.scrollWidth) + 2 })
  })

  return (
    <div className="dl-row" ref={ref}>
      <span className="dl-muted">{shown?.label ?? 'No active task'}</span>
      {here && <Button small variant="primary" onClick={() => void devlog.call('start', here)}>Start</Button>}
      <Button small variant="quiet" onClick={() => devlog.popover('picker', { width: 340, height: 380 })}>▾</Button>
    </div>
  )
}

mount(<StatusItem />, { slot: true }) // slot: the status bar's styling
```

Build each view to one script and one stylesheet next to an HTML file.
esbuild, as `scripts/build-builtins.mjs` does for the built-ins:

```sh
npx esbuild src/views/status.tsx --bundle --platform=browser --format=iife \
  --target=chrome120 --jsx=automatic --minify \
  --define:process.env.NODE_ENV='"production"' \
  --outfile=dist/views/status.js
```

`dist/views/status.html`:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Time tracking</title>
<link rel="stylesheet" href="status.css">
</head>
<body>
<div id="root"></div>
<script src="status.js"></script>
</body>
</html>
```

## Writing a view without React

Any page can speak the protocol. Import `@devlog/ui/bridge` alone, or send
the messages yourself:

```js
// view.js (loaded with <script src="view.js">; inline scripts are blocked)
let next = 1
const waiting = new Map()
const send = (msg) => window.parent.postMessage({ devlog: 1, ...msg }, '*')

window.addEventListener('message', (ev) => {
  if (ev.source !== window.parent || ev.data?.devlog !== 1) return
  const m = ev.data
  if (m.type === 'theme') for (const [k, v] of Object.entries(m.vars)) document.documentElement.style.setProperty(k, v)
  if (m.type === 'reply') { const w = waiting.get(m.id); waiting.delete(m.id); m.ok ? w?.resolve(m.value) : w?.reject(new Error(m.error)) }
  if (m.type === 'message') render(m.data)
})

const call = (method, ...args) => new Promise((resolve, reject) => {
  const id = next++
  waiting.set(id, { resolve, reject })
  send({ type: 'call', id, method, args })
})

send({ type: 'ready' })
call('status').then(render)
```

## Message protocol

Types: `@devlog/extension-api/view`. Every message carries `devlog: 1`.
Messages from anything but `window.parent` should be ignored.

### From the page to the app (`ViewToApp`)

| `type` | Fields | Since | Meaning |
|---|---|---|---|
| `ready` | — | 1.5 | The page is listening. The app answers with `theme`, then `context`. |
| `call` | `id`, `method`, `args` | 1.5 | Ask the extension (its `views.handle` handler). Answered by `reply` with the same `id`. |
| `resize` | `width?`, `height?` | 1.5 | The size the page would like. Status bar and header items get their height from the bar. |
| `popover` | `view`, `width?`, `height?` | 1.5 | Open one of the extension's `popover` views, anchored to this one. |
| `close` | — | 1.5 | Close this view (a popover). |
| `open` | `canvasId`, `date?`, `blockId?` | 1.5 | Show a canvas, or a block's page, in the app. |
| `command` | `command` | 1.5 | Run one of the extension's commands, with `source: 'view'` and the view's context (1.6). |
| `key` | `key`, `code`, `ctrlKey`, `metaKey`, `altKey`, `shiftKey` | 1.7 | A shortcut the page did not use (Ctrl, Alt or Cmd with a key; F-keys), so Ctrl+K and the like still reach the app. `@devlog/ui/bridge` sends these for you. |

### From the app to the page (`AppToView`)

| `type` | Fields | Since | Meaning |
|---|---|---|---|
| `theme` | `vars`, `dark` | 1.5 | The app's colours as CSS custom properties, and whether it is dark. Sent after `ready`, on load, and whenever the theme changes. |
| `reply` | `id`, `ok`, `value?`, `error?` | 1.5 | The answer to a `call`. |
| `message` | `data` | 1.5 | Something the extension sent with `ctx.views.post`. |
| `context` | `context: ViewContext` | 1.6 | Where the view is shown; sent after `theme`, and again when it changes. |

### Theme variables

`--bg`, `--bg-2`, `--bg-3`, `--fg`, `--fg-muted`, `--border`,
`--border-strong`, `--accent`, `--accent-fg`, `--warn`, `--danger`, `--ok`,
`--link`, `--code-bg`, `--shadow`, `--mono`, `--sans`, `--font`. Use them in
your CSS (`color: var(--fg)`) and the view follows the user's theme and
light/dark mode. `@devlog/ui/styles.css` has defaults for the moment before
the first `theme` message.

### View context

| Placement | `context` |
|---|---|
| `canvasHeader` | `{ canvasId }` of the canvas it sits on |
| `statusbar` | The canvas on screen, and `date` + `blockId` when a block page is on screen |
| `popover` | The context of the view that opened it |
| `page` | `{}` |

Commands run from a view (`command` message) get the same context.

## Tips

- Keep state in the extension process and push it with `views.post`; views
  come and go (a popover closes, the user navigates).
- Several copies of a view can be open at once; `post` reaches them all.
- Status bar items: call `resize` whenever the content changes width, and use
  `mount(…, { slot: true })` (or `body.dl-slot`) for a transparent,
  one-line, 22 px body.
- A view loads only while its extension runs; if the extension is stopped
  the frame shows nothing.
