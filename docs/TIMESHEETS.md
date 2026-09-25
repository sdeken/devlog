# Timesheets: design (draft)

Status: **draft for discussion**, nothing built yet. Replaces the simple
"export the review's rows" idea in `EXTENSIONS.md` (issue #2).

## The problem

Tracked time has to reach more than one outside system, and they disagree:

| | Jira | CMS |
|---|---|---|
| Unit | a task (Jira issue) | a client |
| Needs | when the work happened (start + duration) | hours per client per day |
| Ids | Jira issue keys | CMS client ids, unrelated to Jira's |
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
                     sessions, rounding,              per-destination views
                     suggested trims                 (Jira: per task, with times
                                                      CMS: per client per day)
                                                                 │
                                                       preview ──► submit ──► recorded
```

- **The timesheet is core, destinations are extensions.** The synopsis comes
  from Devlog's own tracking data, and several destinations share one
  synopsis. It is useful on its own (history, CSV). Extensions (#1)
  contribute destinations: which canvases they take, their ids, how lines
  are grouped, and how to send them. Destinations contain **no business
  rules** (caps, minimums): those are yours to apply while adjusting.
- **One timesheet per week**, Monday to Sunday like the review. CMS's own
  weeks run Sunday to Saturday, but it takes hours per day, so where a week
  is cut doesn't change what it receives.

## The timesheet

A list of **entries**, each one piece of work:

| field | |
|---|---|
| date, start, minutes | when; `start` is local time, rounded to the quarter hour |
| canvas | the task (or client/project) canvas it belongs to |
| client | derived: the nearest ancestor canvas marked as a client |
| note | optional; empty by default (see *Comments*) |
| source | tracked / explicit (`[2h]` marker) / estimated / manual |
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
  that day, 15 minutes at a time (longest first, one step each in turn),
  never taking a session below 15 minutes. A deficit adds to the longest
  sessions the same way. Balancing within the same client and day keeps one
  client's short tasks from being paid for out of another client's hours.
- If it can't be evened out (every session is already 15 minutes), the
  grid says so: "Acme, Tue: 3 h reported for 55 min worked".
- The same numbers show per week, so a week can be checked at a glance.

Suggestions are never applied silently. They appear as marked changes in
the grid.

### Editing ("shuffling")

A grid for the week: drag an entry to another task or day, change start or
duration (in 15-minute steps), split an entry, merge two, add a manual one
(e.g. a call that wasn't tracked), drop one, edit the note. The grid shows,
live and per destination, what would be sent, alongside the time actually
worked (for example "CMS · Acme · Tue: 9 h 15 m reported, 8 h 50 m worked").

Editing never changes the activity log or blocks. The timesheet is a
separate record, and the original tracked time stays available alongside it.

## Destinations

Each destination (from an extension) declares:

- **Mapping:** which canvases it takes, and their external ids, as
  per-canvas fields, looked up by **walking up the canvas tree** to the
  nearest canvas that sets one:
  - Jira: `jira.issue: ACME-123`, normally on each task canvas. A fallback
    issue is just the key set on those tasks (or on a parent canvas, which
    all tasks beneath it then inherit).
  - CMS: `cms.client: 7731`, normally on the client canvas. Odd cases where
    one real client has several CMS clients are sub-canvases (projects)
    with their own `cms.client`, which wins for everything beneath them.

  A canvas with no mapping for a destination (nothing up the tree) is not
  sent there, so the full-time client never reaches Jira. An entry under a
  destination's canvases that can't be mapped (a task with no issue key) is
  flagged in the grid before sending.
- **Grouping:** how entries become lines. Jira: one worklog per entry
  (issue, start, duration, note). CMS: one line per CMS client per day
  (the sum of that day's entries).
- **Send:** submit the lines; return an external id per line.

### Comments

- **CMS** takes an optional comment per client per day. It is sent empty
  by default. Later, an LLM could draft it from that day's notes.
- **Jira** worklog comments are optional too, and meetings often have none.
  Empty by default, with a per-entry "fill from notes" that takes the
  top-level blocks written on the task during that session. Revisit once
  it's clear how the notes get used in practice.

What was sent (lines, the ids they mapped to at the time, external ids) is
recorded with the timesheet, so an old week reads the same after mappings
change. No dated settings are needed.

## Storage: a managed canvas

The timesheets live in a Devlog-managed canvas, **Timesheets** (created on
first use, not a task, shown in the sidebar like any canvas):

- **One block per week** (`kind=timesheet`, `week=2026-09-21`): the body is
  a readable markdown table of the entries (date, start, duration, task,
  client, note), so the record is human-readable in git with no app needed.
  Edits while drafting are ordinary `edit` records (append-only, so the
  history of the shuffling is kept too).
- **One reply per submission** (`kind=timesheet-sent`,
  `destination=jira`): the lines sent, their external ids, and the ids the
  entries mapped to at the time. This thread is the ledger: sending again compares against it,
  so a second press, or a second machine, sends only what changed, and
  corrections after the fact send differences.
- Timesheet blocks are automatic blocks (edited through the grid, not as
  text).

## Where the pieces live

- `@devlog/core`: building the draft (sessions, rounding, layout), the
  inflation arithmetic and suggested trims, the entry model, reading and
  writing timesheet blocks, and resolving a canvas's mapping by walking up
  the tree. Pure and unit-tested.
- App: the weekly timesheet grid, the managed canvas, preview and submit UI.
- Extensions: Jira and CMS destinations (mapping fields, grouping, sending,
  credentials). A built-in CSV destination (#4) needs no extension.

## Open questions

None blocking. To revisit with use: what, if anything, fills Jira and CMS
comments by default.
