# Named waypoints — design

Status: **approved** (maintainer, 2026-09-04)
Covers: #846 (rename), #845 (seamark as waypoint), #848 (persist named waypoints)
Milestone: v0.21.0
Amended by: #966 (§2.5 superseded — any seamark is eligible; milestone v0.23.0)

Written because #848's own body argues these three are "probably one design, not
three". They share one data model, one UI surface and one identity question, and
designing them separately is how the rework #848 warns about happens.

**Not covered here:** #844 (cancelling waypoint creation). Its own body asks for
the defect to be reproduced before anything is designed, and it has not been
reproduced yet. Do not fold a fix for it into these three.

## 1. What exists today

`PlanRequest.viaPoints` is a bare `LatLon[]` (`app/src/types.ts`, `LatLon =
{lat, lon}`). There is no name field anywhere in the chain.

- **`planViaPoints(request)`** (`app/src/lib/planViaPoints.ts`, #654 hardening)
  is the defensive accessor for reads off a **loaded `Plan`** — it fails open to
  `[]`. Its own comment scopes the claim precisely: *"every direct read of
  `plan.request.viaPoints` in app/src goes through this function instead of the
  bare property"*. It is **not** the only reader of a `PlanRequest`'s
  `viaPoints` — `planRoute.ts:338`, `migratePlan.ts:521` and
  `usePlanFlow.ts:231` each read the property directly, all legitimately, since
  none of them is loading a stored plan. Do not generalise the accessor's
  guarantee past loaded plans.
- **The solver reads only coordinates.** `planRoute.ts`'s waypoint assembly
  snaps each via point to navigable water and builds
  `[origin, ...viaPoints, destination]`, touching `.lat`/`.lon` and nothing
  else. `PlanResultOk` carries no via-point echo at all — only
  `snappedOrigin`/`snappedDestination`.
- **The panel renders coordinates as the label**, via `formatLatLon(v)` in
  `PlannerPanel.tsx` — which is exactly the defect #846 reports.
- **`ViaMarkers.tsx` reads the DRAFT prop**, not `plan.request.viaPoints`
  directly (the #571 redesign; see that file's header comment).
- **GPX round-trips no via-point identity in either direction.** Export builds
  `<rtept>` from post-solve `plan.result.legs`, not from `request.viaPoints`;
  import never reads a `<name>` element. A name is therefore a from-scratch
  addition on both ends, not an existing seam being extended.

## 2. Decisions

### 2.1 `name` is an optional field, and this is not a breaking change

Add `name?: string` alongside `lat`/`lon`. Reading an OLD record is free: a
stored via point with no `name` yields `undefined`, and nothing breaks.

**But writing a NEW one is not free, and this is a required code change, not a
free-by-construction property.** `normaliseViaPoints` (`migratePlan.ts:99-108`)
does not pass fields through — it REBUILDS each via point from an explicit
allowlist:

```ts
out.push({ lat: p.lat as number, lon: p.lon as number });
```

Every `getPlan()` load runs through it. So without an explicit edit copying
`p.name` across, **a saved named waypoint has its name silently stripped on the
very next load** — data loss with no error, no warning and no failing test,
since no existing test asserts on a field that does not yet exist.

`#846` MUST edit `normaliseViaPoints`, and MUST add a round-trip test that
saves a named via point, reloads it through `migratePlan`, and asserts the name
survived. Do not treat the optional-field property as covering this.

Note the deliberate asymmetry `planViaPoints.ts` documents: `normaliseViaPoints`
fails CLOSED (refuses the whole record) on a present-but-malformed `viaPoints`,
while the accessor fails OPEN. A malformed `name` must not be allowed to reject
an otherwise-valid plan — validate it as optional, never as required.

This still avoids the pre-1.0 breaking-change route. The 2026-08-24 ruling
(ADR-0002) waives migration MACHINERY when it would otherwise be needed; it is
not reached here, because an optional field needs none. That ADR also states
explicitly that it *"does NOT waive defensive reads"* — so the allowlist stays
an allowlist, widened by one key rather than replaced by a spread.

**Do not make `name` required, and do not restructure `viaPoints` away from an
array of coordinate records.** Either would turn a free change into a breaking
one.

### 2.2 No `app/sweep/` run is owed — conditionally, and the condition is load-bearing

`sweep-closure`'s `closure.mjs files` reports `app/src/types.ts` and
`app/src/routing/planRoute.ts` as `IN_CLOSURE`. That verdict is at **file**
granularity; the tool has no field-level check, and its own documentation cites
the `draftProvenance` precedent as this same false-positive shape.

Tracing the actual field usage: `planRoute.ts` reads only `.lat`/`.lon` per via
point, and `PlanResultOk` has no via-point echo. So `PlanResult` stays
byte-identical and nothing is owed — **provided `name` is a field the solver
never reads.** This is the same presentation-only shape as #493/PR #504, which
kept `PlanResult` byte-identical for exactly this reason.

A second, independent reason the verdict holds, found in review and stronger
than the first: **`app/sweep/sweepArms.ts` passes `viaPoints: []` for every
arm.** The sweep never populates a via point at all, so it is structurally blind
to via-point changes regardless of what `planRoute.ts` reads. Either argument
alone suffices; they fail independently.

The condition is the whole verdict. If an implementation finds itself passing
`name` into `planRoute.ts`, the verdict lapses and a BASE-vs-HEAD comparison is
owed: **three arm-sets at roughly 31 min each, so ~90 min** — two BASE runs for
the required double-run control, plus one HEAD run to compare against it.

**Each of these three PRs must re-run `closure.mjs diff` against its own real
diff** rather than inheriting this verdict. A wrong NOT-OWED ships an unmeasured
routing change; the tool call is cheap and it is the documented way to settle it.

### 2.3 Persistence is IndexedDB, in a new additive store

Named waypoints are a user-authored catalogue, not a per-viewer convenience.
That is the wrong category for `localStorage` — `usePersistedToggle` and
`usePersistedNumber` exist for UI preferences (a toggle, a number), and
`lib/storage.ts`'s safe wrappers are scoped to that job.

Create a new `waypoints` object store with keyPath `id`, following the shape
already established by `savePlan`/`getPlan`/`listPlans`.

**The DB version MUST be bumped, and this is the single most likely way for
#848 to ship broken.** `services/db.ts:19` opens the database as:

```ts
openDB<SailDB>('sailcommand', 1, { upgrade(d) { … } })
```

IndexedDB runs `upgrade()` **only when the requested version exceeds the
version already stored in the browser**. Every existing install is already at
version 1. So adding `d.createObjectStore('waypoints', …)` inside that same
version-1 body creates the store **for fresh installs only** — for every
existing user the handler never runs, the store never exists, and saving a
waypoint fails at runtime.

The failure mode is the nasty one: it works perfectly for the developer, whose
profile is usually fresh or easily cleared, and fails for exactly the users who
have been using the app. It is also invisible to `fake-indexeddb` unit tests
unless a test deliberately opens at the OLD version first and then reopens.

Required:
1. Bump the version to `2`.
2. Gate the new store on `oldVersion` so an existing DB gains only the new
   store and the `plans`/`settings` creation does not re-run.
3. Add a test that opens the DB at version 1 with the old schema, closes it,
   reopens through `db()`, and asserts the `waypoints` store now exists. A test
   that only ever opens a fresh DB cannot see this defect.

With the version bumped and `oldVersion` gated, the change is genuinely
additive — no migration of records in `plans` or `settings` is needed.

### 2.4 A seamark-sourced waypoint is flattened at pick time

When the user picks a seamark, the waypoint becomes a plain `{lat, lon, name}`
record immediately. It keeps no link back to `seamarks.json` and is never
re-resolved.

The alternative — storing a seamark id and re-resolving on load — was rejected.
Seamark data is regenerated by the pipeline, so a rebuild that moves or removes
a mark would silently change or break a saved route. A saved route changing
under the user without their action is a worse failure than a waypoint whose
name outlives its source mark.

Consequence: the persisted store needs **no provenance field**, and there is no
"seamark has vanished" path to define.

### 2.5 Any seamark is eligible — the curated subset is SUPERSEDED (#966)

**Amended 2026-09-05 by maintainer decision on #966.** Any seamark the user can
see and tap is addable as a route waypoint. If it is on the chart and you can
reach it, you can route past it.

The original rule read: *"Cardinals, laterals and isolated-danger marks only —
the marks a skipper actually routes past, and what #845's own text suggests.
Special-purpose marks and minor lights are excluded: they are numerous and make
poor waypoints, and offering them costs collision-list noise for no
navigational value."* It is retained here verbatim because the amendment turns
on why it was wrong, not merely on what replaced it.

**What refuted it.** A UAT pass of `v0.22.0` found a mark at the bend where the
Flensburg Fjord turns south that functions as a lateral on the water but is
tagged `beacon_special_purpose`, so the allowlist withheld the button. The
exclusion's stated justification — "no navigational value" — was an assumption
about what a skipper uses, and the person sailing this water reports otherwise.
**A mark's usefulness as a WAYPOINT is not the same property as its S-57
category**, and the original rule conflated them.

**Why no narrower fix exists.** Verified against the shipped
`app/public/data/seamarks.json` at that bend (~54.83 N, 9.43 E): exactly four
`beacon_lateral` marks, all starboard/green, and two BLACK
`beacon_special_purpose`, both carrying only `{seamarkType, colour: 'black'}`.
The adjective is restrictive, not merely descriptive — **five**
`beacon_special_purpose` marks sit within 900 m (two black, one white lattice at
652 m, a stake at 806 m, another white lattice at 868 m), so dropping it makes
the sentence a false census. No radius rescues the shorter form either: the
laterals sit 546–619 m out, so any radius admitting all four also admits the
652 m mark.

Distances, by haversine (the method matters — an equirectangular pass gives
figures ~1 m different, and an earlier draft mixed the two): the two black marks
lie **641–679 m** and **681–718 m** from the laterals — one range per mark,
each spanning that mark's distances to the four laterals. Do not collapse those
into one range attributed to "the nearest" — that was a 4×2 pair-set range
mis-attributed to a single mark, and it is how an earlier draft went wrong.

The lateral function the maintainer knows from the water is not expressed in
either black mark's tags, so no tag-based heuristic over this data could
recover it: widening the allowlist by category would have been guesswork, and
dropping it is the rule the data supports.

Three caveats, stated because an earlier draft of this paragraph asserted each
of them wrongly and a reviewer measured all three:

- **Topmarks are not in the shipped extract at all.** `seamarks.json` has no
  topmark property — its key union is `category`, `colour`, `lightCharacter`,
  `lightColour`, `lightPeriod`, `seamarkType`, `shape`. Any topmark claim about
  these marks is unsupported by the artifact this repo actually ships.
- **The colour claim holds only at this bend, not repo-wide.** The retracted
  form read *"none of the special-purpose marks carries a red/green colour or a
  port/starboard category"*. Scoped to the two black marks it is true. Across
  the whole extract, 11 of 703 special-purpose marks carry a red or green colour
  (9 green beacons, 1 red beacon, 1 red buoy) — including one
  `buoy_special_purpose` with `colour: red` 807 m from here, again by haversine.
  The argument above is unaffected, since it turns on these two marks; the
  unscoped form was simply false.
- **The Overpass re-query is NOT reproducible from this document.** The
  retracted form read *"a live Overpass re-query of the same bbox returned zero
  semicolon- or dual-tagged `seamark:type` values"*. It was cited
  without its bbox, date or query text, and the shipped extract cannot stand in
  for it — `pipeline/build_seamarks.mjs` collapses each mark through
  `primaryType()` before writing, so a semicolon- or dual-tagged `seamark:type`
  could not survive into `seamarks.json` whether or not one existed upstream.
  Treat that claim as unverified; it is not load-bearing for the decision.

**Accepted cost**, and it is the original rule's own argument: more marks become
addable, so the collision-list noise the exclusion was written to avoid is now
accepted deliberately rather than avoided by construction. If that noise proves
a real problem in use, the remedy is a presentation change, not a return to a
category allowlist — the allowlist's premise has been refuted, and re-adopting
it would re-adopt the conflation above.

### 2.6 A seamark is inserted at its nearest point along the route

Not appended to the end of the via list. "Route via that buoy" names a point the
skipper will pass, not a detour appended after the destination — appending a
mid-route mark produces a nonsense route until the user manually reorders it.

This requires a nearest-point-on-polyline computation against the current route.
`App.tsx` already carries reorder and drag handlers, so manual correction
remains available when the computed position is not what the user meant.

**With no route planned yet, append.** There is no polyline to project onto, so
"nearest point along the route" is undefined — and this is a reachable state,
not an edge case: a user may well pick marks before planning. Appending is
correct there, because with an empty via list the two rules agree anyway.
Specify it explicitly rather than leaving it to the implementer, or the natural
reading of §2.6 is a crash or a silent no-op on the empty case.

### 2.7 #848 ships panel-only; the map layer is a separate issue

Saved waypoints live in a panel list, and selecting one loads it into the
current route draft. They get no permanent map presence in v0.21.0.

A selectable symbol layer would compete for the z12 `symbol-sort-key` and
collision budget already shared by harbour markers and seamark glyphs — the same
budget where #378 found `sc-wind-barbs` silently culling ETA and speed labels
because `icon-allow-overlap` was set without `icon-ignore-placement`. It would
also need keyboard access per #830's pattern. That is a materially bigger change
than the persistence itself and does not belong in the same PR.

Filed as **#924** (Backlog), with the collision-budget work scoped honestly
rather than assumed cheap.

## 3. Build order

Strictly serial. `PlannerPanel.tsx` and `App.tsx` are touched by all three, so
parallel implementers would be a scheduled conflict, not a risk.

| # | Issue | Adds | Principal files |
|---|---|---|---|
| 1 | #846 | the `name` field and rename UI | `types.ts`, `PlannerPanel.tsx`, `ViaMarkers.tsx`, `migratePlan.ts`, **`lib/planViaPoints.ts`**, both i18n dicts |
| 2 | #845 | seamark → waypoint action | `DataLayers.tsx`, `lib/seamarkPopupDom.ts`, `lib/seamarkPopover.ts` |
| 3 | #848 | persistence + panel picker | `services/db.ts`, new picker component, both i18n dicts |

#846 is first because #845 needs the name field: a seamark-sourced waypoint has
a natural name already, and pre-filling it is the point of the feature. #848 is
last because it persists what the first two define.

**`lib/planViaPoints.ts` is in #846's list for a reason that fails silently.**
It returns `LatLon[]`, and TypeScript array covariance means widening the
element type to carry `name` compiles **either way** — forgetting it produces no
error, just names that never reach the UI through the accessor path. There is no
compiler backstop here, so it must be an explicit checklist item.

**`dedupeViaPoints` (`state/replan.ts`) is name-blind.** It compares
coordinates only, and `usePlanFlow.ts:231` runs it on submit. So two waypoints
at the same position with different names collapse to one, and the user sees
only a count — never which name was dropped. #846 must decide whether that
stays acceptable (defensible: they ARE the same point) or whether the surfaced
message should name what it discarded. Either way, decide it deliberately
rather than inheriting it.

### 3.1 #845 also closes #872

There are two builders of the seamark popup DOM: `DataLayers.tsx` builds it
inline, and `lib/seamarkPopupDom.ts`'s `buildSeamarkPopoverContent` is a lifted
twin used only by `SeamarksInView.tsx`. #872 tracks that split, and
`seamarkPopupDom.ts`'s own header comment documents the twin-drift risk.

Adding an "add as waypoint" action to only one copy would re-introduce exactly
that drift. #845 touches this code anyway, so it points `DataLayers.tsx` at the
shared function and adds the action there once.

`seamarkPopoverRows()` stays DOM-free — its own comment says so. The action
belongs in the DOM-construction layer, not in row building.

**This deliberately reaches `SeamarksInView.tsx` too, and that is intended.**
`buildSeamarkPopoverContent` has no callback parameter today, so adding the
action gives it one — and `SeamarksInView.tsx`'s keyboard-reachable list is its
only current caller. The action therefore appears in the keyboard list as well
as the map popover. That is the correct outcome, not a side effect: a
MapLibre-rendered glyph has no DOM node, so the keyboard list is the *only*
route to this feature for a keyboard user, and shipping the action on the map
alone would make it pointer-only.

## 4. i18n

Every string needs a key in **both** `dict.de.ts` and `dict.en.ts`; parity is
enforced by `satisfies Record<MsgKey, string>`. Extend the existing
`planner.via.*` keys rather than replacing them — `planner.via.marker`'s
`Waypoint {index}` remains the fallback for an unnamed waypoint.

New surfaces needing keys: the rename control; the seamark popover's add action;
the saved-waypoint picker (label, save, delete, select, empty); and a
device-local disclosure line for #848, following the existing `about.caveats.*`
pattern — #848's own body requires that persistence be disclosed rather than
discovered.

## 5. Open residuals

- **#844** is unreproduced and deliberately out of scope (stated in the preamble above §1).
- **The map layer for #848** (§2.7) is tracked as #924.
- **GPX** does not round-trip names in either direction (§1). This design does
  not change that. If a name should survive export/import, that is a separate
  decision about the GPX schema, not an implementation detail of these three.
