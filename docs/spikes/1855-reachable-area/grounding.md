# #1855 reachable area — spike grounding

Base: develop `32f67af0`. Code anchors are `file:symbol`, paths under `app/src/` unless stated. Probe source, config and `results.json` are in `docs/spikes/1855-reachable-area/`.

## 1. The issue

- **Ask.** Given origin, departure and maximum trip duration, show the area the boat can reach under the forecast; the skipper then picks a destination from it.
- **Notes in the issue.** Expose the front at the duration limit instead of searching for one destination. Honour the depth gate, comfort margin and motor settings as a normal plan does. Reachable harbours may be listed with ETAs. Related: #1854, #936, #1708.
- **UX the design must decide:** inputs (reuse planner fields); one region or graded time bands; interplay with depth shading and #1854's view; legend placement in the `app.css` tier order; what a tap in the area or on a reachable harbour does; progress, cancel, and which sail plan the area assumes; states (no reachable water, beyond horizon, offline, budget exhausted); tablet floor >= 820 CSS px in both layout branches, `--sc-*` tokens and primitives, de/en, >= 44 px targets.
- **Draft acceptance.** Origin + departure + maximum duration produce a shaded region; copy marks it as a forecast-derived planning aid; the reviewed UX is followed, with real-browser screenshots in the PR.
- **Process (maintainer, 2026-10-28).** Full #1854-style process: three candidate designs, judge scoring, critique, revision log, real-data probe. The spike answers rig, motor, budget-exhausted and offline posture; the maintainer rules on it. The spike ships this cycle with `Refs #1855`; implementation is v0.62.0.

## 2. What #1854 fixes for this card

