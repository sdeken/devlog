# Timesheets: design

Status: built. The arithmetic is in `@devlog/core` (`timesheet.ts`:
rounding, sessions, draft entries, suggested trims, the stored model), the
week's draft in `src/shared/timesheet.ts`, and the weekly **Timesheet** page
with its storage in the Timesheets canvas belongs to the time extension
(devlog-time) since 0.18.0. Sending goes to destinations other extensions
provide: **Jira worklogs** (devlog-jira) and **CMS timesheets** (devlog-cms,
which fills in the CMS web form; CMS has no API). Since 0.19 a draft week
follows tracked time (your changes are kept apart and laid over it), and
tracked time is corrected at the source (*Corrections*, below). Merging
entries, dragging them, and a per-destination view in the grid are not
built.

## The problem

Tracked time has to reach more than one outside system, and they disagree:

| | Jira | CMS |
|---|---|---|
| Unit | a task (Jira issue) | an assignment (client / project) |
| Needs | when the work happened (start + duration) | decimal hours per assignment per day |
| Ids | Jira issue keys | CMS assignment numbers, unrelated to Jira's |
| Which clients | only some (the as-needed client) | all of them |

Every reported duration follows one firm rounding rule (below). Anything
else, such as how many hours a client should be billed in a week, changes
too often to encode. Devlog reports what was worked, rounded, and **you
finalise it**.

So the time log cannot go straight to a destination. It goes through a
**timesheet**: a weekly synopsis you review and adjust, then send to each
destination. The timesheet is also the permanent record of what was worked
and what was reported.

## Shape

```
activity log + blocks ──► draft timesheet ──(you adjust)──► final timesheet
                              │                                  │
                     sessions, rounding,              per-destination preview
                     suggested trims                 (Jira: per task, with times
                                                      CMS: per client per day)
                                                                 │
                                                       preview ──► send ──► recorded
```

Sending is always something you do: pick a week and a destination, look at
the preview, press **Send**. There are no scheduled or automatic exports.

- **The timesheet is devlog-time's, destinations are other extensions.**
  The synopsis comes from the tracked time the app replays, and several
  destinations share one synopsis. It is useful on its own (history).
  Destination extensions decide which canvases they take, their ids, how
  lines are grouped, and how to send them. Destinations contain **no
  business rules** (caps, minimums): those are yours to apply while
  adjusting.
- **One timesheet per week**, Monday to Sunday like the review.
- **Using it:** open **Timesheet** in the sidebar (a page of the time
  extension). The week is a grid: a column per day plus the week, a row per
  task grouped under its client (with the client's totals), and the day
  totals reported and worked at the bottom. Until it is final the week
  **follows tracked time**: it is drawn again from tracked time whenever it
  is shown, and every minute while the current week is on screen, so a
  running task keeps counting; your changes are laid over it (*Editing*,
  below). Clicking a cell opens its entries underneath. A client's cell
  shows the suggested trim for that day (click to apply). **Mark final**
  approves the week as it stands and freezes it until you Reopen it. Every
  change is saved within a second. Hour targets on canvases show above the
  grid.

## The timesheet

A list of **entries**, each one piece of work:

| field | |
|---|---|
| date, start, minutes | when; `start` is local time, rounded to the quarter hour |
| canvas | the task (or client/project) canvas it belongs to |
| client | derived: the top-level canvas the task is under (a column in the stored table, not a field) |
| note | optional; empty by default (see *Comments*) |
| source | tracked (explicit `[2h]` markers already applied) / estimated / manual |
| worked | the unrounded minutes, kept for the record |

### Rounding (the firm rule)

For a duration of `m` minutes:

- `m = 0` → 0;
- `0 < m < 22.5` → **15** (anything worked counts as at least a quarter hour);
- otherwise → the nearest multiple of 15, exact halves rounding up:
  22.5–37.49… → 30, 37.5–52.49… → 45, and so on.

That is `m > 0 ? 15 · max(1, ⌊m / 15 + ½⌋) : 0`. Start times round to the
nearest quarter hour, halves up.

### Building the draft

1. Take the week's tracked task segments (what the timeline shows; removed
   time already excluded, explicit durations already applied) and the
   estimated time for untracked days.
2. **Merge into sessions:** segments on the same task, with no other task
   in between, are one session unless a gap between them is **longer than
   30 minutes** (lunch). Shorter gaps (the screen locked for a break) count
   as work: a session runs from its first segment's start to its last
   segment's end, so its worked time can be a little more than the tracked
   time the review shows. Sessions are also split at midnight.
3. **Round each session** with the rule above. Rounding happens once, here:
   every destination total is a sum of rounded entries, so Jira, CMS and the
   timesheet always agree, and every number is a multiple of 15 minutes by
   construction.
