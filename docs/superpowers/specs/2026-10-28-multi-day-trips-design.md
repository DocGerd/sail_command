# Multi-day trips — design (#1708, #19 slice 2)

Status: draft for maintainer approval. Rulings D1–D9 and the follow-up rulings on membership,
layover, re-run and details: maintainer rulings 2026-10-28 on #1708.
Umbrella: #19. Builds on slice 1, `2026-10-17-next-passage-design.md` ("Plan next passage").

## Intent

Slice 1 makes the next passage one tap away, but the passages it produces are unrelated saved
plans. This slice links them into a trip, shows the trip as a timeline, checks each stop against
an optional arrival window, and lets the sailor re-plan everything downstream of a change.

## Decided (maintainer ruling 2026-10-28 on #1708)

- **D1.** Trips live in a new `trips` store in the existing IndexedDB; `DB_VERSION` goes 3 → 4.
  That PR merges last in its milestone, and the release is cut promptly.
- **D2.** Each passage keeps its own `windGrid`. The trip stores no forecast.
- **D3.** Creation is implicit: saving a plan seeded by "Plan next passage" creates or extends the
  trip. Seeding from a non-last passage starts a new trip. A plan can be detached.
- **D4.** A per-trip layover rule lives on the trip record: an earliest-departure hour (default
  10:00) plus a minimum rest (default 0 h). Any stop may override it with a fixed departure.
- **D5.** Each stop may carry an optional arrival window, checked against the recommended rig's
  stored ETA. Early arrival shows the wait; late arrival shows the deficit. A check never
  re-solves.
- **D6.** The per-leg feasibility verdict and an explicit downstream re-run (with progress and
  cancel) are in. Lever suggestions are split to their own issue.
- **D7.** The timeline is a trip section in the Routes tab, plus PlansList grouping and a
  next-passage row action. The Live-view entry point is split out.
- **D8.** Trips are not in the backup export for now.
- **D9.** Undo of the next-passage seed is split to its own issue.
- **Membership.** No branches: a plan is in at most one trip. One-passage trips are allowed.
- **Layover.** Uses the recommended rig's ETA. The earliest-departure hour is the next such hour
  after arrival plus rest. The "after now" term applies to seeding and re-runs, not to verdicts.
  A hand-edited departure is stored as that stop's fixed departure.
- **Re-run.** Replaces each downstream passage in place. Cancel lets the current solve finish.
  Online only. The user's active plan stays shown during and after the re-run; if it was itself
  re-planned in place, the view then shows its new version.
- **Details.** The trip name is derived from the first and last stop. An arrival window is entered
  as a day plus an hour range. The plan is saved first; a failed trip link is reported and never
  loses the solve.
- **Audit follow-ups.** A seeded plan whose start was moved before saving is saved detached (no
  manual attach in v1). A Live reroute (new plan id) leaves the trip; the original passage stays.
  A member whose stored plan cannot be read shows an `unavailable` verdict, and its successor's
  layover shows as unknown. The re-run drives the routing client directly, as DepartureCompare
  does, not via `run()`. "Re-plan from here" on the first passage re-plans from its own stored
  departure.
- **Round-2 follow-ups.** Each re-planned passage fetches fresh wind and wave grids, like a normal
  plan. A first passage whose stored departure is already past is moved to the next full hour
  after now for the re-run. Successors of an unavailable member show unknown verdicts and window
  status, and a re-run may not start at or cross it. If the plan save times out, the trip link is
  written only when the save completes; otherwise it is reported as not linked.

## Constraints

- No hunk in `app/src/types.ts` or `app/src/lib/wind.ts`: both are in the #282 sweep closure
  (same constraint as slice 1). The trip type lives outside `types.ts`; builder's call whether
  beside `SavedWaypoint` and `RegionPinRecord` in `services/db.ts` or in a new `lib/trip.ts`.
- No hunk in `app/src/routing/planRoute.ts` or `app/src/routing/isochrone.ts`. A seeded passage
  is an ordinary `run()`, and the re-run uses the existing routing client; editing either file
  means the design is wrong (departure-comparison design §3).
- `Plan` gains no field, so `PLAN_SCHEMA_VERSION` and `migratePlan` are untouched. Membership lives
  only on the trip record.
