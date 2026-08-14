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
below BASE's) — RUN, none fired, see §7.

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

**The `app/sweep/` acceptance cycle HAS been run — see §7. NO stop condition
fired.** A comparison certifies this branch only against the merge-base it was
recorded at. It was first recorded against `d73fa0d`; the branch was later
re-synced, and on 2026-08-13 both the BASE control and the HEAD run were
re-recorded and reproduced bit-for-bit — on a different machine and day, which
is a STRONGER control than the required self double-run, because it tests the
baseline against the very thing that would invalidate it rather than only
against itself.

A control taken against a `develop` that then moves certifies nothing, so after
any further re-sync re-check the sweep's transitive input closure
(`app/src/routing/`, `app/src/lib/mask.ts`, `app/src/lib/depthGate.ts`,
`app/public/data/`, `app/sweep/`, `pipeline/`) before relying on it. That
exemption fails OPEN, so default to re-running and skip only after checking the
closure itself — never a remembered path list.

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

---

## 7. Acceptance sweep — BASE `d73fa0d` vs HEAD

BASE control: `run1` vs `run2` returned 297/297 plans byte-identical at this
branch's own merge-base, which is what licenses the comparison below.

```
node app/sweep/compare.mjs <base>/run1 <head>
```

```
arm becalmed         33 plans  sha A=8dc119cd9a1fdced B=8dc119cd9a1fdced IDENTICAL
arm breeze           33 plans  sha A=a5c90069ff08ca43 B=463ef93a41777330 *** DIFFERS ***
arm deep-becalmed    33 plans  sha A=7e7ac2e14d5305ae B=7e7ac2e14d5305ae IDENTICAL
arm light-motorless  33 plans  sha A=e8a1778afbc95dae B=e8a1778afbc95dae IDENTICAL
arm margin-extreme   33 plans  sha A=897495f53da137f6 B=d6d1b6b35a0bee04 *** DIFFERS ***
arm margin-zero      33 plans  sha A=44f1e20c908032f4 B=deea356f595a27bc *** DIFFERS ***
arm no-comfort       33 plans  sha A=f9680d75231d17d8 B=5fe0fa8f5f464745 *** DIFFERS ***
arm relaxation-dense 33 plans  sha A=471f32a87d1b0986 B=372e41b565451d00 *** DIFFERS ***
arm short-horizon    33 plans  sha A=3b205013ed1a5fea B=3b205013ed1a5fea IDENTICAL

237/297 plans byte-identical across 9 arms x 33 harbours/arm
```

### Per-arm

| arm | rows changed | usedDepthM | minGateDepthM | leg count | ETA | outcome class |
|---|---|---|---|---|---|---|
| becalmed | 0 | 0 | 0 | 0 | 0 | 0 |
| breeze | 1 | 0 | 0 | 1 | 1 | 0 |
| deep-becalmed | 0 | 0 | 0 | 0 | 0 | 0 |
| light-motorless | 0 | 0 | 0 | 0 | 0 | 0 |
| margin-extreme | 18 | 0 | 0 | 16 | 16 | 0 |
| margin-zero | 21 | 0 | 0 | 19 | 21 | 0 |
| no-comfort | 1 | 0 | 0 | 1 | 1 | 0 |
| relaxation-dense | 19 | 0 | 0 | 13 | 15 | 0 |
| short-horizon | 0 | 0 | 0 | 0 | 0 | 0 |

The three discriminating arms all MOVED, so the change is not inert on the only
arms that can see it. `becalmed`/`deep-becalmed` are byte-identical and that is
VACUOUS (0 ok / 33 errors each) — not counted as reassurance. The other four
byte-identical arms are meaningful: `light-motorless` and `short-horizon` carry
real routes and did not move.

### Stop conditions: NONE FIRED

- `ok -> error`: **0**. Every changed row kept its outcome class exactly
  (157 ok plans on both sides).
- `usedDepthM` worse than BASE: **0** — not one row's value moved at all.
- `minGateDepthM` worse than BASE: **0** — likewise unmoved.

### The explanation

**All 60 changed rows carry a `shallow` block on at least one side — i.e.
relaxation fired on every row that moved, and no row where relaxation did not
fire moved at all.** That containment is the primary result: the change touches
exactly the population it is supposed to touch.

