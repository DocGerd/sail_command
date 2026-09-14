# #930 (R3): P3's disc-vs-global relaxation trade, measured against the shipped mechanism

## Recommendation

Keep `APPROACH_RADIUS_M = 1852`. On every Marstal- and Flensburg-origin
harbour pair, at each catalogue boat's default gate and floor, the shipped
per-disc search returned the same `usedDepthM` as the global search: no deeper
relaxation, no lost route. Keep the per-pair equality assertion as the tripwire
for a mask, harbour or boat change that makes the trade bite on that population.

Harness: `app/src/routing/relaxationTrade.differential.test.ts`. It calls the
SHIPPED `findRelaxedGate` twice per pair on the real `mask.bin`, changing only
`approachRadiusM`: `APPROACH_RADIUS_M` vs `Infinity` (`depthGate.ts`'s kill
switch, pinned by `relaxedDepth.test.ts` as the pre-#452 global search).

## What is structural and what is empirical

**Structural (follows from the code):** local `usedDepthM <= global`, and
"local relaxes => global relaxes". Local's navigable set is a subset of
global's at every probe (out-of-disc cells stay at `requestedDepthM`), and
phase 2 only raises disc gates. The harness keeps these checks, labelled as
unable to fail.

**Not structural: equality does not follow from the code.** Both positive
controls below break it (a synthetic mask; the real mask at a non-shipped
radius), so "no regression" is at most an empirical property of the committed
data. Neither control is a reachable input; a data-level argument over every
reachable input (#930's route (b)) was not attempted.

## Results (HEAD, this branch)

Population: origins Marstal and Flensburg x the other 32 harbours, plus the
mirror `[X, Marstal]`, x one depth case per distinct (default gate, relaxation
floor) derived from `BOATS` — Salona 45 + Salona 44 share 3.0 m / 2.1 m, Elan
444 has 2.8 m / 1.9 m.
Waypoints are snapped at the requested gate first, as `planRoute` does (no
snap failed). "Relevant" = the snapped pair is not connected at the requested
gate (BFS). On every other pair both radii return the highest candidate gate
by construction, so only "relevant + relaxed" is empirical evidence.

| case | population | pairs equal | relevant | relevant + relaxed |
|---|---|---|---|---|
| 3.0 / 2.1 | Marstal origin | 32/32 | 32 | 27 (all 2.3 m) |
| 3.0 / 2.1 | Flensburg origin | 32/32 | 6 | 1 (Marstal 2.3 m) |
| 3.0 / 2.1 | `[X, Marstal]` | 32/32 | 32 | 27 (all 2.3 m) |
| 2.8 / 1.9 | Marstal origin | 32/32 | 32 | 27 (all 2.3 m) |
| 2.8 / 1.9 | Flensburg origin | 32/32 | 6 | 1 (Marstal 2.3 m) |
| 2.8 / 1.9 | `[X, Marstal]` | 32/32 | 32 | 27 (all 2.3 m) |

Origin populations: 56 discriminating of 128 pair-runs (72 equal by
construction). Mirror: 54 discriminating of 64.

Asserted: the "pairs equal" column and at least one relevant pair relaxing;
the other cells, "no snap failed" and the next line are `--reporter=verbose` output.
The 5 `KNOWN_DISCONNECTED` harbours are null under both radii in every case.
Every relaxing pair in this population involves Marstal. Without the snap,
Flensburg→Augustenborg reads as relaxing at 2.8 m: its raw snap sits at 2.8 m,
below the 3.0 m gate, while the re-snapped pair connects at 3.0 m.

Plan-level (solver) evidence is out of scope here: `planRoute` takes no radius
parameter, and changing that is a production change. The plan-level pre-P3 vs
P3 comparison is the P3 record's §7 sweep
(`docs/spikes/452-p3-implementation-record.md`, recorded at `d73fa0d` before
the boat catalogue, so 2.1 m floor only): 0 `usedDepthM` worse, 0 ok→error.

## Positive controls

- **Real mask, radius 1000 m vs Infinity** (below the 1050→1060 m Marstal
  cliff, `docs/spikes/452-local-depth-relaxation.md` "The `APPROACH_RADIUS_M`
  cliff"; compared against Infinity so it does not move with
  `APPROACH_RADIUS_M`): lost routes (3.0 / 2.1 case) and different-depth
  divergences (2.8 / 1.9 case, local 1.9 m vs global 2.3 m), each asserted
  `> 0`; counts are not printed. The tripwire throws on both sets.
- **Synthetic two-channel mask:** a 2.5 m pinch midway (outside both discs)
  and a 2.3 m detour pinch inside A's disc. Global 2.5 m, local 2.3 m; the
  tripwire throws, and an empty population throws "nothing measured".

## Mutations (BASE `d219adb` = PR #1201's harness, HEAD = this branch)

| mutation | BASE | HEAD |
|---|---|---|
| `APPROACH_RADIUS_M` 1852→1000 (`depthGate.ts`) | differential GREEN; only the old control (`moved + newlyBlocked > 0`) reds | 6 of 6 equality rows RED, incl. `[elan-444-piranja] origin marstal aeroeskoebing: local usedDepthM 1.9 != global 2.3` |
| drop `cos(lat)` from `colRadius` | 3/3 green | 10/10 green: the equality cliff moves from 1060 m (unequal at 1059 m) to 1408 m, still below 1852 m (bisection in the [PR #1222 mechanism review](https://github.com/DocGerd/sail_command/pull/1222#pullrequestreview-5201691781)) |
| tripwire made tautological (`toBe(r.localUsedDepthM)`) | n/a | both controls RED, 8 others green |

The first row's BASE column is the defect this change fixes: the trade biting on every
relaxing pair left the differential assertion green.

## What is NOT established

- A future mask, harbour or boat could create a pinch outside every disc. The
  equality assertion reds if that pinch changes `usedDepthM` on a pair of this
  population; before this change the harness could not (its assertions were
  structural only).
- Other origins, via-point chains, user-lowered or raised gates, and phase-2
  ascent with two simultaneous bottlenecks are outside this population.
- Phase-2 ascent order is measured only on this population: the `[X, Marstal]`
  mirror is asserted equal above; other orders are not.

## Considered and rejected

- **Route (b), a proof from the code:** not available. The code yields only
  local <= global and "local relaxes => global relaxes"; the synthetic
  control is a counterexample to equality.
- **Plan-level differential via `vi.mock` of `depthGate`:** rejected, it
  swaps a module the whole solver imports, and one Flensburg→Marstal plan
  alone measured 77.61 s in Node (P3 record R4), so 128 pair-runs x 2 radii
  cannot run in CI; §7's sweep compared plan level for the 2.1 m floor.
- **Mask-level LAND-forcing simulation** (the pre-P3 R3 numbers): not the
  shipped mechanism, and run at 2400 m, not 1852 m.
- **Hard-coded boat list:** rejected; depth cases derive from `BOATS`, so a
  new boat joins the population automatically.

## Reproduction

```
npm --prefix app run test -- relaxationTrade
```

10 tests, ~160 s locally (largest single test ~34 s, under
`SOLVER_TEST_TIMEOUT_MS`). Per-pair rows print only with `--reporter=verbose`.