- The new store is additive: an `oldVersion < 4` block creates it, as `pins` was added at 3. The
  `db.ts` #1164 comment already places an empty new store outside ADR-0002's no-migration ruling,
  so no migration machinery is needed.
- One origin serves prod and `/uat/` with one IndexedDB. A `DB_VERSION` 4 on develop makes prod's
  older `openDB` throw `VersionError` for anyone who has opened `/uat/`, until the release reaches
  `main` (CLAUDE.md). Hence D1's
  merge order and prompt release.
- A saved passage always renders against its own stored forecast (D2). Nothing in this slice
  re-fetches wind for an existing passage except an explicit re-run, which saves a new snapshot.
- UI primitives and `--sc-*` tokens only; de/en strings through the dictionaries. Design floor is
  tablet ≥ 820 CSS px (narrow branch at 820 portrait, wide ≥ 1024).

## Trip record

One record per trip in the `trips` store, keyed by `id`.

- `id` — `crypto.randomUUID()`. The trip has no stored name; it is shown as "{first stop} →
  {last stop}" (maintainer ruling 2026-10-28 on #1708).
- `createdAtMs` — listing order.
- `passageIds` — plan ids in sailing order. Passage *i* sails stop *i* → stop *i*+1.
- `layover` — `{ earliestDepartureHour, minRestH }`, defaults 10 and 0 (D4).
- `stops` — one entry per stop, index-aligned: stop 0 is the first passage's start, stop *i*
  (*i* ≥ 1) is passage *i*−1's destination. Each entry may hold:
  - `fixedDepartureMs` — the D4 override; meaningless on the last stop, and ignored on stop 0 (the first passage re-plans from its own stored departure).
  - `arrivalWindow` — `{ startMs, endMs }` (D5); meaningless on stop 0.
- A `by-passageId` multiEntry index on `passageIds` answers "which trip holds this plan".

The record stores no wind, no ETA and no route geometry. Every derived value (ETAs, verdicts,
window status) is read from the member plans at display time.

## Creating, extending, detaching (D3)