The invariant, measured across the whole population by an independent scan of
the raw mask bytes (sub-gate cells on either rig's legs, farther than 1852 m
from every snapped waypoint):

| | ok plans | plans routing through out-of-disc sub-gate water | farthest such cell |
|---|---|---|---|
| BASE | 157 | **41** | **18.86 nm** (2026-08-11 scan) / **18.89 nm** (2026-08-13 re-scan) — see "Two scans, one row" below |
| HEAD | 157 | **0** | — |

Per changed row, on the recommended rig:

- **39 of 60** have direct de-licensing evidence: BASE's route crossed
  out-of-disc sub-gate cells and HEAD's crosses none. The worst row is
  `margin-zero/flensburg`, and the two scans of that row disagree: the
  2026-08-11 scan counted **10 cells**, farthest **34,935 m (18.86 nm)** from
  any waypoint; the 2026-08-13 re-scan, over byte-identical BASE data, counted
  **12 cells**, farthest **34,981 m (18.89 nm)**. Both agree HEAD crosses none.
  Read "Two scans, one row" below before quoting either figure.
- **21 of 60** complied on both sides, so the final route was never the thing
  being corrected; what changed is the SEARCH. Removing route-wide relaxed
  water changes the navigable set the isochrone explores (and, with
  `MAX_FRONTIER` live, which candidates survive), so the solver converges
  elsewhere. Of these, 6 differ only on the non-recommended rig or in leg
  segmentation with an identical polyline and identical ETA — graft 5's merge
  pass re-validating against the field. ETA deltas across the 21 are small and
  two-directional (−2.2 to +5.3 min).

Two rows moved in the six original Flensburg-origin arms — `breeze/marstal` and
`no-comfort/marstal` — which is exactly the 2-of-198 shallow-block population
`app/sweep/README.md` records for those arms. Every shallow row in the original
six moved and nothing else did.

**No row moved that the approach-radius rule does not account for.**

### A correction to this analysis, recorded because it nearly shipped

A first pass reported 14 HEAD plans still routing through out-of-disc sub-gate
water, farthest 22.74 nm. That was an error in the ANALYSIS, not the code: the
hand-built per-arm gate table used `safetyDepthM: 4.0` for `light-motorless`,
whereas `sweepArms.ts` gives that arm plain `DEFAULT_SETTINGS` (3.0 m) with
`motorEnabled: false` — only `deep-becalmed` is 4.0. Every one of the 14 was in
`light-motorless`, carried NO shallow block, and had a minimum depth of
3.0–3.1 m, i.e. at or above its real gate. `light-motorless` is byte-identical
BASE↔HEAD, so those plans are untouched by this change. With the table
corrected the count is 0. The tell was that the "violations" were confined to a
single arm that the diff says did not move.

### Two scans, one row — a disagreement that was NOT resolved

Two independently written scans of byte-identical BASE data disagree on the
per-cell detail of one row. On 2026-08-11 this section's scan reported
`margin-zero/flensburg` at **10 cells / 34,935 m / 18.86 nm**; on 2026-08-13 a
re-implemented scan reported **12 cells / 34,981 m / 18.89 nm**. Both classified
the same **41 of 157** BASE plans and **0** HEAD plans as routing through
out-of-disc sub-gate water, and the 2026-08-13 per-arm split
(1 + 8 + 20 + 1 + 11) sums to that same 41 — so the disagreement is confined to
which CELLS one scan enumerated on one route.

Ruled out from the two records alone:

- **Not the unit conversion.** 34,935 / 1852 = 18.8634 and 34,981 / 1852 =
  18.8882 — each quoted nm value rounds correctly from its own metre value at
  the same 1852 m/nm divisor.
- **Not the gate-table correction recorded just above.** That correction moved
  `light-motorless` from a wrong `safetyDepthM: 4.0` to the real 3.0 and touched
  no other arm. `margin-zero` is
  `{ ...DEFAULT_SETTINGS, depthComfortMarginM: 0 }` (`app/sweep/sweepArms.ts`),
  i.e. `safetyDepthM` 3.0 under BOTH tables, so no version of that table can
  move this row. Independently, this section's BASE figures were already on the
  corrected basis: `light-motorless` is byte-identical BASE↔HEAD, so under the
  uncorrected 4.0 m table those same 14 plans would have counted on the BASE
  side too and this table would read 55 or more, not 41.
