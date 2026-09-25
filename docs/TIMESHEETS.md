# Timesheets: design (draft)

Status: **draft for discussion**, nothing built yet. Replaces the simple
"export the review's rows" idea in `EXTENSIONS.md` (issue #2).

## The problem

Tracked time has to reach more than one outside system, and they disagree:

| | Jira | CMS |
|---|---|---|
| Unit | a task (Jira issue) | a client |
| Needs | when the work happened (start + duration) | hours (per day or per week, TBD) |
| Ids | Jira issue keys | CMS client ids, unrelated to Jira's |
| Which clients | only some (the as-needed client) | all of them |
| Rules | none known | weekly cap: the full-time client is reported at most 40 h/week, even when more was worked |

Across everything, **every reported duration is a multiple of 15 minutes**
(a firm rule). The rules change over time: clients come and go, and caps and
mappings change.

So the time log cannot go straight to a destination. It goes through a
**timesheet**: a weekly synopsis you review and shuffle, then send to each
destination. The timesheet is also the permanent record of what was worked
and what was reported.

## Shape

```
activity log + blocks ──► draft timesheet ──(you edit)──► approved timesheet
                              │                                  │
                         rounding, sessions            per-destination views
                                                        (Jira by task + times,
                                                         CMS by client, capped)
                                                                 │
                                                       preview ──► submit ──► recorded
```

- **The timesheet is core, destinations are extensions.** The synopsis comes
  from Devlog's own tracking data, and several destinations share one
  synopsis. It is useful on its own (history, CSV). Extensions (#1)
  contribute destinations: how to group, which ids, which rules, how to send.
- **One timesheet per week** (Monday to Sunday, like the review).

## The timesheet

A list of **entries**, each one piece of work:

| field | |
|---|---|
| date, start, minutes | when; `start` is local time, rounded to the quarter hour |
| canvas | the task (or client/project) canvas it belongs to |
| client | derived: the nearest ancestor canvas marked as a client |
| note | optional description, prefilled from that session's blocks |
| source | tracked / explicit (`[2h]` marker) / estimated / manual |
| worked | the unrounded minutes, kept for the record |

### Building the draft

1. Take the week's tracked task segments (what the timeline shows; removed
   time already excluded, explicit durations already applied) and the
   estimated time for untracked days.
2. **Merge into sessions:** consecutive segments on the same task with small
   gaps (a few minutes of lock or idle) become one session.
3. **Round each session**: start to the nearest quarter hour, duration to
   the nearest 15 minutes (never below 15 for a session that is kept).
   Sessions that round to zero are listed separately so nothing disappears
   silently.
4. Nudge starts so rounded sessions on the same day don't overlap.

Rounding happens **once, here**. Every destination total is a sum of
rounded entries, so Jira and CMS always agree with each other and with the
timesheet, and every number is a multiple of 15 minutes by construction.

### Editing ("shuffling")

A grid for the week: drag an entry to another task or day, change start or
duration (in 15-minute steps), split an entry, merge two, add a manual one
(e.g. a call that wasn't tracked), drop one, edit the note. The grid shows,
live and per destination, what would be sent and which rules apply (for
example "CMS: Acme capped at 40 h, 3 h 15 m not reported").

Editing never changes the activity log or blocks. The timesheet is a
separate record, and the original tracked time stays available alongside it.

## Destinations

Each destination (from an extension) declares:

- **Mapping:** which canvases it takes, and their external ids. These are
  per-canvas fields, e.g. `jira.issue: ACME-123` on a task canvas and
  `cms.client: 7731` on a client canvas, inherited down the tree. A canvas
  with no mapping for a destination is not sent there (so the full-time
  client never reaches Jira). An entry the destination should take but
  can't map (a task with no Jira issue) is flagged in the grid, to fix
  before sending.
- **Grouping:** how entries become lines. Jira: one worklog per entry
  (issue, start, duration, note). CMS: per client per day (or week).
- **Rules:** adjustments applied to the grouped lines, shown before
  sending:
  - `weeklyCap` per client: report at most N hours in a week. Proposed
    default: trim from the end of the week backwards; you can move the cut
    to other days in the grid.
  - more as needed (minimum per day, excluded days…), each a small pure
    function over lines, unit-tested.
- **Send:** submit the lines; return an external id per line.

### Rules change over time

Destination settings (mappings, caps, which clients) are **dated**: each
change has a `from` date, and a week uses the settings in force on its
Monday. The approved timesheet records a snapshot of the rules it was sent
under, so an old week reads the same after the rules change.

## Storage: a managed canvas

The timesheets live in a Devlog-managed canvas, **Timesheets** (created on
first use, not a task, shown in the sidebar like any canvas):

- **One block per week** (`kind=timesheet`, `week=2026-09-21`): the body is
  a readable markdown table of the entries (date, start, duration, task,
  client, note), so the record is human-readable in git with no app needed.
  Edits while drafting are ordinary `edit` records (append-only, so the
  history of the shuffling is kept too).
- **One reply per submission** (`kind=timesheet-sent`,
  `destination=jira`): the lines sent, their external ids, and the rules
  snapshot. This thread is the ledger: sending again compares against it,
  so a second press, or a second machine, sends only what changed, and
  corrections after the fact send differences.
- Timesheet blocks are automatic blocks (edited through the grid, not as
  text).

## Where the pieces live

- `@devlog/core`: building the draft (sessions, rounding), the entry model,
  reading and writing timesheet blocks, applying dated settings, generic
  rules like `weeklyCap`. Pure and unit-tested.
- App: the weekly timesheet grid, the managed canvas, preview and submit UI.
- Extensions: Jira and CMS destinations (mapping fields, grouping,
  destination-specific rules, sending, credentials). A built-in CSV
  destination (#4) needs no extension.

## Open questions

1. **CMS granularity:** hours per client per *day* or per *week*? Does it
   take a note or description? Start times?
2. **Capping:** when the full-time client passes 40 h, which hours go
   unreported: the end of the week (proposed), spread evenly, or your pick
   each time? Is the cap on *reported* CMS hours only (the timesheet keeps
   the real total)?
3. **Jira mapping:** does every task under the as-needed client get its own
   Jira issue, or is there a fallback issue per client for untracked
   "misc" work?
4. **Jira start times:** rounded to the quarter hour too (proposed), or
   the real start?
5. **Tiny sessions:** a session under 7½ minutes rounds to zero. Drop it
   (listed, proposed), or fold it into the neighbouring session on the same
   task?
6. **Week boundary for the cap:** does CMS's week also run Monday to Sunday?
