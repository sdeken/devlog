# Extension manifest

Every extension has a `devlog-extension.json` at the top of its folder. The
app reads it **without running any code**: canvas fields, settings, commands,
views and node types show up from the manifest alone, and the consent dialog
shows its permissions. The parser is `parseExtensionManifest` in
[`packages/core/src/extensions.ts`](https://github.com/sdeken/devlog/blob/main/packages/core/src/extensions.ts);
it reports every problem at once (`Invalid extension manifest: …; …`).

## Complete example

```jsonc
{
  "name": "devlog-jira",
  "displayName": "Jira worklogs",
  "version": "1.2.0",
  "description": "Sends timesheet entries to Jira as worklogs.",
  "api": "^1.3.0",
  "main": "main.js",
  "contributes": {
    "canvasFields": [
      { "key": "issue", "label": "Jira issue", "placeholder": "ACME-123" }
    ],
    "settings": [
      { "key": "baseurl", "label": "Jira address", "type": "url", "required": true },
      { "key": "email", "label": "Account email", "type": "email" }
    ],
    "secrets": [
      { "key": "token", "label": "API token", "required": true }
    ],
    "commands": [
      { "id": "check", "label": "Check the Jira connection" }
    ],
    "check": "check",
    "destinations": [
      { "id": "worklogs", "label": "Jira" }
    ],
    "views": [],
    "nodeTypes": []
  },
  "permissions": {
    "read": false,
    "write": false,
    "network": ["*.atlassian.net"]
  },
  "appendOnly": ["sent/*.jsonl"]
}
```

## Top-level fields

| Field | Type | Required | Rules and meaning |
|---|---|---|---|
| `name` | string | yes | `^[a-z0-9][a-z0-9._-]{0,63}$`. Informational: the **id** comes from the source, not from this. |
| `displayName` | string | no | Shown everywhere in the app. Defaults to `name`. |
| `version` | string | yes | `1.2.3` or `1.2.3-pre` (a leading `v` is accepted). |
| `description` | string | no | Shown on the extension's card and in the consent dialog. |
| `api` | string | yes | The extension API range it was built for, e.g. `^1.6.0`. Declare the **lowest** you need; newer apps keep loading it. |
| `main` | string | no | The bundled entry file, a relative path inside the extension (no `..`, no backslashes). An extension with no code (fields only) can omit it. |
| `contributes` | object | no | What the app shows without running it (below). |
| `permissions` | object | no | What it asks for (below). |
| `appendOnly` | string[] | no | Globs within its repo folder (`extensions/<id>/`) that git should union-merge. |

## `contributes`

### Fields: `canvasFields`, `settings`, `secrets`

All three are lists of fields:

| Property | Type | Applies to | Meaning |
|---|---|---|---|
| `key` | string | all | `^[a-z][a-z0-9_-]{0,63}$`, unique within its list. |
| `label` | string | all | Shown beside the input. Defaults to `key`. |
| `placeholder` | string | all | Placeholder text. |
| `description` | string | all | A sentence or two under the field. |
| `type` | string | settings, canvas fields | `text` (default), `url`, `email`, `number`, `select`, `checkbox`, `textarea`. Secrets are always hidden text. |
| `options` | `{ value, label }[]` | `select` | Required for `select` (a select without options is an error). |
| `required` | boolean | settings, secrets | The extension's card says "Needs: …" until it is set. |
| `inherited` | `false` | canvas fields | (1.7) The field applies to its canvas only; canvases inside it do not take it on. |

Validation when saved (`fieldProblem`): `url` must start with `http://` or
`https://`; `email` must look like one; `number` must parse; `select` must be
one of the options; `checkbox` is the string `true` or `false`. Every value is
a **string**.

Where they are stored:

| List | Stored in | Read with |
|---|---|---|
| `settings` | `devlog.json` → `settings.<id>.<key>` (synced) | `ctx.settings.get(key)` |
| `secrets` | user data, encrypted with the OS keychain (per machine) | `await ctx.secrets.get(key)` |
| `canvasFields` | the canvas's `canvas.md` as `ext.<id>.<key>: value` | `await ctx.devlog.field(canvasId, key)` or `canvas.fields[key]` |

Canvas fields show as a page per extension in the canvas's Properties.
Unless `inherited: false`, a canvas without its own value takes the nearest
ancestor's (that is what `devlog.field` returns; `ExtensionCanvas.fields`
holds only the values set on that canvas).

### `check`

The id of one of its commands that tests the settings (a login, say). The
settings page offers **Test** and **Save and test** and shows the string the
command returns, or its error. It must name a declared command.

### `commands`

