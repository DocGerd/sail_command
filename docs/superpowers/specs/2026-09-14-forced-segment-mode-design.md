# Forced motor / forced sail per waypoint segment — design

Status: **approved** (maintainer rulings, 2026-09-14)
Covers: #885
Milestone: spec in v0.34.0; implementation in v0.35.0

The router optimises boat speed only. It cannot know about channel width,
traffic separation, bridge timing or a skipper's standing practice, and #244
declined the only in-region data that might have supplied that. This feature
lets the captain state the mode for a stretch of the passage directly.

## 1. Rulings

| # | Question | Ruling |
|---|---|---|
| R1 | Hard constraint or preference? | **Hard, both directions.** Forced motor plans motor only; forced sail never motors. A preference would re-enter the cost-shaping space `docs/spikes/354-mode-churn.md` measured inert or harmful. |
| R2 | Unit of the override | **The waypoint segment** (origin→via, via→via, via→destination). A `Leg` is solver output and is not addressable before planning. |
| R3 | Does it apply to both rig solves? | **Yes, to every requested sail.** Forced-motor segments use a **rig-independent heading fan** (§3.2). |
| R4 | Forced motor while `settings.motorEnabled` is false | **Rejected**: the UI prevents it, and `planRoute` returns a typed error before solving. |
| R5 | Mark forced legs in the result | **Yes**, optional `forced` marker on legs. |
| R6 | Via edits | Structural edits **clear** the affected overrides; inserting a via **inside** a forced segment copies its mode to both halves; live reroute drops all overrides with the vias, disclosed. |
| R7 | Relation to #354 | **Workaround, not a fix.** #354 stays open. Acceptance never cites #354's reproduction routes as fix evidence. |

## 2. Data model

```ts
type SegmentMode = 'motor' | 'sail';

interface PlanRequest {
  // index i governs waypoint i -> waypoint i+1 of [origin, ...viaPoints, destination]
  segmentModes?: readonly (SegmentMode | null)[];   // length === viaPoints.length + 1
}

interface LegCommon { forced?: true }                // absent on every unforced leg
```

- `null` and an absent array both mean "solver decides". An absent array is the
  only state today's records have.
- `Settings` is unchanged: per-segment data does not belong in the plan-global
  user settings, and a `DEFAULT_SETTINGS` edit moves every sweep arm.
- `forced` is optional and absent on unforced legs, so `app/sweep/`'s
  `JSON.stringify` output is unchanged for every plan without overrides — the
  `LegCommon.shallow?` precedent.

## 3. Solver semantics

### 3.1 Carrying the override