- **Not the waypoint set on its own.** §4 measured the snap offsets at 24.7 m
  (Flensburg) and 31.6 m (Marstal). Swapping snapped for unsnapped waypoints
  moves a cell's distance-to-nearest-waypoint by at most those offsets; the two
  scans differ by 46 m, so that swap cannot by itself move a farthest cell
  sitting ~34.9 km out.

What remains, none of it discriminated:

- **Rig scope** — the one candidate with direct textual support on both sides.
  The table above declares the invariant over "either rig's legs" while the
  34,935 m figure was produced under a bullet scoped "on the recommended rig",
  and that table's 18.86 nm is numerically the same recommended-rig value. An
  either-rig scan enumerates a superset.
- **Traversal convention** — step length, 4- vs 8-connected, supercover vs DDA.
  The 46 m gap is one mask cell (46.4 m north–south, 46.8 m east–west at
  54.8 N, from `app/public/data/mask.meta.json`).
- **The sub-gate comparison at the quantisation boundary.** Depth is stored in
  whole decimetres, so `depth < gate` and `depth <= gate` differ by exactly the
  cells reading 3.0 m.
- **Distinct vs visited cells**, and **cell centre vs sampled point** as the
  distance reference. A counting convention alone is insufficient — the farthest
  cell moved, so the enumerated set genuinely differs.

**This was not settled by measurement.** Deciding between these requires
re-running both scans, and NEITHER DRIVER WAS EVER COMMITTED — `app/sweep/`
holds the nine arm files, `armNames.ts`, `sweepArms.ts`, `compare.mjs` and
`vitest.config.ts`, and no safety scan at all; neither script survives in git
history or in any scratchpad. Note also that the bit-for-bit reproduction
recorded for this branch is of the 297-plan sweep ARTIFACTS, not of either scan
over them — so neither cell enumeration is reproduced, and the newer figure is
not thereby the more trustworthy one. Until one scan is rebuilt, committed for
provenance and re-run, quote the range with its scan date attached, or quote
neither.

**Nothing above touches the headline.** 41 → 0, stop conditions 0 / 0 / 0, and
237/297 byte-identity are reported identically by both scans.

---

## 8. ETA cost at R = 1852 — the spike's headline objection REPRODUCES, and is LARGER

The spike's ETA regressions were all measured at **R = 2400 m, never at 1852**.
These are the equivalent figures at the shipped radius, from the same sweep
artifacts as §7 (no additional solver run). Deltas are on the RECOMMENDED rig
— what a user actually sees — with a same-rig control alongside, because a
recommended-rig delta silently mixes routing cost with a rig FLIP.

### Distribution across the 60 changed rows

| | value |
|---|---|
| median ETA delta | **+41.8 s** |
| slower / faster / unchanged | **43 / 11 / 6** |
| sum of all increases | **+49,814 s** |
| sum of all decreases | **−7,774 s** |

The median is small; the distribution is heavily tailed. The tail is the story,
so it is listed in full rather than described.

### Every row worse than +300 s

| row | ETA delta | recommended rig |
|---|---|---|
| `relaxation-dense/svendborg` | **+13,702 s (+228.4 min)** | fock → genoa **FLIP** |
| `margin-extreme/rudkoebing` | **+13,282 s (+221.4 min)** | genoa |
| `margin-zero/svendborg` | **+8,895 s (+148.2 min)** | genoa |
| `margin-zero/rudkoebing` | +4,722 s (+78.7 min) | genoa → fock **FLIP** (same-rig +13,424 s) |
| `relaxation-dense/rudkoebing` | +4,594 s (+76.6 min) | genoa |
| `margin-extreme/troense` | +690 s (+11.5 min) | fock |
| `relaxation-dense/assens` | +398 s (+6.6 min) | genoa |
| `margin-zero/assens` | +398 s (+6.6 min) | fock |
| `margin-extreme/assens` | +318 s (+5.3 min) | genoa |
| `margin-extreme/aeroeskoebing` | +303 s (+5.1 min) | genoa |

