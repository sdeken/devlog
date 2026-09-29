# UI kit reference (`@devlog/ui`)

`@devlog/ui` is for extension **views**: the bridge to the app and your
extension, React hooks, a handful of components and the app's look. Source:
[`packages/ui/src`](https://github.com/sdeken/devlog/tree/main/packages/ui/src).
React 18+ is a peer dependency; bundle both into each view.

| Import | Contents |
|---|---|
| `@devlog/ui` | `devlog` (the bridge), `mount`, hooks, components |
| `@devlog/ui/bridge` | `devlog` only, for pages without React |
| `@devlog/ui/styles.css` | Design tokens and `dl-*` classes |

Like `@devlog/extension-api`, it is not published to npm; take it from a
Devlog checkout (see [Extension Quickstart](Extension-Quickstart#types)).

```tsx
import '@devlog/ui/styles.css'
import { Button, Empty, mount, useCall } from '@devlog/ui'

function Page(): React.JSX.Element {
  const { data, error, loading, reload } = useCall<string[]>('items')
  if (error) return <p className="dl-error">{error}</p>
  if (loading && !data) return <Empty>Loading…</Empty>
  return (
    <div className="dl-page">
      <h1 className="dl-title">Items</h1>
      <ul>{data?.map((x) => <li key={x}>{x}</li>)}</ul>
      <Button onClick={reload}>Reload</Button>
    </div>
  )
}
mount(<Page />)
```

## The bridge: `devlog`

Importing the bridge (directly or through `@devlog/ui`) sends `ready`,
applies the app's theme variables to `:root` as they arrive (and sets
`data-theme="dark"` or `"light"` on `<html>`), and forwards shortcuts the
page did not handle (Ctrl/Cmd/Alt + key, F-keys) to the app.

| Member | Description |
|---|---|
| `call<T>(method, ...args): Promise<T>` | Ask your extension; arrives at its `ctx.views.handle(viewId, …)` handler. Rejects with the handler's error message. |
| `onMessage(cb): () => void` | Messages your extension sends with `ctx.views.post`. Returns an unsubscribe function. |
| `dark: boolean` | Whether the app is in dark mode now. |
| `onTheme(cb: (dark) => void): () => void` | Called when the theme changes. |
| `context: ViewContext` | Where the view is shown (see [Views and UI → View context](Views-and-UI#view-context)). |
| `onContext(cb): () => void` | Called when the context changes. |
| `resize({ width?, height? }): void` | Ask for a size. Status bar items get their height from the bar; the width may be clamped. |
| `popover(view, { width?, height? }?): void` | Open one of your popover views, anchored to this view. |
| `close(): void` | Close this view (a popover). |
| `open({ canvasId, date?, blockId? }): void` | Show a canvas, or a block's page, in the app. |
| `command(command): void` | Run one of your commands (with the view's context). |

## `mount(node, opts?)`

Renders a view's root component into `<div id="root">` (made if missing),
inside `StrictMode`. `opts.slot: true` adds `dl-slot` to `<body>`: a
transparent, 22 px, one-line body for status bar items.

## Hooks

| Hook | Returns | Description |
|---|---|---|
| `useCall<T>(method, args = [], deps = [])` | `{ data, error, loading, reload }` | Calls your extension on mount, when `method` or `deps` change, and on `reload()`. Keeps the last `data` while reloading or after an error. |
| `useMessages(cb)` | — | Subscribes to `ctx.views.post` messages for the component's lifetime. |
| `useDark()` | `boolean` | Whether the app is dark; re-renders on change. |
| `useViewContext()` | `ViewContext` | Where the view is shown; re-renders on change. |
| `useNow(everyMs = 1000)` | `number` | `Date.now()`, updated on an interval (for running clocks). |

```tsx
const here = useViewContext().canvasId
const { data: task } = useCall<Task | null>('task', [here ?? ''], [here])
```

## Components

### `Button`

A `<button type="button">` with the app's look. Props: every button
attribute, plus `variant` (`'default' | 'primary' | 'quiet' | 'danger'`) and
`small`.

```tsx
<Button variant="primary" onClick={save}>Save</Button>
<Button small variant="quiet" onClick={() => devlog.close()}>Cancel</Button>
```

### `Row`, `Stack`

Flex containers (`div` props): `Row` lays out horizontally with an 8 px gap,
centred; `Stack` vertically with an 8 px gap.

### `Field`

A label and its input: `<Field label="Name"><input className="dl-input" /></Field>`.

### `Empty`

A muted paragraph for empty states: `<Empty>Nothing sent yet.</Empty>`.

### `Menu`

A keyboard-driven pick list: ↑/↓ move, Enter picks, Escape closes the view
(for popovers), and an optional search box filters.

| Prop | Type | Description |
|---|---|---|
| `items` | `MenuEntry[]` | `{ key, label, hint?, onSelect }` |
| `search` | `boolean` | Show a search box (focused). |
| `placeholder` | `string` | The search box's placeholder (default "Find…"). |
| `filterText` | `(item) => string` | Text to filter by (default: the label, when it is a string). |
| `empty` | `ReactNode` | Shown when nothing matches (default "Nothing here."). |
| `extra` | `(query) => MenuEntry[]` | Entries added after the filtered ones, from what is typed (a "New …" entry). |

```tsx
<Menu
  search
  placeholder="Start a task…"
  items={tasks.map((t) => ({ key: t.id, label: t.title, hint: t.path, onSelect: () => void devlog.call('start', t.id).then(() => devlog.close()) }))}
  extra={(q) => (q ? [{ key: 'new', label: `+ New task "${q}"`, onSelect: () => void devlog.call('newTask', q) }] : [])}
/>
```

## CSS

`@devlog/ui/styles.css` sets a box-sizing reset, the body font (14 px, the
app's font) and colours from the theme variables, and these classes:

| Class | For |
|---|---|
| `dl-page` | Padding for a `page` view's content |
| `dl-title` | A page heading |
| `dl-row`, `dl-stack`, `dl-spacer` | Horizontal / vertical flex; a flexible spacer |
| `dl-btn`, `dl-btn-primary`, `dl-btn-quiet`, `dl-btn-danger`, `dl-btn-sm` | Buttons (what `Button` renders) |
| `dl-input` | Text inputs, selects |
| `dl-field` | A label with its input (what `Field` renders) |
| `dl-menu`, `dl-menu-item` (`.is-active`), `dl-menu-hint`, `dl-menu-sep` | Menus (what `Menu` renders) |
| `dl-table` (`td.num`, `th.num` right-aligned) | Tables |
| `dl-badge` (`.is-accent`) | Small labels |
| `dl-dot` (`.is-busy`, `.is-warn`) | A status dot |
| `dl-muted`, `dl-empty`, `dl-error` | Muted text, empty states, errors |
| `body.dl-slot` | A status bar item's body |

Theme variables (`--bg`, `--fg`, `--accent`, …) are listed in
[Views and UI → Theme variables](Views-and-UI#theme-variables).
