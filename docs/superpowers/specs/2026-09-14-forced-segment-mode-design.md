# Forced motor / forced sail per waypoint segment — design

Status: §1 rulings approved by the maintainer (2026-09-14); §2–§8 are the design implementing them.
Covers: #885
Milestone: spec in v0.34.0; implementation planned for v0.35.0

The router optimises passage time. It cannot know about channel width,
traffic separation, bridge timing or a skipper's standing practice; #244
declined OSM fairway data as a routing input. This feature
lets the captain state the mode for a stretch of the passage directly.

## 1. Rulings

| # | Question | Ruling |
|---|---|---|
| R1 | Hard constraint or preference? | **Hard, both directions.** Forced motor plans motor only; forced sail never motors. |
| R2 | Unit of the override | **The waypoint segment** (origin→via, via→via, via→destination). A `Leg` is solver output and is not addressable before planning. |
| R3 | Does it apply to both rig solves? | **Yes, to every requested sail.** Forced-motor segments use a **rig-independent heading fan** (§3.2). |
| R4 | Forced motor while `settings.motorEnabled` is false | **Rejected** (enforcement: §3.3, §6). |
| R5 | Mark forced legs in the result | **Yes**, optional `forced` marker on legs. |
| R6 | Via edits | Structural edits **clear** the affected overrides; inserting a via **inside** a forced segment copies its mode to both halves; live reroute drops all overrides with the vias, disclosed. |
| R7 | Relation to #354 | **Workaround, not a fix.** #354 stays open. |

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
  user settings, and a `DEFAULT_SETTINGS` edit moves every sweep arm that does
  not override that field (`app/sweep/sweepArms.ts`).
- `forced` is optional and absent on unforced legs, so `app/sweep/`'s
  `JSON.stringify` output is unchanged for every plan without overrides — the
  `LegCommon.shallow?` precedent.

## 3. Solver semantics

### 3.1 Carrying the override

