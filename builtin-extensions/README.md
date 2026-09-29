# Built-in extensions

Extensions that ship inside the Devlog app, one folder each (with a
`devlog-extension.json`). A devlog enables one with `"<name>": "builtin"` in
its `devlog.json`; it still asks before it starts, and runs sandboxed unless
it says it needs more (Window tracking does, and asks you to trust it).
Once allowed, a built-in keeps its grant when the app updates it.
Packaged into the app's resources as `extensions/`.

An extension written in TypeScript keeps its sources in `src/`: `src/main.ts`
is bundled to `dist/main.js` (its manifest's `main`), and each
`src/views/<view>.tsx` to `dist/views/<view>.html` with its script and
styles (React and `@devlog/ui` included), by `scripts/build-builtins.mjs`.
`npm run build` runs it first (and so do `dev`, `package`, `smoke` and
`screens`). `dist/` is not committed; `src/` is not packaged.
