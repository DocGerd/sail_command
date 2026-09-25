# #1496: frontier-cap headroom for fock, relaxation tiers and the #1136 salvage pass

**Verdict: no truncation anywhere measured, and the #1136 salvage pass is
UNREACHABLE on every real-mask input probed here.** Fock tier-1 peaks stay
well under the cap on the `light-motorless` aperture (max 27,426 of a 95,333
cap, 3.5x headroom). Relaxation (#53 tier 3) fires on exactly one of the four
`light-motorless`-failing harbours this spike could reach; the other three
never call `solve()` at all — they are mask-disconnected even after
relaxation, at `planRoute.ts`'s cheap pre-search check. #1136's salvage pass 2
never fired on any input tried: every probed route either routes at tier 1
alone or never reaches a solve() call.

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
- **Case A (fock tier-1)**: `light-motorless` aperture — Flensburg (raw,
  unsnapped) -> each of the 40 `harbors.json` snap points, `polarFock`
  performanceFactor 0.9, `comfortDepthM: 5`, `motorEnabled: false`,
  `safetyDepthM: 3`, TWS 3 from 0 degrees, 48 h horizon — the SAME
  construction `lm_div3.jsonl`'s genoa rows use, confirmed by a twin check
  (below). Bare `solve()`, not `planRoute()`.
- **Case B/C (relaxation tiers, #1136 salvage)**: production
  `planRouteWithRecord()`, `defaultBoatSnapshot()` (performanceFactor 0.9,
  matching case A), `DEFAULT_SETTINGS` with `safetyDepthM: 3,
  motorEnabled: false` (comfort margin 2.0 -> `comfortDepthM` 5, matching
  case A), `sailIds: ['genoa', 'fock']`, TWS 3 from 0 degrees, 48 h horizon.
  Two populations: the four `light-motorless` harbours reading `no-route` in
  `lm_div3.jsonl` at divisor 3 with the LARGEST peaks there (maasholm, dyvig,
  kappeln, marstal — see that file for the genoa figures), and #1136's own
  pinned pass-2-admitting Bagenkop inputs (TWS 2.0/2.4/2.8,
  `realmask.repro.motorOffSalvage.test.ts`'s `planRoute pass 2` describe
  block).
- **Positive control**: `solve()` with an artificial `maxFrontier: 50`
  override on Flensburg -> dyvig, TWS 3.5 — result `no-route`, peak 50,
  truncatedRings 616. Confirms the `=== cap` truncation proxy fires when
  truncation genuinely occurs; every "0 truncated" reading below is
  therefore a real zero, not an untested predicate.
- **Twin check**: genoa -> aeroeskoebing under case A's exact construction
  reproduces `lm_div3.jsonl`'s ring count exactly (171 of 171) with a close
  peak (5,188 here vs. 5,319 recorded there, 97.5%) — close enough to treat
  case A's fock rows as the direct twin of that file's genoa rows on the
  same aperture; the ~2.5% peak gap is unexplained and immaterial to every
  headroom conclusion below (both readings sit far under the cap).

## Results

### Case A: fock tier-1 headroom, `light-motorless` aperture (40 harbours)

Peak frontier size, cap 95,333, ALL 40 rows `truncatedRings: 0`.

| harbour | status | peak | rings |
|---|---|---|---|
| aaroesund | ok | 27,426 | 208 |
| maasholm | no-route | 22,198 | 435 |
| middelfart | ok | 22,167 | 292 |
| fredericia | ok | 21,378 | 280 |
| augustenborg | no-route | 16,825 | 373 |
| nyborg | ok | 15,186 | 289 |

Highest peak over all 40: aaroesund, 27,426 -- 3.5x headroom under the cap.
Seven `no-route`: arnis, augustenborg, dyvig, graasten, kappeln, maasholm,
marstal. Six of those seven match `lm_div3.jsonl`'s genoa `no-route` set
exactly (arnis, dyvig, graasten, kappeln, maasholm, marstal); augustenborg is
fock-only at this aperture -- one rig-specific dropout this spike did not
attribute further.

### Case B: relaxation tiers (#53 tier 3/4), four `light-motorless`-failing harbours

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
solves run. This is a genuine correction to `lm_div3.jsonl`'s classification
of these three as `horizon-exceeded`: that classification is a `solve()`-level
artefact (the bare search runs many rings before giving up on the horizon);
production's `connectedAt()` short-circuit classifies the SAME inputs
`mask-blocked` before any solve, and never reaches tier 3 or 4. Only marstal
reaches tier 3, both rigs, peaks well under the cap (3.7% and 5.6% of it),
zero truncation.

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

At the shipped divisor, every real-mask input this spike or
`motorOffSalvage.test.ts` records either routes without needing salvage or
never reaches a solve() call for salvage to run inside. Salvage headroom is
therefore UNMEASURABLE here, not merely small: the pass does not execute.

## Scope

- One motor-off aperture (`light-motorless`'s fidelity: pf 0.9, comfort 5,
  TWS 3 from 0 degrees, 48 h horizon) and one route family (Flensburg-origin).
  Production's real horizon is `FORECAST_DAYS = 6` (144 h), not this
  aperture's 48 h -- borrowed from `lm_div3.jsonl` to stay comparable to it.
- Case B/C's four-harbour population is the `light-motorless`-failing set at
  the SHIPPED divisor, not an exhaustive search for a pass-2-firing or
  tier-3-firing input; a different route/TWS/boat could behave differently.
- No case here truncates, so this spike cannot bound headroom AT truncation --
  only confirm none of the probed inputs come close (worst case: 3.5x margin,
  case A).

## Recommendation

No cap change owed. Every measured case (fock tier-1 across 40 harbours,
tier-3 relaxation on marstal) shows real headroom (>=3.5x under the cap);
#1136's salvage pass is unreachable on every real-mask input tried, so it
contributes zero truncation risk by never running. If a future change makes
relaxation or salvage fire on more real inputs, re-measure THOSE inputs
specifically -- this spike's four-harbour population will not represent them.

## Considered and rejected

- **Re-running genoa tier-1 at the `light-motorless` aperture.** Already
  recorded in `lm_div3.jsonl`; the twin check above licenses reading case A's
  fock rows as its direct counterpart instead of duplicating the run.
- **Treating `lm_div3.jsonl`'s `horizon-exceeded` cause on maasholm/dyvig/
  kappeln as production's classification.** Refuted directly: production's
  `connectedAt()` pre-check classifies the same three `mask-blocked` before
  any solve, per case B above.

## Open questions

1. Why is augustenborg fock-only `no-route` at this aperture (genoa routes,
   fock does not)? Not attributed here.
2. Is there ANY real-mask input where #1136's salvage pass still fires at the
   shipped divisor? None was found among the inputs this spike or
   `motorOffSalvage.test.ts` covers; not proven absent in general.