- **§12 slot.** A second card in Wetter, "Erreichbar ab {Start}", a Disclosure closed by default under the conditions card. While open, its compute button is the primary action and the departure handoff demotes to secondary.
- **§12 shared surfaces.** The hour store `state/conditionsHour.ts` (departure); the held wind grid from `state/useAreaForecast.ts`; the place lines; the harbour popup with [Als Start]/[Als Ziel]; the canvas raster pipeline (a sibling layer with an explicit `beforeId`).
- **§12 open questions it hands over:** one region or bands; inputs (max duration as `NumberInput`, which sail plan); progress and cancel (only the `terminate()` cancel of #1193 exists); budget-exhausted and partial results; whether the reach fill hides the sea-state fill; a "reachable in ~3 h 40" line in the harbour popup; whether "Wetter" still names the tab.
- **Rulings on #1854 (2026-10-28).** Slice 1 = PR1 water-clipped sea-state raster + barb halo, PR2 Wetter tab with hour control and "Als Abfahrt übernehmen". Place lines and popups are LATER slices, so the [Als Start]/[Als Ziel] popup §12 lists as shared does not exist after slice 1. No offline planning fallback to the Wetter session grid (§11); offline the card shows the offline note.
- **Tension for the offline posture.** §12 says the reach card "computes in the worker, so it can work offline with the grid's age shown". The §11 ruling forbids planning offline from the Wetter grid. Whether a reach computation from that grid is "planning" under the ruling is a question for the spike, not settled by §12.
- **Raster geometry the reach layer can reuse (§5).** Canvas source, `depthSourceCorners` corners, `depthCanvasRowMap` rows, `raster-resampling: 'nearest'`. Raster layers are not queryable, so taps need a map-level click with a shared lookup (§5 Popup).
- **Data flow (§10).** `ConditionsPanel` mounts inside `MapView` and portals into the Wetter slot; held grids live only in the hook's state for the session; IndexedDB is never read.

## 3. Solver facts that bind the design

### isochrone.ts
- **`solve(p: SolveParams)`** is destination-driven and synchronous. `SolveParams.destination` is required; it sets the per-ring step `dtS` (150/300/600 s at < 2 / < 5 / >= 5 nm from the nearest frontier node), the direct-TWA candidate (`sailCandidates`'s `directTwa`), the `better()` distance tie-break, and the arrival tests. A reach view needs none of these.
- **Ring loop.** Each ring expands every frontier node over the `sailCandidates` TWA set (or `FORCED_MOTOR_HEADINGS` on a forced-motor segment), with a half/quarter/eighth substep retry when a full step is blocked. Children collapse to one node per `pruneKey` per ring (`byKey`), are dropped if `visitedDominates` the key's stamp, and survivors are stamped with `stampVisited`.
- **Prune cells.** `PRUNE_LAT` 0.002°, `PRUNE_LON` 0.003° (comments: ~220 m x ~190 m). Inside confined cells (`pruneCellConfined`, margin `CONFINEMENT_MARGIN_CELLS` = 1) keys are finer by `CONFINED_PRUNE_DIV` = 2 (motor-on) or `MOTOR_OFF_CONFINED_PRUNE_DIV` = 3 (motor-off). Keys carry a board suffix P/S/M.
- **Dominance is on `costMs`, not true time.** `visitedDominates` and `better()` rank on `Node.costMs`, which equals `tMs` only without a comfort preference. At `DEFAULT_SETTINGS` (`depthComfortMarginM` 2.0) `planRoute` passes `comfortDepthM` = gate + 2.0, so shallower water is ranked as slower than it is.
- **Frontier cap.** `defaultMaxFrontier(mask.meta)` = max(`MAX_FRONTIER` 30 000, 0.2 x prune cells of the domain); on the committed mask the probe read 95 333. Over-cap rings are truncated in `better()` order: `costMs`, then maneuver count, then `distToDestNm`, then heading and position; the comment calls the cap "a perf safeguard, not a correctness bound".
- **Budget.** `SolveParams.deadline` is checked at ring entry and every `DEADLINE_CHECK_NODES` (128) nodes. On expiry `solve()` returns `{ status: 'no-route', cause: 'budget-exhausted' }` and discards both `best` and the frontier: nothing partial survives. Absent deadline means unbudgeted (every vitest call and the sweep).
- **Horizon.** `WindField.horizonMs()` is the last `timesMs`; a node past it is dropped, and a frontier that cannot take one more step ends the solve (`horizon-exceeded` if no `best`).
- **Exports a reach module can reuse:** `sailCandidates`, `edgeFactor`, `pruneCellConfined`, `visitedDominates`, `stampVisited`, `defaultMaxFrontier`, `DEADLINE_CHECK_NODES`, `backtrack`. Not exported: `pruneKey`, `better`, `FORCED_MOTOR_HEADINGS`, the prune and confinement constants.

### planRoute.ts
- **Two-rig ladder.** `openLadder` runs tier 1 (requested gate, comfort on), tier 2 (comfort off) when `needsUnpreferencedRetry`, then #53 relaxation tiers 3/4. Each tier solves every `req.sailIds` rig (`runAll`); `compareRigs` decides with `RIG_TIE_BAND_MS` (60 s). `comparisonSuppressed` withholds the verdict only for an undeclared sail.
- **#53 relaxation needs a destination.** It runs only after a failed tier (`depthRelaxationMayHelp`: `mask-blocked`, `horizon-exceeded`), and `findRelaxedGate` (`relaxedDepth.ts`) binary-searches a gate by `mask.cellsConnected` between consecutive waypoints, then gives every waypoint its own disc (`approachGate`, `APPROACH_RADIUS_M` 1852 m) down to `relaxationFloorM(boat)`. A destination-free solve has no pair to probe and no destination disc. The ORIGIN disc has an analogue: a fixed `approachGate` around the origin only (probe config `marstal-genoa-12-disc`).
- **Snap.** `planRoute` snaps origin and destination with `mask.snapToNavigable(p, s.safetyDepthM)`; the probe does the same for the origin.
- **Sweep closure.** `isochrone.ts` and `planRoute.ts` are IN the #282 closure; `workerClient.ts`, `protocol.ts`, `lib/harborReachability.ts` and a new `routing/reach.ts` are NOT_IN_CLOSURE (`closure.mjs files` at `32f67af0`). Editing `solve()` to expose its front owes a sweep; a sibling module importing the exports does not.

### workerClient.ts / protocol.ts
- **`PLAN_BUDGET_MS`** = 360 000 (one deadline per plan, imposed only by `protocol.ts:createHandler`); client waits `PLAN_TIMEOUT_GRACE_MS` (15 000) longer.
- **Pool (#1793).** `defaultPoolSize()` = max(1, min(2, cores - 1)): the ladder worker plus at most one sibling solve worker, so two rigs at most run concurrently.
- **Cancel.** `RoutingClient.cancel()` terminates the workers (`teardown('cancelled')`); the solve loop never yields, so there is no message-based stop. A cancel also tears down any other request on the shared client.
- **Protocol.** `WorkerRequest` has `init` and `plan`; a reach request would be a new member. Progress is `{ tMs, frontierSize }` per ring.

### Harbours and the depth gate
- **Catalogue.** `public/data/harbors.json` holds 47 harbours; 5 carry `knownDisconnected`.
- **Gate.** `lib/boatDepth.ts:defaultSafetyDepthM(boat)` = ceil-to-decimetre(draft + `MASK_TOLERANCE_M`); `relaxationFloorM(boat)` = ceil-to-decimetre(draft). Navigability is a per-query test (`NavMask.segmentNavigable` with a `DepthGate`).
- **Per-boat harbour access.** `lib/harborReachability.ts:computeHarborAccess` classifies each harbour as `ok` (in the `SEED_POINT` flood at the gate), `shallow-approach` (connected only with one approach disc at `relaxationFloorM`), `unreachable` or `known-disconnected`. It is boat-aware, not origin-aware: its seed is the Flensburg-fjord point.

## 4. Probe measurements

### Method
- **Harness.** `reach.probe.test.ts` with its own `vitest.config.ts` (root = its directory, `environment: 'node'`, no setup file), run from a detached worktree at `32f67af0` with a `node_modules` symlink to `app/node_modules`. Artefacts: `docs/spikes/1855-reachable-area/{reach.probe.test.ts,vitest.config.ts,results.json}`.
- **`reach()`** re-implements `solve()`'s ring loop without the destination terms, reusing the exports listed in §3. It keeps `dtS` at 600 s, drops the direct-TWA candidate (it passes `+beat` as `directTwa`, which `sailCandidates` dedupes), and treats the duration cap as the horizon (children past it are dropped; the loop ends when the earliest frontier node cannot take one more step).
- **Fidelity control.** With a `towards` point (Marstal) restoring the direct-TWA candidate and the distance tie-break, `reach()` gave frontier sizes identical to `solve()`'s `onProgress` over 12 rings from Flensburg (14, 72, 213, 692, 1026, 1121, 1104, 1156, 1113, 1012, 1005, 1255). The destination-free form differs by a few nodes per ring (14, 71, 221, 708, …).
- **Inputs.** Committed `mask.bin`/`mask.meta.json`, `harbors.json`, Salona 45 genoa/fock polars; `DEFAULT_SETTINGS` (gate 3.0 m, comfort depth 5.0 m, motor on, 6.5 kn) unless noted; uniform wind `uniformWindGrid(tws, 225°, { hours: 48 })` (the sweep `breeze` aperture at 12 kn); departure = grid start; origin = harbour `snap` passed through `snapToNavigable(p, 3.0)`.
- **Area unit.** A coarse prune cell (0.002° x 0.003°, board-agnostic) holds the minimum true `tMs` of any surviving frontier node in it. "Area" sums those cells' areas; "sector reach" is the furthest such cell per 10° bearing from the origin.
- **Timing basis.** One wall clock per configuration, one thread, this WSL machine (32 logical cores), per-run `/proc/loadavg` is in `results.json`, with another session's solver test running concurrently. These are not tablet figures.

### M1 — cost of a 6 h and 10 h front (12 kn, 225°, motor on)

| config | rings to 6 h / 10 h | nodes expanded to 6 h / 10 h | peak frontier | wall to 6 h / 10 h / drained |
|---|---|---|---|---|
| Flensburg genoa | 36 / 60 | 251 882 / 1 625 796 | 67 372 | 8.1 s / 56.9 s / 63.8 s |
| Flensburg fock | 36 / 60 | 217 379 / 1 477 138 | 64 015 | 6.8 s / 49.8 s / 57.6 s |
| Sønderborg genoa | 36 / 60 | 671 203 / 1 285 924 | 40 629 | 22.3 s / 42.7 s / 54.3 s |
| Sønderborg fock | 36 / 60 | 696 656 / 1 360 501 | 43 041 | 22.2 s / 43.9 s / 56.4 s |
| Marstal genoa, origin disc | 36 / 60 | 1 194 360 / 2 344 632 | 73 338 | 39.9 s / 78.9 s / 89.6 s |

- No ring was truncated: every peak is below the cap, `defaultMaxFrontier` = 95 333.
- "Drained" is the end of the run. After the 10 h ring the loop keeps expanding substep-lagged nodes until none can step within the cap: 85–90 rings in total, adding 13–30 % to the nodes expanded at the 10 h ring (Flensburg genoa 1 838 683 vs 1 625 796).
- Every single-rig 10 h run finished within 90 s, a quarter of `PLAN_BUDGET_MS` (360 s), on this machine. Two rigs run concurrently on the #1793 pool; on a single-worker client they run in sequence. No slower-device factor was measured here.
- Cost depends on the origin: Sønderborg's 6 h front took 671 203 nodes against Flensburg's 251 882, with 6 h areas of 1 228 and 429 nm².

### M2 — is a cell's arrival time final once its ring completes? No.
- Per coarse cell, compared the minimum `tMs` at the end of the first ring that reached it with its final minimum:

| config | cells | lowered later | by > 5 min | > 15 min | > 30 min |
|---|---|---|---|---|---|
| Flensburg genoa | 130 230 | 88 979 | 5 365 | 19 | 0 |
| Flensburg fock | 130 255 | 44 220 | 12 795 | 10 479 | 8 212 |
| Sønderborg genoa | 175 009 | 63 985 | 4 167 | 297 | 103 |
| Sønderborg fock | 173 618 | 81 423 | 12 279 | 164 | 19 |
| Marstal genoa, disc | 213 601 | 135 082 | 39 489 | 1 388 | 1 153 |
| Sønderborg genoa, motor off (6 h) | 103 138 | 37 314 | 9 177 | 7 905 | 6 701 |
| Sønderborg genoa, comfort off (6 h) | 99 624 | 69 521 | 10 471 | 36 | 0 |

- The area reached by time T is not the area stamped by ring T/`dtS`. Cells with final `tMs` <= 6 h vs cells stamped by ring 36: Flensburg genoa 34 417 vs 31 345 (+9.8 %), Flensburg fock 38 442 vs 30 783 (+24.9 %), Marstal disc 145 524 vs 133 201 (+9.3 %), Sønderborg genoa +0.2 %, Sønderborg motor off +4.0 %.
- Mechanisms visible in the code, not separated by the probe: substep children lag the ring clock by up to 7/8 `dtS`; `visitedDominates` ranks on `costMs` and maneuver count, not `tMs`; one coarse cell holds several keys (P/S/M, and finer keys where confined).
- Consequence for the design: a correct region needs the loop run until the frontier drains, not a snapshot at the cap ring; graded time bands read off ring indices would be wrong by the amounts above.
- `lateCostLowered` (a visited stamp's `costMs` lowered after its first ring) is non-zero in every run too (Flensburg genoa 694 113 events), so the solver's own prune state is not final per ring either.

### M3 — harbours reachable only through #53 relaxation (`computeHarborAccess`, SEED_POINT flood, 47 harbours, 5 known-disconnected)

| boat | gate / floor (m) | ok | shallow-approach | unreachable |
|---|---|---|---|---|
| salona-45 | 3.0 / 2.1 | 41 | marstal | — |
| salona-44-speedy-go | 3.0 / 2.1 | 41 | marstal | — |
| elan-444-piranja | 2.8 / 1.9 | 41 | marstal | — |
| salona-44-easy-go | 3.5 / 2.6 | 38 | faldsled, rudkoebing | augustenborg, marstal |

- Basis: connectivity to the Flensburg-fjord seed, not reachability from each probe origin.
- **Origin side.** Flensburg and Sønderborg are `ok` for every boat. Marstal as ORIGIN at the Salona 45's requested 3.0 m gate: the destination-free expansion died in 7 rings having stamped 11 cells (< 1 nm²). With one origin disc (`approachGate` at `relaxationFloorM` 2.1 m, radius 1852 m) it reached 2 655 nm² in 10 h. So a reach view needs an origin-disc posture for pocketed origins; for the Easy Go Marstal stays `unreachable` even with the disc.
- **Destination side.** No destination disc exists in a destination-free solve, so a `shallow-approach` harbour's last mile is never inside a requested-gate region. With the Salona 45 that is Marstal only; with Easy Go it is Faldsled and Rudkøbing, its Marstal and Augustenborg being `unreachable`.

### M5 — motor-on vs sail-only reach (Sønderborg genoa, 6 h, wind from 225°)

| config | area 6 h (nm²) |
|---|---|
| motor on, 12 kn (6 h-cap run `sonder-genoa-12-cap6`) | 1 228 |
| motor off, 12 kn | 1 284 |
| motor only (36 headings at 6.5 kn; probe-only baseline) | 1 065 |
| motor on, 6 kn | 832 |
| motor off, 6 kn | 696 |

- Motor-only reach tops out at 38.7 nm per sector, matching 6.5 kn x 6 h = 39 nm; it is the coastline-only baseline.
- Over the 25 sectors where motor-only reaches >= 10 nm, sector reach divided by the motor-only reach: motor on 12 kn 0.95–1.37 (6 h-cap run); motor off 12 kn 0.95–1.74; motor on 6 kn 0.0–1.0; motor off 6 kn 0.29–1.29. At 12 kn with motor on, no sector falls more than 5 % short of the coastline-only baseline; at 6 kn with motor on, 11 of the 25 sectors fall more than 10 % short.
- **Not a superset.** At 12 kn the motor-off area exceeds the motor-on area (1 284 vs 1 228 nm²; sectors 0° and 340–350° reach 31.5–32.9 nm motor off vs 18.4–25.6 nm motor on). At 6 kn motor on reached 0 nm in the 310° and 320° sectors where motor only reached 12.9 and 17.0 nm. The probe does not establish the cause; candidates in the code are the different confined prune divisors (2 vs 3) and dominance on `costMs`. The design cannot present the region as "everything the boat can reach"; it is what this search reaches.
- All rows above are 6 h-capped runs. The 10 h-capped `sonder-genoa-12` run read the same 6 h area (1 228 nm²) and identical sector maxima; the comfort-off run is used only as the M2 control.

### Infeasible or not measured
- Real (non-uniform) wind: not run. The committed `wind-sw12.json` ends 2026-07-22; uniform 12 kn and 6 kn fields were used, so gradient effects on the region are unmeasured.
- Tablet or reference-device timing: not measurable here; the timings above are this machine's.
- Per-harbour ETA from the region: not computed; the probe's cell map supports it (look up the harbour snap's prune cell).
- Only the Salona 45 was solved; M3 covers all boats by flood only.
