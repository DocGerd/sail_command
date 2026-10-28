# #1855 — Reachable area: "Erreichbar ab {Start}" in the Wetter tab

Status: design spike, not a spec. It ends in a recommendation; the maintainer rules on it (ruling on #1855, 2026-10-28). Implementation is v0.62.0 and needs #1854 slice 1 (sea-state raster, Wetter tab, hour store, "Als Abfahrt übernehmen") merged first. Promotion to a spec owes, as ask-gated main-session edits: a new spec section for the reach card, since no spec describes a destination-free solve; and a re-check of the spec rows #1854's status line lists (offline scope, the "only planning needs network" constraint, waves spec §0) against a compute that runs online only and hides the sea-state fill while shown. The maintainer decisions still open are in §16.

Code anchors use `file:symbol (~:line)`, paths relative to `app/src/` unless they start with `app/`, `docs/` or `.github/`. The probe ran at develop `32f67af0`; `git diff --stat 32f67af0..59abdbb4` over `app/src/routing/`, the mask, depth-gate, harbour-reachability, boat-depth, polar, wind and geo modules, `types.ts`, `data/boats.ts`, `test/fixtures.ts` and `app/public/data/` is empty, so its results transfer to `59abdbb4`, this document's base. Supporting files are in `1855-reachable-area/` (README there). `judges.json`, `critique.json` and `revision-log.md` hold the judges' scores, the critique's 27 findings and their dispositions; where the log and this document differ, this document is current.

## 0. Basis

- **Base: D1, "Minimal card".** Both judges ranked it first. Totals: judge 1 D1 7.2, D3 6.6, D2 6.0; judge 2 D1 7.4, D2 6.6, D3 5.6.
- **Dissent.** The judges disagree only on second place (D3 vs D2). That sets which runner-up the grafts come from, not the base.
- **Grafts, after the critique.** The critique outranks a judge wherever it cites code or `results.json`.

| Graft | Disposition | Decided by |
|---|---|---|
| J1 (1), J2 (d): both rigs, per-cell minimum, rig named | Deferred to R0 and §16 Q1. The engine runs one stepper per rig, so two rigs need no rewrite. | C9 |
| J1 (2), J2 (a)(b): stepper `reach.ts`, cooperative cancel, `drainedToMs` | Stepper and cancel adopted (§5.1, §6). `drainedToMs` is computed, but no copy promises streaming or "vollständig bis" until R0 measures the per-ring earliest frontier `tMs`. | C5, C10 |
| J1 (3), J2 (e): origin disc via `SEED_POINT` or `harborEndpointPocketed` | Narrowed to a three-way origin posture (§5.5). `harborEndpointPocketed` is declined: it is true only for `unreachable`. | C1, C4 |
| J1 (4): row fields from D3 | Adopted: ETA, arrival clock, wind at arrival, "Zufahrt flach", "nicht gefunden". "beide" only under a two-rig policy. No "ausgeschlossen" with `boat.harbors.unreachable` wording. | C4, C16 |
| J1 (5), J2 (f): arrival tests; R0 ETA comparison | Adopted, with a fallback and an R0 cost gate (§7.1). | C16 |
| J1 (6), J2 (a): own client | Adopted as `ReachClient` with a dedicated worker, plus a preemption rule (§6). | C8, C11 |
| J1 (7): keep sea state visible (outline or opt-in fill) | Declined as the default: the issue's draft acceptance asks for a shaded region. Fill on by default, sea state hidden while it shows, the depth hatch kept (§8). | C12, C14, C27 |
| J1 (8): repair D3's destination discs | Moot: no destination discs (§7.2). | C6 |
| J2 (c): source-scanning constant twin | Adopted (§5.9). | — |
| J2 (g): `reach.ts` in `classify-realmask.sh` | Adopted (§5.9). The judge's text is truncated after "classify-realm" (`judges.json`). | — |
| J1: defer bands and map taps | Adopted. | — |

- **Declined parts of the runners-up:** D2's time bands, open-water taps and stamping of every generated child (C8); D3's destination discs (C6), outline-only map (C12), in-card Start picker (the issue says reuse planner fields) and export commit to `isochrone.ts` (it owes a sweep).
- **Cost and fit, re-estimated (C3).** The judges' D1 cost and fit scores do not carry over. Added to D1: a dedicated worker with its own protocol and client and one more 9 438 000-byte mask copy; the stepper; mask-cell edge stamping with a bounded pixel flood; arrival tests; the origin classification and handover seed; an App-level harbour-tap route (§7.4); the R0 measurement gate. Removed: D1's `runBusy` exclusivity coupling. Estimated build size lies between D1 and D2 (an estimate, not measured). It still edits no #282 closure file and owes no sweep (§5.9).

## 1. Goal and non-goals

Goal: from the planner's Start, at a departure chosen on Wetter's hour row, the skipper sees the water one search reaches within a chosen duration, and the harbours inside it with approximate ETAs, then hands one harbour to the planner.

Non-goals:
- No time bands, no open-water tap, no popup line (a later slice, after #1854's popup slice).
- No change to `isochrone.ts`, `planRoute.ts`, `types.ts` or any other closure file.
- No IndexedDB write, no `DB_VERSION` bump, no `sw.ts` change.
- No multi-day reach (#1708) and no departure ranking (#936 stays with DepartureCompare).
- No claim that the region holds everything reachable (M5).

## 2. User flow

1. The skipper has a Start on Planen and opens Wetter. Below the conditions card sits the closed Disclosure **Erreichbar ab Flensburg** (no Start: **Erreichbarkeit**).
2. Opened, it shows the departure (the hour row's value), **Höchstdauer**, the assumptions line and **[Reichweite berechnen]**, the card's primary action; "Als Abfahrt übernehmen" demotes to secondary (#1854 §12).
3. Pressing it freezes the departure into the run. The card shows an indeterminate progress bar, "Suche bis +3 h 10" and **[Reichweitenberechnung abbrechen]**.
4. Done: the map shows one fill over reached water. The card shows the summary, the legend line, the notice and the harbour list sorted by ETA.
5. Scrubbing the hour row does not stale the result: it shows wind at other hours of the trip. The legend names the departure the fill was computed for.
6. A row's **[Als Ziel]** sets Ziel and the run's departure, switches to Planen and focuses `#planner-departure` (#1854 §11's rule with Ziel set). It does not plan.

## 3. Wireframe

```
820x1180 narrow — Wetter, reach card open, result (values illustrative)
+--------------------------------------------------------------+
| [hour row, sticky]  ◀  Sa 14:00  ▶                            |
| … conditions card (#1854) …                                   |
| ▾ Erreichbar ab Flensburg                                     |
|   Abfahrt Sa 14:00 · Höchstdauer [ 6 ] h                      |
|   Annahme: Genua · mit Motor · Tiefe ≥ 3,0 m                  |
|   [ Neu berechnen ]                     [ Reichweite ausblenden ]|
|   ■ In höchstens 6 h erreichbar ab Sa 14:00                   |
|   Planungshilfe aus der Vorhersage (abgerufen 13:52) …        |
|   Häfen nach Ankunft (12)                                     |
|   Sønderborg   ca. 3 h 40 · an 17:40 · SW 11 kn  [Als Ziel]   |
|   …                                                           |
|   Nur mit flacherer Ansteuerung (1)                           |
|   Marstal  Ansteuerung ca. 5 h 50 · Zufahrt flach  [Als Ziel] |
|   ▸ Nicht in 6 h gefunden (28)                                |
+--------------------------------------------------------------+
```

## 4. Inputs

- **Origin.** The planner's Start, snapped with `mask.snapToNavigable(p, gate)` as `planRoute` does. No Start: `reach.noStart` and **[Start im Planer wählen]**.
- **Departure.** The `state/conditionsHour.ts` value at press time, frozen into the request and shown from the result (C13).
- **Duration.** `NumberInput`, min 1 h, step 0.5, max = min(10 h, forecast left after departure), default 6 h, persisted with `lib/usePersistedNumber.ts`. The 10 h max is provisional until R0's tablet measurement (§16 Q7).
- **Not inputs.** Boat, sails aboard, gate, comfort margin and motor settings come from the planner; the assumptions line names them.

## 5. Compute: `routing/reach.ts`

### 5.1 Stepper
- Start from the probe's `reach()` (`1855-reachable-area/reach.probe.test.ts`): `solve()`'s ring loop without the destination terms. `dtS` fixed at 600 s; `sailCandidates` with `+beat` as `directTwa` (deduped); substep retry, `byKey` collapse, `visitedDominates`/`stampVisited` as in `solve()`.
- `createReach(params)` returns one stepper per rig; `step()` runs one ring. The worker yields between rings, which gives a message-based stop and lets one worker alternate rigs (D2 §5.1).
- An optional `towards` restores the direct-TWA candidate and distance tie-break, for the twin test only.

### 5.2 Cell map and stamping
- **Times.** Coarse prune lattice (0.002° × 0.003°) over the mask bounds: 650 × 734 cells (derived from `mask.meta.json`), `Uint16Array` minutes after departure rounded up, `0xFFFF` unreached. A cell holds the minimum true `tMs` of any stamp.
- **Survivor edges, not every child (C8).** Each surviving child stamps the cells its parent edge crosses, at linearly interpolated times. Generated children outnumber expanded nodes 33.0–34.1× in the 10 h configs (`childrenTotal`/`expandedTotal`), so stamping every child is declined.
- **Mask-cell trace (C7).** The same DDA marks the ~46 m mask cells each accepted edge crosses. The raster fills only at-gate pixels connected at the gate to such a marked cell, by a flood bounded to reached coarse cells and their neighbours. A mole inside one coarse cell then leaves the water behind it unfilled. Hole rate and cost are unmeasured (R0).

### 5.3 Run to drain; the final partial step
- The duration cap acts as the horizon. The run ends when no frontier node can take a step within the cap; no snapshot at the cap ring (M2).
- At the cap a child takes a partial step to exactly the cap and stamps its prefix; arrival tests use the remaining time (C18). The probe skipped this (`reach.probe.test.ts` ~:179, ~:255).

### 5.4 Finality and partial results
- A child is never earlier than its parent, so after each ring every cell at or before the earliest frontier `tMs` (`drainedToMs`) is final for this search (D2 §5.1).
- R0 records `drainedToMs` per ring before any copy relies on it (C5). M2 shows why: per-cell times dropped after their first ring by up to 6 525 000 ms (`flens-fock-12`), 6 300 000 ms (`marstal-genoa-12-disc`) and 7 350 000 ms (`sonder-genoa-12-motoroff`), about 105–123 min (C20).
- A stopped run (cancel, preemption, budget, frontier cap) keeps its map. Every stamped cell is reachable no later than its stamp; unstamped water may be reachable too. The card labels it `reach.partial` ("mindestens erreichbar") and its ETAs "ca., kann früher sein".

### 5.5 Origin posture (C1, C4)
- Classify the origin with `lib/harborReachability.ts:endpointStateAt` (~:363), exported for this; the file is NOT_IN_CLOSURE (§5.9). `harborAccessAt` (~:655) gives the same answer for a harbour Start but takes a `Harbor`, not a point. The three states:
  - `ok`: run at the requested gate.
  - `shallow-approach`: an origin `approachGate` at `relaxationFloorM(boat)`, radius `APPROACH_RADIUS_M` (1852 m). M3: Marstal at 3.0 m stamped 11 cells in 7 rings; with the disc it reached 2 655 nm² in 10 h.
  - `unreachable`: seed the run at `findHarborHandoverFor(mask, origin, boat, gate)` (~:570) with the `route.handover.origin` wording, as a plan from that Start does (#1721). No handover point: status `stranded`.
- Disc-only water (below the gate, at or above the floor) is drawn hatched, not in the fill colour (§8).
- Relaxed-depth copy states the cautious bound (`lib/mask.ts:cautiousDepthLowerBoundM`, 1.2 m for the Salona 45's 2.1 m floor) and the below-draft fact as `route.shallow.leadSevere` does, plus "Route planen zeigt die Flachwasserwarnung". It never presents the floor as water depth (C2).

### 5.6 Rig
- Default: one headsail by `state/useDepartureScan.ts:scanSailIdsFor` (genoa when aboard), named in the assumptions line; the [Als Ziel] plan solves every aboard rig.
- The rig gap is mark-dependent (§13 M4), so the two-rig option waits for R0's per-harbour ETA comparison by rig (§16 Q1).

### 5.7 Motor, gate, comfort
- `Settings` pass through: `motorEnabled`, the sail-speed floor, `maneuverPenaltyS`, `performanceFactor`, `safetyDepthM`. No motor toggle in the card.
- Comfort as `planRoute`'s tier 1: `comfortDepthM` = gate + `depthComfortMarginM`. Dominance ranks on `costMs`; stamps record true `tMs`.
- No tier-2 retry and no destination relaxation: those need a destination.
- Copy never says "alles Erreichbare": M5 shows motor-off reaching more than motor-on at 12 kn.

### 5.8 Budget and horizon
- Deadline checked between rings and every `DEADLINE_CHECK_NODES` nodes. Until R0, `REACH_BUDGET_MS` = `PLAN_BUDGET_MS` (360 000); whether it should be shorter is §16 Q8.
- Cap = min(departure + duration, `WindField.horizonMs()`); the result carries `effectiveDurationMs`.

### 5.9 Mirrored internals and the #282 sweep
- `pruneKey`, `better`, the prune and confinement constants and `MIN_SAIL_KN` are module-private in `isochrone.ts`; `reach.ts` mirrors them.
- Two guards pin the mirror: a source-scanning twin over `isochrone.ts` (`test/sourceStrip.ts` with `assertNonVacuousStrip`), and the behaviour twin (`towards` mode equals `solve()`'s per-ring frontier sizes; the probe's fidelity control matched over 12 rings).
- `closure.mjs files` at `59abdbb4`: `routing/reach.ts`, `protocol.ts`, `workerClient.ts`, `lib/harborReachability.ts` NOT_IN_CLOSURE; `isochrone.ts`, `lib/depthGate.ts` IN_CLOSURE. `reach.ts` imports from them and edits neither, so no sweep is owed. Each PR confirms with `closure.mjs diff <merge-base> <head>`.
- `classify-realmask.sh`'s supplement gains `app/src/routing/reach.ts`. Without it, the script's drift check, which runs independent of the diff, sees a realmask test importing a file outside both the closure and the supplement and runs the realmask suite on every PR.

## 6. Worker, client, cancel, preemption

- **Dedicated worker.** `routing/reachWorker.ts`, `reachProtocol.ts`, `reachClient.ts`. Spawned lazily on the first press; disposed when Wetter is left with no run in flight. Cost: one mask copy (9 438 000 bytes) plus polars, and the visited map per rig (428 002–708 160 keys in the 10 h probe runs).
- **Protocol.** `init`; `reach` (origin posture, departure, cap, settings, boat, rigs, wind grid cloned, never transferred); `stop`. Responses: `progress` (search time reached, phase), `result` (cell buffers transferred), `failed` (typed kinds).
- **Cancel (C10).** [Abbrechen] posts `stop`; the worker returns its partial map at the next yield, latency one ring. Leaving Wetter does not stop a run.
- **Preemption (C11).** Starting a plan, recalc, departure scan or confirm, via replan or Live reroute posts `stop`; the partial is kept. A reach never delays or cancels a planning request. While one runs, the compute button is `aria-disabled` with `reach.busy`.
- **Wind.** Past `GRID_CACHE_TTL_MS` the press goes through #1854's manual refresh path first; the run uses the held grid.
- `planLog` start/finish/stop lines without coordinates, as plans log.

## 7. Harbour list and handoff

### 7.1 ETAs (C16)
- Each `ok` harbour is an arrival target: a direct hop when the target is within one step of a node, and capture within `CAPTURE_NM` (0.1 nm), both validated by `edgeFactor`, as `solve()` does (D3 §5.2).
- Fallback, if R0 finds the tests too costly: the nearest marked mask cell within one step of the snap and connected to it at the gate, shown "ca.".
- A harbour with neither goes to **Nicht in {duration} gefunden**, never dropped silently.
- R0 compares reach ETAs with `planRoute` ETAs on ~10 harbour pairs and sets the rounding; until then "ca." and rounding up to 10 min.

### 7.2 Depth-limited harbours (C4, C6, C19)
- No destination discs in the search.
- `shallow-approach` (Salona 45: Marstal; EASY GO!: also Faldsled, Rudkøbing; M3): **Nur mit flacherer Ansteuerung**, ETA from reached cells inside the disc that `cellsConnected` links to the snap under an `approachGate` at `relaxationFloorM`; copy per §5.5 (C2).
- `unreachable` at the gate: same group, ETA to the `findHarborHandoverFor` point, with the `route.handover.destination` wording. The planner routes these (`realmask.repro.harborHandover.test.ts`), so the card never calls them unreachable.
- `known-disconnected`: omitted, with a count line.
- The origin harbour is not listed.

### 7.3 Rows
- Name, "ca." ETA, arrival clock, wind at arrival (held grid at the snap and ETA), chip "Zufahrt flach" in the approach group, [Als Ziel] (≥ 44 px). Rig per row only under a two-rig policy ("beide" within `RIG_TIE_BAND_MS`).
- Sort by ETA, then name.
- [Als Ziel]: `handlePickDestination`, `setDepartureMs(result.departureMs)`, `handleTabChange('plan')`, focus `#planner-departure`, announce `reach.handoff.done` (C26). Offline, `reach.handoff.offline` sits beside it (C25).

### 7.4 Harbour taps before the popup slice (C15)
- While a reach result is shown on Wetter, a harbour tap selects that harbour's row and scrolls it into view; it never edits Start or Ziel. Otherwise taps behave as #1854 slice 1 leaves them. One App-level branch in `handleHarborPick`; pinned by e2e.

## 8. Map rendering

- **Layer.** `ReachLayer.tsx`, canvas source `sc-reach`, raster layer `sc-reach-fill`, `raster-resampling: 'nearest'`, #1854 §5 geometry, `installStyleSetup`.
- **Fill on by default (C12).** One `REACH_FILL_COLOR` in `lib/mapColors.ts`. Disc-only water is hatched in the same raster.
- **Contrast (C17).** The verify pass measures ≥ 3:1 between filled and unfilled water in both themes; if it fails, a vector outline layer is added (never canvas pixels, #1854 §15).
- **Order.** Explicit `beforeId` above the sea-state fill. `sc-depth-hatch` stays visible above `sc-reach-fill` (C14). #1854 §6's `suppressDepth` term hides both depth layers and is keyed on sea state being visible, which the fill hides; so DataLayers gains its own `reachVisible` term that hides `sc-depth` only. `layerOrder.test.tsx` gains rows. Inside an origin disc the reach raster's hatch and the #492 hatch can cover the same cells; the verify pass checks that both stay legible.
- **Sea state.** Hidden while the fill shows; the "Seegang anzeigen" checkbox shows a suppressed state with `reach.suppressed`, and [Reichweite ausblenden] is the control (C27). Barbs stay.
- **Stale.** Start, duration, boat, sails, settings or grid change: fill hidden, rows greyed with `reach.stale` and [Neu berechnen]. Hour scrubbing does not stale (§4).
- Off Wetter the fill is hidden; the result stays in memory for the session.

## 9. States

| State | Card | Map |
|---|---|---|
| No Start | `reach.noStart` + [Start im Planer wählen] | — |
| No wind grid held | skeleton; button `aria-disabled` with reason | — |
| Ready | inputs, assumptions, [Reichweite berechnen] | — |
| Busy (plan, recalc, scan, replan, Live reroute) | `reach.busy` | — |
| Computing | indeterminate bar, `reach.progress` / `.drain`, [Abbrechen] | — |
| Stopped (cancel, preemption, budget, frontier cap) | `reach.partial` above the lists | fill |
| Done | summary, legend, notice, lists | fill |
| Origin relaxed / handover | `reach.originRelaxed` / `reach.originHandover` | fill, disc hatched |
| Stranded | `reach.stranded` | — |
| No harbour in range | `reach.list.none` | fill |
| Short horizon | `reach.horizon.short` | fill |
| < 1 h forecast left | `reach.horizon.none` | — |
| Stale | `reach.stale`, rows greyed | hidden |
| Offline, nothing computed | `reach.offline` | — |
| Offline, result held | result with `reach.ageLine`; `reach.offline` by the button | fill |
| Worker failure | typed key via `ROUTING_FAILURE_MESSAGE_KEY` | — |

A press on an `aria-disabled` button announces its reason (C23).

## 10. Offline posture

- Recommended reading of the #1854 §11 ruling: a reach compute is planning (a solver run whose ETAs feed a plan), so it runs online only, on a grid within `GRID_CACHE_TTL_MS`.
- A result computed online stays visible offline with its forecast fetch time: display, not planning.
- #1854 §12's "it computes in the worker, so it can work offline" predates the ruling; amending it is §16 Q4.

## 11. Accessibility and the 820 px floor

- Targets ≥ 44 px: summary, NumberInput, compute/cancel, hide/show, every [Als Ziel], every row.
- Lists are `<ul>`s under headings; [Als Ziel]'s accessible name starts with its visible text. The fill is not keyboard-reachable; the list and summary are the keyboard and screen-reader path.
- The polite region announces start, done, stopped, partial and the handoff; progress ticks are not announced.
- Focus never moves on a result. The Disclosure summary gets `scroll-margin-top` equal to the sticky hour row (C24), pinned by a geometry check at 820×1180 with and without a toast.
- Tokens only (`--sc-*`), `.reach-*` rules; colour is never the only carrier.
- Name collisions: role-scoped locators with `exact: true`; "Als Ziel" will meet #1854's later popup button; check both languages (CLAUDE.md `getByRole` rule).

## 12. Copy (de / en, `satisfies` parity; selection)

| Key | DE | EN |
|---|---|---|
| reach.title | Erreichbar ab {start} | Reachable from {start} |
| reach.assumes | Annahme: {sail} die ganze Fahrt · {motor} · Tiefe ≥ {gate} | Assumes {sail} all the way · {motor} · depth ≥ {gate} |
| reach.progress | Suche bis +{elapsed} … | Searched to +{elapsed} … |
| reach.progress.drain | Ergebnis wird abgeschlossen … | Finishing the result … |
| reach.legend | In höchstens {duration} erreichbar ab {datetime} | Reachable within {duration} from {datetime} |
| reach.notice | Planungshilfe aus der Vorhersage (abgerufen {time}). Gezeigt ist, was diese Suche findet, nicht jede mögliche Fahrt; „Route planen“ kann abweichen. | Planning aid from the forecast (fetched {time}). It shows what this search finds, not every possible passage; "Plan route" may differ. |
| reach.partial | Berechnung beendet bei +{elapsed}. Gezeigtes Wasser ist mindestens erreichbar, Zeiten können früher sein; weiteres Wasser vielleicht auch. | Stopped at +{elapsed}. The water shown is reachable at least, times may be earlier; more water may be too. |
| reach.originRelaxed | Ausfahrt aus {start}: Innerhalb 1 sm nutzt die Suche Wasser unter der Sicherheitstiefe {gate}; dort kann es flacher als {cautious} sein, unter dem Tiefgang. „Route planen“ zeigt dafür die Flachwasserwarnung. | Leaving {start}: within 1 nm the search uses water below the safety depth {gate}; it may be shallower than {cautious}, below the draft. "Plan route" shows the shallow-water warning for it. |
| reach.list.approach | Ansteuerung in ca. {duration}; die Zufahrt ist flacher als {gate} und nicht eingerechnet. | Approach in about {duration}; the entrance is shallower than {gate} and not counted. |
| reach.list.notFound | Nicht in {duration} gefunden | Not found within {duration} |
| reach.busy | Eine Routenberechnung läuft gerade. | A route calculation is running. |
| reach.offline | Offline: Die Reichweite braucht eine aktuelle Vorhersage, wie die Routenplanung. | Offline: the reachable area needs a current forecast, like route planning. |
| reach.stale | Berechnet für Abfahrt {datetime}, {duration}; die Eingaben haben sich geändert. | Calculated for departure {datetime}, {duration}; the inputs have changed. |
| reach.suppressed | Seegang ist ausgeblendet, solange die Reichweite angezeigt wird. | Sea state is hidden while the reachable area is shown. |

The other keys follow D1 §14 with these changes. `reach.originHandover` and the handover rows reuse the `route.handover.*` wording. Depth figures go through the planner's depth formatter, times through `formatDuration`/`formatTime`/`formatDateTime`. Changelog fragment `changelog.d/1855.added.md`.

## 13. Measurements

Configuration: probe `1855-reachable-area/reach.probe.test.ts` with its own `vitest.config.ts`, at `32f67af0`, committed mask, harbours and Salona 45 polars, `DEFAULT_SETTINGS` (gate 3.0 m, comfort depth 5.0 m, motor on, 6.5 kn) unless noted, uniform wind from 225° (`uniformWindGrid`, 48 h), departure at grid start. Area unit: coarse prune cells holding the minimum true `tMs`. Wall times: one thread on one WSL machine (32 logical cores), loadavg 2.1–2.4 with another session's solver test running; not tablet figures and not a planning basis. Raw data: `results.json`; summary: `grounding.md` §4.

- **Fidelity.** With `towards` = Marstal, `reach()` frontier sizes equal `solve()`'s `onProgress` sizes over 12 rings from Flensburg (`fidelity.identical: true`).
- **M1, cost to drain at 10 h (12 kn).**

| config | nodes expanded at 6 h / 10 h | peak frontier | wall at 6 h / 10 h / drained |
|---|---|---|---|
| `flens-genoa-12` | 251 882 / 1 625 796 | 67 372 | 8.1 / 56.9 / 63.8 s |
| `flens-fock-12` | 217 379 / 1 477 138 | 64 015 | 6.8 / 49.8 / 57.6 s |
| `sonder-genoa-12` | 671 203 / 1 285 924 | 40 629 | 22.3 / 42.7 / 54.3 s |
| `sonder-fock-12` | 696 656 / 1 360 501 | 43 041 | 22.2 / 43.9 / 56.4 s |
| `marstal-genoa-12-disc` | 1 194 360 / 2 344 632 | 73 338 | 39.9 / 78.9 / 89.6 s |

  No ring was truncated (`defaultMaxFrontier` 95 333). Draining added 13–30 % to the nodes expanded at the 10 h ring. Two rigs alternating on one worker would take about twice the single-rig drain, 109–179 s on this machine (derived, not run).
- **M2, ring snapshots are not final.** The final ≤ 6 h set exceeds the ring-36 snapshot by 9.8 % (`flens-genoa-12`), 24.9 % (`flens-fock-12`) and 9.3 % (`marstal-genoa-12-disc`), and by 0.2 % and 4.0 % on two Sønderborg configs (C21). Ring 12 had stamped 1 082 of the 1 268 cells final ≤ 2 h in `flens-genoa-12`. Late lowering maxima are in §5.4.
- **M3, harbour access per boat** (`computeHarborAccess`, `SEED_POINT` flood, 47 harbours, 5 known-disconnected): Salona 45, Speedy Go and Elan 444: 41 `ok`, Marstal `shallow-approach`; EASY GO! (gate 3.5 m): 38 `ok`, Faldsled and Rudkøbing `shallow-approach`, Augustenborg and Marstal `unreachable`. Marstal as Salona 45 origin: 11 cells without a disc, 2 655 nm² in 10 h with one.
- **M4, rig gap per mark (area, nm², genoa / fock).** Flensburg: 2 h 16/15, 4 h 89/88, 6 h 429/478, 10 h 1623/1623. Sønderborg: 6 h 1228/1219, 10 h 2180/2163. The fock run lowered 8 212 cells by more than 30 min after their first ring against 0 for the genoa, so the Flensburg 6 h gap may be search behaviour rather than rig (C9).
- **M5, motor (Sønderborg genoa, 6 h, nm²).** Motor on 12 kn 1 228; motor off 12 kn 1 284; motor only 1 065; motor on 6 kn 832; motor off 6 kn 696. Not a superset: at 6 kn motor on reached 0 nm in two sectors where motor only reached 12.9 and 17.0 nm.
- **Not measured:** non-uniform wind; tablet time and heap; hole rate of node vs edge stamping; arrival-test cost; reach ETAs vs plan ETAs; per-ring earliest frontier `tMs`. R0 covers all but real wind, which needs a current fixture.

## 14. Testing

- **`routing/reach.test.ts` (synthetic masks):** behaviour twin vs `solve()` (rings ≥ 5 nm from `towards`, a confined channel so finer keys are exercised, mutation on `CONFINED_PRUNE_DIV`); source-scanning constant twin; open-water motor-only radius; land wall and sub-gate shoal; drain vs cap-ring snapshot (positive control); final partial step reaches the cap; edge trace leaves no hole in uniform open water; mole inside one coarse cell stays unfilled (C7); origin posture ok / disc / handover / stranded; stop mid-run returns a non-empty partial with every stamp ≤ cap; horizon clamp. Budgets via `test/timeouts.ts`.
- **`routing/realmask.repro.reach.test.ts`:** 12-ring Flensburg twin on the committed mask; a 2 h Flensburg reach whose marked cells are all at-gate water; Marstal origin takes the disc; an EASY GO! Marstal origin seeds at its handover point.
- **Harbours:** every `harbors.json` entry for every catalogue boat lands in exactly one group; a harbour in an unstamped cell beside reached water is found or listed as not found (C16); approach ETA ignores reached water across land inside the disc (C19).
- **Worker and client:** round trip with transfer; stop returns partial; preemption by each planning entry point; budget; `planLog` lines.
- **UI:** every §9 state; stale on each input but not on hour scrubbing; `aria-disabled` reasons; StrictMode render for the hook; layer order and hatch visibility with a per-file size-discriminated `getContext` fake; harbour tap selects a row; handoff focus.
- **e2e `reach.spec.ts`:** `?windFixture=` + `?waveFixture=`, 2 h duration, `STANDARD_VIEWPORTS` ≥ 820 px, both themes: compute, stop, [Als Ziel], offline note, harbour tap selects row, summary not under the sticky row.
- **Verify pass:** 820×1180 and 1180×820, both themes, fill contrast ≥ 3:1, a Marstal run showing the hatched disc, screenshots for the PR.

## 15. Considered and rejected

- **D2 "Map-first bands"** as base: time bands, open-water taps with a readout, two rigs streamed. Rejected as base on cost and on its dependence on #1854's deferred popup and map-click owner; its stepper, own client and constant twin are grafted.
- **D3 "Erreichbare Häfen"** as base: list-first with a vector outline and no fill. Rejected as base: the issue's acceptance asks for a shaded region, its destination discs relax the gate for every path through them (C6), and it owes a sweep for its export commit. Its arrival tests, rows and R0 ETA gate are grafted.
- **Time bands.** Ring-index bands are wrong by the M2 amounts; bands from final times add a third area colour scale. Later slice at most.
- **Snapshot at the cap ring; discarding a stopped run as `solve()` does.** M2; a stopped map is a truthful lower bound.
- **Stamping every generated child.** 33–34× the edges of survivor stamping (§5.2).
- **`harborEndpointPocketed` or a "stamps within 1852 m" test as the disc trigger.** The first is false for Marstal's `shallow-approach` origin (C1); the second misses a pocket wider than the disc.
- **An always-on origin disc.** Lowers the gate near every origin, which a plan does only after a failed tier.
- **Destination discs in the shared search.** They relax the gate for every path through them and re-anchor `edgeFactor`'s comfort ramp at the floor (C6).
- **Reach on the shared `RoutingClient`.** Its `cancel()` terminates every request, Live reroute included.
- **Exporting `pruneKey`/`better` or a destination-free mode in `solve()`.** Edits a closure file and owes a sweep.
- **Outline-only map, or a fill hidden by default.** Fails the draft acceptance (C12).
- **Hiding the depth hatch with the fill.** The hatch is what discloses the accepted mask optimism (#455/#492; C14).
- **Binding the result to the hour row.** Scrubbing, Wetter's main interaction, would stale it at once (C13).
- **A progress fraction on the ring clock.** `flens-genoa-12` reached its 6 h mark at 8.1 s of 63.8 s (C22).
- **Disabled buttons without feedback.** #1854 §15 rejected them on touch (C23).
- **Calling a pocketed harbour "unreachable".** The planner routes it via a #1721 handover (C4).
- **Offline compute from the held Wetter grid.** Conflicts with the #1854 §11 ruling as read here (§10).
- **Hull, smoothing or neighbour fill; auto-plan on [Als Ziel]; a map legend; persisting the result; a sail selector; an in-card Start picker.** As D1 §20 and D3 §19.

## 16. Open questions for the maintainer

1. **Rig policy.** Recommend one rig by `scanSailIdsFor`, named, with the two-rig plan at handoff. Switch to both rigs (per-cell minimum, rig per row, alternating steppers) if R0 shows per-harbour ETAs differ by rig beyond the chosen rounding and the tablet time allows.
2. **Motor.** Recommend following the planner's settings with no card toggle, stated in the assumptions line.
3. **Budget-exhausted and stopped runs.** Recommend showing the partial map and list labelled "mindestens erreichbar", never discarding it.
4. **Offline posture.** Recommend: reach counts as planning, so no offline compute; a held result stays visible with its age; [Als Ziel] shows an offline note; #1854 §12's "can work offline" sentence is amended.
5. **Depth-relaxation harbours and origins.** Recommend no destination discs; shallow-approach harbours in an approach group with ETA to the approach; pocketed harbours with ETA to their handover point and #1721 wording; origin posture by access state (no disc / disc / handover seed).
6. **Compute placement and sweep.** Recommend a dedicated reach worker with `ReachClient`, mirrored internals pinned by two twins, no closure edit, no sweep. Alternatives: the shared ladder worker (no extra mask copy, but exclusivity rules and teardown risk), or an export commit to `isochrone.ts` (owes one sweep).
7. **Maximum duration.** Recommend 10 h provisionally, fixed after R0's tablet run.
8. **Reach budget.** Recommend `PLAN_BUDGET_MS` until R0, then a reach-specific budget from the tablet measurement, since a partial is truthful and a long wait on an exploratory card is a UX cost.
9. **Harbour taps before the popup slice.** Recommend: with a reach result on Wetter, a harbour tap selects its row and never edits the planner.

## 17. Implementation slicing (v0.62.0, every PR `Refs #1855`)

- **R0 — measurement gate (probe extension, no product code).** Per-ring `drainedToMs`; hole rate of node vs edge stamping and pixel-flood cost; arrival-test cost; reach vs `planRoute` ETAs on ~10 harbour pairs, per rig; tablet wall time and heap for one and two rigs at 6 h and 10 h. Decides Q1, Q7, Q8 and the ETA rounding.
- **R1 — `routing/reach.ts` and tests,** plus the `classify-realmask.sh` supplement entry.
- **R2 — reach worker, protocol, client,** stop, preemption hooks, budget, `planLog`.
- **R3 — card, layer, list, handoff, harbour-tap branch,** copy, changelog fragment, e2e, verify-pass screenshots.
- **Cut order if R3 runs long:** wind at arrival, then the approach and handover group (omitted with a count line), then duration persistence.

## 18. Answers to #1854 §12

- **One region or bands:** one region (§8); bands rejected (§15).
- **Inputs:** Start from the planner, departure from the hour row frozen at press time, Höchstdauer as a `NumberInput` (§4).
- **Which sail plan:** one rig by `scanSailIdsFor`, named; two rigs open (§5.6, §16 Q1).
- **Progress and cancel:** search-time progress; cooperative `stop` on a dedicated worker, so no `terminate()` (§6).
- **Budget-exhausted and partial:** the map and list kept, labelled "mindestens erreichbar" (§5.4).
- **Fill vs sea-state fill:** the reach fill hides the sea-state fill while shown, with a hide/show control; the depth hatch stays (§8).
- **Popup line "reachable in ~3 h 40":** a later slice, after #1854's popup slice.
- **Tab name:** "Wetter" stays; this card does not change it.
- **Departures from §12:** no offline compute, against §12's "can work offline" (§10, §16 Q4); the harbour popup and [Als Start]/[Als Ziel] are not shared after #1854 slice 1, so the list's [Als Ziel] and a row-selecting harbour tap stand in (§7.3, §7.4).
