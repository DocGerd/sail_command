# #1855 candidate design D1 — "Minimal card"

Status: candidate design for the #1855 spike, written at develop `32f67af0`. It assumes #1854 slice 1 (water-clipped sea-state raster, Wetter tab, hour store, "Als Abfahrt übernehmen") has shipped and nothing later. Measured figures are from `/tmp/s1855/grounding.md` (§4 M1–M5) and `/tmp/s1855/probe/results.json`; every other number is a code constant or marked as an estimate. Paths are under `app/src/` unless stated.

## 0. Decisions at a glance

| Question | D1 answer | Evidence |
|---|---|---|
| Where | Second card in Wetter, a `Disclosure` closed by default under "Wind und Seegang" | 1854 §12 |
| Origin | The planner's Start (`App.tsx` `origin` state); no origin field in the card | issue: reuse planner fields |
| Departure | The Wetter hour store (`state/conditionsHour.ts`); no departure field in the card | 1854 §4, §12 |
| Duration | `NumberInput`, 1–10 h, step 0.5, default 6 h, persisted per device | M1 measured 6 h and 10 h only |
| Rig | One headsail: the genoa when aboard, else the first aboard headsail (the `useDepartureScan.ts:scanSailIdsFor` rule) | M1: neither rig dominates |
| Motor, gate, comfort | The planner's `Settings` unchanged, stated in the card | issue notes |
| Result | One shaded region (no time bands) plus a harbour list sorted by ETA | M2 |
| Budget | `PLAN_BUDGET_MS`; on expiry the partial map is shown as "mindestens erreichbar" | §7.6 |
| Offline | No compute; a result computed online stays visible with its forecast age | #1854 §11 ruling + clarification |
| Compute | New `routing/reach.ts` (NOT_IN_CLOSURE); `isochrone.ts` untouched; private helpers duplicated and pinned by a differential twin | grounding §3 |
| Handoff | Harbour row [Als Ziel] sets Ziel and departure, switches to Planen; it does not plan | 1854 §11 pattern |

## 1. Goal and non-goals

Goal: from the planner's Start, at the hour shown in Wetter, the skipper sees the water one headsail reaches within a chosen duration, and the harbours inside it with approximate ETAs, then hands one harbour to the planner.

Non-goals:
- No time bands, no area tap, no map popup line (the 1854 popups are a later slice).
- No change to `isochrone.ts`, `planRoute.ts`, `types.ts` or any other #282 closure file.
- No IndexedDB or session-snapshot persistence of the result; no `DB_VERSION` bump; no `sw.ts` change.
- No multi-day reach (#1708) and no ranking of departure windows (#936 stays with DepartureCompare).

## 2. User flow

1. The skipper has a Start on Planen (harbour or map point) and opens Wetter. The conditions card loads as in #1854.
2. Below it, the closed Disclosure reads **Erreichbar ab Flensburg**. Without a Start it reads **Erreichbarkeit**.
3. Opening it shows: departure (the Wetter hour, read-only), Höchstdauer, the assumptions line, and **[Reichweite berechnen]** (primary while the card is open; "Als Abfahrt übernehmen" demotes to secondary, per §12).
4. Pressing it runs the reach in the routing worker. The card shows progress and **[Reichweitenberechnung abbrechen]**.
5. On completion the map shows one fill over the reached water. Sea state and depth are hidden while the fill shows. The card shows a summary, a legend line, the notice and the harbour list.
6. A row's **[Als Ziel]** sets Ziel to that harbour and the departure to the computed hour, switches to Planen and focuses `#planner-departure` (1854 §11's rule for "Ziel set"). **Route planen** then solves both rigs as usual.

## 3. Wireframes

