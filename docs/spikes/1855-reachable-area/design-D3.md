# #1855 candidate design D3 — "Erreichbare Häfen" (harbour-list-first)

Status: candidate design D3 for the #1855 spike, written at develop `32f67af0`. It is one of three candidates for judging, not a recommendation. Code anchors use `file:symbol` and refer to `32f67af0`; paths are under `app/src/` unless they start with `app/` or `docs/`. Measured figures come from the spike's probe (`/tmp/s1855/probe/results.json`, summarised in `/tmp/s1855/grounding.md` §4, "M1"–"M5"). Their basis is one WSL machine, uniform wind from 225°, the Salona 45 and `DEFAULT_SETTINGS`. No tablet figure exists. Pixel figures marked "measured" are #1854's measurements (`docs/spikes/1854-forecast-view-ux.md` §3); the rest are estimates and are marked so.

## 0. Angle

The skipper's question is "where can I go today, and roughly when do I arrive?". The answer is a short list of named harbours, so the list is the primary output. Each row carries an approximate arrival, the rig, wind at arrival and any depth flag. The reachable water is drawn only as a faint outline, for orientation. The design is built for the 820 CSS px narrow sheet, where a list reads better than a map region the skipper must pan to see.

## 1. Goal and non-goals

Goal: from a Start, a departure hour and a time limit, list the catalogue harbours this search reaches within the limit, under the forecast, for the boat's sails. One row hands a harbour to the planner as Ziel.

