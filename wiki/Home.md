# Devlog wiki

Devlog is a desktop app for keeping a running developer log. You write
posts in a Slack-style WYSIWYG Markdown composer; Devlog stores them as plain
Markdown files in a git repository and commits and pushes them for you.
Features beyond notes (time tracking, window tracking, Jira worklogs, CMS
timesheets) come as **extensions** that each devlog opts into.

This wiki has three audiences. Pick the section that fits.

## Using Devlog

| Page | What it covers |
|---|---|
| [Getting Started](Getting-Started) | Install, create or open a devlog, first posts |
| [Concepts](Concepts) | Canvases, surfaces, blocks, pages, tasks, todos |

## Writing extensions

Start with the overview, build the quickstart, then keep the reference pages
open while you work.

| Page | What it covers |
|---|---|
| [Extensions Overview](Extensions-Overview) | The model: what an extension is, where it comes from, how it is trusted |
| [Extension Quickstart](Extension-Quickstart) | A working extension, step by step: manifest, code, test, run, release |
| [Extension Manifest](Extension-Manifest) | Every field of `devlog-extension.json` |
| [Extension API Reference](Extension-API-Reference) | `DevlogContext` (`ctx`): every namespace, method, permission and error |
| [Extension Types](Extension-Types) | Every type an extension sees, field by field |
| [Views and UI](Views-and-UI) | Pages, status bar items, popovers and canvas-header views; the view message protocol |
| [UI Kit Reference](UI-Kit-Reference) | `@devlog/ui`: the bridge, hooks, components and CSS classes |
| [Timesheet Destinations](Timesheet-Destinations) | Sending timesheets to Jira, CMS or your own system |
| [Activity and Time Data](Activity-and-Time-Data) | Pause/resume notices, idle detection, providing time and focus events |
| [Sandbox and Permissions](Sandbox-and-Permissions) | What the runtime allows, grants, limits, unrestricted extensions |
| [Testing Extensions](Testing-Extensions) | `@devlog/extension-api/testing`: the in-memory `ctx` |
| [Built-in Extensions](Built-in-Extensions) | devlog-time, devlog-focus, devlog-jira, devlog-cms as worked examples |
| [API Versions](API-Versions) | What arrived in each API version, 1.0 to 1.8 |
| [Troubleshooting Extensions](Troubleshooting-Extensions) | Common errors and what they mean |

## Working on Devlog itself

| Page | What it covers |
|---|---|
| [Architecture](Architecture) | Processes, packages, where code lives |
| [Storage Format](Storage-Format) | The repository layout and every file format |
| [Core Library](Core-Library) | `@devlog/core`: `DevlogStore`, `RepoIndex`, `SyncManager` and friends |
| [Extension Host Protocol](Extension-Host-Protocol) | How the app runs an extension process and talks to it |
| [Development](Development) | Building, testing, the smoke test, cutting a release |

## Versions

This wiki describes Devlog **0.19.0**, extension API **1.8.0**, storage
format **4**. The longer design notes live in the repository under
[`docs/`](https://github.com/sdeken/devlog/tree/main/docs); the wiki links to
them where they go deeper.