```
820x1180 — Wetter, reach card open, result shown (narrow; values illustrative)
y0    +--------------------------------------------------------------+
      | SailCommand                                      [EN] [i]    |
y61   +--------------------------------------------------------------+
      |[> Anzeigeoptionen]   \_    \_      barbs (haloed)            | .map-stack-tl T2
      |(N)        ░░░░░░░░░░░░░░░         reach fill on water        |
      |       ░░░░░░░ o Sonderburg ░░░░   at/above the gate only;    |
      |  o Flensburg ░░░░░░░░░░░░░░░      sea state + depth hidden   |
      |[2 sm]   ░░░░░░░░░░░░░░                                       |
y531  +==== Planen | *Wetter* | Routen | Live | Boot ================+
      | [«] [<]          Sa 14:00 (in 23 h)          [>] [»]         | sticky (1854)
      | ... conditions card (1854), scrolled above ...               |
      | [ Als Abfahrt übernehmen ]                       (secondary) |
      | [v Erreichbar ab Flensburg]                                  | Disclosure 44
      |   Abfahrt Sa 24. 14:00 (Uhrzeit oben)                        |
      |   Höchstdauer (h) [ 6 ]                                      | NumberInput 44
      |   Annahme: Genua die ganze Fahrt · mit Motor · Tiefe ≥ 3,0 m |
      |   [ Neu berechnen ]                               (primary)  |
      |   ▇ In höchstens 6 h erreichbares Wasser ab Sa 14:00         | legend line
      |   Planungshilfe aus der Vorhersage (abgerufen 13:05). Gezeigt|
      |   ist, was diese Suche findet, nicht jede mögliche Fahrt.    |
      |   Seegang und Wassertiefen ausgeblendet. [Reichweite ausbl.] |
      |   9 Häfen erreichbar                                         |
      |   Sonderburg      ca. 2 h 10 · an 16:10        [Als Ziel]    | rows 44
      |   Gråsten         ca. 2 h 40 · an 16:40        [Als Ziel]    |
      |   ...                                                        |
y1180 +--------------------------------------------------------------+

820x1180 — computing
      | [v Erreichbar ab Flensburg]                                  |
      |   Abfahrt Sa 24. 14:00 · Höchstdauer 6 h · Genua · mit Motor |
      |   Berechnet bis +3 h 20 von 6 h …   [==========------]       | <progress>
      |   [ Reichweitenberechnung abbrechen ]                        |

1180x820 — wide, panel 390 px; reach card open
+-- panel 390 -----------------++----------- map 779 --------------------+
| Planen *Wetter* Routen Live Boot|  ░░░░░░░ reach fill ░░░░░░            |
| [«][<] Sa 14:00 (in 23 h) [>][»]|  ░░░░ o Sonderburg ░░░░░░░             |
| ... conditions card ...      || o Flensburg ░░░░░░                      |
| [v Erreichbar ab Flensburg]  ||                                        |
|  Abfahrt Sa 24. 14:00        ||                                        |
|  Höchstdauer (h) [ 6 ]       ||                                        |
|  Annahme: Genua · mit Motor  ||                                        |
|   · Tiefe ≥ 3,0 m            ||                                        |
|  [ Neu berechnen ]           ||                                        |
|  ▇ In höchstens 6 h …        ||                                        |
|  Sonderburg  ca. 2 h 10      ||                                        |
|    an 16:10      [Als Ziel]  ||                                        |
+------------------------------++----------------------------------------+
```

At 390 px the row wraps ETA under the name; the button keeps its 44 px target.

## 4. Inputs and defaults

- **Origin.** The planner's Start, snapped with `mask.snapToNavigable(p, gate)` as `planRoute` does. A harbour Start is named; a point Start reads "Kartenpunkt {lat, lon}" via `formatLatLon`. No Start: the body shows `reach.noStart` and **[Start im Planer wählen]**, which switches to Planen and focuses the Start combobox. After #1854 slice 1 Wetter has no [Als Start] popup, so Planen is the only way in.
- **Departure.** The `conditionsHour` value, shown read-only. Changing the hour row after a compute marks the result stale (§11).
- **Duration.** `NumberInput` id `reach-hours`, `min` 1, `step` 0.5, `max` = min(10, hours of forecast left after the departure, floored to 0.5). Default 6, or the max when less. Persisted with `lib/usePersistedNumber.ts` under `sc-reach-hours` (localStorage; clamped on read, the stored value untouched). Fewer than 1 h of forecast left disables the button with `reach.horizon.none`.
- **Not inputs.** Boat, aboard headsails, gate, comfort margin and motor settings come from the planner. The assumptions line names them so the skipper knows what to change on Boot or Planen.

## 5. Rig policy

- One headsail, chosen by the rule in `state/useDepartureScan.ts:scanSailIdsFor`: the genoa when aboard, else the first aboard headsail in catalogue order. `reach.ts` gets its own `reachSailIdFor()` with the same rule. The scan's own comment forbids generalising its constant without re-measurement; this borrows the rule for a different question and does not change the scan.
- It is a cost decision, not a recommendation. M1/M2: from Flensburg the fock's 6 h area (478 nm²) exceeds the genoa's (429 nm²); from Sønderborg the genoa's (1228) exceeds the fock's (1219). Uniform 12 kn wind only.
- The card names the sail ("Annahme: Genua die ganze Fahrt"), as `departureScan.helpGeneric` does. The handoff is the two-rig confirm: Route planen solves every aboard sail and may recommend the other.
- No sail selector in D1 (§20).

## 6. Motor, gate and comfort

- `Settings` pass through unchanged: `motorEnabled`, the sail-speed floor from `motorThresholdKn`/`motorSpeedKn`/`sailPreferenceKn`, `maneuverPenaltyS`, `performanceFactor`, `safetyDepthM`.
- Comfort: `comfortDepthM` = gate + `depthComfortMarginM`, as `planRoute`'s tier 1 passes it. Dominance ranks on `costMs`; the cell map records true `tMs` (§7.2).
- No tier-2 retry and no #53 relaxation tiers, except the origin disc (§7.4). Those tiers need a destination (grounding §3).
- The assumptions line states motor on or off. The card never offers a motor toggle.
- Copy never says "alles Erreichbare". M5: motor-off reached more area than motor-on at 12 kn (1284 vs 1228 nm²), and motor-on at 6 kn reached 0 nm in two sectors where motor-only reached 12.9 and 17.0 nm. The region is what this search reaches.

