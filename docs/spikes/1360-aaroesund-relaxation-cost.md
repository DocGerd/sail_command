# #1360: `salona44-relaxation/aaroesund` +16.5 min after #1322 — frontier truncation, measured

**Verdict: CONFIRMED — `MAX_FRONTIER` truncation, resolved at `a4c0ad3` by
#1257.** At #1322's head the fixed 30 000 cap truncates 22 rings of each
tier-3 solve. The same tree uncapped returns genoa to 344.52 min, 0.21 min
faster than BASE. At `a4c0ad3` (develop at this spike's base) the derived
cap (95 333) does not bind, and the default-cap result equals the uncapped
one. `16c7c6b`'s uncapped peaks (64 141 / 64 229) are also below 95 333, so
that cap would not slice there either. No follow-up.

## Method

Follows `1330-fehmarn-frontier-truncation.md`'s method. The main difference:
this row comes from #53 relaxation, so the probe runs the whole ladder through
`planRouteWithRecord()` rather than a solo `solve()`.

- **Inputs.** The `salona44-relaxation` arm (`app/sweep/sweepArms.ts`):
  Salona 44 polars, `DEFAULT_SETTINGS`, uniform 12 kn / 225°, the sweep's
  `T0`, Marstal → Aarøsund, under the sweep's jsdom + `setup.ts` config.
- **Trees.** `git archive` extracts of `36d86a7` (the #1322 sweep's BASE, its
  merge-base), `16c7c6b` (the #1322 sweep's HEAD, wave 1; pre-#1257) and
  `a4c0ad3` (`develop`). `mask.bin`, `mask.meta.json`, `harbors.json` and all
  polars are byte-identical across the three (sha256).
- **Counter.** The counter needs no solver edit: `vi.mock` wraps `solve()`
  to override `maxFrontier` and to count rings whose post-cap `frontierSize`
  (reported by `onProgress`) equals the cap in force — 1330's counter.
- **Evidence type.** Deterministic only: ring counts, peaks, ETA, cost, legs,
  distance. No wall-clock figures.
- **Artifacts.** `1360-aaroesund-relaxation-cost/`: the probe, its config and
  `results.json` (every run, per solve).

## Results

Minutes after departure. "Tier" is the ladder tier the reported route came
from; peak and trunc are that tier's solve. Legs, nm and motor legs are the
merged plan's.

| Rig | Tree | Cap | Tier | Peak | Trunc | ETA | Cost | Legs | nm | Motor legs |
|---|---|---|---|---|---|---|---|---|---|---|
| genoa | `36d86a7` | 30 000 | 4 | 30 000 | 7 | 344.73 | = ETA | 16 | 43.15 | 3 |
| fock | `36d86a7` | 30 000 | 4 | 30 000 | 6 | 344.75 | = ETA | 14 | 42.93 | 3 |
| genoa | `36d86a7` | ∞ | 4 | 36 033 | 0 | 344.73 | = ETA | 16 | 43.15 | 3 |
| fock | `36d86a7` | ∞ | 4 | 35 012 | 0 | 344.75 | = ETA | 14 | 42.93 | 3 |
| genoa | `16c7c6b` | 30 000 | 3 | 30 000 | 22 | 361.27 | 367.6 | 22 | 44.40 | 2 |
| fock | `16c7c6b` | 30 000 | 3 | 30 000 | 22 | 351.60 | 358.9 | 22 | 43.47 | 2 |
| genoa | `16c7c6b` | ∞ | 3 | 64 141 | 0 | 344.52 | 350.5 | 11 | 43.00 | 2 |
| fock | `16c7c6b` | ∞ | 3 | 64 229 | 0 | 345.43 | 352.0 | 12 | 42.94 | 2 |
| genoa | `a4c0ad3` | 95 333 | 3 | 64 230 | 0 | 344.39 | 350.9 | 13 | 42.98 | 2 |
| fock | `a4c0ad3` | 95 333 | 3 | 64 078 | 0 | 345.76 | 352.2 | 12 | 42.97 | 2 |

What the table shows:

- **Reproduction.** Genoa BASE → HEAD at default caps is +16.54 min ETA, the
  issue's +16.5. Fock moves +6.85 min.
- **The ladder changed at #1322.** At BASE, tier-3 genoa (comfort 5.0 m) is
  `mask-blocked` after 6 rings with a peak of 7, at either cap, so tier 4
  (comfort off) supplies both routes. At HEAD tier-3 genoa routes and tier 4
  never runs. BASE's tier-3 genoa failure is the same uncapped, so this
  switch comes from #1322's diff, not from the cap.
- **Truncation was live at BASE but cost nothing here.** BASE truncates 6-7
  rings on each solve that routes; capped and uncapped give identical
  reported (tier-4) routes.
- **#1322 deepened it.** Uncapped peaks rise from 35 012-36 033 (tier 4) to
  64 141-64 229 (tier 3). Truncated rings rise to 22 per solve, and the capped
  ETA is 16.75 min (genoa) and 6.16 min (fock) worse than the same tree
  uncapped.
- **The cap accounts for the whole genoa delta and 6.16 of fock's 6.85 min.**
  HEAD uncapped vs BASE: genoa −0.21 min, fock +0.68 min — while now carrying
  the comfort preference that BASE's tier-4 route did not.
- **`a4c0ad3` resolves it.** Default cap and uncapped agree in every recorded
  field, with 0 truncated rings. Against BASE: genoa −0.34, fock +1.00 min.
  Peak 64 230 against the 95 333 cap leaves 1.48x headroom.

Cost is not comparable across the ladder change: BASE's routes come from
tier 4, where cost equals ETA, and HEAD's from tier 3, where cost includes the
comfort penalty. Within one tree and tier, cost moves with ETA in every row.

## Controls

- **The counter fires on this route.** On the `develop` tree at
  `maxFrontier: 30 000`: 21 (genoa) and 22 (fock) truncated rings, ETA 350.85
  and 352.01.
- **Negative control.** At `develop`'s default cap there are 0 truncated
  rings, and the result is identical in every recorded field to the uncapped
  run.
- **Not reproduced: `develop` at 30 000 ≠ HEAD's default row** (genoa 350.85
  vs 361.27). Unlike 1330's Fehmarn case, `develop` differs from `16c7c6b` on
  this route by more than the cap value; the other routing changes in
  `16c7c6b..a4c0ad3` are not attributed here. The within-tree comparisons
  above (HEAD capped vs HEAD uncapped) carry the attribution instead.

## Recommendation

Close #1360. The mechanism is the one #1330 confirmed for Fehmarn, and the
shipped cap removes it on this route. This peak (64 230) sits under the
64 402 worst case behind the headroom residual in
`1330-fehmarn-frontier-truncation.md`, which stays as stated there.

## Considered and rejected

- **Solo `solve()` at a fixed gate, as 1330 did.** The row is decided by which
  ladder tier routes, so a single-tier probe would miss the tier-3/tier-4
  switch that changes what the row reports.
- **Adding a truncation counter to `isochrone.ts`.** The post-cap
  `frontierSize` already exposes it, and the edit would owe a #282 sweep.
- **Wall-clock measurement.** Excluded by the 2026-09-18 ruling; it cannot
  name a mechanism.
- **Treating the ladder change as the cause.** HEAD uncapped reports the
  tier-3 route and matches BASE within a minute; only the cap moves it.
- **Attributing `develop`'s 30 000-cap difference to a specific commit.** Not
  needed for the verdict, and would take a bisect over non-cap changes.