1. **Hook.** Slice 1's seed state is ephemeral `{ sourcePlanId, origin }` and is never persisted.
   A run started while the seed is active
   (`activeNextPassageSeed`: source active, start unmoved) carries `sourcePlanId` and the seeded departure to `run()` (new `RunOptions` fields), and the trip write happens at `run()`'s save step. A seeded plan whose
   start was moved before saving is saved detached; v1 has no manual attach (maintainer ruling 2026-10-28 on #1708).
2. **Plan first.** The plan is saved by the existing save step, then the trip is written. A failed
   trip write is reported to the user and leaves the saved plan in place (maintainer ruling 2026-10-28 on #1708). If
   the source plan no longer exists at save time, no trip is written. If the save times out
   (#1776), the trip link is written only when the save later completes; otherwise the plan is
   reported as not linked (maintainer ruling 2026-10-28 on #1708).
3. **Source not in a trip.** A new trip is created: `passageIds = [sourcePlanId, newPlanId]`,
   default layover, no per-stop data.
4. **Source is a trip's last passage.** The new plan is appended to that trip.
5. **Source is a non-last passage.** A new trip is started holding only the new plan (maintainer ruling 2026-10-28 on #1708).
6. **Hand-edited departure.** The seed state also records the departure it seeded. When the saved departure differs from it, it is stored as the `fixedDepartureMs` of the stop the new passage leaves (maintainer ruling 2026-10-28 on #1708).
7. **Detach.** Removes the plan from its trip; the plan itself is untouched. Detaching a first or
   last passage shortens the trip. Detaching a middle passage splits the trip in two (maintainer ruling 2026-10-28 on #1708): the passages before it and the passages after it, each keeping the layover rule and its own stops' data. A trip left with zero passages is deleted (same ruling).
8. **Delete.** `deletePlan` widens its transaction to `['plans', 'pins', 'trips']` and applies the
   detach rule above in that same transaction, so no trip references a missing plan.
9. **Recalculate (#114) and other saves.** "Replace" and the departure-compare confirm keep the
   plan id, so trip membership survives. "As new" mints a new id, so the new plan is not in the
   trip. A Live reroute mints a new id: the new plan is not in the trip, and the original passage
   stays (maintainer ruling 2026-10-28 on #1708).
10. **Import.** `parseExportFile` and the import path never read or write `trips` (D8). An imported plan keeps its exported id: one whose id is already in a trip here replaces that member's content and stays in the trip; any other imported plan is in no trip.

## Layover rule and per-stop override (D4)

- The ETA is passage *i*'s stored `recommendedResult(plan.result).etaMs` (maintainer ruling 2026-10-28 on #1708).
- The rule gives the departure of passage *i*+1: the first local `earliestDepartureHour`:00
  strictly after ETA + `minRestH` (arrive 14:00 → depart 10:00 next day, as slice 1). Calendar
  math, never fixed 24 h steps (DST days are 23/25 h).
- For seeding and re-runs the departure is also strictly after now; verdicts omit that term
  (maintainer ruling 2026-10-28 on #1708). At the defaults (10:00, 0 h) the seeding form equals slice 1's
  `nextPassageDepartureMs` on the recommended rig's ETA.
- A stop's `fixedDepartureMs` replaces the rule for the passage leaving that stop.
- The rule seeds the next-passage departure and feeds the re-run. It never rewrites a stored
  plan's `request.departureMs`.
- Slice 1's seed therefore uses the recommended rig's ETA, not the displayed rig's. Every seeded
  save joins a trip (D3), so a seed from the displayed rig would differ from the rule and be stored
  as a hand-edited fixed departure. The next-passage design is amended accordingly; the change
  ships with the trips work (maintainer ruling 2026-10-28 on #1708).

## Arrival windows (D5)

- A stop's window is stored as `{ startMs, endMs }`. It is entered in the trip section as a day
  plus an hour range (maintainer ruling 2026-10-28 on #1708).
- The checked ETA is `recommendedResult(plan.result).etaMs` of the passage arriving at that stop.
  It is the recommended rig's, even while the user views the other rig.
- Status: `early` with wait = `startMs − ETA` when ETA < `startMs`; `in-window` when
  `startMs ≤ ETA ≤ endMs`; `late` with deficit = `ETA − endMs` when ETA > `endMs`.
- The status is recomputed from stored data on display. Changing a window never starts a solve.

## Per-leg feasibility verdict (D6)

Computed per passage from stored plans, the trip record and the current time, never by solving.
"Previous ETA" below is the previous passage's stored recommended-rig ETA.

- `ok` — the passage departs at or after the previous ETA plus `minRestH`. The first passage is
  always `ok` on this test.
- `conflict` — the passage departs before the previous ETA plus `minRestH`. This arises after an
  upstream passage was re-planned or recalculated to arrive later. Departing before the
  earliest-departure hour is not a conflict (maintainer ruling 2026-10-28 on #1708).
- `beyond-forecast` — "beyond forecast — provisional". A `conflict` whose re-run departure (layover
  rule or override) lies after now + `FORECAST_DAYS` days (`services/openMeteo.ts`, the
  bound PlansList's recalc editor already uses). Such a passage cannot be re-planned until a later
  forecast covers it. Never extrapolated. An ETA past the horizon is not detectable without
  solving; a re-run reports it as `beyond-horizon` (below).
- `unavailable` — the passage's stored plan cannot be read (#54 §I.3). The next passage's layover
  shows as unknown, and every later passage shows an unknown verdict and window status
  (maintainer ruling 2026-10-28 on #1708).
- Arrival-window status (above) is shown beside the verdict, not folded into it.
- The trip as a whole shows the worst passage verdict and lists late windows.

## Downstream re-run (D6)

- **Trigger.** Explicit only: a "Re-plan from here" action on a passage in the trip section. It
  never starts by itself after an edit.
- **Order.** Sequential, from the chosen passage to the last. The chosen passage, and each passage after it, departs per the layover rule (or override) applied to the preceding passage's stored ETA — freshly stored for every passage after the chosen one.
  On the first passage, "Re-plan from here" re-plans from its own stored departure; if that is
  already past, from the next full hour after now (maintainer ruling 2026-10-28 on #1708).
- **Unavailable members.** A re-run may not start at or cross an `unavailable` member; the action
  is disabled where it would (maintainer ruling 2026-10-28 on #1708).
- **Mechanism.** The re-run drives the routing client directly — the shared `ensureClient` singleton, `client.plan()`, then `savePlan` — as DepartureCompare's confirm does, not via `run()` (maintainer ruling 2026-10-28 on #1708). Unlike that confirm, it fetches the wind itself (see Forecast). It does not touch `usePlanFlow`'s planning state.
- **Busy.** While a re-run is in flight every other solve starter (Plan route, PlansList recalc, DepartureCompare, Plan next passage) is disabled, and "Re-plan from here" is disabled while any run is busy. The re-run therefore holds the app's planning-busy state (App.tsx's `runBusy` gains it beside the planning phase and Live reroute), so `run()`, a cancel and the client's `failAll` cannot interleave with it.
- **Persistence.** Each passage is replaced in place under its existing id, so its id, trip
  membership, window and override are kept (maintainer ruling 2026-10-28 on #1708). Each passage's outcome (saved plan or
  failure) seeds the next departure and stops the run on failure. The replace sets a fresh
  `createdAtMs`, as `run()`'s recalculate-replace save does (`id: opts.replacePlanId ?? …`,
  `createdAtMs: Date.now()`), so plan views keyed on `${plan.id}-${plan.createdAtMs}` show the
  new version. Each re-run save pins regions exactly as `run()`'s normal save does
  (`pinRegionsAfterSave`), so a re-planned passage stays available offline.
- **Forecast.** Each re-planned passage fetches fresh wind and wave grids, like a normal plan, and
  stores them as its own new snapshot (D2, maintainer ruling 2026-10-28 on #1708). The router is unchanged.
- **Active plan.** The user's active plan stays shown during and after the re-run. If that plan
  was itself re-planned in place, the view shows its new version afterwards (maintainer ruling
  2026-10-28 on #1708).
- **Progress.** A status line names the passage being planned and the count, in the style of the
  departure scan's `departureScan.status.scanning` ("{index} of {total}").
- **Cancel.** A re-run stop flag checked between passages: the current passage's solve finishes and is saved, then the run stops. It never calls `usePlanFlow`'s `cancel()` or `RoutingClient.cancel()`, both of which terminate the solve. Passages already re-planned keep their new results (maintainer ruling 2026-10-28 on #1708).
- **Failure.** A passage whose re-run fails, `beyond-horizon` included, keeps its previous stored
  plan, and the run stops. The failure is reported to the user. The kept passages show whatever
  verdict their stored data now gives.
- **Offline.** Online only (maintainer ruling 2026-10-28 on #1708); slice 1's offline exception does not extend to
  re-runs.

## UI (D7)

- **Routes tab, trip section.** Shown when the active plan belongs to a trip. A timeline lists
  each stop and passage: stop name, arrival ETA, layover, departure, passage verdict, window
  status. Each stop offers the edits that apply to it (a window from stop 1, a fixed departure on stops 1 to second-to-last). The trip offers layover editing and
  "Re-plan from here" per passage. Tapping a passage makes it the active plan (stored grid, no
  fetch).
- **PlansList grouping.** Plans in a trip are listed together under the trip, in `passageIds`
  order. Plans outside any trip list as today. Rows that cannot be read stay listed (#54 §I.3).
- **PlansList row action.** "Plan next passage" on a row loads that plan as the active plan, then
  seeds and switches to the Plan tab exactly as the Routes-tab card does. Loading first is needed
  because slice 1's seed counts only while its source plan is active (`activeNextPassageSeed`).
- **Detach** is a row action on a grouped row.

## Offline behaviour

- The trip section, grouping, verdicts and window status read only IndexedDB and work offline.
- Editing layover, windows and fixed departures works offline (a trip-record write).
- Slice 1's offline next-passage planning is unchanged; saving such a plan creates or extends the
  trip as online.
- A downstream re-run requires a connection (see above).

## Out of scope (each split to its own issue)

- Lever suggestions (earlier departure, shorter layover, other intermediate harbour, motor
  allowance) — D6.
- Trips in the backup export — D8.
- Undo of the next-passage seed — D9.
- Live-view entry point to a trip — D7.

Also out: chaining one stored forecast across several passages (D2), planning past the forecast
horizon (2026-07-14 design §6).

## Acceptance criteria

1. Opening a database created at version 3 with plans, waypoints and pins upgrades it to 4, adds
   an empty `trips` store and leaves every existing record unchanged (mirrors `db.test.ts`'s
   "#1164 T4: v2 -> v3 migration adds the pins store additively"). A fresh install and a v1/v2
   database also reach version 4 with all five stores.
2. Saving a seeded plan whose source is in no trip creates a two-passage trip; from a trip's last
   passage it appends; from a non-last passage it starts a one-passage trip. No plan is ever in
   two trips.
3. Plan-first save: a failed trip write leaves the plan saved and reports the failure; a source
   plan deleted before save yields a saved plan and no trip. A save that times out writes the trip
   link only if it later completes, and otherwise reports the plan as not linked.
4. A hand-edited seeded departure (differing from the departure recorded in the seed state) is
   stored as that stop's `fixedDepartureMs`; an unedited one stores none. A seeded plan whose start
   was moved before saving is saved in no trip.
5. Detaching or deleting a middle passage splits the trip in two; a trip left with zero passages
   is deleted; `deletePlan` does this in its own transaction. A Live reroute's new plan is in no
   trip and the original passage stays; "Replace" and the departure-compare confirm keep
   membership.
6. Layover rule and slice 1's seed: unit tests for the recommended rig's ETA (not the displayed
   rig's, also when the other rig is shown), next-hour
   semantics (arrive 14:00 → 10:00 next day), defaults equalling `nextPassageDepartureMs`, a rest
   crossing the hour, a fixed override, a DST day, and the "after now" term applied to seeding
   and re-runs only, not to verdicts.
7. Window status and verdict are pure functions of stored data and the current time; departing
   before the earliest-departure hour is not a `conflict`; a test asserts no solve is requested
   when a window or layover changes. A `conflict` whose re-run departure lies after now +
   `FORECAST_DAYS` days shows `beyond-forecast`; window wait/deficit values use the recommended
   rig's ETA also while the other rig is shown. An unreadable member shows `unavailable`, its
   successor's layover shows as unknown, and every later passage shows an unknown verdict and
   window status.
8. Downstream re-run: replaces passages in place (ids, windows, overrides kept); progress names the
   passage and count; cancel lets the current solve finish and keeps already re-planned passages;
   a failed passage stops the run; the active plan does not change, and if it was re-planned in
   place the view shows its new version afterwards; offline it is unavailable. It drives the
   routing client directly and does not change `usePlanFlow`'s planning state; each later passage departs per the layover rule (or override) applied to the preceding passage's freshly stored ETA, strictly after now; on the first passage it
   uses that passage's stored departure, or the next full hour after now when that is past; each
   re-planned passage stores newly fetched wind and wave grids; the trip record holds no wind, ETA
   or geometry (D2). Other solve starters are disabled during a re-run, and the re-run is disabled while a run is busy; a test
   holds a re-run in flight and asserts `runBusy` is true and no `run()`, cancel or `failAll`
   reaches the shared client. A re-run cannot start at or cross an `unavailable` member. Each
   replaced passage carries a fresh `createdAtMs`, and a shown re-planned passage remounts its
   view. Each re-run save calls `pinRegionsAfterSave` for the replaced plan, as a normal save does.
9. The export envelope is unchanged (`EXPORT_SCHEMA_VERSION` stays 1); import writes no trip; an
   imported plan whose id is a trip member stays a member.
10. de/en strings in both dictionaries; e2e at `tabletPortrait` and `desktopHd` for create via
    seed, grouping, window status and a re-run; slice 1's existing e2e and `offline.spec.ts` stay
    green. The PlansList "Plan next passage" row action loads then seeds; the trip label reads
    "{first stop} → {last stop}"; an arrival window is entered as a day plus an hour range.
11. Zero hunks in `types.ts`, `lib/wind.ts`, `routing/planRoute.ts`, `routing/isochrone.ts`.

## Implementation slicing

All PRs except the last are inert without the store and must not open the database at version 4.

| # | Scope | Notes |
|---|---|---|
| a | Pure trip logic: record type, layover rule, window status, verdict | Home per Constraints (builder's call); unit tests only |
| b | Trip section and PlansList grouping/row action, against an injected trip source | UI over (a); no store yet |
| c | Downstream re-run orchestration with progress and cancel | Uses (a); router untouched |
| d | `trips` store, `DB_VERSION` 3 → 4, save-path hook, `deletePlan` widening, wiring of (b)/(c); also switches slice 1's seed to `recommendedResult` (next-passage design amendment) | Merges last (D1); cut the release promptly after |

Builder's call: whether (b) and (c) merge into one PR, and how (b)–(c) are feature-gated until (d).
