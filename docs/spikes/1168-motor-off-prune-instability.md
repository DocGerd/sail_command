# #1168: motor-off solve instability — mechanism and fix recommendation

**Verdict: the instability is live on `develop` (`875b420`) and has a
user-visible surface.** Five of 25 Flensburg → Bagenkop motor-off plans
drop one rig as `unreachable` on connected water, and three of those
recommend the slower rig. The measured mechanism is position within a
prune key. Children that fit only as a substep are dominated by cheaper
arrivals 4–182 m away inside the same key, so the frontier empties within
seven rings of Flensburg. A finer confined prune grid (divisor 3 or 4)
removes every death in this battery and keeps ETA monotone in wind speed.
Salvage does not: it stops the deaths but leaves the ETA erratic.
**Recommendation: refine the confined prune key for motor-off solves only,
behind the prerequisites in [Recommendation](#recommendation).** This is a
spike; no solver code changed.

## Method

- **Aperture.** Flensburg → Bagenkop, `motorEnabled: false`, gate 3.0 m,
  uniform wind from 0°, the issue's own configuration. Two origins:
  `FLENSBURG` unsnapped, and `snapToNavigable(FLENSBURG, 3)`, 24.68 m away
  at `875b420`. The destination is always snapped.
- **Two levels.**
  - Bare `solve()`, Salona 45 genoa and fock at performance factor 1.0,
    the issue's convention. The fine battery covers TWS 2.00–4.00 in steps
    of 0.05, both origins: 82 solves per rig. A coarser sweep runs to TWS 8.
  - `planRoute()` with both rigs and the full tier ladder, TWS 2.0–4.0 in
    steps of 0.1 plus 4.5, 5, 6 and 8: 25 plans.
- **Wider apertures, for blast radius.**
  - `light-motorless`: tier-1 `solve()` at plan fidelity (performance
    factor 0.9, `comfortDepthM` 5, `DEFAULT_SETTINGS` motor off, TWS 3 from
    0°), Flensburg → all 40 harbours, genoa.
  - `breeze`: the same fidelity at 12 kn from 225° with the motor on, to six
    routes, four of them long.
- **Tree.** `875b420` (the branch base). `isochrone.ts` changed since the
  2026-09-18 re-measurement: #1257's derived cap and #1259's
  cells-per-degree grid both landed in between.
- **Instrumentation.** All probes ran a copy of `isochrone.ts` with the
  [`instrumentation.patch`](1168-motor-off-prune-instability/instrumentation.patch)
  applied. `isochrone.ts` itself was not edited. The copy records every
  stamped arrival per prune key, attributes each dominated child, and
  switches between the candidate fixes. It also sets `CONFINED_PRUNE_DIV`
  at run time.
- **Evidence type.** Deterministic only: status, cause, ring count, peak
  frontier, expanded nodes, `costMs` and ETA. No wall-clock figures
  (maintainer ruling, 2026-09-18). Expanded nodes stand in for search cost.
- **Pre-registration.** Predictions for salvage, Pareto stamps, divisor 4
  and retraction were written before their output was read
  (`results/preregistration.txt`). Divisor 3 was added afterwards and was
  not pre-registered. Two predictions failed: the finer grid was
  predicted to move the dying set rather than empty it, and dead-stamper
  retraction was predicted to rescue.

Raw results are in
[`1168-motor-off-prune-instability/results/`](1168-motor-off-prune-instability/results/).

## Results

### 1. The issue's table at `875b420`

| TWS | unsnapped | snapped |
|---|---|---|
| 2.4 | ok 19.373 h | ok 19.312 h |
| 2.6 | ok 17.871 h | ok 17.863 h |
| 2.8 | ok 16.553 h | mask-blocked at ring 6 |
| 3.0 | mask-blocked at ring 5 | ok 15.509 h |

Status matches the #1322 column of the 2026-09-18 comment in all 8 cells.
ETAs differ from it by 0.2–3.0 min. This probe does not separate #1257 from
#1259 as the cause of that shift.

### 2. The band is wide and covers both rigs

- **Fine battery** (TWS 2.00–4.00, step 0.05, both origins): genoa dies on
  17 of 82 solves, fock on 15 of 82. Every death is `mask-blocked` within
  seven rings.
- **Coarse sweep** (to TWS 8): genoa 9/50, fock 8/50. The highest dying TWS
  is 3.8 for genoa and 6 for fock.
- **Motor on**: 0 of 22 genoa solves die (TWS 2.0–4.0, both origins). This
  is the only motor-on perturbation measured. Its ETA rises with TWS above
  3.0, the designed #254 sail-preference trade, not this defect.
- Among solves that route, ETA falls monotonically with TWS on both rigs
  and both origins. The instability is in the outcome, not in the ETA.

### 3. Mechanism: position within a prune key

Attribution on the dying rings, numbered from 0 (full dumps in
`results/ctrl_prod.jsonl`):

| | unsnapped TWS 3.0, ring 4 | snapped TWS 2.8, ring 5 |
|---|---|---|
| frontier / accepted edges / blocked edges | 7 / 173 / 65 | 2 / 27 / 41 |
| dominated by `visitedDominates` | 173 (all) | 27 (all) |
| of those, fitted substeps (`dtS`/2..8) | 154 | 27 |
| dominated by the parent's own key | 1 | 0 |
| dominator stamped only in the previous ring | 5 | 0 |
| every dominator's node produced no children | 28 | 4 |
| no single real arrival dominates (componentwise-minimum artefact) | 0 | 0 |
| median / max distance to the nearest real dominator | 49 / 182 m | 31 / 99 m |

- On both dying rings every accepted child is pruned by a cheaper earlier
  arrival sitting 4–182 m away inside the same prune key. Most full steps
  are blocked there and nearly every accepted child is a substep. The
  dominators were mostly stamped two or more rings earlier, and almost never
  in the parent's own key. Where on the chart these rings sit was not
  recorded.
- #1136's spike (§1.3) could only DEDUCE that fitted substeps carry the
  deaths; this attribution MEASURES it. The same spike's componentwise-minimum
  channel does not occur here: 0 of 200 dominated children.
- The rule is sound only if two arrivals in one key are interchangeable. In a
  passage narrower than a key they are not: the cheaper arrival can sit where
  every onward edge is blocked while a later one could get out. That is the
  #1303/#1305 mechanism, and #1322 narrowed it without closing it.

### 4. Plan level: a rig drops out and the ★ goes to the slower rig

`planRoute()` at `875b420` (`results/plan.jsonl`):

| TWS | genoa | fock | recommended |
|---|---|---|---|
| 3.1 | **unreachable** | 17.420 h | fock |
| 3.3 | 15.657 h | **unreachable** | genoa |
| 3.5 | **unreachable** | 15.404 h | fock |
| 3.6 | **unreachable** | 14.963 h | fock |
| 3.7 | 13.975 h | **unreachable** | genoa |

- The other 20 plans route both rigs, except TWS 2.0 and 2.1, where the fock
  fails `beyond-horizon`.
- Three plans recommend fock while a working search routes genoa faster: at
  TWS 3.1, 3.5 and 3.6 the finer grid routes genoa in 16.739, 14.915 and
  14.460 h (§5).
- The 2026-09-18 comment found no dropout on 2.0–3.4 because it sampled in
  steps of 0.2. None of its points (3.0, 3.2, 3.4) falls on 3.1 or 3.3. This
  is a difference of aperture. Whether #1257 or #1259 changed anything here
  is not established, because `11fc282` was not re-run.
- #1136's pass 2 cannot reach these plans. `salvagePassAdmitted` requires
  pass 1 to have returned an error, and a plan with one routed rig is `ok`.
  This is the #1166 shape.

### 5. Candidate fixes, measured

Each fix ran on the scratch copy. "Bare" is the 164-solve fine battery (82
per rig). "Plan" is the 25-plan ladder.

| candidate | bare deaths | ETA rises with TWS (adjacent pairs) | plan `unreachable` dropouts | notes |
|---|---|---|---|---|
| none (`develop`) | 32/164 | 0 | 5/25 | — |
| salvage on every pass-1 solve | 0/164 | 15 (up to 53.5 min) | 0/25 | one false `beyond-horizon`; rescued ETAs up to 105.9 min slower than the finer grid |
| retract dead stampers | 9/9 re-die (genoa, coarse band) | — | — | reaches the path: death moves to rings 7–11 |
| single-arrival (Pareto) stamps | 5/5 re-die at the same ring | — | — | predicted by the zero componentwise count in §3 |
| confined grid, divisor 3 | 0/164 | 0 | not run | cheapest; see §6 |
| confined grid, divisor 4 | 0/164 | 0 | 0/25 | also routes the TWS 2.0/2.1 fock; every plan moves; see §6 |

Salvage (`results/planalt_salvage.jsonl`, `fine_salv_*.jsonl`):

- On every solve that routes today it changes nothing, because it fires only
  on an empty frontier with no `best`.
- At plan level it still moves the routed rig on four plans. The ladder keeps
  tier 1 once both rigs route, instead of falling back to the no-comfort
  tier 2.
- It turns the TWS 3.3 fock dropout into a false `beyond-horizon`: the
  salvaged search limps until the 48 h horizon.
- At TWS 3.5 it recommends fock at 15.623 h over a salvaged genoa at
  15.761 h. The finer grid routes that genoa in 14.915 h.

The finer grid at divisor 4 (`results/planalt_div4.jsonl`):

- Routes both rigs on all 25 plans, with ETA monotone in TWS on both rigs.
- Changes every plan's ETAs, mostly by minutes. At TWS 2.0 the genoa drops
  from 38.1 h to 27.9 h and the fock routes (29.4 h) where it failed before.

### 6. What the finer grid costs

On the bare battery, against divisor 2, over the rows that route under both
grids:

| divisor | median `costMs` Δ (genoa / fock) | rows worse | worst | median peak × |
|---|---|---|---|---|
| 3 | −0.5 / −0.6 min | 27/65, 22/67 | +4.6 / +19.4 min | 1.24 / 1.19 |
| 4 | −1.3 / −1.2 min | 24/65, 23/67 | +6.0 / +26.2 min | 1.44 / 1.44 |

`light-motorless` aperture, 40 harbours, genoa (`results/lm_*.jsonl`):

- At divisor 4, status counts are unchanged (34 routed), but causes move.
  `arnis` and `dyvig` go `horizon-exceeded` → `mask-blocked`, and `maasholm`
  goes the other way. `SolveFailureCause` gates relaxation, so this is a #282
  classification move.
- At divisor 4 the result (cost or cause) moves on 35 of 40 harbours. Four
  routes change family: Rudkøbing −19.9 h, Svendborg −24.5 h, Troense
  −22.0 h and Kerteminde −6.6 h. The coarser grid there found routes close
  to the horizon.
- At divisor 4, expanded nodes rise ×2.08 on the median harbour and ×3.94 at
  most. The largest is 3.96 M, against 2.34 M at divisor 2.
- At divisor 3 the only cause that moves is `maasholm` (`mask-blocked` →
  `horizon-exceeded`), and the result moves on 34 of 40 harbours. Only
  Kerteminde changes family (−6.7 h); Rudkøbing, Svendborg and Troense do
  not. Expanded nodes rise ×1.42 on the median harbour and ×3.25 at most,
  3.03 M at the largest.
- That divisor 4 finds the three faster families and divisor 3 does not is
  #1333's point: a finer key is not a monotone improvement.

`breeze` aperture, motor on (`results/cost_div*.jsonl`):

| route, genoa | div 4: expanded × / truncated rings / `costMs` Δ | div 3: expanded × / truncated rings / `costMs` Δ |
|---|---|---|
| Svendborg | 1.47 / 2 / −0.2 min | 1.28 / 0 / +0.1 min |
| Rudkøbing | 1.65 / 5 / −1.8 min | 1.30 / 0 / −1.3 min |
| Burgstaaken | 1.78 / 4 / −0.1 min | 1.36 / 0 / −0.1 min |
| Orth | 1.68 / 2 / −0.1 min | 1.30 / 0 / −0.1 min |

- Divisor 4 takes all four long genoa routes to the #1257 cap (95 333),
  which reopens the #1330 truncation. For these routes it buys at most
  1.8 min.
- Divisor 3 stays under the cap (peaks 77 223–80 874), but uses most of the
  headroom #1257 sized: 1.18–1.23× remain, where #1257 recorded 1.48×.
- The divisor 4 fock rows are ×1.38–1.67 with no truncation.
- The cap-regime control: on the three Salona 45 solves #1257's derivation
  records, divisor 2 peaks here are within 20 of its figures (Svendborg fock
  61 654 against 61 653, Burgstaaken genoa 62 463 against 62 482, Orth genoa
  61 881 against 61 883).

## Controls

- **The copy is faithful.** With the patch applied and production behaviour
  selected, all 8 issue-table solves match production `solve()` in status,
  ring count, peak, `costMs` and ETA. This was checked twice, before and
  after the divisor became a run-time setting, and a third time on the
  committed patch. Recomputing the stamp from the recorded arrivals also
  matches production 8/8 (`arrmin`). The plan-level
  mock, with no fix applied, reproduces the production `planRoute()` sweep
  25/25 (`planalt_none` against `plan.jsonl`).
- **Order independence** was not re-tested. The #1136 spike's reverse-order
  control (§3.2) is the standing evidence.
- **Counters fire.** The componentwise-minimum counter is 0 on the dying
  rings but reaches 1 871–19 265 on the six routing solves of the issue
  table. The truncation counter reads 0 at divisor 2 and fires at divisor 4.
- **Negative control.** Flensburg → Marstal at 3.0 m has no route at the
  requested gate. It stays `mask-blocked` at divisor 4 (breeze aperture),
  so the finer grid does not invent a route through blocked water. Every edge
  it accepts still passes the mask.
- **Reach.** Each candidate provably changed the search on the configurations
  it was scored on. Retraction moved the dying ring from 5–7 to 7–11. The
  Pareto rule changed peak frontiers on routing rows. The divisor changed
  every plan.

## Scope

- One route family, Flensburg → Bagenkop. Only the `light-motorless` and
  `breeze` probes look wider.
- Uniform wind only. The issue's open question about a real Open-Meteo
  forecast is still unanswered.
- Divisors 3 and 4 were scored on both rigs in the fine battery, but only
  on genoa in the `light-motorless` probe; `breeze` ran divisor 3 on genoa
  only. The plan-level arms cover divisor 4 and salvage only, not divisor 3.
- "0/164" is a rate at this aperture, not a proof. #1333 records that a finer
  key does not make the node set a superset, so a death elsewhere at a finer
  grid remains possible.

## Recommendation

**Refine the confined prune key to divisor 3 for motor-off solves only
(where `motorEnabled` is false or `forcedKind` is `'sail'`). Keep #1136's
pass 2 as the backstop.**

1. **Why the grid rather than salvage.** It attacks the measured mechanism
   (§3). It removes the deaths and keeps ETA monotone, while salvage only
   exchanges a status flip for ETA jumps of up to 53.5 min and a wrong ★
   (§5).
2. **Why only with the motor off.** On `breeze` the finer grid saves at most
   1.8 min. Divisor 4 costs ×1.47–1.78 in expanded nodes and reopens cap
   truncation; divisor 3 avoids the truncation but still costs ×1.28–1.36
   and takes most of the cap headroom (§6). All of the deaths measured here
   are motor-off. Scoping would keep every motor-on solve byte-identical by
   construction, which turns the #282 sweep into a check on that scoping.
3. **Prerequisites, before a PR merges:**
   - Re-derive the budget headroom for the heaviest motor-off arm. On
     `light-motorless` expanded nodes rise up to ×3.25 at divisor 3 (§6).
     This figure gates a decision, so the 2026-09-18 ruling allows timing it.
   - Run the plan-level arm at divisor 3, which this spike did not. Divisor 3
     is recommended over 4 because it removed the same deaths at lower cost
     (§6), not because it was scored at plan level.
   - Pin the fine battery at several inputs, not one. The issue itself says a
     single-input pin cannot guard this.
4. **Sweep cost.** `isochrone.ts` is in the #282 closure (`closure.mjs files`,
   via `planRoute.ts`), so a full BASE double-run plus BASE-vs-HEAD is owed.
   - `light-motorless` discriminates. It is this spike's wind, and the bare
     tier-1 probe's result moves on 34 of 40 harbours at divisor 3. The arm
     itself runs `planRoute()` with both rigs, so its own row count will
     differ.
   - `motorless-short-horizon` should discriminate too, as a motor-off arm.
     It was not probed here.
   - `becalmed` and `deep-becalmed` should be vacuous for this lever. This is
     argued, not measured: a calm death happens before `visitedDominates` is
     reached.
   - Every arm with the motor on is predicted byte-identical. A change there
     would falsify the scoping.