`planRoute.ts`'s per-segment `run` passes `forcedKind` for segment `i` in
`SolveParams` (absent ⇒ today's path). Every relaxation tier calls `runAll`
with the request and settings unchanged, so the override survives all tiers and
both rigs with no tier-specific code. `findRelaxedGate` and `connectedAt` are
mask-only and stay mode-agnostic.

### 3.2 Inside `isochrone.ts:solve`

- **Forced sail** behaves as `motorEnabled: false` for that segment: no motor
  candidates, calm below `MIN_SAIL_KN`.
- **Forced motor** generates only motor candidates at `settings.motorSpeedKn`,
  from a **fixed heading fan plus the direct bearing**, independent of
  `polar.beatAngleDeg`/`gybeAngleDeg` (meaningless with no sail up). The fan's
  spacing is an implementation choice; the PR must report its candidate count
  against today's motor fan.
- Rig independence claimed here is **polar** independence. Each rig reaches a
  via at a different time. Whether that yields identical geometry is an
  acceptance measurement (§6), not a property this spec asserts.
- Motor turns stay uncharged (motor-decision spec §10). The #264 justification
  for motor weaving (sail-locked heading bands) does not exist inside an
  all-motor segment, so a zigzag there would be tie-break-decided. The fixed
  fan does not by itself prevent that: straightness is measured in acceptance
  (§6). A turn penalty is out of scope.
- Via-joint maneuver-state reset and per-segment `mergeCollinearLegs` are
  unchanged; merging never crosses a joint, so a forced span never merges into a
  neighbour.
- Every leg solved in a forced segment carries `forced: true`.

### 3.3 Pre-solve validation

`planRoute` returns a typed error, with no solve, when:
- any entry is `'motor'` and `settings.motorEnabled` is false (label
  `segment-mode-conflict`), or
- `segmentModes.length !== viaPoints.length + 1`.

The length check is only safe once every producer keeps the invariant (§5.2).

## 4. Failure modes

- New internal `SolveFailureCause` `'forced-sail-calm'`, public label
  `'calm-sail-only'` (spelled apart from the cause, as every existing pair is —
  `planRoute.reasonDecoupling.test.ts` enforces it). Emitted only when
  `forcedKind === 'sail'`, by replacing the calm arm of `solve`'s death
  heuristic.
- Both `comfortRetryMayHelp` and `depthRelaxationMayHelp` **reject** it; a
  forced-sail calm must not burn tiers 2–4.
- `combineFailureCause` precedence: below `horizon-exceeded`, above
  `calm-without-motor`.
- Copy names the real remedy: "No wind to sail the segment you marked sail-only.
  Unmark it or choose another departure." (de + en).
- A plan whose request carries a forced-sail segment and fails
  `horizon-exceeded` also names "unmark the sail-only segment" in its remedy.
  Today's copy ("try a later departure or a closer destination") omits it.
- Forced-motor segments fail only on existing causes (mask, horizon, budget),
  whose copy is already true.
- One sail failing on a forced segment while the other routes is handled by
  `assemble` unchanged.
- Disclosed residual: the death heuristic can still classify a forced-sail calm
  as mask-blocked (#264's incidental finding). The new cause narrows the
  "impossible constraint vs blocked mask" ambiguity; it does not close it.

## 5. Persistence and via edits

### 5.1 Stored records

- Absent `segmentModes` reads as no overrides; not a breaking change, no
  migration machinery.
- `migratePlan.ts:migrateRequest` spreads the stored request, so a new
  top-level field would pass through unvalidated. Add a `normaliseSegmentModes`:
  absent → omit; malformed or wrong length → refuse the record (fail closed,
  never fabricate), mirroring `normaliseViaPoints`.
- `isLegShaped` admits the optional `forced`.
- Disclosed: an older build reading a newer record (prod and `/uat/` share one
  origin's IndexedDB) ignores the field, and a recalculation there drops the
  constraint.

### 5.2 Keeping the invariant under via mutation

Every site that changes `viaPoints` must change `segmentModes` in step:
- `state/replan.ts:dedupeViaPoints` returns the kept indices, and both callers
  (`usePlanFlow.ts`'s run path, `replanWithVias`) splice `segmentModes`
  accordingly;
- add, remove, reorder and drag in `App.tsx`/`PlannerPanel.tsx` clear the
  overrides of the segments they touch (R6);
- `lib/viaInsertion.ts:nearestViaInsertIndex` insertion copies the split
  segment's mode to both halves (R6);
- `state/reroute.ts` drops `segmentModes` with the vias (R6);
- GPX import produces no overrides;
- `lib/planForm.ts:viaPointsDiffer` (or a sibling) compares modes too, so a
  mode-only edit dirties the form.

## 6. UI

- Between consecutive waypoint rows in the planner, a tri-state control
  (solver decides / motor / sail), built from the existing primitives (`Chip`,
  `Button`) and `--sc-*` tokens; de + en keys.
- The motor option is disabled, with its reason shown, while the motor is off
  (R4).
- The legs table and map label forced legs as ordered by the captain, so they
  do not read as the solver's speed verdict.
- Design floor: ≥ 820 CSS px (maintainer ruling 2026-09-07).
- A Playwright locator for the new control must not collide with existing
  accessible names in either language (`getByRole` substring matching).

## 7. Testing and acceptance

- **Unit:** a forced-motor segment yields only motor legs, a forced-sail
  segment only sail legs, both marked `forced`; with no overrides the plan is
  byte-identical to BASE (fingerprint compare); both rigs honour the override;
  it survives a relaxed-tier plan (a Marstal-origin route with a via).
- **Cause tables:** extend the exhaustive tables for `combineFailureCause`,
  `comfortRetryMayHelp` and `depthRelaxationMayHelp`; the decoupling guard stays
  green.
- **Real mask:** a new `realmask.repro.*` sibling with two vias bracketing a
  confined passage, forced motor. Assert mode; **measure and report** track
  straightness against a navigable alternative, and whether the two rigs'
  forced-motor geometries match. Do not pin a detour threshold from one run.
- **Persistence:** `segmentModes` and `forced` round-trip through `migratePlan`;
  a wrong-length record is refused.
- **Mutation checks:** delete the forced-motor branch → the real-mask test reds;
  drop `normaliseSegmentModes` → the round-trip test reds; admit the new cause in
  `depthRelaxationMayHelp` → its truth table reds. Run each at BASE as well.
- **Sweep:** `isochrone.ts` and `planRoute.ts` change, so the #282 sweep is owed
  — BASE double-run plus HEAD, detached, per `app/sweep/README.md`. Every arm
  plans with `viaPoints: []`, so it proves only that the override-absent path is
  unchanged. It is a regression control, never evidence for this feature.

## 8. Non-goals

- Fixing #354's mode churn (R7).
- Fairway-aware routing (#244).
- Motorsailing, and charging motor turns (motor-decision spec §10).
- Forcing a mode on an individual solved leg (R2). A "force this leg" action
  that inserts vias at a leg's endpoints would be UI sugar on this model and is
  deferred.
- Keeping overrides through a live reroute (R6).
