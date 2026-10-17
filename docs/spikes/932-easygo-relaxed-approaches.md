# #932: EASY GO!'s relaxed approaches to Faldsled and Rudkøbing, measured

## Recommendation

#932's three questions are answered for the six measured plans. The locality
property is not guaranteed by the router: a seventh plan breaks it with a
corner clip outside both discs (§1). The fix is tracked in #1705.

The issue's premise, that Marstal is the only harbour whose approach relaxes,
no longer holds. At EASY GO!'s default gate (3.5 m), Faldsled and Rudkøbing
reach open water only through #53/#452 relaxation, as `pipeline/verify_mask.py`'s
`EXPECTED_UNREACHABLE_BY_BOAT` records. On six EASY GO! plans to and from those
two harbours, the three properties the issue asks about all hold:

1. No sub-gate water beyond the relaxed harbour's `APPROACH_RADIUS_M` disc:
   0.000 nm on all 12 rig results (§1).
2. Every plan relaxed and carries a `shallow` block, and `RouteSummary` mounts
   the shallow banner (§2).
3. `isSevere` fires on every plan. At EASY GO!'s default gate this follows
   from the search range, so the run confirms the wiring rather than the
   predicate (§3).

Five (boat, harbour) pairs relax over `harbors.json` × `BOATS` (§4). This doc
does not re-derive the issue's 27-of-528 harbour-pair figure.

## Method

- **Tree.** `develop` at `2244872`. Inputs by sha256 prefix: `mask.bin`
  `967b99c32a9e`, `mask.meta.json` `9a32ce93cdc7`, `harbors.json`
  `0827d398d719` (46 harbours), EASY GO! polars genoa `33b5e281a5a9` / fock
  `21d58c175eab`.
- **Probe.** A temporary vitest file under `app/src/routing/`, built on
  `app/src/test/realmaskFixtures.ts` (real mask, real polars) and run with
  `npm --prefix app run test -- <file>`. It was deleted before commit and is
  not in the repo.
- **Plans.** `planRouteWithRecord`, boat `salona-44-easy-go` (draft 2.59 m),
  `DEFAULT_SETTINGS` with `safetyDepthM = defaultSafetyDepthM(boat)` = 3.5 m
  (floor `relaxationFloorM` = 2.6 m), uniform 12 kn / 270° wind at the
  fixtures' `T0`, both rigs. Routes: Faaborg ↔ Faldsled and Svendborg ↔
  Rudkøbing at `depthComfortMarginM` 2.0, plus both outbound routes at margin
  0. On the Marstal passage, margin 0 was the only setting where the #452
  locality check had teeth (`realmask.repro.issue20.marstalMargin0.test.ts`'s
  header).
- **Exposure instruments.** All use the shipped `lib/shallowExposure.ts` walk:
  - total sub-gate exposure: `shallowExposureNm(legs, mask, 3.5)`;
  - exposure beyond a disc: the same call on a mask facade whose
    `depthInfoM` reports deep for every cell centre within 1852 m of the anchor
    (`haversineNm`, the test `shallowConfinedWithinM` applies). Only
    `depthInfoM` is wrapped; the walk is the shipped one;
  - field variant: the facade instead hides cells where `gateAtCell` of the
    plan's own relaxed gate is below 3.5 m;
  - farthest sub-gate cell: the smallest radius, bisected to 1 m, at which
    `shallowConfinedWithinM(legs, mask, 3.5, [anchor], [0], r)` holds.
- **Banner.** The real `RouteSummary`, rendered in jsdom (`I18nProvider`, en)
  with a `Plan` built from each result. The probe reads `.shallow-warning` and
  `.shallow-warning--severe`.

## 1. Sub-gate water stays inside the relaxed harbour's disc

Anchor: the relaxed harbour's snapped point. Disc gates are listed in waypoint
order (origin, destination), from the plan's own `ApproachGate`. Figures are
genoa / fock.

| Plan | Margin | Disc gates (m) | Total sub-gate (nm) | Beyond relaxed disc (nm) | Farthest sub-gate cell (m) |
|---|---|---|---|---|---|
| Faaborg → Faldsled | 2.0 | 3.4, 3.1 | 0.369 / 0.406 | 0.000 / 0.000 | 1530 / 1529 |
| Faaborg → Faldsled | 0 | 3.4, 3.1 | 0.549 / 0.498 | 0.000 / 0.000 | 1579 / 1638 |
| Faldsled → Faaborg | 2.0 | 3.1, 3.4 | 0.286 / 0.296 | 0.000 / 0.000 | 1529 / 1529 |
| Svendborg → Rudkøbing | 2.0 | 3.4, 3.4 | 0.027 / 0.004 | 0.000 / 0.000 | 278 / 232 |
| Svendborg → Rudkøbing | 0 | 3.4, 3.4 | 0.006 / 0.001 | 0.000 / 0.000 | 232 / 232 |
| Rudkøbing → Svendborg | 2.0 | 3.4, 3.4 | 0.031 / 0.031 | 0.000 / 0.000 | 278 / 278 |

