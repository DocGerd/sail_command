# #930 (R3): P3's disc-vs-global relaxation trade, measured against the shipped mechanism

## Recommendation

Keep `APPROACH_RADIUS_M = 1852`. On the committed mask, harbours and boat
catalogue, the shipped per-disc search never needs deeper relaxation than the
global search. Keep the harness's per-pair equality assertion as the tripwire
for a future mask, harbour or boat change that makes the trade bite.

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

**Not structural — route (b) "cannot regress" is unprovable.** Equality does
not follow: both positive controls below construct inputs where local relaxes
deeper than global or loses the route. So "no regression" is an empirical
property of the committed data, never a theorem.

## Results (HEAD, this branch)

Population: origins Marstal and Flensburg x the other 32 harbours, x one depth
case per distinct (default gate, relaxation floor) derived from `BOATS` —
Salona 45 + Salona 44 share 3.0 m / 2.1 m, Elan 444 has 2.8 m / 1.9 m.
"Relevant" = not connected at the requested gate (BFS), i.e. a pair on which
relaxation can fire.

| case | origin | pairs equal | relevant | relevant + relaxed |
|---|---|---|---|---|
| 3.0 / 2.1 | Marstal | 32/32 | 32 | 27 (all 2.3 m) |
| 3.0 / 2.1 | Flensburg | 32/32 | 7 | 2 (Marstal 2.3 m, Augustenborg 2.8 m) |
| 2.8 / 1.9 | Marstal | 32/32 | 32 | 27 (all 2.3 m) |
| 2.8 / 1.9 | Flensburg | 32/32 | 6 | 1 (Marstal 2.3 m) |

The 5 `KNOWN_DISCONNECTED` harbours are null under both radii in every case.
Flensburg→Augustenborg is a second, non-Marstal relaxing geography at the
3.0 m gate. That corrects this document's earlier claim that relaxation
fires only on Marstal pairs. The sweep's shallow-block count (solver level) is
a different filter from this BFS one; neither is derived from the other.

Plan-level (solver) evidence is out of scope here: `planRoute` takes no radius
parameter, and changing that is a production change. The plan-level BASE vs
HEAD comparison is the P3 record's §7 sweep
(`docs/spikes/452-p3-implementation-record.md`): 0 `usedDepthM` worse, 0
ok→error.

## Positive controls

- **Real mask, radius 1000 m vs Infinity** (below the ~1050 m Marstal cliff,
  compared against Infinity so it does not move with `APPROACH_RADIUS_M`):
  27 lost routes (3.0 / 2.1 case, global 2.3 m) and 27 different-depth
  divergences (2.8 / 1.9 case, local 1.9 m vs global 2.3 m). The tripwire
  throws on both sets.
- **Synthetic two-channel mask:** a 2.5 m pinch midway (outside both discs)
  and a 2.3 m detour pinch inside A's disc. Global 2.5 m, local 2.3 m; the
  tripwire throws, and an empty population throws "nothing measured".

## Mutations (BASE `d219adb` = PR #1201's harness, HEAD = this branch)

| mutation | BASE | HEAD |
|---|---|---|
| `APPROACH_RADIUS_M` 1852→1000 (`depthGate.ts`) | differential GREEN, only the lost-route control reds | 4 of 4 equality rows RED, incl. `elan… marstal aeroeskoebing: local 1.9 != global 2.3` |
| drop `cos(lat)` from `colRadius` | 3/3 green | 8/8 green — no discrimination (cause not investigated; the E-W radius shrinks to ~1067 m) |
| tripwire made tautological (`toBe(r.localUsedDepthM)`) | n/a | both controls RED, 6 others green |

The first row's BASE column is the defect this change fixes: the trade biting on every
relaxing pair left the differential assertion green.

## What is NOT established

- A future mask, harbour or boat could create a pinch outside every disc. The
  equality assertion now reds when that happens on this population; before
  this change the harness could not (its assertions were structural only).
- Other origins, via-point chains, user-lowered or raised gates, and phase-2
  ascent with two simultaneous bottlenecks are outside this population.
- Phase-2 ascent order: `[Marstal, X]` vs `[X, Marstal]` agreed on the
  5-harbour direction sample (reported, not asserted).

## Considered and rejected

- **Route (b), a proof of no regression:** false. Only local <= global is
  structural; the synthetic control is a counterexample to equality.
- **Plan-level differential via `vi.mock` of `depthGate`:** rejected, it
  swaps a module the whole solver imports, and one Flensburg→Marstal plan
  alone measured 77.61 s in Node (P3 record R4), so 64 pairs x 2 radii cannot
  run in CI; the §7 sweep already covers plan level against real BASE code.
- **Mask-level LAND-forcing simulation** (the pre-P3 R3 numbers): not the
  shipped mechanism, and run at 2400 m, not 1852 m.
- **Hard-coded boat list:** rejected; depth cases derive from `BOATS`, so a
  new boat joins the population automatically.

## Reproduction

```
npm --prefix app run test -- relaxationTrade
```

8 tests, ~90 s locally (largest single test ~21 s, under
`SOLVER_TEST_TIMEOUT_MS`). Per-pair rows print only with `--reporter=verbose`.
