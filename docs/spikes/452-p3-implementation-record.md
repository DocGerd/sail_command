# #452 P3 implementation record — approach-scoped depth relaxation

Companion to `docs/spikes/452-local-depth-relaxation.md`, which recommended P3
with six grafts but did not build it. This document records what was actually
built, where each graft landed, what was measured, and — explicitly — what
remains unverified.

Branch `feat/452-p3-approach-radius`, merge-base `develop @ d73fa0d`.
`APPROACH_RADIUS_M = 1852` is the maintainer's ruling and was not re-litigated.

---

## 1. What was built

A per-cell depth gate FIELD replaces the route-wide relaxed SCALAR.

`app/src/lib/depthGate.ts` (new) defines `DepthGate = UniformGate |
ApproachGate`, plus `uniformGate`, `approachGate`, `gateAtCell` and
`gateFloorM`. `gateAtCell` returns the requested depth outside every disc, and
the DEEPEST gate among the discs containing a cell inside one.

**Deviation from the plan, with its reason.** The plan put this module at
`app/src/routing/depthGate.ts`. It is in `app/src/lib/` instead: `NavMask`
calls `gateAtCell` at RUNTIME (not merely as a type), and the repo's import
direction is strictly `routing -> lib` with zero `lib -> routing` edges today
(measured: `grep -rn "from '\.\./routing" app/src/lib/` returns nothing).
Placing it under `routing/` would have created the first inversion. Nothing
else about the module differs from the plan's specification.

Threaded through:

| site | before | after |
|---|---|---|
| `NavMask.cellNavigable` (private) | `safetyDepthM: number` | `gate: DepthGate`, first read is `gateAtCell(gate, row, col)` |
| `NavMask.segmentNavigable` | scalar | `gate: DepthGate` |
| `NavMask.segmentClearanceM` | scalar | `gate: DepthGate` (the inlined per-cell check consults the field) |
| `NavMask.cellsConnected` | scalar | `gate: DepthGate` |
| `NavMask.snapToNavigable` | scalar | UNCHANGED signature — builds one `uniformGate` internally (spike §1.4: snapping is not relaxable, and the discs are defined AROUND its output, so no field can exist before it runs) |
| `NavMask.isNavigable` | scalar | UNCHANGED — point predicate, no solver caller |
| `NavMask.segmentShallowestBelow` | `thresholdM` | UNCHANGED — gate-independent by construction |
| `isochrone.ts :: edgeFactor` | `gateM: number` | `gate: DepthGate` |
| `isochrone.ts :: SolveParams` | — | gains `gate?: DepthGate`; absent ⇒ `uniformGate(settings.safetyDepthM)` |
| `postprocess.ts :: mergeCollinearLegs` / `tryMerge` | `settings: Settings` | `gate: DepthGate` |
| `relaxedDepth.ts :: findRelaxedDepthM` | returns `number \| null` | RENAMED `findRelaxedGate`, returns `{ gate, usedDepthM } \| null`, takes an explicit `approachRadiusM` parameter |

`planRoute.ts` no longer builds `{ ...s, safetyDepthM: usedDepthM }`.
`Settings.safetyDepthM` is never overwritten with a relaxed value anywhere —
spike §7 records this as a correctness improvement independent of locality.

`planRoute.ts :: connectedAt` now DELIBERATELY diverges from
`findRelaxedGate`'s own connectivity probe (spike §1.3 warned the two
"must be changed together"; under P3 the divergence is the design). A comment
at that site says so, because re-unifying them would silently re-globalise the
relaxation.

**`PlanResult` / `Leg` / `ShallowInfo` shape: UNCHANGED.** No field added,
removed, renamed or retyped. `DepthGate` is never imported by `types.ts` — the
same containment `SolveFailureCause` and `RoutingFailureKind` already have.
The VALUES on relaxed plans do move; the shape does not.

---

## 2. The six §3.2 grafts

**Graft 1 — per-disc gates, not one relaxed scalar per disc.** Phase 2 of
`findRelaxedGate`: after the shared binary search, each disc is raised in turn
to the highest gate at which the whole waypoint chain still connects, with
every other disc held where it is. Sound because raising ONE disc's gate only
removes cells. Skipped under the kill switch, so the neutralized state
reproduces the pre-#452 PROBE SEQUENCE, not merely the pre-#452 route.
Adapted from P1's per-PATCH idea to per-DISC — it runs no witness BFS, no
dilation, and carries none of P1's unmeasured dilation radius.

