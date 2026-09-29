# Development

Working on Devlog itself. For writing extensions, see
[Extension Quickstart](Extension-Quickstart).

## Setup

Requirements: Node 20+ (22.13+ to run the core's index outside Electron, which
uses `node:sqlite`), and `git` on your `PATH`.

```sh
npm install
npm run dev          # builds the built-in extensions, then runs with hot reload
```

`DEVLOG_USER_DATA=/some/folder npm run dev` keeps a development profile
(settings, consent, secrets, the index) away from your real one.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Bundle built-ins, run with hot reload (electron-vite) |
| `npm run build` | Bundle built-ins, production build into `out/` |
| `npm run typecheck` | `tsc` for main (`tsconfig.node.json`) and renderer (`tsconfig.web.json`) |
| `npm test` | Vitest: file formats, store, git sync against a local bare remote, extensions through the real host, time and timesheets, updates |
| `npm run test:watch` | The same, watching |
| `npm run smoke` | Build, then drive the real app with Playwright: post a note, sync, show the review (needs a display; `xvfb-run` on Linux) |
| `npm run screens` | Build, seed a demo devlog, screenshot every view in light and dark |
| `npm run package` | Build installers into `release/` (`package:mac`, `package:win`, `package:linux`) |

Run one test file: `npx vitest run tests/extensions.test.ts`; the core's:
`npx vitest run packages/core`.

## Where tests live

| Path | Covers |
|---|---|
| `packages/core/tests/` | Formats, oplog replay and fuzzing, order keys, store operations, index equivalence, sync, activity log, compaction, manifests, timesheets |
| `packages/extension-api/tests/` | The test harness |
| `tests/extensions.test.ts` | Real extension processes: the `probe`, `shaper` and `trusted` fixtures in `tests/fixtures/extensions/`, the sandbox's refusals, grants, views |
| `tests/devlog-time.test.ts` | The time extension against the harness |
| `tests/activity.test.ts`, `review.test.ts`, `timesheet.test.ts`, `commits.test.ts`, `updates.test.ts`, `theme.test.ts` | Pure logic in `src/shared` and the commit watcher |

## Conventions

- **Only `@devlog/core` writes to a devlog.** New file-format behaviour goes
  there, with tests.
- **Pure logic lives in `src/shared` or `@devlog/core`** and is unit-tested;
  Electron code stays thin.
- **Extension API changes are additive** and follow the checklist in
  [API Versions](API-Versions#changing-the-api-for-devlog-contributors).
- Documentation lives in `README.md`, `docs/*.md` and the package READMEs;
  this wiki summarises and links to them. Update both when behaviour
  changes.

## Releasing

1. Bump `version` in `package.json` (and `package-lock.json`) and commit.
2. Run the **Build** workflow by hand (Actions → Build → Run workflow) with
   `release_version` set to that version; it tags the commit `vX.Y.Z`.
   Pushing a `vX.Y.Z` tag (`npm version minor && git push --follow-tags`)
   does the same.
3. CI runs typecheck, unit tests, the build and the Playwright smoke test;
   only if all pass does it package Windows and macOS builds and publish a
   GitHub release with the installers and the `latest*.yml` manifests that
   installed apps update from.

CI does not code-sign macOS builds, so they run but do not update
themselves; the Windows build does. Installed apps check for updates shortly
after launch and every four hours, and restart into a new version only when
the app is not in use (screen locked, window hidden or unfocused and idle, or
an update waiting a day and a pause in typing), never during a sync or with
an unsaved edit.

## Publishing this wiki

The wiki's pages live in the repository under `wiki/` (one Markdown file per
page, `Home.md`, `_Sidebar.md` and `_Footer.md` included), so they are
reviewed like code. To publish them to the GitHub wiki:

```sh
git clone https://github.com/sdeken/devlog.wiki.git
cp wiki/*.md devlog.wiki/
cd devlog.wiki && git add -A && git commit -m "Update wiki" && git push
```

(Create the wiki's first page once in the GitHub UI if the wiki repository
does not exist yet.)