## 7. Compute: `routing/reach.ts`

### 7.1 Loop
- Start from the probe's `reach()` (`docs/spikes/1855-reachable-area/reach.probe.test.ts`, ~230 lines): `solve()`'s ring loop without the destination terms. `dtS` fixed at 600 s; `sailCandidates` with `+beat` as `directTwa` (deduped); substep retry, `byKey` collapse, `visitedDominates`/`stampVisited` as in `solve()`.
- Imports from `isochrone.ts`: `sailCandidates`, `edgeFactor`, `pruneCellConfined`, `visitedDominates`, `stampVisited`, `defaultMaxFrontier`, `DEADLINE_CHECK_NODES`, `SolveDeadline`.
- Duplicated, because they are module-private in `isochrone.ts`: `pruneKey`, `better`, `PRUNE_LAT`/`PRUNE_LON`, `CONFINED_PRUNE_DIV`, `MOTOR_OFF_CONFINED_PRUNE_DIV`, `CONFINEMENT_MARGIN_CELLS`, `MIN_SAIL_KN`. `FORCED_MOTOR_HEADINGS` is not needed: reach has no segment modes. Each duplicate carries a one-line pointer to its original. The twin test (§17) pins them.
- An optional `towards?: LatLon` restores the direct-TWA candidate and the distance tie-break. It exists for the twin test only.

### 7.2 Cell map
- Grid: the coarse prune lattice (0.002° × 0.003°) over the mask bounds (`mask.meta.json`: 54.3–55.6°N, 9.4–11.6°E) gives 650 × 734 = 477 100 cells (derived). Encoded as `Uint16Array` of whole minutes after departure, rounded up; `0xFFFF` = not reached. 954 200 bytes, transferred.
- A cell holds the minimum true `tMs` of any surviving node in it.
- **Edge stamping.** Each surviving child also stamps the coarse cells along its segment from the parent, at linearly interpolated times. Reason: one 600 s step at 6 kn is about 1 nm, eight to ten coarse cells (derived), so node-only stamping can leave unstamped cells inside the region. The probe stamped node cells only; the hole fraction and the stamping cost are unmeasured (§19, R1 gate).

### 7.3 Run to drain
- The duration cap acts as the horizon: a child past `departure + duration` is dropped; the loop ends when no frontier node can take one more step within the cap.
- No snapshot at the cap ring. M2: cells reached by T exceed cells stamped by ring T/`dtS` by up to 24.9 % (Flensburg fock, 6 h), and per-cell times drop after their first ring by over 30 min in some runs.
- Progress phases: `expand` while the earliest frontier `tMs` is below the cap, then `drain` (M1: draining added 13–30 % to the nodes expanded at the 10 h ring).

### 7.4 Origin
- Run at the requested gate first. If the run ends with every stamped cell inside `APPROACH_RADIUS_M` (1852 m) of the snapped origin, rerun with `approachGate` around the origin down to `relaxationFloorM(boat)`, the origin-disc analogue of `planRoute`'s #53 tiers. M3: Marstal at 3.0 m died in 7 rings with 11 cells (2 ms); with the disc it reached 2655 nm² in 10 h.
- The result carries `originRelaxed: { floorM } | null`; the card states it (`reach.originRelaxed`).
- Still stranded, or the snap fails: status `stranded` (M3: the Easy Go from Marstal).
- Untested edge: a pocket wider than 1852 m strands outside the disc test, so no rerun happens and the region stays tiny. The card shows it as a normal result.

### 7.5 Horizon
- Effective cap = min(departure + duration, `WindField.horizonMs()`). The `NumberInput` max already prevents exceeding it; the worker clamps again and returns `effectiveDurationMs`.

### 7.6 Budget and partial result
- Deadline from `PLAN_BUDGET_MS` (360 000), checked at ring entry and every `DEADLINE_CHECK_NODES` nodes, as `solve()` does.
- Unlike `solve()`, reach keeps its cell map on expiry and returns it with `complete: false, incompleteReason: 'budget'` and the earliest frontier `tMs` reached.
- Every shaded cell in a partial map is reachable at no later than its shown time: each stamp lies on a navigable path, and edge-stamp times are linear within one step because speed is fixed per step. Unshaded water may also be reachable. So a partial result is shown labelled "mindestens erreichbar" (`reach.partial`), never discarded.
- Frontier cap: `defaultMaxFrontier(meta)`; no ring was truncated in the probe (peak 73 338 vs 95 333). If a ring is truncated, the result is still returned with `complete: false, incompleteReason: 'frontier-cap'`, same copy.
- Timing basis: on the probe machine every single-rig 10 h run drained within 90 s (M1). No tablet figure exists, and CDP CPU throttling is inert on a dedicated Worker (CLAUDE.md), so the tablet check is a real-device pass.

### 7.7 Types
- `ReachRequest`, `ReachResult` and `reachSailIdFor` live in `routing/reach.ts`, not `types.ts` (closure file).

