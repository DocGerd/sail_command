# #1854 — "Wetter" tab: wind and sea state before choosing a destination

Status: UX design spike, written at develop `7a08b939` and revised once after critique. It ends in a recommendation and is not a spec. The maintainer approved this direction on 2026-10-24 (ruling on #1854). Building it first needs these ask-gated spec edits in the main session: (a) waves spec §0's "Plan-bound … No browsing before a plan exists" rule; (b) waves spec §0's cell rendering, worded to cover water-clipped raster cells, the arrow-or-dot marker and the removal of `sc-waves-edge`; (c) the ui-modernization §6 tab list; (d) the source spec's Offline-scope row (`2026-07-14-sail-command-design.md` line 26), for a browse view that needs the network and offline shows only an in-memory forecast with its age; (e) ui-modernization §2's "only planning needs network; everything else keeps working offline" constraint, for the same browse view; (f) ui-modernization §2's "map barbs sample the plan grid at the SLIDER hour" line, because Wetter's barbs sample the area forecast at the card's hour (§6); (g) waves spec §0's "Map only." bullet, because the card shows Hs in its place lines, strip and area line; (h) the source spec's §3.2 Persistence bullet's line "everything except *new* planning works offline" (~:139–140), the second copy of (d)'s rule; (i) the source spec's Route-presentation addendum line "all wind/depth data comes from the plan's stored grid … never re-fetched" (~:206–208), for the same reason as (f). Promoting the design to a spec re-checks the specs for others. One question stays open for the maintainer: whether planning may fall back offline to the Wetter session grid (§11). This design does not do that.

Code anchors use the form `file:symbol (~:line)` and refer to `7a08b939`. Paths with a directory part are relative to `app/src/` unless they begin with `app/` or `changelog.d/` (repo root); bare file names omit their directory. Supporting files are in the sibling directory `1854-forecast-view-ux/`. Measured figures come from the grounding run's `measure.json` (written by `ux-measure.mjs`) and from this revision's `harbour_wave.py`, run against the committed `mask.bin` and `harbors.json` at `7a08b939`. Screenshots `01`–`04` were taken during the grounding run; `03` and `04` show sea-state cells drawn over land. `ux-capture.mjs` took them; `02`–`04` load the e2e `wind-sw12.json` and `wave-bands.json` fixtures, and `01` is a cold load without them. Neither script recorded which build it was served. `judges.json`, `critique.json` and `revision-log.md` hold the judges' scores, the critique's findings and the revision's dispositions, recorded before the claim audit; where the log and this document differ, this document is current.

## 0. Basis

- **Base: Design 3, "Wetter tab".** Two of three judges ranked it first. The mean normalised totals were D3 7.33, D2 7.08, D1 6.78.
- **Why the dissent does not change the base.** The dissenting judge preferred D1 for two reasons: D3 changes the tab IA (ui-modernization §6), and its summary is a viewport statistic with no value for a specific point. On the first: §6 already lists three tabs while the app ships four (`App.tsx:APP_TAB_ORDER` ~:262), so the amendment is owed in any case. On the second: this design makes the Start and Ziel readouts the primary lines, and the strip uses a fixed scope (§3).
- **Grafts.**
  - From D1: a single rendering owner (RouteLayer), a dot marker for cells with no direction, wave coverage shown on the scrubber, the Start readout, a barb halo, the name discipline, and the hoisted `mapWindError`.
  - From D2: a sequential wind-then-wave fetch, nearest resampling, one shared cell lookup, the cell-size honesty line, newest-source adoption, and the explicit idle/no-fetch state.
  - From the judges: the hour held in a store rather than in App state, a narrow re-budget, and the strip never scrolling horizontally.

## 1. Goal and non-goals

Goal: before a destination exists, the skipper sees wind and sea state for the whole area (54.3–55.6°N, 9.4–11.6°E) at an hour they choose, can compare hours across the forecast horizon, and then hands that hour to the planner. At the 820 px narrow design floor the whole area does not fit above the sheet, so the skipper pans (§3).

Non-goals:
- No routing change, no backend, no change to the Live tab. Browsing never writes the departure or the planner's Start and Ziel.
- No wind colour field (§15) and no wind-sea/swell split (spec §0). No dark basemap (2026-08-25 ruling) and no pitch.
- No IndexedDB writes or `DB_VERSION` bump. `sw.ts` does not change; the service worker never caches Open-Meteo.
- No reachable area; that is #1855, and §12 reserves its place.

## 2. User journey

1. Cold load: the Plan tab is the default, as today. The tab strip shows **Planen | Wetter | Routen | Live | Boot**. No forecast is fetched.
2. The skipper taps **Wetter**. Online with nothing held, the card shows skeletons and "Vorhersage wird geladen …" at once. The request starts once the tab has stayed selected for 600 ms: wind first, then waves. Wind draws as soon as it arrives; sea state fills in afterwards.
3. The skipper reads the card from the top: a status chip (fetch time, age, horizon), the hour (◀ ▶ step an hour, « » a day), the conditions at Start and Ziel, the action, and a 3-hourly strip for the chosen day at the Start (or over the whole Revier without a Start). The Disclosure **Zeitleiste, Ebenen und Zeichenerklärung** holds the viewport range, the six-day scrubber, day buttons and the key. The map shows barbs and the water-clipped sea state at that hour.
4. On Wetter a harbour tap opens that harbour's forecast popup with **Als Start** and **Als Ziel**; only those buttons change the planner. A tap on open water opens "Vorhersage hier". On the other tabs harbour taps work as today (`App.tsx:handleHarborPick` ~:1205).
5. **Als Abfahrt übernehmen** (for the current hour: **Jetzt als Abfahrt**) writes the departure, switches to Planen, moves focus (§11), and announces the change. **Route planen** stays the only action that plans. Online, within 10 minutes of the Wetter fetch, planning reuses the cached grid the skipper looked at (§11).

## 3. Entry point and layout

**Entry.**
- New tab `'conditions'`, second in `APP_TAB_ORDER`. "Look before you plan" makes it a sibling of Planen; Planen stays first and stays the default.
- Discoverability is the always-visible tab strip. Nothing is added to the Plan tab (§15), so the default tab's starting state is unchanged for every spec (#1405).
- No map chrome is added, Wetter never opens automatically, and nothing new appears on the map until the tab is entered.
- A boot never restores into Wetter. `lib/sessionSnapshot.ts:writeSessionSnapshot` (~:114) writes `'conditions'` as `'plan'`, and the persisted `Tab` union (~:25) stays unchanged; App's tab type is that union plus `'conditions'`. Mapping on the write side matters because `sc-session` is shared with `/uat/` on one origin, and an older build's `parseSessionSnapshot` (~:70) drops the whole snapshot on an unknown tab.

**Card anatomy.** One `Card` titled "Wind und Seegang". The order is the same in every layout:

1. Header row: the title; a status Chip (`conditions.status.*` plus `conditions.horizon.end`), raised to 1rem with a compound `.chip.conditions-status` rule (a single-class modifier would lose to the later `.chip` base); [Vorhersage aktualisieren] when it applies (§7). A stale, offline or error line sits directly under the row.
2. Hour row, sticky: [« 44] [◀ 44] `formatSliderTime` value plus "(in 23 h)" [▶ 44] [» 44].
3. Place lines: Start, then Ziel (§5 place readout). With a plan loaded, also `conditions.planForecast`.
4. Actions: [Als Abfahrt übernehmen] (primary; "Jetzt als Abfahrt" for the current hour) with its notes (§7).
5. Notice line, always visible: `conditions.notice`.
6. Depth line, while depth is suppressed (§6): `conditions.depthHidden` [Tiefen zeigen].
7. Strip for the chosen day. Scope label: the Start's name, else "Revier". One column per 3 hours (00–21 local). The column whose window holds the current hour is kept; earlier columns and hours beyond the horizon are left out. Rows: time; wind "9–14 (19)"; Hs "0,8". A leading label column carries the units ("Wind kn (Böen)", "Seegang m"); direction is in each column's accessible name only (§9). It is a grid when the strip container is at least 46rem wide and a list (time | wind | sea, with a header row) below that, so the timeline never wraps.
8. Disclosure **Zeitleiste, Ebenen und Zeichenerklärung**: the area line (viewport); the scrubber (day labels; a 28 px wind sparkline: per hour, the maximum mean wind with a lighter gust cap; a 6 px sea ribbon: per hour, the maximum band, empty where the wave axis has no hour, so it is also the wave-coverage indicator; the `Slider` primitive, 44 px tall), with sparkline and ribbon over the strip's scope; day buttons (Heute, Sa 24., …, only days with data); [Revier zeigen] (secondary; cut first); the two toggles; the barb key; `SeaStateLegend`; the scope line; the models line; the disclaimer. Open on wide, closed on narrow, re-seeded on a layout change like DataLayers' `disclosureKey`.

**Fixed scope.** The strip, sparkline and ribbon use the Start's place readout when a Start is set, else all in-mask water lattice points of the Revier. They do not move with pan or zoom. Only the area line in the Disclosure follows the viewport, and it says so ("Im Kartenausschnitt").

**Sticky hour row.** `.sc-card` (app.css ~:2906) sets no `overflow`, so the row can stick inside `.app-panel`. Sticky offsets resolve against the scrollport's content box (CLAUDE.md: −12 px against the padding box), so the row's `top` must account for `.app-panel`'s 0.75rem padding, or content shows above it. AC-18 pins the geometry.

**Wide ≥1024 (side panel).**
- The card sits in the panel: 390 px at 1180x820, 637 px at 1920x1080 (measured), and resizable with `PanelResizer`.
- Both widths are below 46rem, so the strip is a list there.
- The map side is unchanged, except that DataLayers shows its no-plan form even when a plan exists (§6).

**Tablet narrow 820–1023 (bottom sheet; the design floor).**
- `.app-bottom-sheet` sizes to its content up to `max-height: 55vh` (app.css ~:546); on narrow the cap is `calc(55vh - var(--sc-toast-height, 0px))` (~:5361), so a toast lowers it.
- The Disclosure is closed. The strip is a grid of 8 (card inner width ≈762 px, estimate).
- Estimated height: about 609–641 px against the measured 649 px cap. Rows: tab strip 45 (measured); header 44, or 76 when the update button wraps; hour 44; Start 44; Ziel 22; actions 44; notice 44; depth 44; strip 80; Disclosure 44; 8 gaps of 12 (`.sc-card` gap 0.75rem); card padding and border 34; panel padding 24. All but the tab strip are estimates.
- The actions row ends about 262–294 px below the card top (estimate), whatever the strip, a toast or a banner does. AC-11 is the testable claim.
- The whole area does not fit above the sheet: the Plan tab's sheet starts at y=531 (measured), leaving about 470 px of map; a fit would need about z7.2 (estimate), below the maxBounds floor z7.97 (measured). The skipper pans.
- Any gain in map area is unmeasured and is not claimed.

**Phone <820 (nice-to-have).**
- At 390x844 the sheet reaches 55vh and scrolls; the strip is a list.
- The whole area cannot be shown: a fit needs z6.96, and the maxBounds floor there is 7.46 (measured).

**Tab strip, all widths.** `.app-tabs button` (app.css ~:576) goes from `padding: 0.6rem` to `0.6rem 0.25rem` everywhere: `flex: 1` sets the width, and horizontal padding only adds to the min-content width that #299's overflow comes from. `.app-tabs` also gets `container-type: inline-size` with `@container (max-width: 22.5rem) { .app-tabs button { font-size: 0.875rem } }`, so the smaller font follows the strip's own width; the wide panel resizes to `PANEL_MIN_WIDTH_PX` 320 (`lib/panelWidth.ts`) at any viewport. Engines without container queries keep the padding cut and miss only the font step. Layout containment adds no new stacking context or containing block, since `.app-tabs` is already `position: relative; z-index: 3` (~:568). Estimates: 64 px per tab at a 320 px strip; "Planen" needs ≈70 px with the old padding.

```
820x1180 — Wetter, no plan, forecast 2 h old (narrow; values illustrative)
y0    +--------------------------------------------------------------+
      | SailCommand                                      [EN] [i]    | header T3
y61   +--------------------------------------------------------------+
      |[> Anzeigeoptionen]   \_  \_   \_   barbs (haloed), lattice   | .map-stack-tl T2
      |(N)          ::::##::::  sea state on water pixels only       | (unchanged)
      |[> Legende]   \_ .  \_ >  marker in its cell, off the barb    |
      |    o Aabenraa        land never tinted        o Faaborg      |
      |[2 sm]     o Sonderburg     depth shading hidden on this tab  | scale bar (runtime)
y531  +==== Planen | *Wetter* | Routen | Live | Boot ================+ tabs T3
      | WIND UND SEEGANG (abgerufen 13:05 (vor 2 h) · reicht bis     | status chip
      |   Mi 28. 23:00)                    [Vorhersage aktualisieren]|
      | [«] [<]          Sa 14:00 (in 23 h)          [>] [»]         | sticky
      | Start Flensburg: Wind aus SW (225°) 12 kn (Bft 4), Böen 18 kn|
      |   · Seegang: keine Modelldaten in Hafennähe                  |
      | Ziel: noch keins                                             |
      | [ Als Abfahrt übernehmen ]                                   | primary
      | Planungshilfe · nur Wind und Seegang (keine Gewitter, Sicht, |
      |   Niederschlag) · Windpfeil: woher · Wellenpfeil: wohin      |
      | Wassertiefen ausgeblendet, solange Seegang angezeigt wird.   |
      |                                              [Tiefen zeigen] |
      | Sa 24., Flensburg                                            |
      |                 00    03    06    09   [12]   15    18    21 | [12] holds 14:00
      | Wind kn (Böen)  8(12) 9(13) 10(15)11(16)12(17) 9(14) 8(12) 7(11)|
      | Seegang m        –     –     –     –     –     –     –     – | – = no model data
      | [> Zeitleiste, Ebenen und Zeichenerklärung]                  |
y1180 +--------------------------------------------------------------+

1180x820 — Wetter, plan loaded (wide, panel 390 px; values illustrative)
+-- panel 390 -----------------++----------- map 779 --------------------+
| SailCommand          [EN][i] ||[v Anzeigeoptionen]   planless form    |
| Planen *Wetter* Routen Live Boot| [x] Wassertiefen   (layer hidden §6) |
| WIND UND SEEGANG             || [ ] Seezeichen                        |
| abgerufen 13:05 (vor 2 h) ·  ||(N)                                    |
|   reicht bis Mi 28. 23:00    ||  o Flensburg - - - - - o Sonderburg   |
| [«][<] Sa 14:00 (in 23 h) [>][»]|  route dashed at 0.45; no ETA or    |
| Start Flensburg: Wind aus SW ||  manoeuvre labels; barbs and sea     |
|   (225°) 12 kn (Bft 4), Böen ||  state at the card's hour            |
|   18 kn · Seegang: keine     ||                                       |
|   Modelldaten in Hafennähe   ||                                       |
| Ziel Sonderburg: Wind aus SW ||                                       |
|   (220°) 13 kn … · Seegang   ||                                       |
|   0,4 m (schwach bewegt) am  ||                                       |
|   nächsten Modellpunkt, 4,0 nm O                                      |
| Route berechnet mit der      ||                                       |
|   Vorhersage, abgerufen Do 18:40.                                     |
| [Als Abfahrt übernehmen]     ||                                       |
| Planungshilfe · nur Wind …   ||                                       |
| Wassertiefen ausgeblendet …  ||                                       |
|   [Tiefen zeigen]            ||                                       |
| Sa 24., Flensburg            ||                                       |
| Zeit   Wind kn (Böen) See m  ||                                       |
| 00:00  8 (12)          –     ||                                       |
| 03:00  9 (13)          –     ||                                       |
| …                            ||                                       |
| [v Zeitleiste, Ebenen und …] ||[10 sm]                           (i) |
+------------------------------++----------------------------------------+
```

## 4. Time control

- **Store.** A module store, `state/conditionsHour.ts` (`get`/`set`/`subscribe`), read through `useSyncExternalStore`. The precedent is `subscribeContoursFetchState`, used at `RouteLayer.tsx` ~:1170. The card and RouteLayer subscribe; App reads the value only when the departure is handed over. So a slider tick never re-renders App.
- **Clock.** ConditionsPanel holds a `nowMs` state. It is set on tab entry, by a 60 s interval that runs only while Wetter is active and `document.visibilityState === 'visible'`, and on `visibilitychange`. It is never read with `Date.now()` during render (the purity-lint note at `RouteLayer.tsx` ~:1180). Each tick recomputes the age, the "jetzt" and relative labels, the set of valid hours, and the stale and update-button state. If the stored hour has become past, it moves to the first valid hour. The age text sits outside the polite region, which announces only transitions (§9).
- **Hours.** The valid hours are the held wind grid's `timesMs` from the first hour ≥ `floorHour(nowMs)` up to the last one (`WindField.horizonMs`, `lib/wind.ts` ~:126). Whether the live axis starts at 00:00 UTC is unverified; past hours are dropped either way.
- **Seed.** On tab entry, if `departureMs` (`App.tsx` ~:632) has changed since the last seed, the hour is set to it, floored and clamped into range. If it had to be clamped, the card shows `conditions.horizon.seedClamped`. Otherwise the user's last hour is kept.
- **Controls.**
  - ◀/▶ step ±1 h, «/» step ±1 day keeping the clock hour (clamped into range). All four are disabled at the ends.
  - The `Slider` (step 1 over hour indices, in the Disclosure) is labelled by an sr-only `<label>`, because `components/Slider.tsx:SliderProps` has no aria-label prop. Its `aria-valuetext` is `formatDateTime` plus the relative hours. Arrow, Home and End keys are native.
  - A day button keeps the clock hour, clamped into range.
  - A strip column selects its hour. The column whose 3-hour window holds the chosen hour is marked (`aria-current="true"`).
- **Label.** `lib/format.ts:formatSliderTime` (~:435), with the full option list and `nowMs`. The index for the current hour reads "jetzt".
- **Drag.** Barbs and the readouts update on every tick. Hour-driven barb rebuilds go through one `requestAnimationFrame`, like the sea-state repaint; today RouteLayer's barb effect rebuilds synchronously when `tMs` changes (~:1574).
- **Departure.** Browsing never writes it. Only §11's button does, and that button is never disabled.

## 5. Visual encoding and legends

**Wind.**
- The existing barbs only: layer `sc-wind-barbs`, `barb-{0..50}` images from `lib/windBarbs.ts:registerBarbImages`, FROM convention, `icon-allow-overlap`/`icon-ignore-placement` true.
- The data comes from `lib/routeGeoJson.ts:adaptiveBarbFeatures(forecast.wind, tMs, view, [], mask)`: the viewport lattice at about 96 px spacing, land-culled, capped at 500, with no route ribbon.
- The barb images already exist without a plan: `registerBarbImages(map)` runs inside `setupLayers` (~:622), which is installed by `installStyleSetup` keyed on `[map]` (~:1243–1251).
- **Halo (PR A).** Today `drawBarb` draws a single 1.5 px `INK_COLOR` stroke with no halo. PR A adds an underlay of about 3.5 px in `HALO_COLOR` (`lib/mapColors.ts` ~:68) beneath that stroke. The calm circle's ink already reaches the image's bottom edge (`cy` 28, `r` 4 in a 32 px image, `lib/windBarbs.ts` ~:54), so PR A pads the canvas by 2 px on every side (36 px). `barbSegments` is unchanged, so the depth profile's SVG glyphs do not move, and the centred icon keeps its map position. The ink stays as the Okabe-Ito lock requires, and collision does not change. This also changes plan-mode rendering, so it needs a real-browser check.

**Place readout (Start, Ziel, harbour popup).**
- Wind is `WindField.sample` at the harbour's snap point.
- Sea state comes from the nearest in-mask water lattice point among the place's own nearest lattice point and its eight neighbours, labelled with distance (nm) and compass point. If none of those nine is water: `conditions.place.seaNone`. A wind hour with no wave hour: `conditions.sea.noHour`. The words "kein Seegang" and "no sea state" are never used, because they read as calm.
- Measured with `harbour_wave.py` (nearest lattice point per axis, cell `floor((v − origin)·cpd)` with `GridAxis.index`'s `≥ end` exclusion): for 28 of the 46 harbours the nearest point is not in-mask water, Flensburg among them; Flensburg's and Aabenraa's nearest water points are about 15.6 and 13.2 km away (about 8.4 and 7.1 nm). Derived from the same lattice but not printed by the script: 134 of the 322 lattice points are in-mask water, and with the own-or-adjacent rule 44 harbours get a model point; Flensburg and Aabenraa get `seaNone`.
- This labels a model point; no water is shaded from a neighbour, so the no-borrowing rule in §15 still holds.

**Sea state (PR A; plan mode too, which fixes the land tint everywhere).**
- **Semantics (spec §0) unchanged.** Hs in the WMO bands of `lib/waves.ts:SEA_STATE_EDGES_M`, colours `SEA_STATE_COLORS` at `WAVE_FILL_OPACITY` 0.45, and nearest-hour sampling via `waveHourIndexAt`, which never clamps.
- **What changes.** `waveFeaturesAt` (`lib/waveMap.ts` ~:85) culls at the lattice point but then draws a ±0.05° rectangle, which tints adjacent land. It is replaced by a canvas raster that keeps the id `sc-waves-fill`, so `WAVE_STACK_BOTTOM_LAYER` (`waveMap.ts` ~:17) and DataLayers' anchor (`DataLayers.tsx` ~:388) stay untouched.
- **Raster geometry.** Canvas source with `animate: false`, repainted with the `play()`/`pause()` trick (`DataLayers.tsx` ~:331); corners from `depthSourceCorners` (`lib/depthColor.ts` ~:42); rows are every second entry of `depthCanvasRowMap` (~:89), never re-derived, and columns every second mask column. `raster-resampling: 'nearest'` keeps band edges crisp when the raster is magnified. It governs magnification only (`DataLayers.tsx` ~:476 records the hardcoded `LINEAR_MIPMAP_NEAREST` minification filter), so at overview zoom, where the half-resolution raster is minified, band edges blend. That is accepted.
- **Size.** 1513 × ≈1586 px ≈ 2.4 MP: 9.6 MB RGBA plus a 4.8 MB Uint16 index. Each of the two depth canvases is full `meta.cols` wide (`DataLayers.tsx` ~:230/:266), about 38 MB. Quarter resolution is the fallback, chosen by one main-thread measurement (§14).
- **Pixel rule.** A pixel maps to its own nearest lattice point, which reproduces today's rectangle partition exactly. It is coloured only if the mask cell is water (byte > 0), its own lattice point is in-mask water (the §0 centre cull is kept; nothing is borrowed from a neighbour), and Hs is finite. The index is built once per mask and cached at module level; each hour is one pass through a 322-entry colour table.
- **Data cue.** The `sc-waves-edge` line layer is removed. Each shaded cell instead carries exactly one marker: the travel arrow (unchanged), or a new small `sc-wave-dot` ring when the direction is NaN. A calm cell is near-white plus a marker; a cell with no data or on land has neither.
- **Marker placement (PR B; both modes, because it needs the hour's wind).** Wave and wind share one lattice (`services/openMeteo.ts:latLonParams` builds both), and `adaptiveBarbFeatures` anchors lattice barbs at multiples of 2^n native steps from grid index 0, with n no lower than `MIN_SUBDIV_N` (−2), so today barbs sit on wave arrows wherever both share a lattice point. The barb icon is centred on its point, with the station 12 px downwind and the feathers at the upwind tip (`lib/windBarbs.ts` ~:13–16). While barbs are visible, a marker therefore moves to the quarter-cell point of its own cell that lies on the downwind side and farther from that cell's wind axis at the hour. With barbs hidden it sits at the cell centre. Accepted cost: a marker jumps to another quadrant when its cell's wind axis crosses a quadrant boundary between hours, so markers move while scrubbing. The intent is that no marker lies on a barb's shaft or feathers. That intent fails from about z10.9 (512 px tiles), where n reaches `MIN_SUBDIV_N` and the lattice step is a quarter native step. The barb lattice then includes every quarter-cell point (±0.025° from the cell centre). A marker there lands on a barb's anchor wherever that barb is drawn; for a non-calm barb the anchor is the shaft midpoint. In plan mode it also fails near the route at any zoom, because route-ribbon barbs sit every ~110 px along the legs (`RIBBON_PX`), off the lattice. This spike resolves neither case. The unit test of the rule (AC-4) cannot see either; the daylight browser pass (§14) covers z10–12. This is not a general collision-free claim.
- **Popup.** Raster layers are not queryable, so the `click` on `WAVE_FILL_LAYER` (`WaveLayer.tsx` ~:269) becomes a map-level click, using one shared `nearestWaveCell(grid, lngLat)` lookup, the same one the raster uses.
  - In plan mode it opens only where the tapped pixel is shaded, as today. On Wetter it opens on any in-mask water.
  - On Wetter a harbour tap opens the same popup at the harbour, titled `map.forecast.popup.harbour`, with [Als Start] and [Als Ziel] (≥44 px). App routes DataLayers' `onHarborPick` on Wetter into a small module store, `state/harbourForecast.ts`, which WaveLayer subscribes to; the buttons call App's `handlePickOrigin`/`handlePickDestination` with `harborToPickedPoint(h, lang)`.
  - Because both paths end in one popup owner, today's guards still apply to the water click: an armed pick, a `.maplibregl-marker` target, and features in the harbour, seamark, AIS, waypoint and route-hit layers all win (`WaveLayer.tsx` ~:239–256).
  - PR B adds Wind and Böen rows (via `WindField.sample`) in both modes. The water title becomes "Vorhersage hier · {time}". Sea rows follow the place-readout rule. The existing disclaimer stays.
  - The close button gets a scoped ≥44×44 px rule on `.wave-popup` (app.css has no `.maplibregl-popup-close-button` rule today).

**Legends and tiers.**
- All new legend content lives in the card's Disclosure, so no map legend is added. `.map-stack-tl`'s depth "Legende" gains nothing; on Wetter it is only removed while depth is suppressed (§6). The `depthLegendGate` budget and ScaleBar's measured room are unchanged.
- The card is untiered panel/sheet content. The popup reuses `.maplibregl-popup` (Tier 3). No new z-index value is introduced and the tier comment above `.app-header` does not change.
- `SeaStateLegend.tsx` is extracted from `RouteLegend.tsx`'s sea-state block and shared by both.
- PR A adds `route.legend.seaStateMarker` and `route.legend.seaStateCells` to it.
- PR B adds `WindBarbKey.tsx`: inline SVG drawn from `barbSegments()` for 5, 10, 25 and 50 kn. RouteLegend also gains it, since no barb key exists today.

## 6. Interplay

| Situation | Behaviour |
|---|---|
| Wetter tab, plan loaded | The route line stays, drawn like the alt-rig overlay (dash `[1, 1.5]`, opacity 0.45). The time-bearing labels are hidden: `ANNOTATION_LAYERS` (`sc-eta-primary`, `sc-eta-secondary`, `sc-leg-speed`) and `sc-maneuver-labels`. The alt-rig overlay is hidden without writing its persisted toggle. RouteLayer gets `conditionsActive` and `forecast`: barbs and WaveLayer draw the area forecast at the card's hour, and the plan's own weather is not drawn. The card shows `conditions.planForecast`. `.route-layer-controls` is rendered only while ViaMarkers' status chip shows (`viaReplanning`); ViaMarkers stays mounted either way. So the card's hour row is the only clock on screen. |
| Leaving Wetter | The route styling, labels and overlays come back, with the plan's weather at the plan slider's hour. `hourIdx` (`RouteLayer.tsx` ~:1179) is kept because RouteLayer stays mounted, and it resets only when `plan.id` changes (~:1195). |
| WaveLayer ownership | One instance, owned by RouteLayer. It moves out of `.route-layer-controls` (~:1853) into a stable first position of a fragment returned before the `if (!plan) return null` (~:1842), so a tab switch never remounts it. A remount would be harmless anyway: on unmount the layers stay, emptied (`WaveLayer.tsx` ~:275). |
| Depth, hatch, contours | DataLayers gets `conditionsActive` and renders its planless form (`plan === null` branch, ~:1505/:1554) on Wetter. While sea state is visible there, it also hides `sc-depth` and `sc-depth-hatch` (its visibility effect, ~:896, gains a `suppressDepth` term) and does not render the depth Legende; the persisted toggles are not written. The card shows `conditions.depthHidden` with [Tiefen zeigen], which sets a per-visit flag in App state that lifts the suppression; leaving the tab resets the flag and restores depth. Reason: depth's 7–12 m stops are sky blue and blue (`lib/depthColor.ts` STOPS ~:133–140), sea state's low bands are pale blues at 0.45, and the composite matches neither legend. Contours (default off) are unaffected. Stack order is unchanged: depth < sea-state raster < waypoints, harbours, seamarks, AIS < route. |
| Harbour taps | On Wetter a harbour tap never edits the planner; it opens the harbour's forecast popup, whose [Als Start]/[Als Ziel] are the only way the tab changes Start or Ziel. On the other tabs `resolveHarborPickTarget` behaves as today. |
| Seamarks | They stay above the raster and still win taps. |
| Sea-state and barb toggles | The card shows "Windpfeile anzeigen" and "Seegang anzeigen" bound to the same keys, `sc-barbs-visible` and `sc-waves-visible`. RouteLayer's copies are never mounted at the same time, so live sync is not relied on (it exists anyway: `lib/usePersistedToggle.ts:listenersByKey` ~:25). |
| Live tab | Unchanged: `conditionsActive` is false and the plan's weather shows as today. |
| Plan tab banners | `route.staleForecast` and the RouteSummary age note are unchanged; they refer to the plan. |

## 7. States

A visually hidden polite region announces status transitions; errors use `role="alert"` inline in the card only when nothing is shown. The map never goes blank without a message in the card.

- **Idle or cold:** no request until Wetter has been selected for 600 ms; the dwell is cleared when the tab is left. Online with nothing held, the loading skeleton shows at once on entry.
- **Loading, nothing held:** Skeletons for the hour row, place lines and strip, plus `conditions.status.loading`. The map shows only what it shows today.
- **Refreshing, grid held:** the held grid stays on screen; the chip shows `conditions.status.refreshing`.
- **Ready:** the chip shows `conditions.status.fetched` and `conditions.horizon.end`. The age updates with the clock (§4). Once the forecast is `GRID_CACHE_TTL_MS` (10 min) old and the device is online, [Vorhersage aktualisieren] appears.
- **Stale:** above 12 h (`lib/plan.ts:STALE_THRESHOLD_MS` ~:15, currently unexported) the chip switches to warning style and `conditions.status.stale` shows under the header row. The clock tick makes this reachable while the tab stays open.
- **Refetch triggers:** automatic on tab re-entry or the `online` event when the held forecast is older than 1 h; manual with the button from 10 min. The clock tick never fetches.
- **Offline, nothing held:** `conditions.offline.none`. No layers, and the strip and scrubber are hidden.
- **Offline, held:** `conditions.offline.held`. "Held" means the newest wind by `fetchedAtMs` among this session's grid and the active plan's `windGrid`; the waves of that same source go with it, mirroring usePlanFlow's rule that stored wind never pairs with fresh waves. A plan source is labelled `conditions.status.fromPlan`. IndexedDB is never read.
- **Fetch failure, nothing shown:** mapped through the hoisted `mapWindError` (`state/usePlanFlow.ts` ~:100) to `error.offline`, `error.rateLimited`, `error.windService` or, for a non-`OpenMeteoError`, `error.windUnknown`, as an alert with [Vorhersage aktualisieren].
- **Fetch failure, grid held:** quiet. The held grid stays with its age, and the chip shows `conditions.status.refreshFailed`; no alert.
- **Rate limit:** after `error.rateLimited` the update button is disabled for 60 s, with `conditions.update.cooldown` as visible text.
- **Partial:** if waves failed, wind is drawn, `conditions.error.waves` shows, and the ribbon is empty. Waves are never fetched after a wind failure (`usePlanFlow.ts` returns at ~:430, before the wave fetch at ~:448), so there is no sea-only state.
- **Current hour:** the button reads "Jetzt als Abfahrt" (§11).
- **Short remaining forecast:** when less than 6 h of forecast remains after the chosen hour, `conditions.useAsDeparture.short` shows next to the button. The button stays enabled; the card only states the remaining forecast and never advises a later departure.
- **Offline handoff:** `conditions.useAsDeparture.offline` shows next to the button (§11).
- **Horizon:** `conditions.horizon.end` is part of the chip. A held grid with no future hours shows `conditions.horizon.noneLeft` and the update button.
- **Mask not loaded:** barbs draw unculled (as today, `RouteLayer.tsx` ~:1174) and sea state waits for the mask. If loading the mask fails, `conditions.maskMissing` shows. Place-line wind still works.
- **Empty viewport scope (area line):** if the view holds no water lattice point, the area line uses the water point nearest the view centre and is labelled `conditions.scope.nearest`.

## 8. Copy (de / en, `satisfies` parity; numbers via `formatKn`, `formatHeading`, `formatNm`, `formatSeaStateM`; `{cardinal}` and `{bearing}` via a new `formatCompassPoint`)

| Key | DE | EN |
|---|---|---|
| nav.conditions | Wetter | Weather |
| conditions.title | Wind und Seegang | Wind and sea state |
| conditions.hour.label (sr-only) | Uhrzeit für Wind und Seegang | Time for wind and sea state |
| conditions.hour.prev / .next | Eine Stunde früher / Eine Stunde später | One hour earlier / One hour later |
| conditions.day.prev / .next | Einen Tag früher / Einen Tag später | One day earlier / One day later |
| conditions.hour.now / .in | jetzt / in {hours} h | now / in {hours} h |
| conditions.hour.valuetext | {datetime}, in {hours} Stunden | {datetime}, in {hours} hours |
| conditions.day.group / .today | Tag wählen / Heute | Choose day / Today |
| conditions.strip.group | Übersicht {day}, {scope} | Overview {day}, {scope} |
| conditions.strip.rowWind / .rowSea | Wind kn (Böen) / Seegang m | Wind kn (gusts) / Sea state m |
| conditions.sr.windFrom / .knots / .gusts / .sea / .metres (sr-only) | Wind aus {cardinal} / Knoten / Böen / Seegang / Meter | wind from {cardinal} / knots / gusts / sea state / metres |
| conditions.scope.area | Revier | Sailing area |
| conditions.role.start / .destination | Start / Ziel | Start / Destination |
| conditions.place.wind | {role} {place}: Wind aus {cardinal} ({dir}) {speed} kn (Bft {force}), Böen {gust} kn | {role} {place}: wind from {cardinal} ({dir}) {speed} kn (Bft {force}), gusts {gust} kn |
| conditions.place.sea | Seegang {height} m ({band}) am nächsten Modellpunkt, {dist} {bearing} | sea state {height} m ({band}) at the nearest model point, {dist} {bearing} |
| conditions.place.seaNone | Seegang: keine Modelldaten in Hafennähe | sea state: no model data near the harbour |
| conditions.sea.noHour | Keine Seegangsdaten für diese Stunde – Daten bis {datetime} | No sea-state data for this hour — data until {datetime} |
| conditions.start.none | Kein Start gewählt. Hafen auf der Karte antippen: zeigt seine Vorhersage und lässt ihn als Start übernehmen. | No start chosen. Tap a harbour on the map to see its forecast and set it as the start. |
| conditions.destination.none | Ziel: noch keins | Destination: none yet |
| conditions.planForecast | Route berechnet mit der Vorhersage, abgerufen {time}. | Route computed with the forecast fetched at {time}. |
| conditions.area | Im Kartenausschnitt: Wind {min}–{max} kn (Bft {bftMin}–{bftMax}) aus {cardinal}, Böen bis {gust} kn · Seegang bis {height} m | In the map view: wind {min}–{max} kn (Bft {bftMin}–{bftMax}) from {cardinal}, gusts to {gust} kn · sea state up to {height} m |
| conditions.area.variable | Im Kartenausschnitt: Wind {min}–{max} kn (Bft {bftMin}–{bftMax}), Richtung umlaufend, Böen bis {gust} kn · Seegang bis {height} m | In the map view: wind {min}–{max} kn (Bft {bftMin}–{bftMax}), direction variable, gusts to {gust} kn · sea state up to {height} m |
| conditions.scope.nearest | am nächsten Modellpunkt | at the nearest model point |
| conditions.useAsDeparture | Als Abfahrt übernehmen | Use as departure |
| conditions.useAsDeparture.now | Jetzt als Abfahrt | Leave now |
| conditions.useAsDeparture.done | Abfahrt auf {datetime} gesetzt. | Departure set to {datetime}. |
| conditions.useAsDeparture.offline | Offline – Planen braucht eine Verbindung. | Offline — planning needs a connection. |
| conditions.useAsDeparture.short | Danach bleiben nur {hours} h Vorhersage. | Only {hours} h of forecast remain after that. |
| conditions.fitArea | Revier zeigen | Show sailing area |
| conditions.update | Vorhersage aktualisieren | Update forecast |
| conditions.update.cooldown | Zu viele Anfragen – in einer Minute wieder möglich. | Too many requests — try again in a minute. |
| conditions.status.loading | Vorhersage wird geladen … | Loading forecast … |
| conditions.status.refreshing | Wird aktualisiert – zeigt den Abruf von {time}. | Updating — showing the forecast fetched at {time}. |
| conditions.status.fetched | abgerufen {time} (vor {age}) | fetched {time} ({age} ago) |
| conditions.status.fromPlan | aus der geladenen Route, abgerufen {time} (vor {age}) | from the loaded route, fetched {time} ({age} ago) |
| conditions.status.refreshFailed | Aktualisierung fehlgeschlagen – zeigt den Abruf von {time}. | Update failed — showing the forecast fetched at {time}. |
| conditions.status.stale | Vor {hours} h abgerufen – für aktuelle Bedingungen aktualisieren. | Fetched {hours} h ago — update for current conditions. |
| conditions.offline.none | Offline – Wind und Seegang brauchen eine Internetverbindung. Es ist keine Vorhersage im Speicher. | Offline — wind and sea state need an internet connection. No forecast is held in memory. |
| conditions.offline.held | Offline – zeigt die Vorhersage, abgerufen {time} (vor {age}). Zum Aktualisieren wird eine Verbindung gebraucht. | Offline — showing the forecast fetched at {time} ({age} ago). Updating needs a connection. |
| conditions.error.waves | Seegang konnte nicht geladen werden – nur Wind wird gezeigt. | Sea state could not be loaded — showing wind only. |
| conditions.horizon.end | reicht bis {datetime} | runs to {datetime} |
| conditions.horizon.seedClamped | Abfahrt {datetime} liegt außerhalb der Vorhersage; gezeigt wird {shown}. | Departure {datetime} is outside the forecast; showing {shown}. |
| conditions.horizon.noneLeft | Diese Vorhersage enthält keine kommenden Stunden mehr. | This forecast has no upcoming hours left. |
| conditions.maskMissing | Seegang kann ohne Wasserkarte nicht dargestellt werden. | Sea state cannot be drawn without the water map. |
| conditions.notice | Planungshilfe · nur Wind und Seegang (keine Gewitter, Sicht, Niederschlag) · Windpfeil: woher · Wellenpfeil: wohin | Planning aid · wind and sea state only (no thunderstorms, visibility, rain) · wind barb: from · wave arrow: towards |
| conditions.depthHidden | Wassertiefen ausgeblendet, solange Seegang angezeigt wird. | Water depths hidden while sea state is shown. |
| conditions.depthShow | Tiefen zeigen | Show depths |
| conditions.more.summary | Zeitleiste, Ebenen und Zeichenerklärung | Timeline, layers and key |
| conditions.key.barbs | Windpfeile zeigen, woher der Wind weht: halber Strich 5 kn, ganzer Strich 10 kn, Dreieck 50 kn (Mittelwind in 10 m Höhe). Zahl in Klammern: Böen. | Wind barbs show where the wind blows from: half feather 5 kn, full feather 10 kn, pennant 50 kn (mean wind at 10 m). Figure in brackets: gusts. |
| conditions.key.scope | Zeitleiste und Übersicht gelten für den Start oder das ganze Revier, Bereichswerte für den Kartenausschnitt. | The timeline and overview cover the start or the whole sailing area; range values cover the map view. |
| conditions.models | Open-Meteo-Modelle: {models} | Open-Meteo models: {models} |
| conditions.disclaimer | Planungshilfe: Modellvorhersage von Open-Meteo, keine amtliche Wetter- oder Seewetterangabe. | Planning aid: Open-Meteo model forecast, not an official weather or marine forecast. |
| route.legend.seaStateMarker (PR A) | Jede gefärbte Zelle trägt einen Pfeil oder Punkt; ohne Markierung gibt es keine Daten. | Every shaded cell carries an arrow or dot; no marker means no data. |
| route.legend.seaStateCells (PR A) | Jede Farbfläche ist eine Modellzelle, etwa 6 km breit und 11 km hoch; an Küsten und in engen Förden grob. | Each shaded block is one model cell, about 6 km wide and 11 km tall; coarse at coasts and in narrow fjords. |
| map.forecast.popup.title | Vorhersage hier · {time} | Forecast here · {time} |
| map.forecast.popup.harbour | {harbour} · {time} | {harbour} · {time} |
| map.forecast.popup.wind / .gust | Wind / Böen | Wind / Gusts |
| map.forecast.popup.setStart / .setDestination | Als Start / Als Ziel | Set as start / Set as destination |

Reused unchanged: `error.offline`, `error.rateLimited`, `error.windService`, `error.windUnknown`, `route.windBarbs.toggle`, `route.waves.toggle`, `route.legend.seaState*` (including `seaStateArrow`, which explains that wave arrows point where the waves travel), `seaState.band.*` and `map.waves.popup.*` (including "Modellschätzung, keine amtliche Angabe.").

## 9. Accessibility

- **Tabs.** The existing roving-tabindex tablist with automatic activation (`App.tsx:handleAppTabsKeyDown` ~:1235) works over the new `APP_TAB_ORDER`.
- **Targets.** The four steppers 44×44; day buttons ≥44 px tall; strip columns ≥48×72 in the grid and 44 px rows in the list; toggle rows 44 px; popup buttons and the popup close button ≥44×44; the slider gets `.conditions-scrubber .sc-slider { min-height: 44px }` (the base input rule gives 40).
- **Semantics.** The hour readout is plain text, not a live region. Day buttons are buttons with `aria-pressed`; the strip is a `role="group"` labelled `conditions.strip.group`, its columns are buttons, and the column holding the chosen hour has `aria-current="true"`. A column's accessible name is its visible text with sr-only words (`conditions.sr.*`: direction, units, "Böen", "Seegang") interleaved, so the name contains the visible text in order (WCAG 2.5.3). The sparkline and ribbon are `aria-hidden`; their data is repeated in `aria-valuetext` and the strip.
- **Announcements.** One polite region announces only transitions: forecast loaded, fresh to stale, offline, refresh failed, and `conditions.useAsDeparture.done`. The age text is outside it, so the clock tick announces nothing. `alert` is used only when nothing is shown.
- **Colour is never the only carrier.** Band names and values appear as text, and barbs encode speed by shape.
- **Contrast and theme.** Text is at least 1rem `--sc-fg` on `--sc-bg` with tabular-nums. The selected column has a 3 px `--sc-accent` border. Dark mode themes the card through tokens; the basemap and the sea swatches stay the same in both themes.
- **Focus.** Focus is never moved when the forecast loads. Programmatic focus moves happen only on user actions: the handoff (§11), and a pressed stepper, day button or strip column keeps focus. Map taps are not keyboard-reachable, an existing limitation, so the place lines and the strip are the keyboard and screen-reader path to the values.
- **Name collisions.** Playwright's `getByRole` matches names by substring; RTL does not. Each case was checked in both languages:

| New name | Avoids | Evidence |
|---|---|---|
| Uhrzeit für Wind und Seegang / Time for wind and sea state | "Vorhersagezeitpunkt"/"Forecast time" (RouteLayer slider); "Vorhersagestunde" | "Vorhersagestunden" is live text in `planner.departureSafetyContext` (dict.de.ts ~:302) |
| Zeitleiste, Ebenen und Zeichenerklärung / Timeline, layers and key | "Legende"/"Legend" | 1 non-exact `getByText('Legende')` site (`compass.spec.ts:1446`, scoped to the controls); the `datalayers.spec.ts` sites pass `exact: true` |
| Vorhersage aktualisieren / Update forecast | `banner.retry` "Erneut versuchen"; "Neu laden"/"Reload" | the global error banner can share the screen |
| Wetter / Weather | — | EN "Weather" is a substring of the map attribution link (`components/MapView.tsx`'s Open-Meteo `<a>`), and "Weather"/"Wetter" both occur in `about.sources.openMeteo`, so new specs use role-scoped `exact: true` |
| Als Abfahrt übernehmen / Jetzt als Abfahrt | `getByLabel('Abfahrt')` (7 sites) | button text is not a label; no `aria-label` is set |
| Als Start / Als Ziel | `getByRole('region', { name: 'Start' / 'Ziel' })` in several e2e specs | different role; the popup exists only on Wetter |
| Tiefen zeigen; "Wassertiefen ausgeblendet …" | checkbox "Wassertiefen" | different role; no `getByText('Wassertiefen')` site in `app/e2e` at `7a08b939` |

## 10. Data flow and components

```
tab='conditions' ─600 ms dwell─▶ useAreaForecast(active, online, plan)            (App)
   fetchWindGrid ─then─▶ fetchWaveGrid            (both via the shared grid caches)
   → {wind, wave, source, status, errors} ─▶ RouteLayer forecast/conditionsActive (barbs, WaveLayer)
                                          └─▶ ConditionsPanel: mounted inside MapView, portalled
                                              into the Wetter .app-panel slot
ConditionsPanel: useMapInstance() → bounds on debounced moveend; useSheetTop();
                 NavMask view over loadRoutingAssets()' cached mask
conditionsHour store ◀── ConditionsPanel controls ──▶ RouteLayer (barbs + WaveLayer tMs)
harbourForecast store ◀── App onHarborPick (Wetter only) ──▶ WaveLayer popup
     popup [Als Start | Als Ziel] ─▶ App handlePickOrigin / handlePickDestination
"Als Abfahrt übernehmen" ─▶ App: setDepartureMs, handleTabChange('plan'), focus (§11)
```

- **Placement.** The tabpanel (`.app-panel` in `.app-bottom-sheet`) is outside `<MapView>` (`App.tsx` ~:1697–1825), where `useMapInstance()` is null. ConditionsPanel therefore mounts inside MapView and portals into a Wetter slot, as `SeamarksInView` does into `seamarksSlot` (~:1821).
- **Fetch and cache.** Reuses `services/openMeteo.ts:fetchWindGrid`/`fetchWaveGrid` (~:375/:458) and their `createGridCache` (~:334): 10-minute TTL, in-flight dedupe, a deep clone per read. Reads `?windFixture=`/`?waveFixture=` exactly as `usePlanFlow.ts` does (~:414); a wind fixture without a wave fixture means no waves. Waves are fetched only after wind resolves (`usePlanFlow.ts` ~:443–454). Held grids live only in the hook's state, for the session.
- **No backend; no CSP change.** `app/vite.config.ts`'s `connect-src` (~:163) already lists `https://api.open-meteo.com` and `https://marine-api.open-meteo.com`.

**PR A (land tint; plan mode first; ships alone):**
- `lib/waveMap.ts`: adds `seaStateRasterIndex`, `paintSeaState`, `nearestWaveCell` and arrow/dot marker features; removes the cell-polygon builder and `WAVE_EDGE_*`.
- `components/WaveLayer.tsx`: canvas source with a raster `sc-waves-fill`, the marker layer and dot image, the map-level popup gated to shaded pixels.
- `lib/windBarbs.ts` (halo, 36 px canvas) and `components/RouteLegend.tsx` (two legend lines).
- `app.css`: the popup close-button rule.
- `changelog.d/1854.changed.md`, ending "(#1854).".
- Tests that pin the edge or fill layers, the cell-polygon builder or the barb canvas ops: `lib/waveMap.test.ts` (`waveFeaturesAt`), `WaveLayer.test.tsx`, `RouteLayer.test.tsx`, `layerOrder.test.tsx`, `App.test.tsx`, `lib/windBarbs.test.ts`, `app/e2e/waves.spec.ts`.

**PR B (the tab):**
- New: `state/conditionsHour.ts`; `state/harbourForecast.ts`; `state/useAreaForecast.ts`; `state/windErrorKey.ts` (`mapWindError` hoisted; `usePlanFlow.ts` imports it); `lib/beaufort.ts` (`beaufortForce` hoisted from `DepartureCompare.tsx` ~:37); `lib/areaForecast.ts` (place readout, Revier and viewport scopes, hourly summaries, strip columns, speed-weighted circular mean, "variable" below a resultant of 0.5); `components/ConditionsPanel.tsx` (scrubber, day strip, key); `components/SeaStateLegend.tsx`; `components/WindBarbKey.tsx`.
- New: `lib/useSheetTop.ts`, a ResizeObserver on `.app-bottom-sheet` that removes the sheet band from the viewport scope of the area line. This is new plumbing, not a reuse: `LiveView.tsx` writes `--live-sheet-h` (~:368–380) on its card element, and only on narrow.
- Changed:
  - `App.tsx`: Tab type and order, tab button and tabpanel slot, hook, props, `onHarborPick` routing on Wetter, the per-visit depth flag, handoff.
  - `RouteLayer.tsx`: `conditionsActive`, `forecast`, the fragment, the Wetter route styling and label hiding, the `.route-layer-controls` rule, rAF-coalesced barb rebuilds, and an optional fit-area nonce. "Revier zeigen" lives here: `fitBounds` on the area with padding from the #1626 `measureChrome()` occluders, `bearing: map.getBearing()`, `duration: 0`, accepting a fit clamped by maxBounds; the file is already in `test/cameraAnimationCallSites.test.ts:ALLOWED_FILES` (~:115).
  - `components/WaveLayer.tsx`: marker placement from the hour's wind, the Wetter water popup, the harbour popup.
  - `DataLayers.tsx` (`conditionsActive`, `suppressDepth`); `components/PlannerPanel.tsx` (a focusable Ziel section for the pointer handoff); `lib/sessionSnapshot.ts` (write-side mapping).
  - `DepartureCompare.tsx`; `lib/plan.ts` (export `STALE_THRESHOLD_MS`); `lib/format.ts` (`formatCompassPoint`, `formatAgeShort`, `formatDayShort`).
  - `app.css`: token-only `.conditions-*` rules, `.chip.conditions-status`, the sticky hour row, the slider rule, the tab padding and container query; no z-index.
  - Both dicts and `changelog.d/1854.added.md`.
- **Not touched:** `types.ts`, `lib/wind.ts` and `lib/mask.ts`, all IN the #282 sweep closure; new code only builds `NavMask` views over the cached buffer. Also `services/openMeteo.ts`, `services/db.ts`, `sw.ts`, `routing/**`. The files listed above that exist at `7a08b939` are NOT_IN_CLOSURE (`closure.mjs files` at `7a08b939`), so NOT OWED is expected. Confirm that with `closure.mjs diff <merge-base> <head>` before merging.

## 11. Handoff to planning

- **The button.** The card's only primary action. For a later hour it reads **Als Abfahrt übernehmen** and sets that hour's start. For the current hour it reads **Jetzt als Abfahrt** and sets `Date.now()` rounded up to the next 5 minutes, read at press time. It is never disabled: PlannerPanel's departure min/max are soft guidance computed at mount (`PlannerPanel.tsx` ~:772–778), and no past-departure validation was found in `app/src` (grep at `7a08b939`). On press it:
  1. calls `setDepartureMs`, then `handleTabChange('plan')` (~:1220);
  2. moves focus. With no Ziel, a pointer press (`event.detail > 0`) focuses the Ziel section (`tabindex="-1"`), so a tablet's soft keyboard does not open over the sheet; a keyboard press focuses the Ziel combobox via `setPendingDestinationFocus(true)` and `PlannerPanel.tsx`'s effect (~:436). With Ziel set, it focuses `#planner-departure`;
  3. announces `conditions.useAsDeparture.done`. It does not start planning.
- **The same grid, online only.** `buildUrl()` (`openMeteo.ts` ~:55) has no departure parameter, and `usePlanFlow` defaults to the same `fetchWindGrid` (~:243). So a plan started online within the TTL of the Wetter fetch solves on the exact grid the skipper judged. After the TTL it refetches; the plan-forecast line and the status ages make that visible.
- **Offline.** `run()` plans offline only from `opts.storedWindGrid` (`usePlanFlow.ts` ~:363–370), which App passes only for an active next-passage seed (`App.tsx` ~:1404). So while offline the card shows `conditions.useAsDeparture.offline` next to the button, and the button still sets the departure. Falling back to the Wetter session grid offline would widen the source spec's Offline-scope row; that is the open question for the maintainer (Status).
- **Ranking windows.** Ranking departure windows stays with `DepartureCompare`. Wetter is the manual look.

## 12. Future: #1855 reachable area

- **Slot.** A second card in Wetter, "Erreichbar ab {Start}", a Disclosure closed by default under the conditions card.
- **What it shares.** The hour store (departure), the held wind grid (it computes in the worker, so it can work offline with the grid's age shown), the place lines, the harbour popup with its [Als Start]/[Als Ziel] handoff, and the canvas raster pipeline (a sibling layer with an explicit `beforeId`).
- **Primary action.** While the reach card is open, its compute button becomes the primary action and the departure handoff demotes to secondary.
- **Open UX questions:** one region or time bands; inputs (max duration as a NumberInput; which sail plan); progress and cancel (the solver is synchronous, so only the `terminate()`-based cancel from #1193 exists); budget-exhausted and partial results; whether the reach fill hides the sea-state fill (two area fills do not read together); a "reachable in ~3 h 40" line in the harbour popup; whether "Wetter" still names the tab.
- **Spike.** [`1855-reachable-area.md`](1855-reachable-area.md) answers these questions and lists its departures from this section in its §18.

## 13. Acceptance criteria

1. A cold load issues zero Open-Meteo requests. Planen is the default tab, and the tablist reads Planen, Wetter, Routen, Live, Boot. `writeSessionSnapshot` persists `'conditions'` as `'plan'`, and the persisted `Tab` union is unchanged, so the previous build still parses the snapshot.
2. Online, with nothing held, entering Wetter shows the loading skeleton at once. Staying 600 ms issues one wind request and then one wave request; the wave request starts only after the wind response resolves. Leaving within 600 ms issues none.
3. At a settled camera (two consecutive byte-equal screenshots per state), toggling only sea-state visibility changes a sampled water pixel inside a coastal cell and leaves the adjacent land pixel unchanged, in plan mode and on Wetter. Mutation check: drawing today's rectangles reds the land half.
4. Every shaded cell has exactly one marker: an arrow, or a dot when the direction is NaN. With barbs visible (PR B), each marker lies inside its own cell, on the downwind side, off the wind axis (unit test of the placement rule).
5. Stepping by hour or day, dragging, a day button and a strip column each change the hour and the map. `#planner-departure` keeps its value until the button is pressed.
6. The button sets the departure (the chosen hour's start; for the current hour, `Date.now()` rounded up to the next 5 minutes at press time), selects Planen, focuses per §11 for a pointer and a keyboard press, and announces. It is never disabled. Offline it shows `conditions.useAsDeparture.offline`; an e2e offline run with a held grid asserts the note is visible before the handoff.
7. On Wetter with a plan loaded: the route line shows with dash and 0.45 opacity; the annotation and manoeuvre label layers are hidden; the alt-rig overlay is hidden; neither the plan's own barbs nor its sea state draw; `.route-layer-controls` is absent (unless `viaReplanning`); DataLayers shows its planless form; and the fake map records exactly one `addSource` for the sea-state canvas source across a Planen → Wetter → Planen round trip, with the size-discriminated `getContext` fake installed and a positive control that the source is added once (§14). Leaving restores the plan overlays and labels at the earlier slider hour.
8. Each state in §7 renders its listed copy. Offline, no request is issued. The age is visible whenever a grid is shown. With a fake clock advanced 13 h while the tab stays open, the stale copy shows, the earlier current hour is no longer selectable, and the polite region announced only the transition.
9. On Wetter a harbour tap opens that harbour's forecast popup and leaves Start and Ziel unchanged; [Als Start] and [Als Ziel] set them, and the place lines update. On the other tabs a harbour tap behaves as today.
10. On Wetter a tap on in-mask water opens "Vorhersage hier" with wind and sea rows. A seamark, AIS vessel, waypoint, the route line or an armed pick wins over it; a harbour opens its own popup (AC-9). In plan mode the popup opens only on a shaded pixel.
11. At 820x1180, DE, Wetter, no plan, forecast at least 10 min old (update button visible): the status chip and the actions row are fully inside the viewport with `.app-panel` `scrollTop` at 0. Measured with and without a toast and a banner.
12. #299: the five-tab strip has `scrollWidth <= clientWidth` at 280 and 320 px viewports, at 1024 px wide with the default panel, and at 1180x820 with the panel at its default width and at 320 px; in DE and EN, with the selected (bold) tab included.
13. New interactive controls meet the §9 target sizes.
14. No new z-index value. de/en parity holds. No new accessible name collides (§9).
15. `closure.mjs diff` reports NOT OWED. `DB_VERSION`, `sw.ts` and the CSP are unchanged.
16. For every `harbors.json` entry the place readout's sea form is pinned (model point, or `seaNone`). None renders a band from missing data, and no rendered string contains "kein Seegang" or "no sea state".
17. On Wetter with sea state visible, `sc-depth` and `sc-depth-hatch` are hidden and the depth Legende is absent, while the persisted toggles are unchanged; [Tiefen zeigen] shows depth again for the visit; leaving the tab restores it.
18. After the card is scrolled, the sticky hour row's top edge sits at the scrollport's visible top with no content showing above it.

Cut order if time runs short: "Revier zeigen" first, then the sparkline (the ribbon stays as the coverage indicator). PR A is the cut line. If it slips, keep the vector cells at reduced opacity plus the marker legend line; the land tint then remains a documented residual and the issue's land-tint requirement is only partly met.

## 14. Test plan

**Guard prerequisite.** `test/setup.ts` stubs `getContext` to null for every jsdom test, so the sea-state canvas source and the depth layers are never created there. Any test asserting them, their sources or their visibility (AC-7, AC-17, the WaveLayer, RouteLayer, DataLayers and App tests) installs, per file, a size-discriminated `getContext` fake like `layerOrder.test.tsx`'s, keyed to that file's own fixture width. It is never registered in `setup.ts`: `app/sweep/vitest.config.ts` → `setup.ts` is in the sweep closure's `EXTRA_EDGES`, so that would make the #282 sweep owed.

**Unit, PR A:**
- The raster index partition equals today's ±0.05° rectangles minus land pixels. Positive control: a coastal water point whose rectangle covers land maps those land pixels to "none".
- Land is transparent; a centre-culled cell and a NaN-Hs cell get no pixels; band colours equal `SEA_STATE_COLORS`. Corners twin `depthSourceCorners`; the row map is pinned as `depthCanvasRowMap` subsampled; `nearestWaveCell` agrees with the index; one marker (arrow or dot) per shaded cell.
- The plan-mode popup opens only on a shaded pixel.
- `windBarbs.test.ts`: the halo pass is pinned as its own op sequence, and the 2 px canvas padding leaves `barbSegments` unchanged.
- Layer creation and order are pinned with the `getContext` fake above.

**Unit, PR B:**
- `useAreaForecast`: no fetch before the dwell, dwell cleared on leave; waves called only after wind settles; fixtures; held-on-failure; offline means no call; newest-source pairing; typed errors; quiet refresh failure; the 60 s rate-limit cooldown; the 1 h automatic-refetch threshold.
- `areaForecast`: the place readout over every `harbors.json` entry (AC-16); Revier and viewport scopes; min/max, gust, circular mean and "variable"; no data never counted as calm; 3-hourly columns without past or beyond-horizon hours; the nearest-point fallback; the marker placement rule (AC-4). Also the store's seed rule.
- ConditionsPanel renders every state; the clock tick with fake timers (AC-8), including that the age text is outside the polite region; focus never moves on load. Any ref written in a cleanup is also set in setup, and the test renders under `<StrictMode>`.
- Handoff: the `Date.now()` rounding at press time; pointer versus keyboard focus targets; the offline note.
- RouteLayer override (barbs from `forecast.wind` with `legs = []`, Disclosure absent, one WaveLayer, Wetter route styling and hidden labels, rAF-coalesced barb rebuilds); DataLayers `conditionsActive` and `suppressDepth`; the harbour tap on Wetter leaves Start and Ziel unchanged; `sessionSnapshot` writes `'conditions'` as `'plan'`; App.test's #704 arrow-key test (~:929) updated to five tabs; dict and placeholder parity.

**e2e:**
- New `conditions.spec.ts` with `?windFixture=` and `?waveFixture=`, over the `STANDARD_VIEWPORTS` entries ≥820 (desktop4k, desktopHd, tabletLandscape, tabletPortrait), in both themes via `emulateMedia`. It covers:
  - `queryRenderedFeatures` on `sc-wind-barbs` and the arrow layer returning more than 0; the AC-3 A/B pixel probe;
  - scrub → place line changes; strip click → hour; harbour tap → popup, then [Als Start]; handoff fills `#planner-departure`; AC-11 geometry with and without a toast and a banner; AC-18 sticky geometry;
  - offline with a held grid: `setOffline` is used only for `navigator.onLine`; the test asserts no request is issued and the handoff note is visible.
- `layout.spec.ts` #299: `toHaveCount(5)`, a "five-tab" title, and tab boxes plus the last-tab index (~:848/:867) derived from the count; the new AC-12 cases. `waves.spec.ts` drops `EDGE`. Run the full suite anyway: the tab strip itself changes on every spec's start screen.
- No existing spec arrow-cycles the app tablist. The `ArrowRight`/`Home`/`End` uses in `waves`, `annotations` and `seamarks` drive sliders, `panel-resize` drives the resizer, and `layout.spec` ~:2103 drives the legs table. So the dwell is a safeguard, not load-bearing.

**Real browser (verify skill):** Wetter at 820x1180, 1180x820 and 1920x1080 in both themes; a plan-mode region view before and after PR A (also the README hero recapture). A daylight-legibility look covering: barbs over the rough band; barb and marker separation at overview zoom and at z10–12; whether the calm and smooth bands can be told apart at 0.45 (raise a Wetter-only fill opacity if not); a coastal shallow with depth suppressed and shown; and a smooth-band cell matching the legend swatch composited over the basemap.

**One gating measurement:** index build plus per-hour paint plus upload at half resolution, on the main thread, with 4× CDP CPU throttling (main-thread throttling works; worker throttling does not). If paint plus upload exceeds 16 ms, use quarter resolution.

## 15. Considered and rejected

- **D1 forecast dock (map-mode chip plus a bottom dock).**
  - It adds a Tier-2 participant to three same-tier height budgets plus ScaleBar's occluder set.
  - An always-visible chip changes every spec's start state.
- **D2 card at the top of Planen, with hour = departure.** Browsing rewrites a routing input and dirties a loaded plan. It also pushes Start and Ziel under the sticky "Route planen" bar at 820.
- **Implicit carry-over of the hour into the departure.** Same reason, and it would break the two-clocks separation.
- **A bare harbour tap setting Start, then Ziel, on Wetter (today's pick rule).** An exploratory tap would edit a routing input and overwrite a loaded plan's Ziel. The popup's explicit buttons replace it.
- **A viewport-scoped strip and sparkline.** They would change under every pan. The strip uses a fixed scope; the viewport range stays only as the labelled area line.
- **A disabled handoff for the current hour.** "Can I leave now?" is the on-deck question, and a disabled button gives no feedback on touch. "Jetzt als Abfahrt" replaces it.
- **The copy "kein Seegang" / "no sea state".** It reads as calm water, and the usual cause is the location, not the hour.
- **Keeping depth shading under sea state on Wetter.** The composited hues match neither legend.
- **An on-map hour label in `.route-layer-controls`.** On Wetter the container renders only for ViaMarkers' status chip; the sticky hour row is the clock.
- **Numeric wind labels on the map (this round).** A new symbol layer would join the collision index beside #378's annotation layers; revisit after the daylight check.
- **The two Wetter toggles as header chips, or in Anzeigeoptionen.** The header row has no width for them at 820 beside the status chip and update button (estimate), and new rows in Anzeigeoptionen hit the depth-legend budget. They stay in the Disclosure, which is open on wide.
- **A "Hier (GPS)" line.** It adds a row to the narrow budget, and a fix exists only while `showOwnship` or Live tracking runs.
- **A "Wind und Seegang zur Abfahrt ansehen" link in PlannerPanel (D3).** Discoverability already comes from the tab strip. The link would add about 44 px to the default tab and shift its starting state for every spec (#1405), for a convenience only.
- **An explicit "Laden" button on first entry.** It costs a tap every session on a tab whose name is already the request. The dwell plus the audit in §14 keeps the zero-request guarantee.
- **Parallel wind and wave fetch.** It contradicts `usePlanFlow`'s ordering, which exists because of the 429 history.
- **A separate ConditionsLayer with its own barb source.** That means two owners of the same layers and shared source ids. RouteLayer already owns barbs and WaveLayer.
- **Hour in App state.** Every tick would re-render the whole App tree.
- **Linear raster resampling.** It produces colours between bands that the legend does not list when the raster is magnified; `nearest` avoids that only under magnification (§5).
- **In-canvas cell outlines.** They are drawn in raster pixels, so their on-screen width follows the raster's magnification: thin at overview zoom, thick when zoomed in.
- **Bilinear Hs, or borrowing a neighbour's value into fjords.** Either invents data; land-point behaviour is unverified (spec §0). The place readout's labelled model point shades nothing.
- **Masking with the basemap's land layers.** Ordering is fragile, and the coastline differs from the nav mask.
- **A wind colour field.** A second colour scale would collide with the sea-state ramp, and the Okabe-Ito lock keeps barbs ink.
- **A viewport range as the only readout.** It moves with pan and gives no value at the harbour; the place lines are primary instead.
- **A horizontally scrolling or wrapping strip.** Scrolling hides columns and a 4×2 wrap breaks the timeline; narrow strips become a list instead.
- **Persisting the area forecast to IndexedDB or the service worker.** CLAUDE.md says the SW never caches Open-Meteo, and spec §0 says a DB version bump breaks production for anyone who opens `/uat/`.
- **Auto-fitting the camera on tab entry.** At 820 the maxBounds floor (z7.97) and the sheet prevent a whole-area fit, and moving the camera unasked is a surprise.
- **"Vorhersage" as the tab name; reusing "Vorhersagezeitpunkt" or `banner.retry`.** Substring and same-screen collisions (§9).
- **A dark or night basemap.** Settled ruling, never proposed.