**Graft 2 — P1's test methodology.** Containment is enforced structurally
rather than by a property test: phase 2 only ever RAISES gates from a
configuration already known to connect and re-probes at every step, so the
returned field is a provable subset of phase 1's. The refusal to assert
`g_i >= BOAT_DRAFT_M` as a test row is honoured — it is a theorem given
`loDm = Math.round(BOAT_DRAFT_M * 10)`, so no reachable change violates it
(#410). The merge-pass locality mutation and the kill-switch byte-identity
rows are both present (§3).

**Graft 3 — `minGateDepthM` / `usedDepthM` must not fall below BASE.** Two
homes, because there is no BASE at runtime. In TEST:
`realmask.repro.test.ts`'s DEFAULT_SETTINGS Flensburg→Marstal case still pins
`usedDepthM: 2.3`, re-derived independently (§4) rather than kept green — a
scoping bug that shrinks the search lowers it, so that row IS the falsifiable
runtime form of this guard. In ACCEPTANCE: `app/sweep/README.md`'s escalation
trigger (any `ok → error`, any `usedDepthM` below BASE's, any `minGateDepthM`
below BASE's) — NOT YET RUN, see §6.

**Graft 4 — `ShallowInfo.shallowDistanceNm` + `radiusM`.** DEFERRED by
orchestrator ruling, tracked as **issue #516**. Both fields change the
serialised `PlanResult` on every relaxed row, which would make the sweep's
byte-diff unable to separate "routing changed" from "schema grew".

**Graft 5 — the same gate into `mergeCollinearLegs`.** Landed as the
`settings: Settings` → `gate: DepthGate` parameter swap in `postprocess.ts`
(both `mergeCollinearLegs` and `tryMerge`) and at the `planRoute.ts :: run`
call site. The strict, non-union mask signature is what forced the compiler to
visit `postprocess.ts`'s three `segmentClearanceM` calls rather than let them
keep compiling against a scalar.

**Graft 6 — split the disc-gate change from the comfort-ramp change.**
Honoured: NO ramp re-anchor ships here. `edgeFactor` anchors at
`gateFloorM(gate)`, which for a `UniformGate` is the gate itself and for an
`ApproachGate` is `minGateM` — the same value the pre-#452 relaxed tiers put
in `settings.safetyDepthM`. A `Math.min(1, …)` clamp was added to the
shortfall; see §5 for why the plan's justification for it is wrong and it is
inert.

---

## 3. Mutation checks

Every mutation was applied to a clean tree, run, and reverted with an empty
`git diff` confirming the revert.

| # | mutation | result |
|---|---|---|
| M1 | `gateAtCell` overlap MAX → MIN | RED 1: `expected 2.3 to be close to 2.7` |
| M2 | delete the ellipse test (bbox becomes membership) | RED 3, incl. the bbox-corner cell `expected 2.3 to be close to 3` |
| M3 | drop `cos(lat)` from the column radius | RED 2: `expected 3 to be close to 2.3` |
| M4 | kill switch returns a huge-radius `ApproachGate` | RED 1: `expected 'approach' to be 'uniform'` |
| M5 | delete phase 2 (per-disc ascent) | RED 2: `[2.5, 2.7, 2.6]` vs the expected 8-probe sequence |
| M6 | kill switch falls through into phase 2 | RED 1: `[2.5, 2.2, 2.3, 2.4, 2.7, 2.5, …]` vs `[2.5, 2.2, 2.3, 2.4]` |
| M7′ | `tryMerge` validates route-wide at `gateFloorM(gate)` (the pre-#452 hazard) | RED 1: graft-5 locality row, `expected 1 to be 2` |
| M8 | `APPROACH_RADIUS_M` → `Infinity` | RED 3 in `planRoute.shallow`; RED 1 in `realmask` naming real offenders 7.46–8.01 nm out |
| M9a | `cellNavigable` ignores the field, uses `requestedDepthM` | RED 2: `expected false to be true` (the ACCEPT half) |
| M9b | `cellNavigable` uses `minGateM` | RED 2: `expected true to be false` (the REJECT half) |

M9a and M9b are a deliberate pair: a one-sided test would pass under one of
them, so both halves of each accept/reject pair are load-bearing.

**M7 — initially UNREACHABLE, then made reachable with a new fixture.**
Making `planRoute.ts :: run` pass `uniformGate(settings.safetyDepthM)` to
`mergeCollinearLegs` while still passing the field to `solve()` — the plan's
own §5.5 "forgot graft 5" mutation — first red ZERO tests. That was not weak
evidence, it was NO evidence: measured, the genoa result on the
`reqNearApproach` fixture is a SINGLE leg (`GENOA legs=1 … maxLegNm=7.796`,
byte-identical with and without the mutation), so the merge pass is a no-op
and the mutation cannot reach the behaviour.

**Closed by fixture, not by argument.** A probe across origin columns found
the merge pass is load-bearing once the route is long enough for the solver
to emit several collinear legs:

| origin col | genoa legs (HEAD) | genoa legs (M7) | max leg nm HEAD → M7 |
|---|---|---|---|
| 5 | **1** | **2** | 27.72 → 21.59 |
| 20 | 3 | 4 | 24.01 → 24.01 |
| 40 | 3 | 4 | 20.51 → 20.51 |
| 80 | 1 | 1 (fock 1 → 2) | 14.73 → 14.73 |
| 165-adjacent (`reqNearApproach`) | 1 | 1 | 7.796 → 7.796 (unreachable) |

Origin col 5 is the case built on: at HEAD the whole ~27.7 nm passage merges
into ONE span that crosses the 2.5 m gap, navigable only because the
destination's approach disc licenses that cell. `planRoute.shallow.test.ts ::
'#452 graft 5: the merge pass re-validates against the field, not a uniform
gate'` pins it. M7 now REDS: `expected 2 to be 1`.

**The two graft-5 tests cover opposite errors and neither is sufficient
alone**: this one reds when the merge pass is handed a gate that is too
STRICT (uniform requested); `postprocess.test.ts`'s pair reds when it is
handed one too PERMISSIVE (uniform at the relaxed floor — the pre-#452
hazard). Together they pin the wiring in both directions.

---

## 4. Re-deriving `realmask.repro.test.ts`'s DEFAULT case

The acceptance criterion required this case be RE-DERIVED, not kept green.

**Method — an independent reimplementation, not a re-run of the code under
test.** A standalone Node script read `app/public/data/mask.bin` and
`mask.meta.json` as raw bytes and reimplemented, from scratch: the snap ring
search, disc membership as an exact HAVERSINE in metres (the implementation
uses a linearised ellipse in grid space — a deliberately different
construction), and a stack-based 4-connected flood fill. It imports neither
`NavMask` nor `depthGate.ts`. The expected numbers were written into the test
BEFORE `planRoute` was run against them.

Results:

```
Flensburg snap cell 1195 46   (54.798125, 9.433818)   24.7 m from the harbour point
Marstal   snap cell 1338 1551 (54.857708, 10.528364)  31.6 m
disc cells at R=1852: Flensburg 4983, Marstal 4993

PHASE 1: connects at 2.3, 2.2, 2.1; fails at 2.4 .. 2.9  → highest = 2.3
PHASE 2: Flensburg disc -> 2.3 m,  Marstal disc -> 2.3 m
         usedDepthM = min = 2.3 m
```

`usedDepthM = 2.3` is CONFIRMED, unchanged from BASE — graft 3's guard holds
on this route. The solver agrees with the hand-derivation.

**A concrete plan claim this REFUTES.** The plan predicted that "with the
pinch at Marstal's approach, the Flensburg disc tightens back toward the
requested depth instead of sitting at 2.3 m, which is literally the reported
complaint". It does not. `connects(2.4, 2.3)` is FALSE: the Flensburg disc
genuinely needs 2.3 m too, so phase 2 tightens NEITHER disc on this route.
Phase 2 is exercised and pinned on the synthetic approach fixture instead
(where the origin disc does rise 2.5 → 2.9), not on Flensburg→Marstal.

**The two distances the spike records as never measured.**

- Marstal snap → the cliff-driving cell pair at lat 54.8502–54.8506 /
  lon 10.5378–10.5385: **1026.1 m**. The spike states a value inside the
  1050–1060 m band would explain the radius cliff and that "any other distance
  would refute it". 1026.1 m is OUTSIDE that band, so this REFUTES the
  spike's hypothesis rather than confirming it. The 1068-vs-1060 contradiction
  (spike R1) is untouched by this and remains open; it cannot change R = 1852,
  which clears both figures.
- Flensburg→Marstal connects at R = 1852 with the phase-2 gates: **true**
  (38.02 nm apart).

---

## 5. Corrections that SUPERSEDE the spike's numbers

The spike is the artifact future sessions read; these correct it. It was not
edited (another agent owns that file).

**(a) The `isochrone.test.ts` ripple count.** Spike §4(a)/§6 says the change
"ripples through … 9 `isochrone.test.ts` cases". **9 is the CALL-SITE count,
not the case count. The case count is 6** (`describe('#243 edgeFactor
arithmetic')`). The `relaxedDepth.test.ts` figure of 8 IS a case count and is
correct; its call-site count is 10.

**(b) Four larger ripples the spike omits entirely**, measured by `tsc -b`
after the production migration — 65 test call sites in total, versus the ~19
the spike's two numbers imply:

| API | test call sites |
|---|---|
| `segmentNavigable` | 23 |
| `segmentClearanceM` | 9 |
| `cellsConnected` | 12 |
| `mergeCollinearLegs` | 13 |
| `edgeFactor` | 9 |
| `findRelaxedDepthM` | 10 |

**(c) The fixture trap the spike does not mention, and it is the expensive
one.** EVERY pre-existing synthetic relaxation fixture puts its pinch 6–13 km
from both waypoints — entirely outside a 1852 m disc. At R = 1852 the gap cell
is gated at the requested depth, so every relaxation-positive case flips to
`unreachable`. Confirmed by running it: 4 tests failed on the first pass
(`planRoute.shallow.test.ts` x2, `planRoute.depthComfort.test.ts` x2), with
the observed descent `[2.5, 2.2, 2.1] → null`. Resolution: the tier-ladder
cases moved their destination to col 165 (~1606 m from the wall, inside a
disc) so they keep exercising relaxation, and the ORIGINAL distant geometry
was KEPT as a new test asserting the pinch is NOT relaxed — the two together
are a direct before/after on the one behaviour P3 changes.

**(d) The clamp's stated justification is wrong.** The plan claimed
`edgeFactor`'s shortfall clamp "becomes reachable with a field gate" and
specified a test for it. It does not: `segmentClearanceM` returns a minimum
over cells each of which passed its OWN gate, and every cell's gate is
`>= minGateM = gateFloorM`, so `clearanceM >= floorM` and `shortfall <= 1`
by exactly the argument the plan uses for the scalar case. The clamp SHIPPED
(it is a correct guard in the safe direction and costs one `Math.min`) but is
INERT, and per #410 no test asserts it — a mutation the codebase cannot
produce proves nothing. Its code comment says it is inert.

---

## 6. What remains UNVERIFIED

**The `app/sweep/` acceptance cycle has NOT been run.** Deliberate: the BASE
double-run control is still being recorded at this same merge-base, and a HEAD
run is meaningless until that BASE control is byte-identity-verified. Nine arms
x 33 harbours = 297 plans. `becalmed` and `deep-becalmed` are VACUOUS as safety
evidence (33/33 errors each); the discriminating arms are `margin-zero`,
`relaxation-dense` and `margin-extreme`. **This change moves routing values, so
the full cycle is OWED before merge.**

**R3 — P3's named trade is UNEXERCISED by every measurement that exists.**
Spike §2.3's trade is that a localized `connectedAt` can return a LOWER
connecting gate than the global search. The spike's own 2026-08-10 "P3 safety
re-solve" section states its numbers came from forcing distant sub-gate cells
to LAND in a mask clone and re-running the solver, so `findRelaxedDepthM`
"still searched against a single scalar gate" — and that run was at
**R = 2400 m only, never at 1852 m**. Its "0/29 worse `usedDepthM`" is
therefore **not evidence about what was built here**, and is not cited as
support anywhere in this document. Phase 2 makes the trade MORE likely to
bite, not less, because it raises gates after a search that was already harder.
Test 12's synthetic fixture and the pending sweep are the only controls.

**R5 — the sweep's discriminating arms are all Marstal geography.**
`sweepArms.ts` records that only 27 of 528 harbour pairs relax at all and every
one involves Marstal. A green sweep will therefore evidence safety ON MARSTAL
GEOGRAPHY, not generally. The spike's §6 item 5 wants evidence that a per-disc
gate can come out lower on some real harbour OTHER than Marstal; that evidence
does not exist and this change does not create it. This is a scope limit on
what any green result here can mean, not a caveat to skim.

**R4 — performance, MEASURED.** Same test, same machine, same
`node_modules`, apples-to-apples on `realmask.repro.test.ts`'s
Flensburg→Marstal DEFAULT_SETTINGS case (`1 passed | 12 skipped` at BASE,
`1 passed | 13 skipped` at HEAD, so the filter matched in both):

- BASE `d73fa0d`: **58.38 s**
- HEAD (P3): **77.61 s**
- ratio **1.33x**

Under the plan's own ~1.5x threshold, so not treated as a design problem — but
material, and the failure mode does not surface in CI. `planRoute()` is
UNBUDGETED at every vitest call site, while the browser worker imposes
`PLAN_BUDGET_MS = 120_000` (#432). A route already close to that ceiling can
be pushed past it by a 1.33x factor and would fail as a user-facing
`search-budget-exceeded`, with the whole vitest suite still green. The Node
figures above are NOT comparable to a browser worker's budget (CLAUDE.md is
explicit on this); only the RATIO transfers. A real-browser timing pass on
Flensburg→Marstal is owed and has not been done.

**Also not done:** no e2e run (port 4173 is contended), and no real-browser
pass of any kind.

**R7 note.** Only `1852` appears in the code. The spike's `1852 m / 3704 m`
pairing is deliberately absent from every comment: they license 34x-vs-90x
different amounts of shallow water and must never read as comparable
alternatives.