```
ReachRequest  { origin: LatLon; originHarborId: string|null; departureMs; durationMs;
                settings: Settings; sailId: SailId; boat: BoatSnapshot }
ReachResult   { status: 'ok' | 'stranded' | 'beyond-horizon';
                lattice: { south, west, dLat, dLon, rows, cols };
                cellMinutes: Uint16Array; effectiveDurationMs;
                gateM; originRelaxed: { floorM } | null;
                complete: boolean; incompleteReason?: 'budget' | 'frontier-cap';
                frontTMs: number; windFetchedAtMs }
```

## 8. Worker, client, cancel

- `protocol.ts`: new `WorkerRequest` member `{ type: 'reach'; id; request: ReachRequest; boatId; polarKey; windGrid; budgetMs? }`, handled in `createHandler` on the ladder worker. New responses `{ type: 'reachProgress'; id; tMs; frontierSize; phase }` and `{ type: 'reachResult'; id; result }` (cell buffer in the transfer list).
- `workerClient.ts`: `RoutingClient.reach(request, windGrid, onProgress)`, with the same `PLAN_BUDGET_MS` + `PLAN_TIMEOUT_GRACE_MS` deadline, `planLog` start/finish/cancel lines (no coordinates), and the typed `RoutingError` kinds.
- Cancel: `RoutingClient.cancel()` (#1193). It terminates the workers and fails every pending request, so D1 keeps reach exclusive:
  - Reach does not start while App's `runBusy` is true (a plan, or a Live reroute: `App.tsx` ~:1517), a via replan (`state/replan.ts`) is in flight, or a departure scan or confirm runs (DepartureCompare's `busy` rule). The button is disabled with `reach.busy`.
  - While a reach runs, `runBusy` includes it, so `canPlan` is false, and ViaMarkers' drag and the route-line drag are disabled. 1854 §6 keeps ViaMarkers mounted on Wetter, so a via replan could otherwise start mid-reach.
  - Leaving the Wetter tab cancels a running reach. Live reroutes start from LiveView (`App.tsx:handleLiveReroute`, Live tab); plans, scans and confirms from Planen.
  - The next request rebuilds the client through the existing `ensureClient` path.
- Wind: when the held grid is older than `GRID_CACHE_TTL_MS`, the compute press goes through 1854's manual-refresh path ([Vorhersage aktualisieren]), including its 60 s rate-limit cooldown, then computes on the held grid. No new automatic fetch trigger is added. Barbs and reach then share one grid, at the freshness planning uses.
- The hook owning the job sets any cleanup-written ref flag in its setup and its test renders under `<StrictMode>` (CLAUDE.md StrictMode rule).

## 9. Map rendering

- **Layer.** `ReachLayer.tsx`, mounted by ConditionsPanel inside `MapView`. Canvas source `sc-reach` (`animate: false`, the `play()`/`pause()` repaint trick), raster layer `sc-reach-fill`, `raster-resampling: 'nearest'`, installed through `lib/styleReload.ts:installStyleSetup`.
- **Order.** Explicit `beforeId`: the anchor WaveLayer uses for `sc-waves-fill`, added after it, so the stack is depth < sea state < reach < waypoints, harbours, seamarks, AIS < route. `layerOrder.test.tsx` gains rows for it (CLAUDE.md: a new layer is unguarded until it has rows there).
- **Geometry.** 1854 §5's raster geometry: corners from `depthSourceCorners`, rows every second entry of `depthCanvasRowMap`, columns every second mask column. Half resolution unless 1854's gating measurement picked quarter; reach follows that choice.
- **Pixel rule.** A pixel is filled iff its mask cell's depth is at or above the gate (the origin disc's floor inside the disc when `originRelaxed`) and its coarse cell's minutes are ≤ the effective cap. Land and sub-gate water stay transparent. The index (pixel → coarse cell) is built once per mask and cached; a result is one pass.
- **Colour.** One constant `REACH_FILL_COLOR` in `lib/mapColors.ts` at 0.4 opacity. Constraints: outside the depth ramp, the sea-state ramp and the route's sail/motor and port/starboard colours. The candidate is chosen in the daylight verify pass. No outline in D1 (cut-first extra: boundary pixels in ink, same pass).
- **Suppression.** While a result is shown on Wetter, `sc-waves-fill`, its markers, `sc-depth` and `sc-depth-hatch` are hidden, extending 1854 §6's `suppressDepth` term with `reachVisible`. Persisted toggles are not written. The card shows `reach.suppressed` with **[Reichweite ausblenden]** / **[Reichweite zeigen]** (per visit). Barbs stay: they are ink.
- **Off Wetter.** The fill is hidden on every other tab; the result stays in memory.
- **Legend.** One card line with an inline swatch; no map legend, no tier change, no new z-index.

## 10. Harbour list and depth relaxation

