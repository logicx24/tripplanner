# Trip Poller — Design

**Date:** 2026-05-24
**Status:** Approved, ready for implementation

## Problem

Poll a group of friends for their availability over a multi-month window, then
find the contiguous **N-day blocks** that work for the most people. Existing
tools (When2meet, LettuceMeet, WhenNOT) collect availability and show overlap
heatmaps, but none directly answer "rank the contiguous N-day windows by
headcount" or let you explore leniency / exclusions. This tool fills that gap.

## Constraints

- **No hosting to manage, no database, no account system.** Static files only.
- Will be hosted on **GitHub Pages** (served from a subpath, e.g.
  `you.github.io/tripplanner/friend.html`), so all inter-page links must be
  **relative**, never `/`-absolute.
- Shared state is solved by **manual merge**: friends generate a code and send
  it to the organizer, who pastes codes in. Nothing leaves the browser
  automatically.

## Architecture

Plain HTML + vanilla JS. No framework, no bundler, no build step. Opens from
`file://` or static hosting.

```
tripplanner/
  friend.html        # friend-facing: mark availability -> get code
  organizer.html     # organizer-facing: create trip, paste codes, explore
  shared.js          # encode/decode + ranking math (UMD: browser + node)
  test.js            # node --test, zero dependencies
  docs/plans/2026-05-24-trip-poller-design.md
```

`shared.js` uses a small UMD guard so it loads as a `<script>` in the browser
and `require()`s in Node for tests.

## Data model & encoding

All encodings are **UTF-8-safe** (TextEncoder + base64url) so names with
accents/emoji round-trip cleanly.

### Trip token
Created once on the organizer page, carried in the friend link URL. It is the
single source of truth for the shared **absolute** calendar.

```js
tripToken = base64url(JSON({
  name:  "Ski 2026",
  start: "2026-06-15",   // full YYYY-MM-DD; day-0 of the window
  days:  90              // window length
}))
```

Absolute `start` (not relative to "today") guarantees every friend's calendar
renders the identical date range regardless of when they open the link.

### Availability bitmap
One bit per day, `1` = free. The selection is an **arbitrary set** of days
(discontinuous allowed). 90 days -> 12 bytes -> base64url (~16 chars).

### Friend code
One copy-pasteable blob, no spaces/newlines:

```js
friendCode = base64url(JSON({
  trip: tripToken,     // the whole token, verbatim — used for the match check
  name: "Dave",
  free: packedBitmap   // base64url bits
}))
```

### Friend link
```
friend.html?trip=<tripToken>
```

## Friend page (`friend.html`)

1. Read `?trip=...`; decode. If missing/malformed -> friendly error
   ("ask the organizer for the link").
2. Header: "Mark your availability for **Ski 2026** (Jun 15 – Sep 12, 2026)."
3. Required **name** field (code won't generate until filled).
4. **Calendar:** month-by-month grid from `start` for `days` days. Each day is
   a toggle. **Click-and-drag to paint** streaks; arbitrary discontinuous
   selections supported. Out-of-range days not shown.
5. Quick helpers (small): *All · None · Weekends only*.
6. **Live code box** at bottom: regenerates on every change, **Copy** button
   with "✓ copied" flash, and "*23 days selected — send this code to your
   organizer.*"

No save button, no account; the code only leaves the browser when the friend
sends it.

## Organizer page (`organizer.html`)

### Create trip
Form: name, start `YYYY-MM-DD`, range length -> generate trip token -> show the
friend link with a Copy button.

### Analyze
**Vercel-style bulk paste:** dump a blob of codes separated by
commas/newlines/whitespace -> split -> validate. Show:
- **Accepted** list (names).
- **Rejected** list with reasons (wrong trip / unparseable / duplicate name).

The **first** valid code establishes the reference trip (decodes name, start,
days, renders the calendar). Every subsequent code's `trip` field must match
the reference **byte-for-byte**, else **hard-rejected**:
"code is for a different trip: 'Tahoe Summer'." This means the pasted codes
fully reconstruct the trip — no persistence required.

Accepted codes are also stashed in `localStorage` so a reload doesn't lose
work (purely client-side).

### Controls (recompute live on change)
- **N** — block length.
- **K** — leniency: a person counts if free on at least `N - K` of the
  window's days. `K = 0` is the strict base case.
- **Exclusions** — each loaded person has a toggle; turning someone off drops
  them from the pool and re-ranks.

### Ranking math
```
for each start day d in 0 .. days-N:
    window   = d .. d+N-1
    attendees = included people free on at least (N - K) of the window's days
    score    = count(attendees)
rank windows by score desc
```

### Best-stretch collapse
Merge a run of consecutive start-days only when they yield the **identical
attendee set** (not merely the same score). Adjacent windows that score the
same but with different people stay separate. Collapsed entry:

> **Jun 20 – 26** · 8 of 10 · *any 5-day block in this 7-day span works for
> the same group* · missing: Dave, Priya

Sort by score desc, then span width desc (more flexibility first), then
earliest date.

### Result row contents
- Date span — "**Jun 20 – 24** (5 days)" (or flexible span if collapsed).
- Headcount — "**8 of 10**".
- **Who's in**, and **who's out** ("missing: Dave, Priya"). With K >= 1,
  partial attendees show their gap ("Sam — out Jun 22").

## Testing (TDD — tests first)

All real logic lives in `shared.js` as pure functions. Tested with Node's
built-in runner (`node --test`), **zero dependencies**.

- **Round-trips:** bitmap pack/unpack, trip token, friend code (incl. emoji
  names) — encode then decode returns the original.
- **Validation:** mismatched trip token rejected; garbage rejected; duplicate
  names flagged.
- **Ranking fixtures:** hand-built availability -> known expected blocks, for
  K=0 and K>=1.
- **Collapse:** adjacent same-set windows merge; adjacent different-set windows
  don't.
- **Edges:** N > range, K >= N, empty pool, one person, zero overlap.

## Out of scope (YAGNI)

- No live/auto aggregation (manual merge is the chosen model).
- No accounts, no server, no database.
- No weighting people by importance (exclusions cover the practical need).