`planRoute.ts`'s `run` passes `forcedKind` for segment `i` in that segment's
`SolveParams` (absent ⇒ today's path); `run` is one sail's solve and loops over
its segments. Every relaxation tier calls `runAll`
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
  against today's per-node candidate set (`mags` in `solve`, motor enabled).
- Rig independence claimed here is polar independence. Forced-motor geometry does not read the clock except at the forecast horizon, so both rigs should produce identical geometry up to floating-point near-ties; §7 measures it and a mismatch is a finding.
- Motor turns stay uncharged (motor-decision spec §10). The #264 justification
  for motor weaving (sail-locked heading bands) does not exist inside an
  all-motor segment. A zigzag can still arise there: at default settings
  #243's depth-comfort cost (`edgeFactor`) prices motor candidates by
  clearance, and substeps shorten clocks. The fixed fan does not by itself
  prevent it: straightness is measured in acceptance (§7). A turn penalty is
  out of scope.
- Via-joint maneuver-state reset and per-segment `mergeCollinearLegs` are
  unchanged; merging never crosses a joint, so a forced span never merges into a
  neighbour.
- Every leg solved in a forced segment carries `forced: true`.

### 3.3 Pre-solve validation

`planRoute` returns a typed error, with no solve, when:
- any entry is `'motor'` and `settings.motorEnabled` is false (label
  `segment-mode-conflict`), or
- `segmentModes.length !== viaPoints.length + 1`.

That rejection is the R4 guarantee. The UI additionally shows the conflict on
the segment control while the motor is off (§6), which covers the
settings-first order: mark a segment motor, disable the motor, then Plan.

The length check is only safe once every producer keeps the invariant (§5.2).

## 4. Failure modes

- New internal `SolveFailureCause` `'forced-sail-calm'`, public label
  `'calm-sail-only'` (a distinct string; `planRoute.reasonDecoupling.test.ts`
  reds an identical pair). Emitted only when
  `forcedKind === 'sail'`, by replacing the calm arm of `solve`'s death
  heuristic.
- Both `comfortRetryMayHelp` and `depthRelaxationMayHelp` **reject** it; a
  forced-sail calm must not burn tiers 2–4.
- `combineFailureCause` precedence: below `horizon-exceeded`, above
  `calm-without-motor`.
- Copy names the real remedy: "Too little wind to sail the segment you marked
  sail-only. Unmark it or choose another departure." (de + en).
- A plan whose request carries a forced-sail segment and fails
  `horizon-exceeded` also names "unmark the sail-only segment" in its remedy.
  The label stays `beyond-horizon` (#282: labels are a function of the cause);
  a presentation helper `noRouteMessageKey(reason, request)` in `lib/plan.ts`
  replaces every direct `NO_ROUTE_MESSAGE_KEY[...]` read that renders copy
  (usePlanFlow, replan, reroute, useDepartureConfirm, RouteSummary,
  DepartureCompare). `migratePlan.ts`'s `Object.hasOwn` validation keeps
  reading the table.
- Forced-motor segments fail on mask, horizon and budget; on `forcedKind === 'motor'` the heuristic's fallback arm returns `mask-blocked`, since a motor candidate cannot be calm.
  Site: the `cause:` return at the end of `isochrone.ts:solve`
  (`blockedDeaths >= calmDeaths && blockedDeaths > 0 ? 'mask-blocked' : 'calm-without-motor'`).
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
  never fabricate), mirroring `normaliseViaPoints`. Dropping the field instead
  would silently free a constrained segment.
- `isLegShaped` rejects a present `forced` other than `true`.
- Disclosed: an older build (prod and `/uat/` share one origin's IndexedDB)
  solves without the field, but `recalcRequest` and `useDepartureConfirm`
  spread the stored request, so a recalculation or departure change there
  saves a record that keeps `segmentModes` while no leg honours them.
- Disclosed: an older build maps a stored per-sail reason `calm-sail-only`,
  unknown to it, to `null` (`migratePlan.ts:sailResultOf`), and `RouteSummary`
  renders that sail as `error.savedPlanUnreadable`.

### 5.2 Keeping the invariant under via mutation

Draft modes live in `App.tsx` as `draftSegmentModes`, beside `draftViaPoints`.
Via-mutation sites and their rules:
- appends (`handleMapTap`'s via branch, `handleAddViaByCoord`, `insertViaNearestOrAppend`'s fallback) insert into the last segment, so they copy its mode to both halves (R6);
- insertion inside a segment copies the split segment's mode to both halves
  (R6): `lib/viaInsertion.ts:nearestViaInsertIndex` (via
  `App.tsx:insertViaNearestOrAppend`) and `App.tsx:handleInsertViaAfter`
  (#1171, which does not use it);
- `handleViaDragEnd` clears the two segments touching the dragged via;
- `App.tsx:handleUpdateViaByCoord` clears the touched segments on a coordinate change, not on a name-only edit;
- `handleRemoveVia` and `handleReorderVia` clear the segments touching each
  removed or moved via;
- the plan-sync effect loads draft modes from `plan.request` under the same #660
  guard, and `pendingFormBaselineRef` snapshots them;
- `handleImportRoute` resets draft modes to all-`null`;
- `handlePlan`'s `usePlanFlow` `run({ … })` request literal carries them;
- `lib/planForm.ts:planFormDirty` and `App.tsx:viaDraftStale` compare modes, so
  a mode-only edit dirties the form;
- `lib/recalc.ts:recalcRequest` copies `segmentModes` explicitly (its
  copied-never-aliased contract);
- `state/replan.ts:dedupeViaPoints` also returns the kept indices beside `kept`
  (`App.tsx:droppedViaLabels` needs `kept`'s object identity). `usePlanFlow.ts`'s
  run path and `replanWithVias` rebuild `segmentModes` from them; a dropped via
  merges two segments into one that keeps the mode of its non-degenerate half (the one outside the 60 m dedupe radius), never `null`: clearing would silently free a constrained segment, the outcome §5.1's refusal avoids. The other two
  callers, `droppedViaLabels` and `useViaReplan` (`droppedCount` only), need no
  change. `replanWithVias`/`useViaReplan` have no production caller (#571);
- `state/reroute.ts` drops `segmentModes` with the vias (R6): its request is a
  fresh literal.

Carried by spread, no edit: `useDepartureConfirm`, `DepartureCompare`'s `base`.

## 6. UI

- Between consecutive waypoint rows in the planner, a segmented control
  (solver decides / motor / sail) built from the existing `Button` primitive
  and `--sc-*` tokens; de + en keys.
- While the motor is off, the motor option is disabled with its reason shown,
  and a segment already marked motor shows the conflict (R4, §3.3).
- `live.reroute.hint` (de + en) says via points and segment overrides are not carried over (R6).
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
- **Cause tables:** extend `planRoute.budget.test.ts`'s `PRECEDENCE` and
  `planRoute.reasonDecoupling.test.ts`'s `EXPECTED`, `EXPECTED_LABELS` and
  literal cause count.
- **Real mask:** a new `realmask.repro.*` sibling with two vias bracketing a
  confined passage, forced motor. Assert mode; **measure and report** track
  straightness against a navigable alternative, and whether the two rigs'
  forced-motor geometries match (a mismatch is a finding, §3.2). Do not pin a
  detour threshold from one run.
- #354's reproduction routes (`docs/spikes/354-mode-churn.md` §3.1) are never cited as fix evidence (R7).
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
