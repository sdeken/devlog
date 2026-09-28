# Block pages and todos as blocks: design

Status: agreed. Phase 1 (block pages) in 0.14.0; phases 2 and 3 to follow.

## The idea

Every block is also a page. Opening a block shows the block itself at the
top, as that page's surface, and the blocks written inside it as the page's
stream. A canvas and a block page are the same kind of view one level
apart; the breadcrumb runs Client / Project / Standup / Sep 28 / …, and you
can go up a level.

In a stream, a block with blocks inside it no longer shows them inline as a
thread. It shows a chip ("3 notes") that opens its page.

Todos become ordinary blocks that can sit anywhere in that tree (phase 2), and
the todo panel is a view over them.

The standup, for example: in the Standup task, type "Sep 28" and post it with
Alt+Enter. That starts the task (posting on a task canvas does) and opens the
new block's page. Notes and action items go inside it. Anything worth keeping
at the top is an edit of the block, the page's surface. The Standup task then
reads as a list of dated blocks, each one openable.

## Decisions

1. **Storage: children live in their root block's day file,** as replies do
   today. Notes written on a later day go into that older file with their
   own timestamps. One file holds a whole subtree, so moving or deleting one
   touches a single file, and nothing refers across files. Views that work
   by date (review, summary, timeline, timesheet) attribute blocks by when
   they were written. The date range query therefore also returns older day
   files that hold blocks written in the range; the index keeps creation
   times for that. No storage format change for pages.
   - Considered and rejected: storing each block in the file of the day it
     was written (edits to old blocks would land in old files anyway, and
     loading a page would mean reading every later file), and transparently
     splitting big threads into their own files (no gain for flat files in
     git).
2. **Todos move out of `todos.md` into the streams** (phase 2): a todo is a
   block with `kind=todo` at any depth, done or open through a `done`
   field. A one-time conversion moves each old todo into the day file of
   the day it was created, its comments becoming its children. The storage
   format goes to 4, so an older app refuses the devlog instead of writing
   to `todos.md`.
3. **Ticking a todo off no longer writes a "✓" block;** the todo shows as
   done where it is, and the timeline shows when it was ticked. Existing
   "✓" blocks stay as history.
4. **Todo panel order:** grouped by canvas (collapsible sections; a chain
   of canvases with a single path collapses into one heading), then in the
   order the todos appear in their streams. Drag to reorder within a group.
   There is no ranking across groups.
5. **Opening a page:** double-click a block, click its chip, or its Open
   action. On a page, double-clicking the surface edits it.
6. **Making a block with blocks inside it a task** moves those blocks into
   the new task canvas; the block stays where it was as the link to it
   (phase 3).
7. **A task is a canvas you can record time against.** Block pages do not
   track time on their own; a page inside a task canvas belongs to that
   task, so posting anywhere in it makes the task active.

## Phases

1. **Block pages.** The page view (surface, stream grouped by the day each
   block was written, breadcrumb, up a level with Alt+↑), chips in place of
   inline threads, the note box posting into the page on screen, Alt+Enter
   to post and open, reordering among siblings at any depth, back and
   forward through pages, search and timeline results opening the page, the
   date range query finding blocks written in the range in older files.
2. **Todos as blocks.** The conversion (format 4), `[ ]` and pasted
   checklists posting one todo per line, a checkbox in the stream, the todo
   page (checkbox in the header), the panel built from the index (grouped
   by canvas; Here is the page on screen and everything beneath it),
   extension API 1.4 (`parentId` when adding, todo state, a todo query).
3. **Polish.** Move under another block, making a block with children a
   task (decision 6), recent pages in the quick switcher.