Everything else is under +300 s; 20 rows are under +100 s.

### Rows that got FASTER — 11, and 3 of them are flip artifacts

`relaxation-dense/troense` **−2,329 s (−38.8 min)** is the largest genuine
improvement (no flip, same-rig identical). Then `relaxation-dense/aeroeskoebing`
−130 s, `margin-extreme/faldsled` −90 s, `margin-extreme/faaborg` −38 s,
`breeze/marstal` −31 s, `relaxation-dense/soeby` −27 s, `margin-extreme/fynshav`
−18 s, `margin-zero/langballigau` −7 s, `margin-extreme/gelting-mole` −3 s,
`relaxation-dense/fynshav` −3 s.

**`margin-extreme/svendborg` reads −5,099 s (−85.0 min) and that number must not
be quoted alone**: it flips genoa → fock, and the same-rig delta is **+8,439 s**.
The rig that was recommended at BASE got much slower; a faster alternative was
already available and now wins. Same shape at `margin-zero/rudkoebing`
(+4,722 s recommended, **+13,424 s** same-rig) and `margin-zero/troense`
(+294 s recommended, **+11,602 s** same-rig).

### Recommended-rig flips — 10

`margin-extreme`: drejoe (genoa→fock, decided→tie), faldsled (genoa→fock),
soeby (fock→genoa, tie→decided), **svendborg (genoa→fock, decided→decided)**.
`margin-zero`: aeroeskoebing (genoa→fock, tie→tie), rudkoebing (genoa→fock,
tie→decided), troense (genoa→fock, decided→decided).
`relaxation-dense`: aeroeskoebing (genoa→fock, tie→decided), drejoe
(fock→genoa, tie→tie), **svendborg (fock→genoa, decided→decided)**.

Four of the ten cross a `tie` boundary, where the flip is a 60 s tie-band
artifact rather than a meaningful preference change (`RIG_TIE_BAND_MS`).

### Direct comparison with the spike's R = 2400 m figures

| route | spike @ 2400 m | this build @ 1852 m | verdict |
|---|---|---|---|
| Svendborg | +6,527 s (+108.8 min), fock→genoa flip | **+13,702 s (+228.4 min)**, fock→genoa flip (`relaxation-dense`) | **~2.1× WORSE**; the flip reproduces in the same direction |
| Svendborg | +1,360 s | +8,895 s (`margin-zero`) | worse |
| Rudkøbing | +1,691 s | **+13,282 s** (`margin-extreme`) | worse |
| Rudkøbing | +1,297 s | +4,594 s (`relaxation-dense`) | worse |
| Troense | +1,567 s | +690 s (`margin-extreme`); **−2,329 s** (`relaxation-dense`) | better, and improves outright on one arm |

The spike's arm for each figure is not recorded, so these are matched by route
only — every arm in which each route moved is listed rather than one picked.

### The plain statement

**The spike's headline ETA objection REPRODUCES at the shipped radius, and on
Svendborg it is roughly twice as large as the 2400 m figure that motivated the
objection.** A smaller radius forbids more water, so a longer legal route is
the mechanism, not a surprise — but the magnitude was not known before this
run, and "R = 1852 clears both cliff figures" says nothing about ETA cost.

What that cost buys is §7's invariant: BASE routed 41 of 157 ok plans through
sub-gate water, the farthest cell measured at 18.86 nm from any waypoint by the
2026-08-11 scan and 18.89 nm by the 2026-08-13 re-scan (§7, "Two scans, one
row" — the plan counts agree, the per-cell detail of one row does not); HEAD
routes none. The +228 min Svendborg route is the legal one — it carries zero
out-of-disc sub-gate cells, like every other HEAD plan.

**NOT established, and it is the obvious next question:** whether a +228 min
route is one a skipper would accept, or whether they would rather be told the
passage is unreachable at 3.0 m. That is a product judgement this document
cannot make, and it is the strongest argument for graft 4 (#516) — a user who
can see "2.4 m minimum, 0.2 nm of it" can decide for themselves. No such
disclosure ships in this PR.
