# Spike #1350 — per-rig plan budget vs parallel rig solving

- **Issue:** #1350, follow-up to #1331.
- **Date:** 2026-09-27. **Merge-base:** `a4c0ad3`.
- **Status:** Recommendation only. No code, no measurement taken; every
  figure below is cited with its source and basis. The maintainer rules
  (§6) before anything is built.

**Verdict: of the two options #1350 names, only parallel rig solving
shortens the user's wait; a per-rig budget either changes which rig gets cut
or lengthens the worst-case wait (§5). Build parallel solving, in the
tier-barrier shape of §4, if a tablet measurement of the worst known route
approaches `PLAN_BUDGET_MS`; #1490 measures a different plan (§3, §6 Q1).
Until then keep the shared 360 s deadline (#1331's ruling).**

## 1. Today's shape

- One deadline object per plan, created in `protocol.ts`'s `createHandler`
  (`const deadline =`, ~:111) from the `budgetMs` the client sends:
  `timeoutMs - PLAN_TIMEOUT_GRACE_MS` (`workerClient.ts`, ~:531), with
  `PLAN_BUDGET_MS = 360_000` (~:140).
- `runAll` maps over `req.sailIds` synchronously, one rig after the other
  (`planRoute.ts`, ~:628, and the `#340/#54 NAMED COUPLING` comment above
  it). The deadline is shared by pass 1's up to 4 tiers × 2 rigs × N
  segments (`planRoute`'s doc comment, ~:424), plus any #1136 pass-2
  replays (next bullet).
- #1136 pass 2 re-runs `runAll` per recorded tier under `pass2Deadline`:
  the shared deadline or `PASS2_BUDGET_MS = 60_000` from pass 2's start,
  whichever expires first (~:805, ~:62).
- `comparisonComplete` is `!budgetCut`: false when any sail's cause is
  `budget-exhausted` (`assemble`, ~:752).

So the user waits for the SUM of every rig solve of every tier that fires.
The per-rig figures on record at the shipped #1257 cap (#1331 comment
5728660679): Flensburg → Burgstaaken, Salona 45, tier 1, bare `solve()` per
rig, synthetic uniform 12 kn / 225°, idle box, machine not recorded,
measured for PR #1335 (2026-09-18) — genoa 127.9 s + fock 144.0 s =
271.9 s.

## 2. The deciding axis: the user's wait

| | Wait for a plan that fits | Worst-case bound | On the #1331 route |
|---|---|---|---|
| Shared deadline (today) | sum of rigs | budget | 271.9 s (sum) |
| Per-rig budget | sum of rigs | sum of per-rig budgets | 271.9 s (sum) |
| Parallel rigs | per-tier max, summed | budget | 144.0 s (tier 1 max) |

The parallel row is arithmetic on #1331's per-rig figures and assumes two
concurrent solves each run at single-solve speed. That assumption is not
verified on any machine, the reference tablet included (§6 Q2).

`planRoute`'s #432 doc comment (~:424) records why the budget is one object
per plan: a per-`solve()` budget "would bound each piece while leaving the
user's actual wait unbounded and settings-dependent, since how many tiers
fire is invisible to them". A per-rig budget is that design at rig
granularity; §5 applies the argument per variant.

## 3. Recommendation

Parallel rig solving, tier by tier (§4), gated on a tablet measurement of
the worst known route, which #1331's ruling comment names as Flensburg →
Burgstaaken. #1490's first ask ("if it approaches the budget, weigh #1350")
covers a different plan, the light-motorless Flensburg → Svendborg
motor-off plan, so it does not by itself trigger this. No tablet figure for
Burgstaaken appears in #1331, #1350, #1490 or spike 1147.

`comparisonComplete` improves under parallel solving (both rigs start at
the same instant, so the second rig is no longer starved by the first) but
the mixed pair `combineFailureCause` ranks (~:133) stays reachable: one rig
can finish and the other run out of budget.

## 4. Design shape (not prototyped)

**The ladder stays in one place; each tier's rig solves run concurrently,
with a barrier per tier.** Every tier decision is pair-level:

- `needsUnpreferencedRetry` (~:380): "the retry always re-solves BOTH rigs
  together".
- Tier fallbacks test `.some((r) => r.rigResult)` over both rigs.
- `findRelaxedGate` runs once (~:947) and "BOTH rigs solve against that
  single gate FIELD", which keeps the comparison apples-to-apples.
- `salvagePassAdmitted` reads the plan-level `Pass1Record`.

A relaxed gate can cross `postMessage`: `UniformGate`, `ApproachGate` and
`Disc` are plain data (`lib/depthGate.ts`).

What moves:

1. **Sync callers.** `planRoute` is synchronous; the routing unit tests
   call it directly and `app/sweep/sweepArms.ts` imports it. One ladder
   can serve both if it is expressed as a sequence of "solve these rigs
   at this gate" steps, run inline by a sync driver and dispatched to
   workers by an async one. A second hand-written ladder would be a
   duplicated algorithm to keep in step. `planRoute.ts` is in the #282
   closure (`closure.mjs files`), so the refactor owes a sweep.
2. **Deadline start.** `protocol.ts` measures `Date.now() - startedAtMs`
   from its own handler start; two workers need one shared start instant.
3. **Cancel.** `terminate()` is the only interrupt (`workerClient.ts`'s
   `'cancelled'` comment); `cancel()` must terminate both workers.
4. **Liveness.** `armLiveness` (~:402) re-arms per pending plan on any
   progress or probe message; with two workers, a silent one must not hide
   behind a chatty one.
5. **Progress readout.** `usePlanFlow.ts`'s `PlanningState` `'routing'`
   comment says the "sail N of 2" readout is honest because rigs solve
   sequentially, and `planRoute.test.ts`'s `'#340/#54: solve order matches
   request.sailIds'` pins that order. Both change meaning (§6 Q4).
6. **Pass 2.** `replayWithSalvage` (~:811) calls `runAll` per tier, so it
   parallelises the same way, still under `pass2Deadline`.
7. **Singleton.** `usePlanFlow.ts`'s `clientRef` (~:138) is one client
   shared through `ensureClient` by several consumers, e.g.
   `DepartureCompare.tsx`'s `useDepartureScan` and `useDepartureConfirm`.

**Memory, per extra worker.** Its own `NavMask` over a transferred copy of
the mask (`usePlanFlow.ts` `.slice(0)`, ~:179; `mask.bin` is 9,438,000
bytes) and a structured clone of the wind grid per plan (`protocol.ts`'s
`windGrid: WindGrid`). The grow-only ~47 MB BFS scratch (`mask.ts`'s #1256
comment above `let bfsVisited`) is paid only by a realm that calls
`cellsConnected`; `solve()` does not, so a solve-only second worker avoids
it if connectivity checks and relaxation probes stay in the ladder's
worker. Per-solve solver heap is not measured here.

## 5. Considered and rejected

- **Per-rig budget, any of four variants.** None reduces the wait:
  - *Split the 360 s per rig, per tier:* bounds each piece; the worst
    case is tiers × rigs × 180 s (4× today's at 4 tiers), exactly the
    #432 objection.
  - *Split the 360 s per rig, across tiers:* same total as today, but an
    asymmetric pair that fits the shared budget (e.g. 200 s + 150 s) gets
    its slower rig cut at 180 s, where today both finish.
  - *360 s each, per rig across tiers:* up to 2× today's worst-case wait.
  - *360 s each, per rig per tier:* tiers × rigs × 360 s (8× today's at 4
    tiers); the #432 objection in full.
  Its one benefit, guaranteeing the second rig a share, is delivered
  by parallel solving without lengthening the wait.
- **Two independent `planRoute` calls, one sail each.** Each worker would
  run its own ladder, so the two rigs could return results from different
  tiers or relaxed gates, which `compareRigs` would then rank. Breaks every
  pair-level decision in §4.
- **Ladder on the main thread.** `connectedAt` and `findRelaxedGate` run
  synchronous `cellsConnected` BFS passes, several per
  relaxation (`mask.ts`'s #1256 comment); on the main thread they block the
  UI.
- **Building now.** #1331 already raised the budget; no tablet figure for
  the worst known route is on record (§3), and #1490's open measurement
  covers a different plan. Building first would pay the §4 costs for an
  unquantified benefit.

## 6. Questions for the maintainer

1. Does #1350 wait for a tablet measurement of Flensburg → Burgstaaken,
   and what fraction of `PLAN_BUDGET_MS` triggers it? #1490 measures the
   Flensburg → Svendborg motor-off plan instead, and its body gives no
   per-rig split, so it cannot show the rig asymmetry §2 depends on.
2. Does the reference tablet run two solver workers concurrently at close
   to single-solve speed, and can it hold a second worker's mask and wind
   copies? Neither is established in any file read here.
3. Where does the coordinator live: the first worker dispatching to a
   second, or another arrangement? Nested-worker support was not checked.
4. May the #340 phase readout change from "sail N of 2" to a concurrent
   form (e.g. per-rig status)?
5. Is any per-rig budget variant (§5) wanted regardless, given #432's
   one-budget-per-plan argument?
6. Should parallel solving keep today's worst-case budget (360 s) or allow
   lowering it once the wait is max-of-rigs? Spike 1147 §5 left the
   acceptable worst-case wait open.
