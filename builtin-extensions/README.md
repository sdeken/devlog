# Built-in extensions

Extensions that ship inside the Devlog app, one folder each (with a
`devlog-extension.json`). A devlog enables one with `"<name>": "builtin"` in
its `devlog.json`; it still runs sandboxed and still asks before it starts.
Packaged into the app's resources as `extensions/`.

An extension written in TypeScript keeps its sources in `src/`: `src/main.ts`
is bundled to `dist/main.js` (its manifest's `main`), and each
`src/views/<view>.tsx` to `dist/views/<view>.html` with its script and
styles (React and `@devlog/ui` included), by `scripts/build-builtins.mjs`,
which `npm run build` runs first. `dist/` is not committed; `src/` is not
packaged.