| Property | Type | Since | Meaning |
|---|---|---|---|
| `id` | string | 1.0 | `^[a-z][a-z0-9_-]{0,63}$`. Register it in code with `ctx.commands.register(id, run)`. |
| `label` | string | 1.0 | Shown in the quick switcher and menus. |
| `keybinding` | string | 1.6 | e.g. `Mod+Shift+S`. See below. |
| `menus` | string[] | 1.6 | Any of `canvas` (a canvas's right-click menu), `block` (a block's actions), `tray` (the tray icon's menu). |
| `nodeType` | string | 1.6 | Offer it only on canvases of this node type: a type id of its own (`task`) or a full name (`builtin.devlog-time/task`). |
| `post` | boolean | 1.6 | Make it a way to post from the note box: its keybinding posts the note, then runs the command on the new block (`context.source === 'post'`). |
| `tag` | string | 1.6 | With `post: true`: `#<tag>` on the first line of a note also posts this way; the tag is taken off before posting. |

**Keybindings** are normalised to one spelling: modifiers in the order `Mod`,
`Ctrl`, `Alt`, `Shift`, then one key. `Mod` is Ctrl, or Cmd on a Mac
(`CmdOrCtrl` is accepted as a synonym, as are `Control` and `Option`). The key
is a letter or digit, a punctuation mark (`` ` - = [ ] \ ; ' , . / + ``),
`F1`–`F24`, or one of `Enter Space Escape Tab Backspace Delete Home End PageUp
PageDown ArrowUp ArrowDown ArrowLeft ArrowRight`. A plain key or Shift+key is
refused (it would steal typing), except F-keys. `Mod++` means the plus key.

### `views` (1.5)

Pages from the package that the app shows in sandboxed frames.

| Property | Type | Meaning |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9_-]{0,63}$`, unique. Answer its calls with `ctx.views.handle(id, …)`. |
| `title` | string | Shown in the sidebar, switcher or tooltip. Defaults to `id`. |
| `entry` | string | An `.html` file, relative to the extension folder. |
| `placement` | string | `page`, `statusbar`, `popover` or `canvasHeader` (1.6). |
| `icon` | string | One character or emoji (at most two code points), for the sidebar. |
| `nodeType` | string | (1.6) For `canvasHeader`: show only on canvases of this type. |

See [Views and UI](Views-and-UI) for what each placement does.

### `nodeTypes` (1.6)

Kinds of canvas the extension gives meaning to.

| Property | Type | Meaning |
|---|---|---|
| `id` | string | `^[a-z][a-z0-9_-]{0,63}$`, unique. The full name is `<extension id>/<id>`. |
| `label` | string | e.g. "Task" (at most 40 characters). Offered as **New *label* inside…** and under **Type** in canvas properties. |
| `icon` | string | One character or emoji, shown before the canvas's name. |
| `placeholder` | string | Added to the note box's placeholder on canvases of this type (at most 120 characters). |

### `destinations` (1.3)

Places a finished timesheet can be sent. Each is `{ "id", "label" }` and must
be registered in code with `ctx.destinations.register(id, { preview, send })`.
See [Timesheet Destinations](Timesheet-Destinations).

## `permissions`

| Permission | Type | Meaning |
|---|---|---|
| `read` | boolean | Wants to read blocks. The user picks the scope: the whole devlog or chosen canvases. |
| `write` | boolean | Wants to add blocks and change canvases. The user picks the scope. |
| `network` | string[] | Domains it talks to (`example.com`, `*.atlassian.net`, optionally with `:port`). **Shown at consent, not enforced.** |
| `send` | boolean | (1.7) Sends finished timesheets through *other* extensions' destinations. |
| `unrestricted` | boolean | Runs without the sandbox: full file-system and process access. Runs only if the user ticks "I trust it". |

Without `read` an extension still gets its own settings, secrets, files and
the canvas fields it declared, and can list the canvases in its write scope.
See [Sandbox and Permissions](Sandbox-and-Permissions).

## `appendOnly`

Globs (`^[A-Za-z0-9_.*/{}-]{1,128}$`, relative, no `..`) within the
extension's repo folder. The app writes a `merge=union` line for each into
the devlog's `.gitattributes`, so two machines appending to the same file
never conflict. Use it for JSON-lines logs you only ever append to:

```json
"appendOnly": ["**/*.jsonl"]
```

## Common manifest errors

| Message | Fix |
|---|---|
| `"name" must be lowercase letters, digits, "." , "_" or "-"` | Rename; no capitals or spaces. |
| `"api" is not a version range: …` | Use `^1.6.0`, `~1.7.0`, `1.x`, … |
| `"contributes.settings": key "BaseURL" must be lowercase …` | Keys are lowercase. |
| `… is a select with no options` | Add `options`. |
| `… has keybinding "Shift+S"; use something like "Mod+Shift+S"` | Add `Mod`, `Ctrl` or `Alt`. |
| `"contributes.views": x needs an "entry" .html file inside the extension` | `entry` must end in `.html` and be relative. |
| `"contributes.check" must name one of its commands` | Declare the command too. |
| `"tag" is a lowercase word, on a "post" command` | Add `"post": true`. |
