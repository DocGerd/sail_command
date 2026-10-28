# #1855 candidate design D2 — "Map-first bands"

Status: candidate design for the #1855 spike, one of three. It builds on the approved #1854 Wetter design (`docs/spikes/1854-forecast-view-ux.md`, §12) and the probe in `/tmp/s1855/probe/`. Code anchors are `file:symbol` on develop `32f67af0`, paths under `app/src/`. Figures marked M1–M5 come from `/tmp/s1855/grounding.md` §4; everything else marked "estimate" is unmeasured.

## 0. Recommendation in brief

- The reach result is drawn on the map as time bands (default 2 / 4 / 6 h) shaded on navigable water, from a per-cell earliest-arrival map.
- That map comes from a new destination-free expansion, `routing/reach.ts`, which runs until its frontier drains at the duration cap; bands are a post-pass over the drained map, never ring indices (M2).
- Both rigs run, one per worker where the pool allows; each cell shows the earlier of the two, and the tap readout names the rig.
- Cells stream to the map as they become final, so the inner band appears first and a cancel or budget expiry leaves a correct partial area.
- A tap on the shaded area or a reachable harbour gives the ETA and [Als Ziel]; the card's harbour list is the keyboard and screen-reader path to the same action.
- Offline, nothing new is computed (the #1854 §11 ruling); a region already computed this session stays on screen with its forecast's age.

## 1. User flow

1. The skipper opens **Wetter**. Below the conditions card sits the closed Disclosure **Erreichbar ab {Start}** (#1854 §12).
2. Opening it shows: the Start (from the planner), the departure (the card's hour store), a **Höchstdauer** NumberInput in hours, and **[Bereich berechnen]**. While the Disclosure is open, that button is the primary action and "Als Abfahrt übernehmen" demotes to secondary (§12).
3. Pressing it starts the computation. The map shows the 2 h band within the first seconds on this machine (M1: the 2 h ring was stamped after 0.3–1.5 s single-thread), then the 4 h and 6 h bands as they become final. A progress line reads "vollständig bis 2 h 40 von 6 h"; [Bereichsberechnung abbrechen] stops it and keeps what is final.
4. Done: a status line, a band legend, and **Erreichbare Häfen (n)**, sorted by ETA.
5. The skipper taps a shaded point or a harbour (map or list): a readout "ca. 3 h 40 mit Genua · Ankunft Sa 17:40 · davon 1 h 10 unter Motor" with **[Als Ziel]**.
6. [Als Ziel] writes the destination and the reach departure, switches to Planen and focuses **Route planen**. It does not start planning; "Route planen" stays the only action that plans (#1854 §2 step 5).

### Wireframes

```
820x1180 — Wetter, reach computed (narrow; values illustrative)
y0    +--------------------------------------------------------------+
      | SailCommand                                      [EN] [i]    | header T3
y61   +--------------------------------------------------------------+
      |[> Anzeigeoptionen]   \_   \_   barbs at the card's hour      | .map-stack-tl T2
      |(N)     ░░░░░▒▒▒▒▒▓▓▓▓▓▓▓▒▒▒▒░░░░   bands on navigable water |
      |        ░░▒▒▓▓▓▓█ Flensburg █▓▓▒▒░   █ ≤2 h  ▓ ≤4 h  ▒ ≤6 h   |
      |        ░▒▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒░      (legend is in the card)  |
      |[2 sm]  sea state and depth hidden while the area shows       | scale bar
y531  +==== Planen | *Wetter* | Routen | Live | Boot ================+ tabs T3
      | [«] [<]          Sa 14:00 (in 23 h)          [>] [»]         | sticky hour row
      | (conditions card above, scrolled; its actions now secondary) |
      | [v Erreichbar ab Flensburg]                                  | Disclosure
      |   Abfahrt Sa 14:00 (Uhrzeit oben)        [Start ändern]      |
      |   Höchstdauer  [ 6 ] h  (1–10)                               | NumberInput
      |   [ Bereich berechnen ]                                      | primary
      |   Berechnet 14:02 · Vorhersage von 13:05 · Genua und Fock    | status
      |   █ bis 2 h  ▓ bis 4 h  ▒ bis 6 h                            | legend, text
      |   Was diese Suche mit deinen Einstellungen erreicht; außer-  | notice
      |   halb kann Wasser trotzdem erreichbar sein. Planungshilfe.  |
      |   [Erreichbarkeit anzeigen ✓]                                | toggle
      |   [> Erreichbare Häfen (12)]                                 | Disclosure
y1180 +--------------------------------------------------------------+

1180x820 — Wetter, computing (wide, panel 390 px; values illustrative)
+-- panel 390 -----------------++----------- map 779 --------------------+
| Planen *Wetter* Routen Live …||(N)      ░▒▓█ inner bands growing     |
| [«][<] Sa 14:00 (in 23 h)[>][»]|        outer band not yet drawn      |
| …conditions card…            ||                                       |
| [v Erreichbar ab Flensburg]  ||                                       |
|  Abfahrt Sa 14:00            ||                                       |
|  Höchstdauer [ 6 ] h         ||                                       |
|  vollständig bis 2 h 40      ||                                       |
|  von 6 h  [====------]       ||                                       |
|  [Bereichsberechnung         ||                                       |
|   abbrechen]                 ||                                       |
|  [> Erreichbare Häfen (4)]   ||                                       |
+------------------------------++----------------------------------------+

Map popup on a shaded tap (both layouts)
+---------------------------------------------+
| Erreichbar · 54,92° N 9,81° O         [×]   |  close ≥44×44
| ca. 3 h 40 mit Genua · Ankunft Sa 17:40     |
| davon ca. 1 h 10 unter Motor                |
| Aus der Vorhersage berechnet; Planungshilfe.|
| [ Als Ziel ]                                |  ≥44 px
+---------------------------------------------+
```

The narrow heights are estimates: the reach card is about 9 rows of 44 px plus gaps, so it does not fit under the conditions card at 820 (#1854 §3 estimates that card at 609–641 px against a measured 649 px cap). Opening the Disclosure scrolls it to the top of `.app-panel`'s visible area, below the sticky hour row, accounting for the content-box offset CLAUDE.md records for sticky positioning.

## 2. Inputs and defaults

| Input | Source | Default | Notes |
|---|---|---|---|
| Start | planner origin (harbour or point) | — | Read-only line with [Start ändern] (switches to Planen and focuses the Start combobox). Without a Start, the card shows `reach.noStart` and the button stays visible with that note. |
| Abfahrt | `state/conditionsHour.ts` (the card's hour) | the card's hour | One clock on screen: the sticky hour row. Changing it marks a shown result stale; it never recomputes on its own. |
| Höchstdauer | new `NumberInput`, hours, step 1 | 6 h | Range 1–10 h: 10 h is the longest cap the probe measured (M1). Persisted with `lib/usePersistedNumber.ts`. |
| Boat, sails aboard, depth gate, comfort margin, motor settings | the planner's current settings | as in Planen | Shown as one line, `reach.settingsLine`, with a pointer to the Boot tab. Not editable in the card. |

- The bands' width is `w = ceil(D / 4)` hours; edges are `w, 2w, …` below D, plus D. So 6 h gives 2 / 4 / 6, 10 h gives 3 / 6 / 9 / 10, and at most four bands are drawn.
- The effective cap is `min(departure + D, wind.horizonMs())`. If the horizon cuts it, the card says so (`reach.horizon.clamped`) and never advises another departure (CLAUDE.md, beyond-horizon rule).

## 3. Map rendering

- **Layer.** One canvas raster source and layer, `sc-reach-fill`, a sibling of `sc-waves-fill` with an explicit `beforeId` (the bottom of the harbour/waypoint stack, as `sc-waves-fill` is anchored today). Same geometry as the #1854 sea-state raster: corners from `lib/depthColor.ts:depthSourceCorners`, rows as every second entry of `depthCanvasRowMap`, every second mask column, `raster-resampling: 'nearest'`, repainted with the `play()`/`pause()` trick. `layerOrder.test.tsx` gains rows for it.
- **Pixel rule.** A pixel is coloured if its mask cell is navigable at the effective gate (`gateAtCell` on the run's `DepthGate`, so the origin disc is honoured) and its reach cell holds an arrival at or before the drained time. The reach cell of a pixel is `rowCell[r] * cols + colCell[c]`: two small lookup arrays built once per mask, because the reach grid is axis-aligned in lat/lon.
- **Reach grid.** The solver's coarse prune grid, 0.002° x 0.003° (`PRUNE_LAT`, `PRUNE_LON`; comments give ~220 m x ~190 m). Over the mask bounds (54.3–55.6°N, 9.4–11.6°E) that is 650 x 734 cells (derived), held as a `Float32Array` of minutes after departure plus a `Uint8Array` rig index and a `Uint16Array` motor minutes.
- **Palette.** A single-hue sequential ramp, soonest band darkest. All seven Okabe-Ito hues already carry meaning on this map (`lib/mapColors.ts`: port, starboard, via, boat, origin, destination, depth warning), depth uses vermillion → yellow → blues (`lib/depthColor.ts` STOPS) and sea state pale bands, so the candidate is a violet ramp, alpha from 0.45 (`WAVE_FILL_OPACITY` parity) at the first band to about 0.2 at the last. The exact values are validated in the implementing PR against both basemap themes; none is fixed here.
- **Interplay while the area shows (Wetter only).**
  - Sea-state fill and its markers are hidden; depth stays suppressed as on Wetter (#1854 §6). Two area fills do not read together (§12).
  - Barbs stay, at the card's hour.
  - A loaded route keeps its #1854 Wetter styling (dashed, 0.45) and paints above the bands.
  - `Erreichbarkeit anzeigen` (card toggle, per visit, not persisted) hides the bands and brings sea state back without discarding the result.
  - On every other tab the reach layer is hidden; the result stays in session state.
- **Legend.** In the card only, as text plus swatches (`reach.legend.band`), like #1854's legends. No new map chrome, no new z-index; the tier comment above `.app-header` does not change.
- **Isolines (later slice).** Band edges as a vector `line` layer from marching squares over the reach grid, ink with a halo, no labels (labels would join the collision index #378 manages).
- **Paint cost.** One pass over the half-resolution raster per repaint. Streaming repaints are coalesced to at most two per second. Its cost is unmeasured; the #1854 gating method (main thread, 4x CDP CPU throttle) applies.

## 4. Taps and handoff

- Raster layers are not queryable, so taps go through the map-level click #1854 §5 introduces, with one shared lookup `reachCellAt(lngLat)` into the reach grid.
- **Open water, shaded:** the popup in §1 (ETA, rig, arrival clock time, motor share, notice, [Als Ziel]). [Als Ziel] picks a point destination, as a map pick does today; `{name}` in the announcement then reads `reach.pointName`.
- **Open water, not shaded:** no reach popup; #1854's "Vorhersage hier" opens as usual.
- **Harbour:** the harbour's own popup gains the line `reach.popup.harbour` ("erreichbar in ca. 3 h 40 mit Genua"). Its ETA is the reach cell at the harbour's `snap`.
- **Dependency.** The harbour popup with [Als Start]/[Als Ziel] is not in #1854 slice 1 (ruling, 2026-10-28). If it has not shipped when reach does, the reach slice ships the shared map-level click and popup owner (#1854 §5's design) itself; the harbour list in the card does not depend on it.
- **[Als Ziel]** (popup or list row) writes the destination, sets the departure to the reach departure (the result's, not the card's current hour if that has moved since), switches to Planen, focuses Route planen and announces `reach.toDestination.done`. Writing both keeps the plan on the inputs the area was computed for.
- Today's guards keep winning over the click: an armed pick, a marker target, seamark, AIS, waypoint and route-hit features (`WaveLayer.tsx` click guards).

## 5. Compute

### 5.1 `routing/reach.ts`

- A destination-free expansion re-implementing `solve()`'s ring loop, as the probe's `reach()` does: the `sailCandidates` TWA set (or forced-motor headings), `edgeFactor`, the half/quarter/eighth substep retry, one node per prune key per ring, `visitedDominates`/`stampVisited`, the frontier cap `defaultMaxFrontier(mask.meta)`. `dtS` is fixed at 600 s; there is no direct-TWA candidate and no distance tie-break.
- **It is a stepper, not a loop:** `createReach(params)` returns an object whose `step()` runs one ring and returns the cells that became final. The worker yields between rings, which gives a message-based cancel and lets one worker alternate two rigs.
- **Cells are stamped along every accepted edge,** not only at node positions: a coarse-grid DDA from parent to child stamps each crossed cell with the linearly interpolated arrival time, if earlier than its current value, and the edge's rig and motor time. Every generated child of a navigable edge is stamped, including children later pruned: a pruned child is still a reachable state, and its `tMs` can be lower than the survivor's, since dominance ranks on `costMs` (M2 lists this mechanism). Node-only stamping would leave gaps between nodes about a step apart; the gap rate of either method is unmeasured (§11).
- **Finality.** Every future stamp descends from the current frontier, and a child's time is never earlier than its parent's. So after each ring, every cell whose time is at or before the frontier's earliest `tMs` is final for this search. `step()` returns those newly final cells and `drainedToMs` = that earliest `tMs`. This is the progress figure and the partial-result boundary. Ring indices are never used for bands (M2: ring snapshots miss 9.8–24.9 % of the cells finally reached by 6 h in three of five configurations).
- **Cap.** A child past the cap stamps the part of its edge before the cap and is then dropped. The run ends when the frontier is empty, so the outermost band is drained too (M1: draining adds 13–30 % of the nodes expanded up to the 10 h ring).
- **Motor time.** Each node carries its accumulated motor milliseconds, one more number per node; the stamped cell keeps the value of its earliest arrival.
- **Reuse.** It imports `sailCandidates`, `edgeFactor`, `pruneCellConfined`, `visitedDominates`, `stampVisited`, `defaultMaxFrontier` and `DEADLINE_CHECK_NODES` from `isochrone.ts`. `pruneKey`, `better`, `FORCED_MOTOR_HEADINGS` and the prune and confinement constants are not exported; reach.ts mirrors them (§5.6).

### 5.2 Rig policy

- Every rig in the plan request's sail list for the boat (the planner's "Sails aboard") is expanded independently. Each reach cell shows the earliest arrival over the rigs and records which rig gave it.
- The area is therefore "reachable with at least one of your sails". The popup and the harbour list name the rig, so the skipper knows which sail the ETA assumes; the plan after [Als Ziel] runs both rigs and recommends one as today (`planRoute.ts:compareRigs`).
- **Workers.** `defaultPoolSize()` is max(1, min(2, cores − 1)). With two workers each runs one rig. With one, it alternates `step()` calls between the rigs, so both advance together and a budget cut hits both at about the same elapsed time.
- **Shown boundary.** The displayed drained time is the minimum of the rigs' `drainedToMs`; a cell is shown once both rigs have drained past its time. If one rig finishes and the other is cut, the area is shown to the common time, and the status names both: `reach.status.rigsPartial` ("Genua vollständig bis 6 h, Fock bis 3 h 20; Bänder bis 3 h 20").

### 5.3 Motor and comfort

- Motor follows the planner's `settings.motorEnabled`, speed, threshold and sail preference, as a plan does. There is no reach-only motor switch.
- The popup and list show the motor share of the earliest arrival.
- Comfort: as planRoute's tier 1, `comfortDepthM` = gate + `depthComfortMarginM`. There is no comfort-off retry, because there is no failure to retry.
- **Honesty.** M5 shows the region is what this search reaches, not everything reachable: at 12 kn the motor-off area exceeded the motor-on area (1 284 vs 1 228 nm²), and at 6 kn motor-on reached 0 nm in two sectors where motor-only reached 12.9 and 17.0 nm. The notice line says so (`reach.notice`), and the copy never says "alles Erreichbare".

### 5.4 Depth gate, origin and destination

- **Gate.** The requested `safetyDepthM`, as a plan's tier 1.
- **Pocketed origin.** Before the run, `mask.cellsConnected(origin, SEED_POINT, uniformGate(gate))` (`lib/harborReachability.ts:SEED_POINT`). If it fails and the same test with an origin `approachGate` at `relaxationFloorM(boat)`, radius `APPROACH_RADIUS_M` (1852 m), passes, the run uses that origin disc. M3: Marstal at 3.0 m died in 7 rings with 11 cells; with the disc it reached 2 655 nm² in 10 h. The card then shows `reach.originRelaxed` with the floor depth, the same disclosure class as the shallow banner. With neither, `reach.originBlocked`.
- The disc is applied only when needed, not always: it lowers the gate within 1 852 m of any origin, which a plan does only after a failed tier.
- **Destination side.** No destination disc exists, so a harbour whose approach needs #53 relaxation is never inside the requested-gate area (Salona 45: Marstal; Easy Go: also Faldsled and Rudkøbing, M3). The list classifies harbours with `computeHarborAccess` for the boat. A `shallow-approach` harbour within `APPROACH_RADIUS_M` of a shaded cell is listed as `reach.harbour.shallow` ("Zufahrt nur mit verringerter Tiefe; Ansteuerung in ca. 4 h 10"), with the ETA of the nearest shaded cell. [Als Ziel] stays available; planRoute's relaxation decides the actual approach.
- `known-disconnected` and `unreachable` harbours are never listed.
- **Snap.** The origin is snapped as planRoute does (`mask.snapToNavigable(p, gate)`).

### 5.5 Budget, cancel and horizon

- **Budget.** The reach worker owns its deadline, `REACH_BUDGET_MS` = `PLAN_BUDGET_MS` (360 000), checked between rings and every `DEADLINE_CHECK_NODES` nodes. Unlike `solve()`, expiry keeps the cell map: the result is `{ partial: true, drainedToMs }`.
- **Partial result.** Bands are drawn only up to `drainedToMs`; no band past it is drawn, not even partly. The status shows `reach.status.budget` ("Rechenzeit erschöpft: vollständig bis 4 h 20") with a suggestion of a shorter Höchstdauer, never of another departure.
- **Expected cost.** M1, this machine, single thread, under load: one rig to a drained 10 h cap took 54–90 s, at most a quarter of the budget. It depends on the origin (Sønderborg's 6 h front: 671 203 nodes; Flensburg's: 251 882). No ring hit the frontier cap. Tablet timing is unmeasured.
- **Cancel.** [Bereichsberechnung abbrechen] posts `cancel`; the worker stops at its next yield. Cancel latency is one ring. On this machine, Flensburg genoa averaged about 0.95 s per ring over 10 h (56.9 s, 60 rings) but about 2.2 s per ring between 8 h and 10 h (30.8 s at ring 48, 56.9 s at ring 60), where late cancels land. The final cells stay shown, labelled `reach.status.cancelled`.
- **Horizon.** The cap is clamped to the wind grid's horizon (§2). A departure at or past the horizon disables nothing; pressing [Bereich berechnen] shows `reach.horizon.none`.

### 5.6 Placement and the #282 sweep

- **New files, all outside the sweep closure.** `routing/reach.ts`, `routing/reachProtocol.ts`, `routing/reachWorker.ts` (a dedicated worker entry), `routing/reachClient.ts`. The grounding records `routing/reach.ts` as NOT_IN_CLOSURE at `32f67af0`; the others must be confirmed with `closure.mjs files`, and the PRs with `closure.mjs diff <merge-base> <head>`.
- **Mirror, don't export.** Exporting `pruneKey` and the constants from `isochrone.ts` edits a closure file and owes a sweep (an additive export is not yet read as NOT OWED; #944 was deferred). Reach.ts mirrors them, and two guards pin the copy:
  - a source-scanning twin test reads `isochrone.ts` (`sourceStrip.ts` with `assertNonVacuousStrip`) and pins `PRUNE_LAT`, `PRUNE_LON`, `CONFINED_PRUNE_DIV`, `MOTOR_OFF_CONFINED_PRUNE_DIV`, `CONFINEMENT_MARGIN_CELLS`, `MIN_SAIL_KN` and the forced-motor heading set against reach.ts;
  - a differential test: reach.ts in a `towards` mode (direct-TWA candidate and distance tie-break restored) reproduces `solve()`'s per-ring frontier sizes over 12 rings from Flensburg toward Marstal, the probe's fidelity control.
- **A refactor of `solve()` to share one ring kernel** is deferred: it owes a sweep and risks the solver's hottest path for no user-visible gain. It can be done later with its own sweep.
- **Own client, own workers.** `RoutingClient.cancel()` terminates the shared workers and kills a plan in flight, and a reach run would block plan requests on the same worker. `ReachClient` therefore spawns its own worker(s), lazily on the first press, kept for the session. Cost: one more mask copy per reach worker (`mask.bin` is 9 438 000 bytes) plus the polars. Starting a plan cancels a running reach (two solvers would contend for the tablet's cores). While a plan runs, a press on [Bereich berechnen] starts nothing and shows `reach.planRunning`.
- **Protocol.** `init` (mask buffer copy, polars), `reach` (origin, departure, cap, settings, boat, rig list, wind grid, run id), `cancel`. Responses: `cells` (transferred `Uint32Array` cell ids, `Float32Array` minutes, `Uint8Array` rig, `Uint16Array` motor minutes, `drainedToMs` per rig), `done`, `failed` (typed kinds, as `RoutingFailureKind`).
- The wind grid is cloned, never transferred (CLAUDE.md convention).

## 6. States

A polite region announces transitions; `role="alert"` is used only when nothing is shown.

| State | Card | Map |
|---|---|---|
| Closed Disclosure | — | nothing |
| No Start | `reach.noStart`, [Start ändern] | nothing |
| Ready, nothing computed | inputs + [Bereich berechnen] | nothing |
| Computing | progress line + bar, cancel button | bands grow, inner first |
| Done | status, legend, notice, toggle, harbour list | bands |
| Done, inputs changed since | `reach.stale` (names the changed input); button re-enabled | old bands at reduced contrast until recomputed |
| Partial: budget / cancelled / one rig cut | `reach.status.budget` / `.cancelled` / `.rigsPartial` | bands to the drained time |
| No reachable water | `reach.empty` (origin cell only) | nothing |
| Origin relaxed / blocked | `reach.originRelaxed` / `reach.originBlocked` | bands / nothing |
| Horizon clamps the cap | `reach.horizon.clamped` | bands to the horizon |
| No forecast left | `reach.horizon.none` | nothing |
| Offline, nothing computed | `reach.offline`; button `aria-disabled` with the note | nothing |
| Offline, result held | result kept with `reach.status.age`; `reach.offline` replaces the button | bands |
| Plan running | `reach.planRunning` on press | unchanged |
| Worker failure | `reach.error` with the typed kind | partial bands, if any, kept and labelled |
| Mask not loaded | `conditions.maskMissing` (#1854) | nothing |

## 7. Offline posture

- The 2026-10-28 ruling and its clarification forbid planning from the Wetter session grid offline, while a held forecast may still be shown with its age.
- A reach computation runs the solver from an origin under a forecast, so this design treats it as planning: offline, it is not started.
- A result computed online this session is a held, derived result, so it stays on screen offline with "Berechnet {time} mit der Vorhersage von {fetched}" (`reach.status.age`).
- This supersedes #1854 §12's "it computes in the worker, so it can work offline with the grid's age shown". The maintainer rules on this; §13 lists it.
- **Online grid.** The area is computed on `useAreaForecast`'s held grid, the one the barbs and the status chip show. If that grid is past the 10-minute TTL, the press first triggers the hook's refresh (which updates barbs and chip too) and computes on the refreshed grid, so the card and the area share one `fetchedAtMs`. Nothing is written to IndexedDB, the service worker does not change, and no `DB_VERSION` bump is needed.

## 8. Shared Wetter surfaces

| #1854 surface | Use here |
|---|---|
| `state/conditionsHour.ts` | departure; the sticky hour row is the only clock |
| `state/useAreaForecast.ts` held grid and status chip | the grid the area is computed on; a press past the TTL refreshes it through the hook first (§7) |
| Canvas raster pipeline (§5) | `sc-reach-fill` geometry, nearest resampling, repaint |
| Map-level click + popup owner (§5 Popup, later slice) | `reachCellAt` lookup; reach line in the harbour popup |
| DataLayers `suppressDepth` / WaveLayer visibility | sea state hidden while bands show |
| Handoff pattern (§11) | [Als Ziel] sets destination + departure, switches tab, focuses, announces |
| Polite region, `mapWindError` | status transitions; wind fetch errors |

Whether "Wetter" still names the tab once it holds reach is left to the maintainer (§13); this design keeps it.

## 9. Accessibility and tablet floor

- **Keyboard and screen readers.** Map taps are not keyboard-reachable, so the harbour list is the full path: a `<ul>` whose `<li>` rows carry the harbour, ETA, rig and motor share as text, each with one ≥44 px [Als Ziel] button whose accessible name is its visible text plus the harbour name (WCAG 2.5.3). Rows are not buttons, so no control is nested in another. Open-water points have no keyboard path; the list is the accessible substitute. Point destinations stay available through Planen.
- **Progress.** A native `<progress>` with `aria-valuetext` = `reach.progress` ("vollständig bis 2 h 40 von 6 h"). The polite region announces start, done, partial and cancelled, not each ring.
- **Colour is never the only carrier:** band names and times appear in the legend, popup and list; the later isolines add a non-colour edge.
- **Targets.** NumberInput, buttons, toggle and list rows ≥44 px; the popup close ≥44×44 (#1854 §5 rule).
- **Tablet ≥820.** Wide: the card sits in the 390 px panel at 1180x820. Narrow 820: the Disclosure scrolls into view under the sticky hour row (§1). The band area is usually larger than the ~470 px of map above the sheet (#1854 §3, measured); a [Bereich zeigen] button (later slice) fits the area with `measureChrome()` padding and `bearing: map.getBearing()`, `duration: 0`. There is no automatic fit (#1854 §15 rejects moving the camera unasked).
- **Focus** moves only on user actions: [Als Ziel] → Route planen; the compute button keeps focus and the cancel button takes its place in the same row, so focus moves to it.
- StrictMode: any ref written in a cleanup is also set in setup, and the card's tests render under `<StrictMode>`.

## 10. Copy (de / en; durations via `lib/format.ts:formatDuration`, distances via `formatNm`)

| Key | DE | EN |
|---|---|---|
| reach.title | Erreichbar ab {start} | Reachable from {start} |
| reach.maxDuration | Höchstdauer | Maximum duration |
| reach.compute | Bereich berechnen | Compute area |
| reach.cancel | Bereichsberechnung abbrechen | Stop area calculation |
| reach.progress | vollständig bis {done} von {cap} | complete to {done} of {cap} |
| reach.legend.band | bis {h} h | up to {h} h |
| reach.notice | Was diese Suche mit deinen Einstellungen erreicht; außerhalb kann Wasser trotzdem erreichbar sein. Aus der Vorhersage berechnet – eine Planungshilfe. | What this search reaches with your settings; water outside may still be reachable. Derived from the forecast – a planning aid. |
| reach.settingsLine | {boat} · Sicherheitstiefe {depth} m · Motor {motor} | {boat} · safety depth {depth} m · engine {motor} |
| reach.popup.eta | ca. {duration} mit {sail} · Ankunft {time} | about {duration} with {sail} · arrival {time} |
| reach.popup.motor | davon ca. {duration} unter Motor | of which about {duration} under engine |
| reach.popup.harbour | erreichbar in ca. {duration} mit {sail} | reachable in about {duration} with {sail} |
| reach.toDestination | Als Ziel | Set as destination |
| reach.toDestination.done | Ziel {name} und Abfahrt {time} übernommen. | Destination {name} and departure {time} set. |
| reach.pointName | Punkt auf der Karte | Point on the map |
| reach.planRunning | Während eine Route berechnet wird, startet keine Bereichsberechnung. | No area calculation starts while a route is being planned. |
| reach.harbours | Erreichbare Häfen ({n}) | Reachable harbours ({n}) |
| reach.harbour.shallow | Zufahrt nur mit verringerter Tiefe; Ansteuerung in ca. {duration} | Approach only at a reduced depth; approach area in about {duration} |
| reach.status.done | Berechnet {time} · Vorhersage von {fetched} · {sails} | Computed {time} · forecast from {fetched} · {sails} |
| reach.status.age | Berechnet {time} mit der Vorhersage von {fetched} | Computed {time} with the forecast from {fetched} |
| reach.status.budget | Rechenzeit erschöpft: vollständig bis {done}. Eine kürzere Höchstdauer rechnet schneller. | Time limit reached: complete to {done}. A shorter maximum duration computes faster. |
| reach.status.cancelled | Abgebrochen: vollständig bis {done} | Stopped: complete to {done} |
| reach.status.rigsPartial | {sailA} vollständig bis {a}, {sailB} bis {b}; Bänder bis {b} | {sailA} complete to {a}, {sailB} to {b}; bands to {b} |
| reach.stale | Das Ergebnis gilt für {what} von vorher. | This result is for the previous {what}. |
| reach.empty | Von diesem Start aus erreicht die Suche kein Wasser. | From this start the search reaches no water. |
| reach.originRelaxed | Ausfahrt aus {start} nur mit {depth} m Sicherheitstiefe in den ersten 1 sm. | Leaving {start} only at a {depth} m safety depth within the first 1 nm. |
| reach.originBlocked | {start} ist mit {boat} bei {depth} m nicht ans Revier angebunden. | {start} is not connected to the area with {boat} at {depth} m. |
| reach.horizon.clamped | Die Vorhersage reicht nur bis {time}; Bereich bis {done}. | The forecast ends at {time}; area to {done}. |
| reach.horizon.none | Für diese Abfahrt liegt keine Vorhersage mehr vor. | No forecast is left for this departure. |
| reach.offline | Offline wird kein neuer Bereich berechnet. | No new area is computed offline. |
| reach.noStart | Wähle zuerst einen Start. | Choose a start first. |
| reach.startChange | Start ändern | Change start |
| reach.visible | Erreichbarkeit anzeigen | Show reachable area |
| reach.error | Der Bereich konnte nicht berechnet werden ({reason}). | The area could not be computed ({reason}). |

**Name collisions,** checked in both languages against the dicts at develop:
- "Bereichsberechnung abbrechen" vs `planner.cancel` "Routenberechnung abbrechen": neither contains the other. A bare "Berechnung abbrechen" would be a substring of `planner.cancel`, so it is not used. "Stop area calculation" vs "Cancel route planning", "Stop live view", "Stop replanning": no containment.
- "Als Ziel" vs "Ziel" region names: a different role, as #1854 §9 records for the same label.
- "Höchstdauer" vs `route.totals.duration` "Dauer": "Höchstdauer" contains "dauer" case-insensitively. The only `app/e2e` "Dauer" site at develop is a `.route-legs thead th` text list (`panel-resize.spec.ts`), scoped to the legs table, so no locator collides; a new spec matching "Dauer" by role uses `exact: true`. EN "Maximum duration" vs "Duration": the same.
- "Erreichbar ab …" vs `boat.harbors.unreachable` "Nicht erreichbar: …": a heading vs text, not a substring of each other.

## 11. Testing

**Unit (reach.ts, pure, node environment):**
- Differential: `towards` mode reproduces `solve()`'s per-ring frontier sizes (the probe's 12-ring control) on the real mask and polars.
- Twin: the mirrored constants against `isochrone.ts` source, with a positive control that the strip is non-vacuous.
- **Finality property:** across random seeds and three origins, no cell returned as final by `step()` is ever lowered later. Mutation: reporting cells by ring index instead of `drainedToMs` reds it (M2 says that mutation is reachable).
- Bands read the drained map: a fixture where a substep-lagged node lowers a cell after its first ring puts the cell in the earlier band.
- Edge stamping: a straight edge stamps every crossed coarse cell with monotone times; a blocked full step stamps nothing past the block.
- Cap: a child past the cap stamps only its pre-cap prefix; the run ends with an empty frontier.
- Origin disc: Marstal at the Salona 45's 3.0 m uses the disc and reaches more than its 7-ring death; Flensburg does not get a disc.
- Rig merge: the per-cell minimum and its rig index; the shown boundary is the minimum `drainedToMs`.
- Budget: a fake clock past the deadline returns `partial` with the cells so far, not `no-route`.

**Unit (client, card, layer):**
- ReachClient: streaming merge, cancel keeps final cells, starting a plan cancels reach, typed failures. Worker code itself is covered only by e2e (as `worker.ts` is).
- The card renders every §6 state; the polite region announces only transitions; StrictMode wrap.
- Layer: `sc-reach-fill` created once across tab round trips, hidden off Wetter, sea state hidden while it shows; with a per-file size-discriminated `getContext` fake (never in `setup.ts`, which is in the sweep's `EXTRA_EDGES`); `layerOrder.test.tsx` rows.
- Pixel rule: land and sub-gate pixels stay transparent; disc pixels use the disc gate.
- `reachCellAt` agrees with the raster's cell index.
- Harbour list: ETA from the snap cell; `shallow-approach` handling; known-disconnected never listed; all `harbors.json` entries covered for the Salona 45 and Easy Go.
- Dict parity and placeholder parity; the name-collision table above.

**e2e** (`reach.spec.ts`, `?windFixture=`, `STANDARD_VIEWPORTS` ≥820, both themes):
- Compute from Flensburg with a 2 h cap, chosen to keep the spec short; the bands render (pixel probe on a water pixel near the origin and on a land pixel nearby); the harbour list fills; [Als Ziel] fills Ziel and departure and lands on Planen.
- Cancel mid-run keeps a partial area and its label.
- Offline (server killed, per the honest-offline rule) with a held result: bands stay, no compute.
- Plan the default departure explicitly to avoid the hour-boundary race (#1731).
- Only one e2e implementer at a time (shared port 4173).

**Real browser (verify skill):** 820x1180, 1180x820, 1920x1080, both themes; palette legibility over the basemap; streaming feel; the paint-cost measurement (§3).

**Sweep:** none owed; confirm with `closure.mjs diff` before each merge.

## 12. Risks and unmeasured items

| Item | Status | Gate |
|---|---|---|
| Tablet compute time | unmeasured; M1 is this machine under load | slice 0 measurement on a reference tablet; if a 6 h two-rig run nears the budget, lower the default to 4 h |
| Gap rate of edge stamping vs node stamping | unmeasured | slice 1 measures holes inside the 6 h band for both methods |
| Cost of stamping all children and pre-cap prefixes | unmeasured | slice 1 compares nodes/s with the probe |
| Main-thread repaint cost | unmeasured | #1854's throttled measurement |
| Worker memory (mask copy, visited map with 428 002 keys in the Flensburg genoa run) | memory unmeasured | measure heap in slice 2 |
| Real, non-uniform wind | not probed (M-infeasible) | real-browser pass on a live forecast |
| Region is not a superset (M5) | measured; mitigated by copy | — |
| Single-worker devices run two rigs alternately | by design; doubles wall time | progress stays truthful |
| Bands read as guarantees | copy and popup say "ca." and "Planungshilfe" | claim audit of copy |
| Palette vs via pink for colour-vision deficiency | open | PR validates against the via marker |

## 13. Questions for the maintainer

1. Is a reach computation "planning" under the §11 ruling (this design: yes, so no offline compute)?
2. Per-cell minimum over the sails aboard, labelled per cell (this design), or one sail chosen in the card?
3. Should [Als Ziel] also start planning? This design does not, matching #1854's single planning action.
4. Does the tab keep the name "Wetter" once it holds the reach card?

## 14. Implementation slicing (v0.62.0)

0. **Measurement (no product code):** reference-tablet timing for a 6 h two-rig run from Flensburg and Sønderborg; gap rate of the two stamping methods. Decides the default duration and the stamping method.
1. **`routing/reach.ts` + tests** (differential, twin, finality, cap, disc, budget). Pure, no UI. NOT OWED.
2. **Reach worker, protocol and `ReachClient`:** streaming, cooperative cancel, rig alternation, typed failures.
3. **Reach card + band raster + harbour list + [Als Ziel] from the list.** Needs #1854 PR B (Wetter tab, hour store, `useAreaForecast`, `suppressDepth`). This slice meets the issue's draft acceptance.
4. **Map taps:** the `reachCellAt` popup, and the harbour-popup reach line. Needs the #1854 popup slice, or ships the shared map-level click itself.
5. **Isolines and [Bereich zeigen].** Cut first if time runs short.

## 15. Considered and rejected

- **One region at the limit, no bands.** It hides the question the skipper asks next ("how far by lunch?"), and bands cost nothing extra once the per-cell map exists.
- **Bands from ring snapshots.** Wrong by up to 24.9 % of cells at 6 h (M2).
- **Union of rigs without attribution, or a rig picker.** The first hides which sail an ETA assumes; the second halves the information for no saving on a two-worker pool.
- **Exporting the prune internals from `isochrone.ts`, or refactoring `solve()`.** Either edits the sweep closure and owes a sweep; the mirror plus differential test does not.
- **Running reach on the shared `RoutingClient`.** Its only cancel terminates the workers and would kill a plan in flight.
- **An always-on origin disc.** It lowers the gate near every origin, which a plan does only after a failed tier.
- **Offline compute from the held Wetter grid.** Conflicts with the 2026-10-28 ruling as this design reads it (§13 Q1).
- **Auto-recompute on input change.** Up to tens of seconds per run (M1) on every hour step.
- **Labels on the map ("2 h", "4 h").** They would join the collision index; the legend is in the card.
- **Auto-fitting the camera to the area.** Rejected for Wetter in #1854 §15 for the same reason.
- **Persisting the area to IndexedDB.** Session-only, like the Wetter grid; a `DB_VERSION` bump would break production for `/uat/` visitors.