## Considered and rejected

- **Salvage on every pass-1 solve.** Rejected on measurement (§5). It is
  contained, byte-identical on every solve that routes today, and closes 4 of
  5 dropouts. It leaves 15 ETA rises of up to 53.5 min, turns one dropout
  into a false `beyond-horizon`, and flips a ★ to the slower rig.
- **Widen `salvagePassAdmitted` to the one-rig-dead case.** The same salvage
  quality as above, plus the #1166 containment ruling it would reverse.
- **Retract the stamps of nodes that produced nothing.** Rejected on
  measurement. At most 28 of 173 dominated children have only dead
  dominators, and retraction rescued 0 of 9 dying genoa solves while provably
  reaching the path.
- **Single-arrival (Pareto) stamps.** Rejected on measurement. There are zero
  componentwise-minimum dominators on the dying rings, and all 5 dying
  configurations tested die at the same ring.
- **Finer grid for every solve.** Rejected for now. It gains at most
  1.8 min on `breeze`. Divisor 4 reopens the #1330 truncation, and divisor 3
  leaves 1.18–1.23× cap headroom (§6). Revisit only together with a
  re-derived `FRONTIER_PER_PRUNE_CELL`.
- **Divisor 4 for motor-off.** Not preferred. It costs more than divisor 3
  for the same measured rescue, and it moves two relaxation-gating causes on
  `light-motorless` where divisor 3 moves none of those two. Its three
  faster `light-motorless` route families are real and are recorded as an
  open question.
- **Add candidate headings; relax `visitedDominates` unconditionally.**
  Already rejected by #1136's spike (§9.1, §9.2). Nothing here reopens either.
- **Leave it.** The 2026-09-18 "no live user target" premise came from a
  0.2-step aperture. At 0.1 the app shows `unreachable` on connected water
  and recommends the slower rig (§4).

## Open questions

1. Is scoping by motor mode acceptable? The alternative is an unscoped finer
   grid with a re-derived cap, which is a larger blast radius.
2. Does the finer grid hold for other routes and for a real forecast? Only
   the sweep and a forecast-driven probe can say.
3. Is the `maasholm` cause movement (§6), and at divisor 4 also
   `arnis`/`dyvig`, benign for the relaxation ladder? It shifts which tier
   runs, and only a `planRoute`-level sweep row shows the effect.
4. Divisor 4 found Rudkøbing, Svendborg and Troense routes 20–25 h faster
   on `light-motorless`, where divisor 3 and `develop` did not. Is that slow
   family a separate defect worth its own issue?

## Reproduction

See [`1168-motor-off-prune-instability/README.md`](1168-motor-off-prune-instability/README.md).