- Computed on the main thread from the cell map, `harbors.json` and the cached `NavMask`, with `computeHarborAccess(mask, harbors, boat, gate)` (memoised, `lib/harborReachability.ts`) for classification.
- `ok` harbours: snap with `snapToNavigable(h.snap, gate)`; ETA = that cell's minutes. Listed when ≤ the cap.
- `shallow-approach` harbours: a requested-gate region never contains their last mile (grounding M3). If any cell within `APPROACH_RADIUS_M` of the snap is reached, they are listed in a second group, **Nur mit flacherer Ansteuerung**, with `reach.list.approach`: ETA to the approach and a statement that the last mile is shallower than the gate and not counted. Salona 45: Marstal; Easy Go: Faldsled and Rudkøbing (M3, Flensburg-seed basis).
- `unreachable` and `known-disconnected` harbours, and the origin harbour, are omitted.
- Sort by ETA ascending, then name. ETA via `formatDuration`, rounded up to 10 min, prefixed "ca.", plus the arrival clock time via `formatTime`.
- The ETA comes from the search, not a plan. The handoff's plan can differ either way (M5's non-monotonicity); the notice says so.
- **Handoff.** **[Als Ziel]**: `handlePickDestination(harborToPickedPoint(h, lang))`, `setDepartureMs(result.departureMs)`, `handleTabChange('plan')`, focus `#planner-departure`, announce `reach.handoff.done`. Start is untouched; it is the reach origin (a Start change clears the result, §11). It never plans.

## 11. States

| State | Card | Map |
|---|---|---|
| No Start | `reach.noStart` + [Start im Planer wählen] | — |
| No wind grid held (1854 loading) | Skeleton; button disabled | — |
| Ready, nothing computed | inputs, assumptions, [Reichweite berechnen] | — |
| Busy (plan, Live reroute, via replan, scan or confirm running) | `reach.busy`; button disabled | — |
| Computing | progress text + `<progress>`, [Reichweitenberechnung abbrechen] | — |
| Cancelled (button or tab leave) | `reach.cancelled`; previous result, if any, stays | previous fill |
| Done | summary, legend, notice, suppression line, lists | fill |
| Partial (budget or frontier cap) | `reach.partial` (warning style) above the lists | fill |
| Stranded | `reach.stranded` | — |
| No harbour in range | `reach.list.none`; fill still shown | fill |
| Short horizon | `reach.horizon.short` (effective duration) | fill |
| < 1 h of forecast left | `reach.horizon.none`; button disabled | — |
| Stale (hour, duration, boat, sails, settings or grid changed) | `reach.stale`; [Neu berechnen]; rows stay usable | fill |
| Start changed | result cleared | fill removed |
| Offline, nothing computed | `reach.offline`; button disabled | — |
| Offline, result held | result with `reach.ageLine`; `reach.offline` next to the disabled button | fill |
| Worker failure | typed `RoutingError` key via the existing `ROUTING_FAILURE_MESSAGE_KEY` map | — |

A disabled button always has its reason as visible text next to it.

## 12. Offline posture

- The #1854 ruling (2026-10-28) forbids planning from the Wetter session grid offline; its clarification keeps showing a held forecast with its age. D1 reads a reach compute as planning: it is a solver run whose output (ETAs) feeds a plan. So reach computes only online, on a grid within `GRID_CACHE_TTL_MS`, the planner's freshness.
- A result computed online stays visible offline with its forecast fetch time, like a held forecast: display, not planning.
- 1854 §12's "it computes in the worker, so it can work offline" predates the ruling; D1 supersedes it. This is put to the maintainer (§21), not settled here.

## 13. What it shares with #1854

| 1854 surface | Use |
|---|---|
| Wetter tab and card stack | The reach Disclosure is the second card |
| `state/conditionsHour.ts` | Departure; stale on change |
| `state/useAreaForecast.ts` held wind grid | Compute input; refreshed past the TTL |
| §5 raster geometry, repaint trick, `nearest` | `sc-reach-fill` |
| §6 depth suppression term | Extended with `reachVisible`, plus sea-state hiding |
| §11 handoff and focus rule | [Als Ziel] row handoff |
| §9 polite region | Reach announcements |

Not shared after slice 1: the harbour popup and [Als Start]/[Als Ziel]; the place lines. A later slice can add "erreichbar in ca. 3 h 40" to the popup from the same cell map.

## 14. Copy (de / en, `satisfies` parity)