4. Lay the rounded sessions out without overlaps: starts on quarter hours,
   in the order they happened, each starting no earlier than the previous
   one ends.

The tracked segments already carry your corrections (below), and a gap you
said was not worked is never counted as work in step 2, however short.

Entry ids are stable, so what you change and what destinations remember
stays on the right entry as time accumulates: a tracked entry's id comes
from its session's start and canvas (`t…`), an estimated one's from its
day and canvas (`n…`), one you add is `m1`, `m2`, …. A session that grows
keeps its id; one whose start you correct, or that moves to another task,
gets a new id, and your changes move to it (`carryAdjustments`: the entry
on the same canvas that overlaps it most, or else the one with exactly its
time).

### Rounding inflation, and suggested trims

The rule inflates days full of short tasks: a dozen 2–5 minute tasks report
3 h for under an hour of work. It usually evens out because a long task
gets logged a bit short, but that's done by hand today. The draft does the
arithmetic and **suggests** the evening-out; you accept, change or ignore
each suggestion.

- **Per client per day** (the CMS line; a client here is the top-level
  canvas a task sits under): the target is the rounded total
  actually worked for that client that day, `round(Σ worked)`. The draft's
  line is `Σ round(each session)`. The difference is the inflation (or,
  more rarely, a deficit).
- **Suggestion:** take the difference out of that client's longest sessions
  that day, 15 minutes at a time, each step from whichever session is then
  the longest, never taking a session below 15 minutes. A deficit adds to the longest
  sessions the same way. Balancing within the same client and day keeps one
  client's short tasks from being paid for out of another client's hours.
- A client's day cell shows what was reported and worked when you hover it;
  the grid's footer has the day totals, reported and worked.

Suggestions are never applied silently. They show as a button on the
client's day cell (−0:15, or +0:15 for a deficit); clicking it applies that
day's suggestions for the client.

### Editing ("shuffling")

A draft week is two things laid together: the **draft** drawn from tracked
time, and **your changes**, kept apart in the saved timesheet
(`adjustments`) so that more tracked time never pushes them out, and a
draft never has to be rebuilt by hand:

- **Reported time**: minutes added to or taken from a tracked or estimated
  entry (− / + in 15-minute steps, and applied trims), as a difference from
  the rounded time, so it still applies as the entry grows.