Non-goals:
- No plan is created by the card. Only **Route planen** on Planen plans (as #1854 §2).
- No graded time bands on the map (§19).
- No claim that the list holds every reachable harbour: M5 shows the search is not monotone in its inputs.
- No offline computation (§9).
- No change to `solve()`, `planRoute()` or the #1721 handover wrapper.

## 2. User flow

1. The skipper opens **Wetter**. Under the "Wind und Seegang" card sits the Disclosure **Erreichbare Häfen ab {Start}**, closed (#1854 §12). Without a Start it reads **Erreichbare Häfen**.
2. Opening it shows three inputs: Start, Abfahrt and Zeitlimit (§4). Abfahrt is the card's hour from `state/conditionsHour.ts`. While the Disclosure is open, **Häfen suchen** is the card's primary action, and #1854's **Als Abfahrt übernehmen** is styled secondary (#1854 §12).
3. Pressing **Häfen suchen** starts the computation in a worker. A progress line shows search time reached and harbours found. Rows appear as harbours are found, marked "vorläufig". **Suche abbrechen** stops it.
4. On completion the rows are sorted once by arrival and the outline is drawn. The polite region announces the count.
5. A row's **Route dorthin** button writes Start, Ziel and Abfahrt into the planner, switches to Planen and moves focus to **Route planen**. It does not plan. Selecting a row (tapping its body) highlights that harbour on the map.
6. Changing the hour, the Start, the limit, the boat or a routing setting marks the result stale. The list stays, greyed, with "Gilt für Abfahrt Sa 14:00 – neu suchen". Nothing recomputes on its own.

## 3. Wireframes (ASCII; values illustrative)

```
820x1180 — Wetter, reach Disclosure open, search complete (narrow sheet; design floor)
y0    +--------------------------------------------------------------+
      | SailCommand                                      [EN] [i]    | header T3
y61   +--------------------------------------------------------------+
      |[> Anzeigeoptionen]    \_   \_    barbs, sea state (unchanged) | .map-stack-tl T2
      |(N)       . - - - - - - - - - .   faint reach outline (vector) |
      |        .   (o)Sonderburg       .  ring = reachable harbour    |
      |      .  o Flensburg(Start)  (O)Aabenraa  <- selected: thick   |
      |        ' - - - - - - - - - - '                               |
      |[2 sm]                                                         | scale bar
y531  +==== Planen | *Wetter* | Routen | Live | Boot ================+ tabs T3 (y measured on Planen)
      | [«] [<]          Sa 14:00 (in 23 h)          [>] [»]         | sticky hour row (#1854)
      | ... Wind und Seegang card (scrolled above) ...               |
      | [v Erreichbare Häfen ab Flensburg]                           |
      | Start [Flensburg        v]  Zeitlimit [ 6 ] h  [Häfen suchen]| primary while open
      | Abfahrt Sa 14:00 (Stunde oben) · Salona 45 · Tiefe 3,0 m     |
      |   (+2,0 m Komfort) · Motor an, 6,5 kn          [Einstellungen]|
      | 9 Häfen in 6 h gefunden · Genua schneller bei 7              |
      | 1 Sonderburg        2 h 50 · an 16:50 · Genua · SW 13 kn     |
      |                                          [Route dorthin]     |
      | 2 Aabenraa          4 h 10 · an 18:10 · beide · SW 12 kn  *  |
      |                                          [Route dorthin]     |
      | 3 Marstal  [Zufahrt flach]  5 h 30 bis 1 sm vor dem Hafen …  |
      | [> Nicht in 6 h gefunden (31) · ausgeschlossen (5)]          |
      | Planungshilfe aus der Vorhersage: Häfen, die diese Suche     |
      |   erreicht. Kein vollständiges Verzeichnis.                  |
y1180 +--------------------------------------------------------------+
  * = selected row (3 px --sc-accent border, aria-current)

820x1180 — computing
      | Start [Flensburg v]  Zeitlimit [ 6 ] h   [Suche abbrechen]   |
      | Suche läuft … 3 h 10 von 6 h · 4 Häfen bisher                |
      | [=============>                    ]   (role=progressbar)    |
      | 1 Sonderburg   ca. 2 h 50 · vorläufig      [Route dorthin]   |
      | …                                                            |

1180x820 — wide, panel 390 px (rows stack to two lines)
+-- panel 390 -----------------++----------- map 779 --------------------+
| [v Erreichbare Häfen ab Flens.]||   outline + rings, sea state stays     |
| Start [Flensburg        v]   ||                                         |
| Zeitlimit [ 6 ] h            ||                                         |
| [ Häfen suchen ]             ||                                         |
| Abfahrt Sa 14:00 · Salona 45 ||                                         |
|   · 3,0 m (+2,0) · Motor an  ||                                         |
| 1 Sonderburg                 ||                                         |
|   2 h 50 · an 16:50 · Genua  ||                                         |
|   SW 13 kn   [Route dorthin] ||                                         |
| …                            ||                                         |
+------------------------------++-----------------------------------------+
```

Row content, in this visible order: rank, harbour name, flag chips, duration, "an {clock}", rig ("Genua", "Fock" or "beide"), wind at arrival, **Route dorthin**. The other rig's duration is in the row's sr-only text and in an expanded detail on tap ("Fock 3 h 05").

## 4. Inputs and defaults

| Input | Control | Default | Rule |
|---|---|---|---|
| Start | `HarborPicker`, in the card | the planner's Start (harbour or point) | Editing it here does not write the planner; only **Route dorthin** does. Slice 1 of #1854 has no harbour popup, so the card needs its own picker. |
| Abfahrt | read-only line, bound to `conditionsHour` | the card's hour | Changed with the sticky hour row. Seeded as in #1854 §4. |
| Zeitlimit | `NumberInput`, hours | 6 | Range 1–10, step 0.5. 10 h is the longest limit the probe measured (M1). Clamped to the forecast left after Abfahrt (`WindField.horizonMs`); a clamp shows `reach.limit.clamped`. |
| Boat, depth, comfort, motor | summary line with [Einstellungen] → Boot tab | current settings | Not editable in the card. |
| Sails | none | the planner's `sailIds` | Same set a plan would solve. |

Why 6 h: the probe's 6 h fronts took 6.8–39.9 s per rig here, and 10 h drained runs took 54.3–89.6 s (M1). The default is the cheaper measured mark; tablet cost is unknown (§17 R0).

## 5. Compute

### 5.1 Placement: new `routing/reach.ts`

- A destination-free ring loop, as the probe's `reach()`: `dtS` 600 s, no direct-TWA candidate, the limit acting as the horizon, and the loop run until the frontier drains. M2 shows a cell's arrival time is not final when its ring completes, so a snapshot at the limit ring is wrong; draining is required.
- It reuses `isochrone.ts`'s exports (`sailCandidates`, `edgeFactor`, `pruneCellConfined`, `visitedDominates`, `stampVisited`, `defaultMaxFrontier`, `DEADLINE_CHECK_NODES`, `backtrack`).
- It also needs `pruneKey`, `better`, `FORCED_MOTOR_HEADINGS` and the prune and confinement constants, which are not exported. Recommended: one export-only commit to `isochrone.ts`. It is in the #282 closure, so the commit owes one sweep; the prediction, posted before the run, is byte-identical artifacts on every arm. The alternative is to copy them into `reach.ts`; that adds a second copy of constants a future solver change must keep in step, which only a test reading both could catch.
- **Differential test (required either way).** The probe's fidelity control becomes a pinned test: `reach()` given a `towards` point restores the direct-TWA candidate and the distance tie-break, and its per-ring frontier sizes must equal `solve()`'s `onProgress` sizes over 12 rings from Flensburg towards Marstal on the real mask. The probe measured them identical.
- Rejected: refactoring `solve()` to expose its front (§19).
- `reach.ts`, `protocol.ts` and `workerClient.ts` are NOT_IN_CLOSURE (`closure.mjs files` at `32f67af0`), so after the export commit the feature owes no further sweep. Confirm with `closure.mjs diff` before each merge.

### 5.2 Harbour arrivals

A cell lookup at the harbour's snap point is rejected (§19). Instead every listed harbour is an arrival target inside the loop, mirroring `solve()`'s two arrival tests:
- **Direct arrival.** For each expanded node with a target within one step's distance at the node's best speed, evaluate a hop on the bearing to the target: TWA from that bearing, speed from `polar.speedKnAt` with the sail-speed floor rule, the maneuver penalty if the board changes, and `edgeFactor(mask, from, target, gate, comfortDepthM)` non-null. Arrival time is `node.tMs` plus that hop's true time, as `solve()` computes it.
- **Endpoint capture.** A child within `CAPTURE_NM` (0.1 nm) of a target, validated by `edgeFactor`, as `solve()` does.
- Per target and rig, keep the arrival with the lowest `costMs` and report its true `etaMs`, as `solve()` ranks `best`. Arrivals can only improve during the drain.
- A spatial bucket over the targets keeps the per-node test to a few candidates. The cost of this test was not measured; R0 measures it.

These ETAs are this search's arrivals, not plan ETAs: the search has no per-target direct-TWA candidate in its heading set, a fixed 600 s step (`solve()` shortens to 150/300 s near the destination), no #53 tiers, no postprocess, and dominance on `costMs`. The card says "ca." and the row hands over to a real plan. R0 compares reach ETAs to `planRoute` ETAs; the displayed rounding follows that measurement, and no tolerance is set here.

### 5.3 Depth gate, relaxation and pocketed ends

- **Pre-classification.** `computeHarborAccess(mask, harbors, boat, gate)` (`lib/harborReachability.ts`) sorts the catalogue for the current boat. `known-disconnected` and `unreachable` harbours are not targets; they are listed under "ausgeschlossen" with the existing `boat.harbors.unreachable` wording. For the Salona 45 that leaves 41 `ok` and Marstal as `shallow-approach` (M3); for the Salona 44 Easy Go, Faldsled and Rudkøbing are `shallow-approach`, and Augustenborg and Marstal `unreachable`.
- **Shallow-approach targets.** M3: a destination-free solve has no destination disc, so these harbours are never reached at the requested gate. The search uses one `approachGate` (`lib/depthGate.ts`) with a disc of `APPROACH_RADIUS_M` (1852 m) at `relaxationFloorM(boat)` around each such harbour. `ApproachGate.discs` is an array, and `gateAtCell` takes the deepest gate where discs overlap. The row carries the chip **Zufahrt flach** and the detail "Zufahrt nur mit gelockerter Tiefe (bis {floor} m), wie es die Routenplanung tut". The planner relaxes only as far as needed (`findRelaxedGate`), so its gate can be deeper than the floor the search assumed.
- **The outline excludes disc-only water.** Cells reached only because a disc lowered their gate are not drawn, so the outline stays the requested-gate region and the legend can say so. The filter tests each cell's own depth, so requested-gate water reached only by passing through a disc is still drawn. That is accepted; how many cells it affects is not measured, and R0 counts them.
- **Pocketed origin.** If `harborEndpointPocketed(mask, origin, boat, gate)` is true, the search adds an origin disc at `relaxationFloorM` (the probe's `marstal-genoa-12-disc`, M3: Marstal as origin stamped 11 cells without it and 2 655 nm² in 10 h with it). The card shows `reach.origin.relaxed`. A plan from the same origin may instead start at a #1721 handover point (`routing/harborHandover.ts`), so the two can start from different water; the copy does not claim they match.
- **Origin unreachable even with the disc** (M3: Easy Go from Marstal): state `reach.none.origin`.

### 5.4 Rigs

- Every rig in the planner's `sailIds` is searched; with two, they run concurrently on a two-worker pool (#1793 `defaultPoolSize`) and in sequence on one worker.
- Per row: the faster rig, or "beide" when the two arrivals are within `RIG_TIE_BAND_MS` (60 s), the band `compareRigs` uses. A harbour only one rig reaches shows that rig.
- The summary line counts rows per faster rig ("Genua schneller bei 7").
- If either rig's polars are estimates (`lib/plan.ts:rigEstimateBased`'s rule), the card shows `reach.estimate`.
- The outline is the union of both rigs' cells.

### 5.5 Motor, comfort

- Motor follows `settings.motorEnabled` and `motorSpeedKn`, as a plan does. The card offers no motor toggle; [Einstellungen] leads to the Boot tab.
- Comfort follows the plan's tier 1: `comfortDepthM` = gate + `depthComfortMarginM`. There is no comfort-off retry, so a harbour a plan would reach only at its tier 2 can be missing.
- M5: the motor-off area can exceed the motor-on area (Sønderborg genoa, 6 h, 12 kn: 1 284 vs 1 228 nm²), and at 6 kn motor-on reached 0 nm in two sectors where motor-only reached 12.9 and 17.0 nm. So the copy says "Häfen, die diese Suche erreicht", never "alle erreichbaren Häfen". The cause of the non-monotonicity is not established (grounding §4 M5).

### 5.6 Budget, cancel, partial results

- One deadline per reach request, `PLAN_BUDGET_MS` (360 000), imposed in `protocol.ts` like a plan's. M1: every single-rig 10 h run here drained within 90 s.
- `reach.ts` returns on deadline with `complete: false` and everything found so far. It does not discard its state as `solve()` does.
- Partial semantics, stated in the card: found rows are real arrivals, but their times may still drop (M2 measured cells lowered by more than 30 min after their first ring) and further harbours may be missing. Rows show "ca." plus the chip **unvollständig**; the outline is dashed and its legend line reads `reach.partial`. The card offers [Mit kürzerem Zeitlimit suchen], which halves the limit (floor 1 h). It never suggests a later departure.
- **Cancel.** `terminate()` is the only interrupt (#1193). The card uses its own `RoutingClient` (§10), so a reach cancel cannot tear down a plan or a Live reroute on the shared client. The killed worker returns nothing, so cancel keeps only the rows already delivered by progress messages, labelled `reach.cancelled`, and draws no outline. Only the deadline path, where `reach.ts` returns normally, has a partial outline.
- **Progress.** Per ring the worker posts `{ sailId, tMs, frontierSize, found }`, where `found` lists new or improved arrivals. The card shows the lower rig's elapsed search time against the limit, then "Abschluss …" during the drain, whose length is not known in advance (M1: 85–90 rings for a 60-ring limit).
- A half-budget warning logs through `lib/planLog.ts` like a plan's; log lines carry harbour ids, never coordinates.

## 5.7 What this card shares with #1854

| #1854 surface | Use here |
|---|---|
| Hour store `state/conditionsHour.ts` | Used: Abfahrt is the card's hour (§4). |
| Held grid from `state/useAreaForecast.ts` | Used: the search runs on it, refreshed first when older than the TTL (§8). |
| `ConditionsPanel` mounted in MapView and portalled into the Wetter slot | Used: the reach card mounts inside it, under the conditions card. |
| §12 Disclosure and primary-action swap | Used: [Häfen suchen] is primary while open; the departure handoff is secondary. |
| Canvas raster pipeline | Not used: the outline is a vector line, because #1854 §15 rejected in-canvas outlines. |
| Harbour popup [Als Start]/[Als Ziel] and place lines | Not in #1854 slice 1; the row's **Route dorthin** and the in-card Start picker stand in. The popup's "erreichbar in ca. …" line is R4. |
| Depth suppression and stack order (§6) | Unchanged; the reach layers slot between the sea-state raster and the harbour layer. |

## 6. Map rendering

- **Outline, not fill.** `sc-reach-outline`, a GeoJSON line layer: 2 px line over a 4 px `HALO_COLOR` casing, colour from `lib/mapColors.ts`. #1854 §15 rejected in-canvas outlines because their screen width follows raster magnification, so the outline is vector.
- **Geometry.** In the worker: the union of both rigs' coarse prune cells with final arrival within the limit, excluding disc-only cells (§5.3), then marching squares over that cell grid. Closing pinholes by a one-cell dilate and erode, re-clipped to cells navigable at the gate, is proposed; how ragged the raw outline is was not measured (R0 renders it).
- **Partial (deadline path only).** `line-dasharray` on the same layer. A cancelled search has no outline (§5.6).
- **Reachable harbours.** No new symbol layer (#1854 §15 deferred numeric labels for collision reasons; #378). `sc-reach-harbours` is a circle layer drawn as a stroke-only ring under the harbour icons; circle layers take no part in symbol placement. The selected row's harbour gets a thicker ring via `feature-state`.
- **Optional track preview (R4).** For the selected row, the arrival node's `backtrack` polyline as a thin dashed line, labelled "Suchspur, keine geplante Route".
- **Stack.** depth < sea-state raster < `sc-reach-outline` < `sc-reach-harbours` < harbours, seamarks, AIS, waypoints < route. Both layers anchor with an explicit `beforeId`; `layerOrder.test.tsx` gains rows for them across mount orders and after a style reload.
- **Sea state stays visible.** With no fill, the outline does not compete with the sea-state fill or the depth rule in #1854 §6. That answers #1854 §12's "whether the reach fill hides the sea-state fill": there is no reach fill.
- **Legend.** One line in the reach card ("─ Wasser, das die Suche innerhalb von 6 h bei 3,0 m erreicht"; "○ erreichter Hafen"). No map legend and no new z-index; the card is untiered sheet content.
- **Camera.** No automatic camera move. [Bereich zeigen] reuses #1854's RouteLayer fit nonce (`RouteLayer.tsx` is in `cameraAnimationCallSites.test.ts:ALLOWED_FILES`); it is cut first.
- **Map taps.** A tap on a ringed harbour on Wetter selects its row and scrolls it into view (R4; it needs the Wetter harbour-tap routing from #1854's popup slice). Until then harbour taps behave as #1854 slice 1 leaves them.

## 7. States

| State | Card |
|---|---|
| Closed | Disclosure header only; no computation. |
| No Start | `reach.start.none` and the picker; [Häfen suchen] shows `reach.start.required` on press rather than being disabled (#1854 §15 rejected disabled buttons on touch). |
| No forecast held | `reach.forecast.none`; the search waits for #1854's fetch. |
| Ready, no result | inputs plus [Häfen suchen]. |
| Computing | progress line and bar, provisional rows, [Suche abbrechen] in the primary slot. |
| Complete | summary line, sorted rows, "Nicht in {limit} gefunden" Disclosure (names only), "ausgeschlossen" count, outline. |
| Complete, no harbour | outline plus `reach.none.harbour`; if the limit is below 10 h, [Mit {limit+2} h suchen]. |
| No reachable water | `reach.none.origin` (origin pocketed even with the disc) or `reach.none.calm` (motor off, frontier dies). |
| Partial (budget) | §5.6; chip **unvollständig**, dashed outline. |
| Cancelled | rows found so far, `reach.cancelled`; no outline. |
| Stale | rows greyed, `reach.stale` with the departure it was computed for; inputs live. |
| Beyond horizon | limit clamped (`reach.limit.clamped`); under 1 h of forecast left after Abfahrt: `reach.horizon.short`, no search. |
| Offline | `reach.offline`; no search. A result from earlier in the session stays, labelled with its forecast's fetch time. |
| Worker failure | typed `RoutingFailureKind` → the existing message keys (`state/replan.ts:ROUTING_FAILURE_MESSAGE_KEY`); never `error.internal` by string match. |

## 8. Forecast freshness

The search uses the grid a plan started now would use. If the held grid is older than `GRID_CACHE_TTL_MS` (10 min), [Häfen suchen] first refreshes through #1854's `useAreaForecast` and then searches on the new grid; the card says so ("Vorhersage wird aktualisiert, dann wird gesucht"). This keeps a row's ETA and the plan its handoff leads to on one forecast within the TTL, as #1854 §11 does for the departure handoff.

## 9. Offline posture

Recommended: the search is online-only. Reasons:
- It is route computation: it produces arrival times and hands a harbour to the planner. The 2026-10-28 ruling rules out planning from the Wetter session grid; the 20:45 clarification limits that to planning and keeps showing a held forecast. A search that produces ETAs sits on the planning side of that line.
- Its handoff leads to a plan, which cannot run offline unless `storedWindGrid` is passed (`usePlanFlow.ts`, #1854 §11), so an offline result would end at a button that cannot complete.
- §8 ties the search to the grid a plan would use; offline there is none.

Offline the card shows `reach.offline`. A complete result from earlier in the session stays visible with its forecast's fetch time, and **Route dorthin** still writes Start, Ziel and Abfahrt; planning then shows Planen's own offline behaviour. The alternative (search offline from the held grid, age shown) is in §19 for the maintainer to choose instead.

## 10. Worker and data flow

```
ReachCard (inside ConditionsPanel's portal)  ── press ──▶ reachClient.reach(req, onProgress)
   req: { origin, originHarborId, departureMs, limitMs, sailIds, settings, boatId,
          targets: [{harborId, point, disc?}], originDisc? }    (targets from computeHarborAccess)
   wind grid: the held area grid (cloned, never transferred); mask: transferred .slice(0) once at init
worker: protocol.ts 'reach' ─▶ reach.ts per rig (pool: ladder worker + sibling)
   ◀── 'reachProgress' { sailId, tMs, frontierSize, found[] }   per ring
   ◀── 'reachResult'   { complete, perRig: arrivals[], outline: GeoJSON, tracks? }
```

- **Separate client.** `state/reachClient.ts` owns a `RoutingClient` created on first search and disposed when the card closes or the tab is left. `RoutingClient.cancel()` and `dispose()` act on every request of a client, and the shared singleton serves planning, recalculation and Live reroute, so a shared client would let a reach cancel kill a reroute. Cost: a second worker set, each holding its own copy of the mask; its memory on a tablet is not measured (R0).
- **Leaving the tab** cancels a running search (result kept as cancelled); leaving keeps a complete result for the session. The result lives in the card's state, never IndexedDB.
- **Protocol.** `WorkerRequest` gains `reach`; `WorkerResponse` gains `reachProgress` and `reachResult`. `RoutingFailureKind` is reused; no new kind is planned. Only arrivals, the outline and optional track polylines cross `postMessage`, never the cell map.
- **Handoff.** **Route dorthin** calls App's `handlePickOrigin` (if the card's Start differs from the planner's), `handlePickDestination(harborToPickedPoint(h, lang))`, `setDepartureMs`, `handleTabChange('plan')`, then moves focus to **Route planen** and announces `reach.handoff.done`. A loaded plan's Ziel is overwritten only by this explicit press (#1854 §15's rule for implicit edits).
- **Not touched:** `types.ts`, `lib/wind.ts`, `lib/mask.ts`, `planRoute.ts`, `harborHandover.ts`, `services/db.ts`, `sw.ts`, CSP. `isochrone.ts` only in R1's export commit.

## 11. Accessibility

- **List.** An `<ol>` with an accessible name (`reach.list.label`); each row an `<li>` whose body is a button (`aria-pressed` for selection) plus the **Route dorthin** button. The selected row has `aria-current="true"` and a 3 px `--sc-accent` border.
- **Names.** The row button's name is its visible text in order with sr-only words interleaved ("1, Sonderburg, Ankunft in 2 Stunden 50, um 16:50, Genua, Fock 3 Stunden 05, Wind aus Südwest 13 Knoten"), so it contains the visible text (WCAG 2.5.3). **Route dorthin**'s name is "Route dorthin: Sonderburg".
- **The list is the accessible path.** The outline and rings are `aria-hidden` map content; every fact on the map is in the list.
- **Progress.** `role="progressbar"` with `aria-valuetext` ("3 Stunden 10 von 6 Stunden, 4 Häfen"). The polite region announces only: search started, finished with count, cancelled, partial, stale, failure. Provisional row updates are not announced, and focus never moves when rows arrive or reorder.
- **Targets.** Inputs, both buttons per row and the row body ≥ 44 px tall; **Route dorthin** ≥ 44×44.
- **Colour.** Flags are text chips; rig is text; the ring is shape plus the list.
- **Focus.** The completion sort happens once; if the focused element is a row, focus stays on that row's element after the sort.

### Name collisions (Playwright substring, both languages; RTL is exact)

| New name | Risk | Choice |
|---|---|---|
| Häfen suchen / Find harbours | none found in dicts | keep |
| Suche abbrechen / Stop search | "…abbrechen" has variants: `planner.cancel` "Routenberechnung abbrechen", `planner.via.add.cancel`, `planner.pickOnMap.cancel`, `planner.via.coord.cancelEdit`, `live.reroute.cancel`, and bare "Abbrechen" in `plansList.recalc.cancel` and `banner.tapPick.cancel` | "Suche abbrechen" contains none of them and none contains it; check `getByRole(…, { name: 'Abbrechen' })` sites, which would match it |
| Zeitlimit / Time limit | "Dauer" is live text (`route.totals.duration`, `route.legs.duration`); "Fahrtdauer" would contain "dauer" | avoid "Dauer" |
| Erreichbare Häfen ab … / Reachable harbours from … | "erreichbar" occurs in `boat.harbors.*` and `boat.switch.endpointUnreachable` text | role-scoped `exact: true` in new specs |
| Route dorthin: {Hafen} / Route there: {harbour} | "Route" prefixes "Route planen"; "Route planen" is not a substring of it | grep `getByRole('button', { name: 'Route'` before merge |
| Zufahrt flach / Shallow approach | `HarborHandoverNotice` wording | grep before merge |

## 12. Tablet 820 px and layouts

- **Narrow 820–1023.** The sheet cap is `calc(55vh - var(--sc-toast-height, 0px))`, measured at 649 px at 820x1180 by #1854; the tab strip is 45 px (measured). #1854 estimated its own card at 609–641 px, so the reach Disclosure header already sits at or below the sheet's fold. Opening the Disclosure scrolls the panel so its header sits under the sticky hour row (a scroll on a user action only). Rows then use the sheet below the hour row; how many fit was not measured.
- The input row (Start, Zeitlimit, button) is one line when the card is at least an estimated 40rem wide and stacks below that; this is a container query on the card, like #1854's strip.
- **Wide ≥ 1024.** Panel 390 px at 1180x820 (measured by #1854): inputs stack, rows take two lines.
- **Phone < 820.** Stacked; nice-to-have only (2026-09-07 ruling).
- Testable claims are in §14 (AC-R8, AC-R9), not as a height sum.

## 13. i18n (de / en, `satisfies` parity; numbers via `lib/format.ts`'s `formatDuration`, `formatTime`, `formatDateTime`, `formatKn`)

| Key | DE | EN |
|---|---|---|
| reach.title | Erreichbare Häfen ab {start} | Reachable harbours from {start} |
| reach.titleNoStart | Erreichbare Häfen | Reachable harbours |
| reach.start.label | Start | Start |
| reach.start.none | Start wählen, um zu suchen. | Choose a start to search. |
| reach.start.required | Bitte zuerst einen Start wählen. | Choose a start first. |
| reach.limit.label | Zeitlimit (h) | Time limit (h) |
| reach.limit.clamped | Die Vorhersage reicht nur für {hours} h ab Abfahrt; das Zeitlimit wurde gekürzt. | The forecast covers only {hours} h after departure; the time limit was shortened. |
| reach.departure | Abfahrt {datetime} (Stunde oben) | Departure {datetime} (hour above) |
| reach.settings | {boat} · Tiefe {depth} (+{margin} Komfort) · {motor} | {boat} · depth {depth} (+{margin} comfort) · {motor} |
| reach.run | Häfen suchen | Find harbours |
| reach.cancel | Suche abbrechen | Stop search |
| reach.progress | Suche läuft … {elapsed} von {limit} · {count} Häfen bisher | Searching … {elapsed} of {limit} · {count} harbours so far |
| reach.finishing | Abschluss … | Finishing … |
| reach.summary | {count} Häfen in {limit} gefunden | {count} harbours found within {limit} |
| reach.row.eta | ca. {duration} · an {clock} | about {duration} · arrive {clock} |
| reach.row.both | beide | both |
| reach.row.provisional | vorläufig | provisional |
| reach.row.go | Route dorthin | Route there |
| reach.flag.shallow | Zufahrt flach | Shallow approach |
| reach.flag.shallowDetail | Zufahrt nur mit gelockerter Tiefe (bis {floor}), wie es die Routenplanung tut. | Approach only with a relaxed depth (down to {floor}), as route planning does. |
| reach.notFound | Nicht in {limit} gefunden ({count}) | Not found within {limit} ({count}) |
| reach.excluded | Ausgeschlossen ({count}) | Excluded ({count}) |
| reach.notice | Planungshilfe aus der Vorhersage: Häfen, die diese Suche innerhalb des Zeitlimits erreicht. Kein vollständiges Verzeichnis, keine Seekarte; ein geplanter Törn kann abweichen. | Planning aid from the forecast: harbours this search reaches within the time limit. Not a complete list and not a chart; a planned passage can differ. |
| reach.legend.outline | Wasser, das die Suche in {limit} bei {depth} erreicht | Water the search reaches within {limit} at {depth} |
| reach.legend.ring | erreichter Hafen | harbour reached |
| reach.estimate | Segeldaten für {sail} geschätzt. | Sail data for {sail} estimated. |
| reach.origin.relaxed | Start liegt flacher als {depth}; die Suche fährt im Umkreis von 1 sm mit {floor} aus. | The start is shallower than {depth}; the search leaves within 1 nm at {floor}. |
| reach.none.origin | Von {start} findet die Suche bei {depth} kein Fahrwasser. | From {start} the search finds no navigable water at {depth}. |
| reach.none.calm | Ohne Motor kommt die Suche bei dieser Vorhersage nicht voran. | Without the engine the search makes no progress in this forecast. |
| reach.none.harbour | Kein Hafen innerhalb von {limit} gefunden. | No harbour found within {limit}. |
| reach.partial | Unvollständig: Rechenzeit erreicht. Zeiten können kürzer sein, Häfen können fehlen. | Incomplete: time budget reached. Times may be shorter and harbours may be missing. |
| reach.cancelled | Abgebrochen: bisher gefundene Häfen. | Stopped: harbours found so far. |
| reach.retryShorter | Mit {limit} suchen | Search with {limit} |
| reach.stale | Gilt für Abfahrt {datetime} – neu suchen. | Computed for departure {datetime} – search again. |
| reach.horizon.short | Weniger als 1 h Vorhersage nach der Abfahrt. | Less than 1 h of forecast after departure. |
| reach.offline | Offline: Die Hafensuche braucht eine aktuelle Vorhersage. | Offline: the harbour search needs a current forecast. |
| reach.refreshFirst | Vorhersage wird aktualisiert, dann wird gesucht. | Updating the forecast, then searching. |
| reach.handoff.done | {harbour} als Ziel übernommen. | {harbour} set as destination. |
| reach.list.label | Erreichbare Häfen, nach Ankunft sortiert | Reachable harbours, sorted by arrival |

## 14. Acceptance criteria

1. **AC-R1** Start + Abfahrt + Zeitlimit produce a list and an outline; the notice marks them as a planning aid from the forecast.
2. **AC-R2** Every listed ETA comes from a direct-arrival or capture test validated by `edgeFactor`, never from a cell lookup (unit test with a target in an unvisited cell beside visited water).
3. **AC-R3** The search runs to drain: a unit test with a substep-lagged node shows its later, earlier arrival replacing the first one.
4. **AC-R4** Shallow-approach harbours carry **Zufahrt flach**; known-disconnected and unreachable harbours are never rows; Salona 45 lists Marstal flagged; Easy Go lists Marstal and Augustenborg under "ausgeschlossen".
5. **AC-R5** On deadline the result is partial with rows kept and the outline dashed; cancel keeps found rows; neither tears down a request on the shared planning client.
6. **AC-R6** Offline: no search starts and `reach.offline` shows; an earlier complete result stays with its fetch time.
7. **AC-R7** **Route dorthin** sets Start, Ziel and Abfahrt, selects Planen, focuses **Route planen**, announces, and does not plan.
8. **AC-R8** At 820x1180, DE, opening the Disclosure leaves its header and the [Häfen suchen] button fully inside the viewport, under the sticky hour row; with and without a toast.
9. **AC-R9** No horizontal overflow of the card or the list at 820x1180 and at 1180x820 with the panel at default width and at 320 px, DE and EN.
10. **AC-R10** No new z-index; `sc-reach-outline` and `sc-reach-harbours` keep their place in `layerOrder.test.tsx` across mount orders and a style reload.
11. **AC-R11** Changing hour, Start, limit, boat or a routing setting marks the result stale and starts nothing.
12. **AC-R12** de/en parity; no new name collides (§11).
13. **AC-R13** `closure.mjs diff` NOT OWED for R2–R4; R1's sweep paid with its pre-registered prediction.

## 15. Testing

- **Unit, `reach.ts`.**
  - Synthetic open-water mask, motor-only uniform field: the reached set is a disc of radius `motorSpeedKn` × limit within one cell (the analytic control the probe's motor-only row approximates: 38.7 nm against 39 nm at 6 h).
  - The fidelity differential against `solve()` (§5.1), real mask, `solverTimeoutMs`.
  - Arrivals: direct and capture paths; a target behind a land spit (blocked direct hop, capture later); arrival improvement during drain; disc targets; pocketed origin with and without the disc.
  - Deadline mid-ring returns `complete: false` with arrivals kept; cancel via `terminate()` at the client.
  - Marching squares: closing never adds a cell that fails the gate; disc-only cells excluded.
- **Unit, client and protocol.** `reach` request round trip, progress order, typed failures, the separate client's dispose on card close; a cancel on it leaves a concurrent plan on the shared client running.
- **Real mask.** `routing/realmask.repro.reach.test.ts`: Flensburg 2 h (cheap), Marstal-origin disc, one Easy Go case. `classify-realmask.sh` may skip it in CI because `reach.ts` is outside the routing closure; R1 either adds `reach.ts` to the classifier's supplement paths or the PR runs it locally and says so.
- **Components.** ReachCard renders every §7 state; rows update without moving focus; one sort on completion; StrictMode render for any ref written in a cleanup. Layer assertions install a size-discriminated `getContext` fake per file, never in `test/setup.ts` (sweep closure `EXTRA_EDGES`).
- **e2e.** `reach.spec.ts` with `?windFixture=` (regenerated by `pree2e`), limit 2 h to keep CI time down, over `STANDARD_VIEWPORTS` ≥ 820 in both themes: search → rows → **Route dorthin** → planner fields; AC-R8/R9 geometry; offline note. One e2e implementer at a time (shared preview port).
- **Real browser (verify skill).** 820x1180 and 1180x820, both themes: outline legibility over the rough sea-state band and over depth shading; ring visibility under harbour icons; a partial result.

## 16. Risks

| Risk | Why | Mitigation |
|---|---|---|
| The list contradicts the planner | A cell lookup at the requested gate would list Marstal as unreachable for the Salona 45 while plans route there at defaults (#53). | Disc targets (§5.3), arrival tests rather than cell lookups (§5.2), R0's ETA comparison, "ca." copy, handoff to a real plan. |
| ETAs differ from plan ETAs | Fixed 600 s step, no per-target direct candidate, no tiers or postprocess. | R0 measures the error; rounding follows it. |
| Tablet compute time | Only this machine was measured; CDP throttling is inert on a dedicated Worker. | R0 on the maintainer's tablet gates the default and maximum limit. |
| Two worker sets in memory | Separate client holds its own mask copy per worker. | Lazy creation, dispose on close; R0 measures. |
| Read as exhaustive | M5 non-monotone search. | Notice copy; "Nicht gefunden" never says "unerreichbar". |
| Ragged outline | Coverage of far cells unmeasured. | R0 renders it; closing step; outline is secondary by design. |
| Sweep owed by the export commit | `isochrone.ts` in closure. | One commit, pre-registered prediction, run as the README requires. |
| Stale result acted on | Hour scrubbed after a search. | Stale state greys rows and names the departure. |

## 17. Implementation slicing (v0.62.0; all after #1854 slice 1 PR2)

- **R0, measurements (no product code).** Extend the probe: per-harbour arrival test cost; reach ETA vs `planRoute` ETA on about ten harbour pairs; outline render for 6 h from Flensburg, Sønderborg and Marstal (disc); one real-wind run if a current forecast fixture is generated; a real-tablet run of the 6 h default. The maintainer sets the default and maximum limit and the ETA rounding from it.
- **R1, solver.** Export-only commit to `isochrone.ts` (sweep owed, predicted byte-identical); `routing/reach.ts` with arrivals, discs, drain, deadline, outline; unit and real-mask tests. No UI.
- **R2, worker.** Protocol messages, `RoutingClient.reach`, `state/reachClient.ts`, progress, cancel, budget, logging.
- **R3, card.** ReachCard in the Wetter tab: inputs, search, progress, list, states, stale, offline, **Route dorthin**; `sc-reach-outline` and `sc-reach-harbours`; dicts; `changelog.d/1855.added.md`; e2e.
- **R4, later and cuttable.** Track preview for the selected row; map harbour tap → row (needs #1854's harbour-tap routing); "erreichbar in ca. …" line in #1854's harbour popup once it exists; [Bereich zeigen]. Cut order: [Bereich zeigen], then track preview.

## 18. Answers to #1854 §12's open questions

- **One region or bands:** one faint outline; time lives in the list.
- **Inputs:** Start picker, Zeitlimit `NumberInput` (1–10 h, default 6), Abfahrt from the hour store.
- **Sail plan:** both declared rigs; per row the faster, "beide" within 60 s.
- **Progress and cancel:** per-ring progress with found rows; cancel by `terminate()` on a separate client.
- **Budget-exhausted:** partial result kept and labelled.
- **Reach fill vs sea state:** no fill, so sea state stays.
- **Popup line:** later slice (R4).
- **Tab name:** "Wetter" stays; renaming would change e2e names before the card proves itself. Revisit after R3.

## 19. Considered and rejected

- **Harbour ETA from the snap point's prune cell.** A ~220 × 190 m cell can be stamped without any node reaching the harbour entrance, and an unstamped cell can sit beside reached water; cell times also fall during the drain (M2). Arrival tests mirror what a plan checks.
- **Refactoring `solve()` to expose its front.** `solve()` is destination-driven (step size, direct candidate, tie-break, arrival tests), discards everything on `budget-exhausted`, and is in the sweep closure with the #1793 generator around it. A sibling module keeps plans untouched.
- **Graded time bands.** Bands read off ring indices are wrong by the M2 amounts; bands from final times are correct but add a second area colour scale over sea state and depth. The list carries time.
- **A reach fill (raster).** Two area fills do not read together (#1854 §12), and the outline needs a vector line anyway.
- **Numeric ETA labels on the map.** A new symbol layer joins the collision index beside #378's annotations; rings plus the list avoid it.
- **Snapshot at the limit ring.** M2: cells reached by 6 h exceed those stamped by ring 36 by up to 24.9 % (Flensburg fock).
- **Searching offline from the held grid, age shown (#1854 §12's original sentence).** Technically possible, since the computation runs locally. Rejected because the search produces ETAs and a planning handoff, which the 2026-10-28 ruling keeps online; the handoff's plan cannot run offline anyway. The maintainer can choose it instead; the change is the §7 offline row and §8's refresh step.
- **Sharing the planning `RoutingClient`.** Its cancel and dispose act on every request, including Live reroute.
- **A motor toggle in the card.** It would make the card a second settings surface and invite reading motor-off as a subset (M5 shows it is not).
- **Auto-search on hour change.** Every search costs seconds to a minute here (M1); unannounced recomputation on scrubbing is worse than a stale label.
- **Auto-planning from a row.** #1854 keeps **Route planen** the only action that plans.
- **Listing harbours not found with an estimated time.** The search stopped at the limit and has no time for them.