| Key | DE | EN |
|---|---|---|
| reach.title | Erreichbar ab {start} | Reachable from {start} |
| reach.title.noStart | Erreichbarkeit | Reach from a start |
| reach.noStart | Für die Reichweite braucht der Planer einen Start. | The reachable area needs a start in the planner. |
| reach.chooseStart | Start im Planer wählen | Choose start in planner |
| reach.departure | Abfahrt {datetime} (Uhrzeit oben) | Departure {datetime} (time above) |
| reach.duration.label | Höchstdauer (h) | Maximum duration (h) |
| reach.assumes | Annahme: {sail} die ganze Fahrt · {motor} · Tiefe ≥ {gate} | Assumes {sail} all the way · {motor} · depth ≥ {gate} |
| reach.motor.on / .off | mit Motor / ohne Motor | motor on / motor off |
| reach.compute / .recompute | Reichweite berechnen / Neu berechnen | Calculate reachable area / Recalculate |
| reach.cancel | Reichweitenberechnung abbrechen | Cancel reachable-area calculation |
| reach.progress | Berechnet bis +{elapsed} von {duration} … | Searched to +{elapsed} of {duration} … |
| reach.progress.drain | Ergebnis wird abgeschlossen … | Finishing the result … |
| reach.legend | In höchstens {duration} erreichbares Wasser ab {datetime} | Water reachable within {duration} from {datetime} |
| reach.notice | Planungshilfe aus der Vorhersage (abgerufen {time}). Gezeigt ist, was diese Suche findet, nicht jede mögliche Fahrt; „Route planen“ kann abweichen. | Planning aid from the forecast (fetched {time}). It shows what this search finds, not every possible passage; "Plan route" may differ. |
| reach.partial | Rechenzeit überschritten (Suche bis +{elapsed}). Gezeigtes Wasser ist mindestens erreichbar; weiteres vielleicht auch. | Time limit reached (searched to +{elapsed}). The water shown is reachable at least; more may be. |
| reach.originRelaxed | Ausfahrt aus {start}: im Umkreis von 1 sm Wasser ab {floor} zugelassen, unter der Sicherheitstiefe {gate}. | Leaving {start}: water from {floor} allowed within 1 nm, below the safety depth {gate}. |
| reach.stranded | Von {start} aus findet die Suche kein Wasser mit ausreichender Tiefe. | From {start} the search finds no water deep enough. |
| reach.horizon.short | Die Vorhersage reicht bis {end}; berechnet für {effective}. | The forecast ends {end}; calculated for {effective}. |
| reach.horizon.none | Für diese Abfahrt bleibt weniger als 1 h Vorhersage. | Less than 1 h of forecast is left for this departure. |
| reach.offline | Offline: Die Reichweite braucht eine aktuelle Vorhersage, wie die Routenplanung. | Offline: the reachable area needs a current forecast, like route planning. |
| reach.busy | Eine Routenberechnung läuft gerade. | A route calculation is running. |
| reach.cancelled | Berechnung abgebrochen. | Calculation cancelled. |
| reach.stale | Berechnet für {datetime}, {duration}; die Eingaben haben sich seitdem geändert. | Calculated for {datetime}, {duration}; the inputs have changed since. |
| reach.ageLine | Vorhersage abgerufen {time} ({age}). | Forecast fetched {time} ({age}). |
| reach.suppressed | Seegang und Wassertiefen sind ausgeblendet, solange die Reichweite angezeigt wird. | Sea state and depths are hidden while the reachable area is shown. |
| reach.hide / .show | Reichweite ausblenden / Reichweite zeigen | Hide reachable area / Show reachable area |
| reach.list.title | Häfen nach Ankunft | Harbours by arrival |
| reach.list.count | {count} Häfen erreichbar | {count} harbours reachable |
| reach.list.eta | ca. {duration} · an {time} | about {duration} · arrive {time} |
| reach.list.approachTitle | Nur mit flacherer Ansteuerung | Only with a shallower approach |
| reach.list.approach | Ansteuerung in ca. {duration}; die letzte Seemeile ist flacher als {gate} und nicht eingerechnet. | Approach in about {duration}; the last mile is shallower than {gate} and not counted. |
| reach.list.none | In dieser Zeit ist kein Hafen erreichbar. | No harbour is reachable in this time. |
| reach.list.asDestination | Als Ziel | As destination |
| reach.list.asDestination.aria | Als Ziel: {harbour}, ca. {duration} | As destination: {harbour}, about {duration} |
| reach.handoff.done | Ziel {harbour} und Abfahrt {datetime} übernommen. | Destination {harbour} and departure {datetime} set. |
| reach.done.announce | Reichweite berechnet: {count} Häfen. | Reachable area calculated: {count} harbours. |

Numbers through `formatDuration`, `formatTime`, `formatDateTime`, `formatLatLon` and the depth formatter the planner uses. Changelog fragment `changelog.d/1855.added.md`, ending "(#1855).".

## 15. Accessibility and the 820 px floor

- **Targets.** Disclosure summary, NumberInput, compute/cancel, hide/show and every [Als Ziel] are ≥ 44 px tall; rows are ≥ 44 px.
- **Semantics.** The lists are `<ul>`s under headings. [Als Ziel]'s accessible name starts with its visible text (WCAG 2.5.3). `<progress>` carries `aria-valuetext` = the progress copy. The map fill is not keyboard-reachable; the list and the summary are the keyboard and screen-reader path.
- **Announcements.** 1854's polite region announces start, done (`reach.done.announce`), cancelled, partial and the handoff. Progress ticks are not announced.
- **Focus.** Never moved by a result. Opening the Disclosure scrolls it into view (`block: 'nearest'`); the handoff focuses per §10.
- **Colour.** Not the only carrier: the legend line, summary and ETAs are text. Tokens only (`--sc-*`) in `app.css`, `.reach-*` rules; the swatch reads `REACH_FILL_COLOR`.
- **820 narrow.** The conditions card already fills the sheet (1854 §3 estimate 609–641 px against a 649 px cap), so the reach card starts below the fold; the panel scrolls, and 1854's sticky hour row stays visible. Opened reach card, estimate before the list: summary 44, departure 22, duration 44, assumptions 44, button 44, legend 22, notice 44, suppression 44, gaps → about 400 px plus 44 per row.
- **Wide.** At 390 px the row wraps (§3). The panel resizer applies unchanged.
- **Name collisions.** Within the card, the EN no-Start title avoids "Reachable area", which would be a substring of "Calculate/Hide/Show reachable area". "erreichbar"/"reachable" occur in `boat.*`, `harborPicker.*` and `error.*` strings; "Abbrechen" occurs on three buttons, and `planner.cancel` is "Routenberechnung abbrechen" (not a substring of the reach cancel). "Als Ziel" will meet the later 1854 popup's [Als Ziel]. New specs use role-scoped locators with `exact: true` and row-scoped queries.