- **Notes** on tracked or estimated entries.
- **Entries you add** (a call that wasn't tracked): stored whole, with day,
  start, duration, task and note. Moving an estimated entry to another day,
  time or task turns it into one of these.
- **Estimates you removed.**

`resolveTimesheet` lays them over the fresh draft (pushing an entry you
lengthened past the next one rather than overlapping it). **Drop my
changes** clears them. A final timesheet is exactly what was saved.

What happened, as opposed to what you report, is not edited here: a
tracked entry's start, end, task or removal is a **correction** to tracked
time (below), so the review, timeline, summary and timesheet agree.

**+ Add a task…** adds a row for a task with no time yet. What each
destination would get shows in its Send preview.

A timesheet saved before 0.19 has no `adjustments`: it stays exactly as
saved (it does not count time tracked since) until you press **Follow
tracked time…**, which keeps the entries you added, and the notes and
changed durations of tracked entries that still match one (same task, day
and start; durations only where the time behind them has not changed).
Changed tasks on tracked entries are not carried over: reassign that time.

### Corrections

A correction says what a stretch of time was, whatever was tracked: *from
14:00 to 15:00 on Tuesday was Globex*, or *was not work*. devlog-time writes
it to its own log (`assign` events, extension API 1.8), filed on the day it
corrects and stamped with when it was made; an undo is an `assign` that
`cancels` it. The app applies corrections after replaying the clock and
duration markers, in the order they were made (a later one wins where two
overlap): the window is cut out of whatever was tracked and, unless it was
not work, one segment on the given canvas fills it. Time outside the window
is untouched, so a task still running keeps counting past a correction
made in the middle of it. The review's **Trim** and **Remove** are older
corrections of the same kind (`exclude` events in the app's log).

From the Timesheet: moving a tracked entry's start earlier assigns the time
before it to its task; a later start, or an earlier end, marks what is
outside as not worked; a later end assigns the time after; a new task
assigns the whole stretch; removing it marks it not worked. **Reassign
time…** takes any window on any day, which is how a stretch that is still
running is split. The week's corrections are listed under the grid, each
with **Undo**.

## Destinations

Each destination (from an extension) declares:

- **Mapping:** which canvases it takes, and their external ids, as
  per-canvas fields, looked up by **walking up the canvas tree** to the
  nearest canvas that sets one:
  - Jira: `ext.builtin.devlog-jira.issue: ACME-123` (canvas properties →
    Jira worklogs), normally on each task canvas. A fallback
    issue is just the key set on those tasks (or on a parent canvas, which
    all tasks beneath it then inherit).
  - CMS: `ext.builtin.devlog-cms.assignment: 12345` (or the project name),
    normally on the client canvas. Where one real client has several CMS
    assignments, sub-canvases (projects) set their own, which wins for
    everything beneath them.

  A canvas with no mapping for a destination (nothing up the tree) is not
  sent there, so the full-time client never reaches Jira. An entry under a
  destination's canvases that can't be mapped (a task with no issue key) is
  listed in the Send preview as not sent, with the reason.
- **Grouping:** how entries become lines. Jira: one worklog per entry
  (issue, start, duration, note). CMS: one line per assignment per day
  (the sum of that day's entries). CMS weeks run Sunday to Saturday, so a
  Devlog week touches two; a day only opens in CMS on the day itself (and
  not outside the assignment's dates), so time on a later day is held back
  until then.
- **Preview and send:** show what would be created, changed or removed,
  then send it, reporting what went through, what failed, and a one-line
  summary.

### Comments

- **CMS** takes a description per assignment per day. devlog-cms sends the
  day's entry notes joined with `; ` when there are any, and otherwise keeps
  what CMS has. Later, an LLM could draft it from that day's notes.
- **Jira** takes the entry's note as the worklog comment (empty when there
  is none).

What was sent is kept by each destination in its own ledger (below), so an
old week reads the same after mappings change. No dated settings are
needed.

## Storage: a managed canvas

Since 0.18 the timesheet is the time extension's (devlog-time): its page,
its storage, its send flow. The timesheets live in a canvas it keeps,
**Timesheets** (created on first use, not a task; marked `devlog.managed:
timesheets`, the mark the app gave it before, which devlog-time takes as
its own). Like every canvas an extension keeps, it stays out of the
sidebar, the quick switcher, pickers, search, the review and the timeline:
it is the extension's storage, reached through the Timesheet page.

- **One block per week** (`kind=timesheet`, `week=2026-09-21`): the body is
  a readable markdown table of the entries (date, start, duration, task,
  client, note), so the record is human-readable in git with no app needed,
  followed by the exact data in a `devlog-timesheet` fence, which is what is
  read back: the entries as of the save, and your changes (`adjustments`).
  Edits while drafting are ordinary `edit` records (append-only, so the
  history of the shuffling is kept too).
- **What was sent** is kept by each destination extension in its own synced
  folder (devlog-jira: `extensions/builtin.devlog-jira/sent/<week>.json`,
  entry id → issue, worklog id and what was sent; devlog-cms:
  `extensions/builtin.devlog-cms/sent/<week>.json`, assignment and day →
  hours). Jira compares against its ledger, so a second press, or a second
  machine, sends only what changed, and corrections after the fact send
  differences; CMS compares against what CMS shows, and uses its ledger to
  set days it filled before back to 0. Each send also
  leaves a read-only reply under the week's timesheet block ("Sent to Jira: 3
  worklogs created, 1 updated (4:15 on 2 issues)"), written by devlog-time,
  so the history reads in the notebook itself. devlog-time reaches the
  destinations through the app (`destinations.preview` / `send`, with
  `permissions.send`), which gives each destination the week with labels
  and its own canvas fields, as before.
- Timesheet blocks are automatic blocks (edited through the grid, not as
  text).

## Where the pieces live

- `@devlog/core`: sessions, rounding, layout, the inflation arithmetic and
  suggested trims, the entry model and stable ids, laying your changes over
  a fresh draft (`resolveTimesheet`, `carryAdjustments`, `adoptTimesheet`),
  the timesheet block format, and resolving a canvas's mapping by walking
  up the tree (`inheritedField`).
  Pure and unit-tested.
- `src/shared/timesheet.ts`: the week's draft (tracked time, and the
  review's estimates for untracked days), bundled into devlog-time's page.
- `src/shared/activity.ts`: corrections (`activeCorrections`,
  `applyCorrections`), applied wherever tracked time is read.
- devlog-time: the weekly timesheet grid and the Summary (pages built on
  `@devlog/ui`), corrections in its log, the Timesheets canvas, preview and
  send, hour targets.
- App: what it recorded (`devlog.activity`), block ranges, the kept canvas,
  and passing sheets to the destinations.
- Extensions: Jira and CMS destinations (mapping fields, grouping, sending,
  credentials).

## Open questions

None blocking. To revisit with use: what, if anything, fills Jira and CMS
comments by default.