- Field variant: 0.000 nm outside the relaxed gate field on all 12 rig rows.
  This variant has no control of its own; the controls below apply to the
  haversine facade.
- The unrelaxed waypoint's disc (Faaborg or Svendborg) still carries 3.4 m,
  because phase 2 of `findRelaxedGate` ascends only to one decimetre below the
  requested gate. Its use is total minus beyond-that-disc, which is 0.000 nm on
  all 12 rows, so no route used that licence.
- The closest margin is the 1638 m Faldsled row, 214 m inside the 1852 m disc.

Controls, all 12 rig rows:

- licence: total exposure > 0, so the zeros measure confined water rather than
  no water;
- radius 0: beyond-disc exposure equals the total, and `shallowConfinedWithinM`
  at r = 0 reads `false`, so the instrument can fail;
- wrong anchor: anchored on the unrelaxed waypoint, confinement reads `false`,
  with the farthest cell 8548–8707 m (Faaborg side) or 13 707 m (Svendborg
  side) away. The anchors are not interchangeable.

The 3-decimal nm columns cannot detect a corner clip; the farthest-cell column
is the one that discriminates. On the six plans above, every farthest cell is
under 1852 m.

### Counterexample: Faldsled → Faaborg at margin 0

This plan was found in PR #1704's review and reproduced with this doc's
instruments.

- It relaxes like the others: a single tier-3 `ApproachGate`, discs 3.1 / 3.4.
- The fock leg at index 3 is a 1.354 nm motor leg that fails
  `segmentNavigable` against that gate. It clips cell (1992, 988), charted
  3.4 m with `gateAtCell` 3.5 m. The cell lies 2671 m from Faldsled and
  8828 m from Faaborg, outside both discs.
- The leg's exposure beyond the disc is 1.2e-5 nm, which reads 0.000 in the
  table's format. The farthest cell is 2671 m, and `shallowConfinedWithinM` at
  1852 m reads `false`.
- The leg is flagged `shallow` (min 3.4 m) on a relaxed plan, under a 2.59 m
  draft. That is not a grounding hazard, but the locality guarantee does not
  hold.
- The genoa result has no leg that fails the gate.
- The review traced the leg to `backtrack`'s collinear merge (`isochrone.ts`,
  `prev.end = end`). Nothing checks the merged chord against the gate. Tracked
  in #1705.

## 2. The disclosure stack mounts

- Relaxed: on all six EASY GO! plans `record.tiers` holds a single tier-3
  entry with an `ApproachGate` and a non-null `usedDepthM`, and that tier
  supplied the route. Tiers 1–2 never solve, because `planRoute`'s #53 fast path
  classifies a pair that is disconnected at the requested gate before solving.
- `shallow` present: `{requested 3.5, used 3.1, minGate 3.1}` for Faldsled and
  `{3.5, 3.4, 3.4}` for Rudkøbing, with 1–4 flagged legs per rig.
- Banner: `RouteSummary` renders `.shallow-warning` on all six.
- Controls: EASY GO! Faaborg → Lyø (an `ok` harbour), and the Salona 45 (gate
  3.0 m) on Faaborg → Faldsled and Svendborg → Rudkøbing. All three plans route
  at tier 1 with a uniform gate, carry no `shallow` key, show zero sub-gate
  exposure, and render no banner. The banner therefore comes from EASY GO!'s
  gate, not from the route.

## 3. `isSevere` fires

- Predicate, `ShallowWarning.tsx`: `shallow.usedDepthM - MASK_TOLERANCE_M <
  plan.request.boat.draftM`. Faldsled gives 3.1 − 0.9 = 2.2 < 2.59 and
  Rudkøbing 3.4 − 0.9 = 2.5 < 2.59.
- Rendered: `.shallow-warning--severe` on all six. The lead reads "could run as
  low as 2.2 m" (Faldsled) or "2.5 m" (Rudkøbing), "below this boat's 2.59 m
  draft".
