# #930 (R3): P3's disc-vs-global relaxation trade, measured against the shipped mechanism

## Verdict

**Closure route (a)** — a real, non-simulated differential harness. No mask
cloning, no LAND-forcing, no alternate scalar search: the harness calls the
SHIPPED `findRelaxedGate` (`app/src/routing/relaxedDepth.ts`) twice per
route, against the real committed `mask.bin`, changing only
`approachRadiusM` — `APPROACH_RADIUS_M` (1852 m, shipped) vs `Infinity`
(`depthGate.ts`'s own documented kill switch, pinned by
`relaxedDepth.test.ts` as reproducing the pre-#452 global search cell for
cell). Harness: `app/src/routing/relaxationTrade.differential.test.ts`.

**Finding: the trade never bites, on the complete reachable population.**
Across all 32 (Marstal, X) pairs in the shipped `harbors.json` — the
COMPLETE set of pairs where relaxation can fire at all anywhere in the
region (`app/sweep/sweepArms.ts`'s own header: exactly 1 of 32 non-Marstal
harbours needs relaxation from any other origin, and it is always Marstal;
this is not a sample of a larger space) — `usedDepthM` at the shipped
1852 m radius equals `usedDepthM` at `Infinity` EXACTLY, on all 27 pairs
that relax at all. The other 5 (the `KNOWN_DISCONNECTED` set) return `null`
under both radii.

This narrows the residual, it does not close it as a general theorem: the
result is empirical, scoped to the currently committed `mask.bin` and
`harbors.json`. A future mask/harbour change could in principle reopen it;
this harness is the re-runnable check for that.

## Method

`findRelaxedGate(mask, [MARSTAL, X], 3.0, radiusM, relaxationFloorM(salona-45))`,
called directly (no `planRoute()`/solver — `findRelaxedGate` is pure mask
BFS, cheap enough to run the full 32-pair sweep at two radii in ~30 s).
`FLOOR_M = relaxationFloorM(salona-45) = 2.1`.

Three tests:

1. **Differential.** All 32 pairs, local (1852 m) vs global (Infinity).
   Asserts local's `usedDepthM` is never null-while-global-isn't (would be
   impossible under the subset argument: local's per-probe navigable set is
   a subset of global's at every radius) and never numerically LESS
   relaxed (higher) than global's.
2. **Positive control.** Same 32 pairs at radius = 1000 m vs 1852 m.
3. **Direction check.** 5-harbour sample, `[Marstal, X]` vs `[X, Marstal]`.

## Results

27 of 32 pairs relax (the 5 `KNOWN_DISCONNECTED` harbours — arnis, kappeln,
maasholm, dyvig, graasten — return `null` under both radii, as expected).
On all 27: `localUsedDepthM === globalUsedDepthM === 2.3` m, exactly.

An exploratory fine sweep (not committed as a test — informal, run via a
throwaway file during this session) found why: the Marstal-local pinch is a
hard CLIFF, not a gradient. At every one of 5 sampled destinations
(Flensburg, Sønderborg, Bagenkop, Ærøskøbing, Fåborg), `usedDepthM` is
`null` for every radius <= 1040 m and exactly `2.3` for every radius from
1060 m up to `Infinity`, with no intermediate value ever observed. So for
THIS mask, once a disc is large enough to reach Marstal's pinch at all, it
grants the SAME single decimetre-quantised gate the unrestricted search
would — there is no partial-credit regime where a smaller (but still
sufficient) disc needs deeper relaxation than the global search. The
shipped 1852 m sits ~790 m above that cliff (matching `depthGate.ts`'s own
comment on the margin), so the shipped radius clears it with room to spare.

Direction check: `findRelaxedGate([Marstal, X], …)` and
`findRelaxedGate([X, Marstal], …)` agree on all 5 sampled pairs (both
`2.3`). `relaxedDepth.ts`'s phase-2 per-disc ascent walks the waypoint array
IN ORDER and could in principle diverge by order — it does not, on this
sample, because ascent only ever adjusts the non-bottleneck disc (X's),
which never determines the reported minimum.

## Positive control

Radius = 1000 m (below the measured ~1050–1060 m cliff) vs the shipped
1852 m: **all 27 relaxing pairs flip from `2.3` to `null`.** The comparison
mechanism detects movement decisively when a real difference exists.

Two earlier calibration attempts are recorded because they are informative,
not because they are the final control: 100 m produced `null` everywhere
(too tight to be a control at all — the actual pocket/corridor is larger
than a 100 m disc can reach) and 1200 m produced NO change from 1852 m on
any pair (both sit above the cliff). Neither is a weak positive control;
both are unusable ones, which is why 1000 m — chosen from the measured
cliff location, not guessed — is the one shipped in the test.

## Mutation testing (guarding the assertions, not just the metric)

Every mutation below was applied to the UNMODIFIED, committed
`app/src/lib/depthGate.ts`, run, then reverted with `git restore` (the file
carried no other changes of mine, so this was safe) — confirmed clean via
`git diff --stat` before and after each attempt.

- **Radius scaling bug** (`rowRadius`/`colRadius` divided by 3, simulating a
  realistic unit-conversion mistake). REDS the positive-control test: at
  the shipped 1852 m (now effectively ~617 m, below the cliff) every
  relaxing pair goes `null`, so `moved.length + newlyBlocked.length` at the
  TIGHT_RADIUS_M probe is `0` and the assertion correctly fails. Confirms
  the harness's core sensitivity is real, not vacuous.
- **Ellipse axis transposition** (`d.rowRadius2`/`d.colRadius2` swapped in
  `gateAtCell`'s membership test — a realistic transposed-index bug, the
  same class CLAUDE.md documents elsewhere in this repo). REACHED the code
  (executes on every `ApproachGate` cell) but produced NO observable change
  in any of the three tests. Explained, not just asserted: at Marstal's
  latitude the two axes are within 0.5% of each other in grid units
  (measured: 46.383 m/row-unit vs 46.601 m/col-unit, ratio 0.9953) — a
  46 m-cell mask cannot see a sub-1% axis-length error. Genuine null
  result, not a probe that fails to reach.
- **In-bbox-but-outside-ellipse fallback made permissive**
  (`gate.requestedDepthM` -> `gate.minGateM` in `gateAtCell`'s final
  return). REACHED the code but produced NO change: during phase 1's
  uniform binary search, `minGateM` always equals the probe depth itself
  (`min(requestedDepthM, mid, mid) === mid`), so this specific fallback
  swap is a no-op for phase 1 on this route shape.
- **Outside-bbox fallback made permissive** (`gate.requestedDepthM` -> `0`
  for cells outside the union bounding box). REACHED the code but produced
  NO change: Marstal's own pinch sits INSIDE its disc's bounding box at
  every radius tested, so the outside-bbox branch is simply never on the
  critical path for these routes.

**What this establishes, precisely.** The harness's SENSITIVITY is real
(radius-scaling mutation reds cleanly). The specific "local never needs
MORE relaxation than global" assertion behaves, for this 2-waypoint,
one-bottleneck topology, close to a structural consequence of the
mechanism's own shape: GLOBAL's kill-switch branch (`uniformGate`) applies
its candidate depth to the ENTIRE mask unconditionally, so it is
definitionally the most permissive outcome that specific probe depth can
produce — no realistic single-line bug in the disc/bbox geometry (three
attempted) could make LOCAL exceed it, because every attempted mutation
either left the bottleneck cell governed by the SAME correct math (ellipse
transposition — invisible at this scale) or touched a branch the bottleneck
never reaches (both fallback mutations — the pinch is always inside the
disc and inside the ellipse once the radius clears the cliff). This is
reported as an HONEST LIMIT of what single-line mutation testing could
exercise here, not as a proof that the assertion can never fail — a
mutation to the phase-2 ascent loop's per-disc bookkeeping, or a future
mask with two simultaneous bottlenecks, remains untested.

## What is NOT established

- Whether a future mask revision (finer resolution, a new harbour, a
  reconnected `KNOWN_DISCONNECTED` pocket) could produce a SECOND
  relaxation-relevant pinch elsewhere. Per `app/sweep/sweepArms.ts`, none
  exists today; the harness is the re-runnable check for if one appears.
  If it did, that pair would exercise geometry no current pair does —
  including, possibly, phase-2 ascent as an actual discriminator (see
  below). No fresh issue is filed for this; this document is the pointer
  if it ever needs picking up.
- Whether phase-2 per-disc ascent can ever be the mechanism that makes
  LOCAL exceed or fall short of GLOBAL. On the real mask, every relaxing
  pair has exactly one bottleneck (Marstal's own disc), so ascent only ever
  touches the OTHER waypoint's disc, which never determines the reported
  minimum. No pair in `harbors.json` exercises a route where BOTH waypoints
  are simultaneously bottlenecks, so this harness's real-mask coverage
  cannot speak to that case. The synthetic `relaxedDepth.test.ts` fixtures
  are a separate, narrower control (not audited here).

## Reproduction

```
npm --prefix app run test -- relaxationTrade
```

~30 s. Filter matches `relaxationTrade.differential.test.ts`'s 3 tests
only.
