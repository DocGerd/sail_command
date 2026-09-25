# #1496: frontier-cap headroom for fock, relaxation tiers and the #1136 salvage pass

**Verdict: no truncation anywhere measured, and the #1136 salvage pass was
not admitted on any real-mask input probed here.** Fock tier-1 peaks stay
well under the cap on the `light-motorless` aperture (max 20,554 of a 95,333
cap, 4.64x headroom). Relaxation (#53 tier 3) fires on exactly one of the four
`light-motorless`-failing harbours this spike could reach; the other three
never call `solve()` at all — they are mask-disconnected even after
relaxation, at `planRoute.ts`'s cheap pre-search check. #1136's salvage pass 2
was never admitted on any input tried: every probed route either routed at
tier 1/3 alone or never reached a `solve()` call at all.

Split from #1490 (agent-doable part); #1490 keeps the real-tablet measurement.
This spike does NOT re-run genoa tier-1 at the `light-motorless` aperture —
that is already recorded per-harbour in
[`1168-motor-off-prune-instability/results/lm_div3.jsonl`](1168-motor-off-prune-instability/results/lm_div3.jsonl)
(the shipped `MOTOR_OFF_CONFINED_PRUNE_DIV = 3`).

## Method

- **Evidence type**: deterministic only — peak frontier size per ring
  (`onProgress`'s `frontierSize`, read AFTER the cap slice in
  `isochrone.ts`, so peak <= cap by construction) vs. `defaultMaxFrontier(mask.meta)`
  (95,333 for this mask), and a truncation flag (`frontierSize === cap`,
  which can only ever read yes/no, never a negative headroom magnitude). No
  wall-clock timings (maintainer ruling, 2026-09-18).
- **Harness**: an uncommitted vitest file under `app/src/routing/`, run
  locally with `node_modules/.bin/vitest run <file>` and deleted before this
  commit; not part of the diff. It imported `solve`, `defaultMaxFrontier`,
  `planRouteWithRecord` and spied on the real `solve` export (the mechanism
  `app/src/routing/realmask.repro.motorOffSalvage.test.ts` already proves
  reaches `planRoute()`'s internal calls) to record each solve() call's
  params (`salvage`, `comfortDepthM`, `maxFrontier`) and peak frontier
  directly off the call, never inferred from timing.
- **Case A (fock tier-1)**: `light-motorless` aperture — Flensburg and each
  of the 40 `harbors.json` snap points, BOTH through
  `mask.snapToNavigable(…, 3)`, `polarFock` performanceFactor 0.9,
  `comfortDepthM: 5`, `motorEnabled: false`, `safetyDepthM: 3`, TWS 3 from 0
  degrees, 48 h horizon — the SAME construction `probe-cost.test.ts` uses to
  produce `lm_div3.jsonl`'s genoa rows, confirmed exactly by a twin check
  (below). Bare `solve()`, not `planRoute()`.
- **Case B/C (relaxation tiers, #1136 salvage)**: production
  `planRouteWithRecord()`, `defaultBoatSnapshot()` (performanceFactor 0.9,
  matching case A), `DEFAULT_SETTINGS` with `safetyDepthM: 3,
  motorEnabled: false` (comfort margin 2.0 -> `comfortDepthM` 5, matching
  case A), `sailIds: ['genoa', 'fock']`, TWS 3 from 0 degrees, 48 h horizon.
  Two populations: the four `light-motorless` harbours reading `no-route` in
  `lm_div3.jsonl` at divisor 3 with the LARGEST peaks there (maasholm, dyvig,
  kappeln, marstal — see that file for the genoa figures), and the Bagenkop
  inputs #1136 pinned (TWS 2.0/2.4/2.8,
  `realmask.repro.motorOffSalvage.test.ts`'s `planRoute pass 2` describe
  block) — which do not admit pass 2 at the shipped divisor (see Case C).
- **Positive control**: `solve()`, fock, both endpoints through
  `mask.snapToNavigable(…, 3)`, Flensburg -> dyvig, TWS 3.5, an artificial
  `maxFrontier: 50` override — result `no-route`, peak 50, 662 of 671 rings
  truncated. Confirms the `=== cap` truncation proxy fires when truncation
  genuinely occurs; every "0 truncated" reading below is therefore a real
  zero, not an untested predicate.
- **Twin check**: genoa -> aeroeskoebing with BOTH endpoints through
  `mask.snapToNavigable(…, 3)` (matching
  `docs/spikes/1168-motor-off-prune-instability/probe-cost.test.ts`'s
  `SC_LM=1` construction, which produced `lm_div3.jsonl`) reproduces that
  file's row EXACTLY: 171 rings, peak 5,319. Case A below uses this same
  snapped-endpoint construction, so it is the direct twin of `lm_div3.jsonl`'s
  genoa rows on the same aperture.

## Results

### Case A: fock tier-1 headroom, `light-motorless` aperture (40 harbours)

Both endpoints snapped via `mask.snapToNavigable(…, 3)` (see Method). Peak
frontier size, cap 95,333, ALL 40 rows `truncatedRings: 0`.

| harbour | status | peak | rings |
|---|---|---|---|
| maasholm | no-route | 20,554 | 398 |
| aaroesund | ok | 16,881 | 207 |
| svendborg | ok | 16,673 | 391 |
| dyvig | no-route | 14,877 | 393 |
| faldsled | ok | 13,982 | 186 |
| arnis | no-route | 13,508 | 336 |

Highest peak over all 40: maasholm, 20,554 -- 4.64x headroom under the cap.
Six `no-route`: arnis, dyvig, graasten, kappeln, maasholm, marstal --
IDENTICAL to `lm_div3.jsonl`'s genoa `no-route` set. The prior raw-endpoint
run's seventh dropout (augustenborg, fock-only) does not reproduce under the
snapped construction: augustenborg routes `ok` here, matching genoa.

### Case B: #53 relaxation, tier 3 headroom (one harbour) — tier 2 and tier 4 not reached

Only tier 3 was measured, on one harbour (marstal). Tier 1 did not run for
any of the four harbours below — `connectedAt(requestedGate)` is false for
all four, so the ladder skips straight past tier 1/2 to relaxation. Tier 4
(the preference-off retry at the relaxed gate) never opens on marstal because
its tier 3 routes both sails, so `needsUnpreferencedRetry` stays false.
**Tier 2 and tier 4 headroom: not measured; no input in this spike reached
them.**

| harbour | `record.tiers` | solve() calls | genoa peak | fock peak |
|---|---|---|---|---|
| maasholm | `[]` | 0 | -- | -- |
| dyvig | `[]` | 0 | -- | -- |
| kappeln | `[]` | 0 | -- | -- |
| marstal | `[{tier:3, usedDepthM:2.3}]` | 2 | 5,429 | 3,593 |

Three of four never call `solve()` at all: `planRoute.ts`'s `connectedAt()`
(a cheap `mask.cellsConnected` BFS, `:769-774`) returns false at the
requested 3.0 m gate, and after relaxation's own BFS probe (`findRelaxedGate`)
ALSO returns null, the ladder falls straight to the `record.cause =
'mask-blocked'` return (`:1032`) with `record.tiers` still empty and zero
solves run. `lm_div3.jsonl`'s `horizon-exceeded` classification of these
same three is not wrong — it is the correct `solve()`-level cause for a bare,
disconnected search that runs to the horizon before giving up. What this
answers is #1168's own Open question 3 ("[i]s the `maasholm` cause movement
… benign? … Only a `planRoute`-level sweep row shows the effect" —
`docs/spikes/1168-motor-off-prune-instability.md`, Open questions §3): in
`planRoute()`, `connectedAt()` and `findRelaxedGate` both fail before any
`solve()` call, so #1168 §6's cause-movement/pass-2-admission concern does
not apply to these three inputs in production — no label change, no pass 2.
Only marstal reaches tier 3, both rigs, peaks well under the cap (3.7% and
5.6% of it), zero truncation.

### Case C: #1136 salvage pass 2

Zero `salvage: true` solve() calls observed on ANY input tried, for two
distinct reasons:

- maasholm/dyvig/kappeln: `record.tiers.length === 0`, so
  `salvagePassAdmitted`'s `record.tiers.length > 0` precondition
  (`planRoute.ts:363`) fails -- pass 2 cannot be admitted when no tier ever ran.
- marstal and all three #1136-pinned Bagenkop inputs (TWS 2.0/2.4/2.8):
  `pass1.status === 'ok'`, so `salvagePassAdmitted`'s `pass1.status ===
  'error'` precondition (`:361`) fails -- the plan already routed at tier 1
  (Bagenkop) or tier 3 (marstal), so salvage is correctly never tried.

What was shown is narrower than "salvage cannot widen the frontier": pass 2
of `planRoute()` (`salvagePassAdmitted`) was never admitted on any input
tried. The salvage trigger INSIDE `solve()` itself (`solve({salvage:
true})`'s re-expansion ring, which skips dominance and is the ring most
likely to widen the frontier) was not probed at the shipped divisor — #1168
ran that shape at divisor 2 (`results/lm_salv.jsonl`, `fine_salv_*.jsonl`),
not divisor 3. So: pass 2 is not admitted on any input tried here, and this
spike measures no salvage headroom. Its truncation risk is unmeasured, not
zero. The reachability gap itself is tracked in #1502 (the
`motorOffSalvage.test.ts` real-mask pass-2 rows no longer reach pass 2 at
the shipped divisor), #1334 (no sweep arm combines motor-off with a short
horizon, so salvage widening is untestable there) and #1456 (the sweep
cannot show whether pass 2 ran).

## Scope

- One motor-off aperture (`light-motorless`'s fidelity: pf 0.9, comfort 5,
  TWS 3 from 0 degrees, 48 h horizon) and one route family (Flensburg-origin).
  Production's real horizon is `FORECAST_DAYS = 6` (144 h), not this
  aperture's 48 h -- borrowed from `lm_div3.jsonl` to stay comparable to it.
- Case B/C's four-harbour population is the `light-motorless`-failing set at
  the SHIPPED divisor, not an exhaustive search for a pass-2-firing or
  tier-3-firing input; a different route/TWS/boat could behave differently.
- No case here truncates, so this spike cannot bound headroom AT truncation --
  only confirm none of the probed inputs come close (worst case: 4.64x margin,
  case A).

## Recommendation

No cap change owed. Every measured case (fock tier-1 across 40 harbours,
tier-3 relaxation on marstal) shows real headroom (>=4.64x under the cap).
#1136's salvage pass is not admitted on any input tried here, so this spike
measures no salvage headroom; its truncation risk is unmeasured, not zero
(#1334, #1456). If a future change makes relaxation or salvage fire on more
real inputs, re-measure THOSE inputs specifically -- this spike's
four-harbour population will not represent them.

## Considered and rejected

- **Re-running genoa tier-1 at the `light-motorless` aperture.** Already
  recorded in `lm_div3.jsonl`; the twin check above licenses reading case A's
  fock rows as its direct counterpart instead of duplicating the run.
- **Calling `lm_div3.jsonl`'s `horizon-exceeded` cause on maasholm/dyvig/
  kappeln a misclassification.** It is not — it is the correct `solve()`-level
  cause for a bare, disconnected search. `planRoute()` never reaches `solve()`
  for these three (`connectedAt()` and `findRelaxedGate` both fail first), so
  the cause never surfaces there either; see case B above and #1168's Open
  question 3.

## Open questions

1. Is there ANY real-mask input where #1136's salvage pass still fires at the
   shipped divisor? None was found among the inputs this spike or
   `motorOffSalvage.test.ts` covers; not proven absent in general.