- Structural: for EASY GO! at 3.5 m, `findRelaxedGate` searches [2.6, 3.4], so
  every relaxed plan has `usedDepthM − 0.9 ≤ 2.5 < 2.59`. For this boat the
  predicate can only be false at a requested gate of 3.6 m or more.
- Controls: the same plans re-rendered with `request.boat` set to the Elan
  (1.9 m) or the Salona 45 (2.1 m), or with `usedDepthM` forced to 3.5, show the
  banner without the severe class. The check can read `false`, and it follows
  the plan's own boat snapshot.

## 4. Relaxing (boat, harbour) pairs

A pair relaxes when the harbour's snapped cell does not 4-connect to the
open-water seed at the boat's default gate, but does connect once the
harbour's approach disc may relax down to `relaxationFloorM`.

Two methods, each over `harbors.json` (46) × `BOATS` (4) = 184 rows:

- (a) the shipped `computeHarborAccess` at `defaultSafetyDepthM`, counting
  `shallow-approach`;
- (b) an oracle: `NavMask.cellsConnected(seed, harbour, uniformGate(G))`;
  where that fails, `findRelaxedGate([seed, harbour], G, APPROACH_RADIUS_M,
  floor)`, and the same call with radius `Infinity` (the global search).

(a) and (b) disagree on 0 of 184 rows. 21 of those rows agree by
construction: 20 are known-disconnected, a flag both sides read from
`harbors.json`, and 1 is snap-failed (augustenborg), which maps to picker
`unreachable`. The independent check therefore covers 163 rows. Five pairs
relax:

| Boat | Draft | Gate / floor | ok | Relaxing (P3 / global gate) | Unreachable | Known-disconnected |
|---|---|---|---|---|---|---|
| Salona 45 | 2.1 | 3.0 / 2.1 | 40 | marstal (2.3 / 2.3) | — | 5 |
| Salona 44 SPEEDY GO! | 2.1 | 3.0 / 2.1 | 40 | marstal (2.3 / 2.3) | — | 5 |
| Elan 444 PIRANJA | 1.9 | 2.8 / 1.9 | 40 | marstal (2.3 / 2.3) | — | 5 |
| Salona 44 EASY GO! | 2.59 | 3.5 / 2.6 | 37 | faldsled (3.1 / 3.1), rudkoebing (3.4 / 3.4) | augustenborg (no navigable snap within 300 m), marstal | 5 |

- Positive control: Marstal's 2.3 m matches the reconnection threshold that
  `realmask.repro.issue20.marstalDefault.test.ts` pins independently
  (Flensburg/Marstal connected at 2.3 m, not at 2.4 m).
- Twin: `app/src/test/harborReachability.test.ts`, which pins the same
  per-state counts, ran green on this tree (33/33).
- The issue's 27-of-528 figure counted origin–destination harbour pairs at a
  33-harbour catalogue. That is a different quantity and is not re-derived
  here.

### #452 spike §6 item 5

Item 5 asks for "evidence that P3's per-disc gate can genuinely come out lower
than the global search's answer on some real harbour — not just Marstal". No
such harbour was found. P3 equals global for Faldsled (3.1 m)
and Rudkøbing (3.4 m), both from the seed (table above) and from Flensburg:
`realmask.repro.relaxationTrade.originFlensburg.test.ts` (#930) ran green on
this tree, and its EASY GO! rows read 3.1 / 3.1 and 3.4 / 3.4. The item stays
open, but it now has non-Marstal subjects.

## What this does not establish

- Other routes. Measured: one wind field, one departure, the four routes
  above, no via points.
- Margin 0 on Rudkøbing → Svendborg. That plan was run only in the review,
  where no leg failed the gate.
- Uniform-gate plans. Whether a plan that did not relax can emit a chord that
  fails its own gate was not measured.
- Robustness to a mask rebuild. The 214 m margin on the farthest Faldsled cell
  was measured on this mask only.

## Considered and rejected

- **A committed real-mask regression row** for these plans: not added, because
  this PR is docs-only (#932 re-scoped). A maintainer may still file it;
  Svendborg → Rudkøbing is the cheaper fixture.
- **A new `app/sweep/` arm:** a sweep compares plan bytes, which says nothing
  about disc confinement.
- **A hand-written exposure walk:** rejected under CLAUDE.md's
  duplicated-traversal rule. The facade reuses the shipped walk.
- **Severity from the formula alone:** rejected as the only evidence. The real
  component was rendered, with controls.

## Stale records found

- The issue's "33-harbour catalogue" and its triage comment's 40 are both
  stale. `harbors.json` has 46 entries.