## 16. Sweep consequences

- Touched: new `routing/reach.ts`, `components/ReachCard.tsx`, `components/ReachLayer.tsx`, `lib/reachRaster.ts`, `lib/reachHarbours.ts`, `state/useReach.ts`, `state/reachResult.ts`; changed `routing/protocol.ts`, `routing/workerClient.ts`, `components/ConditionsPanel.tsx`, `components/DataLayers.tsx` (`reachVisible`), WaveLayer's visibility, `lib/mapColors.ts`, `App.tsx` (handoff), dicts, `app.css`.
- Not touched: `isochrone.ts`, `planRoute.ts`, `types.ts`, `lib/mask.ts`, `lib/wind.ts`, `test/setup.ts`. Grounding §3: `reach.ts`, `protocol.ts` and `workerClient.ts` are NOT_IN_CLOSURE at `32f67af0`; the closure walks outward, so `reach.ts` importing `isochrone.ts` does not join it.
- Expected verdict NOT OWED; confirm with `closure.mjs diff <merge-base> <head>` per PR. `mapColors.ts`, `DataLayers.tsx` and the new files need that check too.
- The duplicated prune constants are the price of NOT OWED (§20 lists the export alternative).

## 17. Testing

**Unit, `routing/reach.test.ts` (synthetic masks, always in CI):**
- Twin: with `towards`, reach's per-ring frontier sizes equal `solve()`'s `onProgress` sizes (the probe's fidelity control, which matched over 12 rings on the real mask). `solve()` shortens `dtS` below 5 nm from the destination while reach keeps 600 s, so only rings whose every node is ≥ 5 nm from `towards` are compared; the mask is sized for that. The mask includes a confined channel, so `pruneCellConfined`'s finer keys are exercised. Mutation: change `CONFINED_PRUNE_DIV` in reach and the twin reds; a positive control confirms the compared rings contain confined keys.
- Open-water disc, motor only: reached radius within one step of `motorSpeedKn` × duration.
- A land wall and a sub-gate shoal leave cells behind them unreached.
- Drain: the final map equals a run with an extra empty ring; a snapshot at the cap ring differs (positive control for §7.3).
- Edge stamping: no unstamped cell inside a uniform open-water region (measures the hole rule).
- Origin disc: a pocketed origin strands at the gate and reaches beyond the disc with it; a fully landlocked origin returns `stranded`.
- Deadline: an injected clock expires mid-run; result `complete: false`, cells non-empty, every stamped cell ≤ cap.
- Horizon clamp; motor-off calm → only the origin cell; `reachSailIdFor` with genoa ashore.
- Budgets via `SOLVER_TEST_TIMEOUT_MS` / `solverTimeoutMs` (`test/timeouts.ts`).

**Unit, real mask:** `routing/realmask.repro.reach.test.ts`: the 12-ring Flensburg twin on the committed mask (runs when `classify-realmask.sh` sees a routing-closure path, i.e. whenever `isochrone.ts` changes, the case where drift can occur) and a 2 h Flensburg reach whose stamped cells are all water at the gate.

**Unit, UI and glue:**
- `lib/reachRaster.ts`: pixel rule over a fixture mask: water at gate and reached → filled; land, sub-gate, unreached → transparent; disc floor applies only inside the disc. Mutation: drop the gate clip and the sub-gate row reds.
- `lib/reachHarbours.ts`: `ok`/`shallow-approach`/`unreachable`/`known-disconnected` handling over every `harbors.json` entry for each catalogue boat; ETA rounding up; origin harbour omitted.
- `protocol.ts`/`workerClient.ts`: reach message round trip with transfer; partial result; cancel teardown; budget timeout kind; `planLog` lines.
- `ReachCard`: every §11 state, disabled-with-reason, stale on each input, cleared on Start change, focus never moved by a result, StrictMode render.
- `ReachLayer`/`DataLayers`/WaveLayer: layer creation, order and suppression with a per-file size-discriminated `getContext` fake (never in `setup.ts`; `layerOrder.test.tsx` has the pattern); persisted toggles unchanged.
- Handoff: Ziel, departure, tab, focus target, announcement.

**e2e, `reach.spec.ts`:** `?windFixture=` + `?waveFixture=`, duration 2 h to keep CI time short, `STANDARD_VIEWPORTS` ≥ 820 px, both themes. Covers: compute → progress → done; `sc-reach` source added once; list row [Als Ziel] fills Ziel and `#planner-departure`; cancel; offline note with a held result; tab leave cancels. `startPreview()` call sites keep `assertCleanServiceWorkerState` (`startPreviewSwAssertCallSites.test.ts`).

**Real browser (verify skill):** 820x1180 and 1180x820, both themes; fill colour legibility over the basemap; a relaxed-origin run from Marstal; screenshots for the PR.

## 18. Risks

- **Tablet time.** No tablet figure; 10 h single-rig runs took ≤ 90 s on the probe machine (M1). If a tablet exceeds `PLAN_BUDGET_MS`, users get partial maps routinely. Mitigation: R1's real-device check; lower the 10 h max if needed.
- **Search artefacts.** M5's non-superset results and M2's late lowering mean the region is a search product. Copy says so; ETAs carry "ca.".
- **Holes.** Unmeasured; edge stamping is the planned fix and R1 measures it.
- **Memory.** The probe's visited-key count reached 708 160 (Marstal disc, 10 h) on top of the cell map; tablet memory unmeasured.
- **Uniform wind only.** All probe runs used uniform 12 kn and 6 kn fields; gradient behaviour of the region is unmeasured.
- **Single rig.** The fock can reach water the genoa does not (M1). The assumptions line and the two-rig handoff carry this.
- **Duplicated constants.** Drift if `isochrone.ts` changes them; the twin tests catch it when they run.
- **Shared client.** `cancel()` tears down the whole client; D1's exclusivity rule must hold. It depends on disabling via and route-line drags during a reach; a future feature that starts routing from Wetter breaks it.
- **1854 dependency.** D1 needs 1854 slice 1's hour store, `useAreaForecast` and raster geometry merged.

## 19. Implementation slicing (v0.62.0, every PR `Refs #1855`)

- **R1 — `routing/reach.ts` + tests, no UI.** Gating measurements on the probe configs: hole fraction with and without edge stamping, stamping cost, and peak memory. Real-device timing of a 6 h and a 10 h run on the maintainer's tablet. Decides the 10 h max.
- **R2 — worker protocol and client.** Reach message, progress, partial transfer, cancel, budget, `planLog`.
- **R3 — card, layer, list, handoff.** `ReachCard`, `ReachLayer`, `reachRaster`, `reachHarbours`, suppression, copy, `changelog.d/1855.added.md`, e2e, verify-skill screenshots.
- Cut order if R3 runs long: the shallow-approach group (omit those harbours, stating it), then persistence of the duration, then the outline extra.

## 20. Considered and rejected

- **Time bands.** Possible from the drained cell map with a colour table, but they add a legend scale and a second ramp beside depth and sea state. A later slice can add them; ring-index bands are wrong by M2.
- **Both rigs, per-cell minimum.** Truthful per destination, but doubles compute, and on a single-worker client runs in sequence. Rejected for D1's cost; a candidate for a richer design.
- **A sail selector in the card.** One more control at 820 for a choice the planner's two-rig solve makes anyway.
- **Exporting `pruneKey`/`better` from `isochrone.ts`.** Smaller code, but it edits a closure file and owes a sweep (#944's additive-export exemption is deferred).
- **A destination-free mode inside `solve()`.** Edits the closure's core loop; owes a sweep and risks the plan path.
- **Snapshot at the cap ring.** Wrong by up to 24.9 % of cells (M2).
- **Discarding a budget-exhausted run, as `solve()` does.** Loses a truthful lower bound after up to 360 s of work.
- **Offline compute from the held Wetter grid.** Conflicts with the #1854 §11 ruling as D1 reads it (§12).
- **A dedicated reach worker.** Avoids the shared-client teardown, but holds a second mask copy and its own lifecycle code.
- **Letting a reach run while other tabs plan.** One synchronous worker would queue the plan behind the reach, and a cancel would tear down both.
- **Hull, smoothing or neighbour fill of the region.** Shades water the search never reached.
- **Tap inside the area to set a destination.** Raster layers are not queryable, and an arbitrary water point as Ziel adds a picking flow; harbours cover the issue's ask.
- **Auto-planning on [Als Ziel].** Route planen stays the only action that plans (1854 §2).
- **A map legend.** Adds a tier participant; the card line suffices.
- **Persisting the result.** No IndexedDB writes; a reach is cheap to recompute online and meaningless offline beyond the session.

## 21. Questions for the maintainer

1. Is a reach compute "planning" under the #1854 §11 ruling? D1 says yes: no offline compute, held result shown with its age.
2. Show a budget-exhausted partial map labelled "mindestens erreichbar", or show nothing?
3. One rig by the departure-scan rule, stated in the card, with the two-rig solve at handoff: acceptable?
4. Leaving Wetter cancels a running reach: acceptable, or should it keep running and block planning?
5. Maximum duration 10 h until a tablet measurement says otherwise?
