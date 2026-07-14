# SailCommand — Design Specification

**Date:** 2026-07-14
**Status:** Approved by user (brainstorming session)
**Working name:** SailCommand

## 1. Purpose

Plan the fastest sailable route between two points in the Flensburg Fjord /
Danish South Sea area for a **Salona 45** (standard main + genoa or fock),
using real hourly wind forecasts. The optimizer minimizes tacks and gybes by
pricing each maneuver into the time cost. Planned routes persist across app
restarts and connection loss. While sailing, the device GPS shows the current
position on the planned route. The app runs in the browser and installs on
Android as an offline-capable PWA.

## 2. Decisions (from requirements dialogue)

| Topic | Decision |
|---|---|
| Platform | Pure client-side PWA (Vite + React + TypeScript), no backend |
| Wind model | Time-evolving hourly forecast (isochrone routing), Open-Meteo (DWD ICON), fetched directly from browser |
| Obstacles | Land **and** depth aware; safety depth configurable, default 3.0 m (draft 2.1 m) |
| Departure time | Selectable within forecast horizon (~6 days) |
| Port entry | Searchable curated harbor list **plus** tap-anywhere on map |
| Offline scope | Planning requires internet; following/viewing planned routes fully offline (route + wind used + map data persisted) |
| Sail choice | Router evaluates both rigs (main+genoa, main+fock) and recommends the faster; routes with recommendation |
| Live guidance | GPS position + active leg, heading to steer, distance to next maneuver, ETA. No live re-routing in v1 |
| Area | 54.3–55.3°N, 9.4–11.0°E (Flensburg Fjord, Als, Schlei, Kiel Bight, Ærø, Fyn archipelago to Svendborg/Faaborg, southern Little Belt) |
| Engine | Motor fallback: configurable motoring speed (default 6.5 kn); router may plan engine legs when sailing speed < threshold (default 2.5 kn), clearly marked |
| Language | German + English, UI toggle |
| Hosting | GitHub Pages via GitHub Actions (static site, HTTPS) |

## 3. Architecture

Two parts: a **build-time data pipeline** producing static assets, and the
**frontend PWA** consuming them.

### 3.1 Data pipeline (scripts in `pipeline/`, outputs committed to `app/public/data/`)

Run on the dev machine (or GitHub Actions) when data needs refreshing — not at
app runtime.

- **Land/depth mask** — OSM land polygons + EMODnet Bathymetry (Baltic ~115 m
  grid) → packed binary grid, ~100 m cells, covering the bbox. Each cell
  stores quantized depth (or LAND). The router tests navigability as
  `depth >= safety depth` at query time, so safety depth stays user-tunable
  without regenerating data. Estimated size: ~1100 × 1200 cells ≈ 1.3 M cells
  ≈ 1.3 MB at 1 byte/cell (gzip smaller).
- **Harbor list** — curated JSON, ~30 harbors (Flensburg, Glücksburg,
  Langballigau, Kappeln, Maasholm, Schleimünde, Gelting, Sønderborg, Aabenraa,
  Dyvig, Augustenborg, Høruphav, Ærøskøbing, Marstal, Søby, Faaborg,
  Svendborg, Lyø, Avernakø, Drejø, Bagenkop, …). Fields: id, names (de/dk/en),
  lat/lon of a **guaranteed-navigable snap point** just off the harbor mouth.
- **Basemap** — regional vector-tile extract as a single PMTiles file
  (Protomaps builds), ~30 MB, rendered by MapLibre GL. Fully offline once
  cached.
- **Polars** — two JSON speed tables (TWA × TWS → boat speed) for Salona 45:
  main+genoa and main+fock. Derived from ORC VPP data for the class (research
  task at implementation time; fall back to VPP estimates from comparable
  45 ft cruiser-racers if no ORC certificate data is obtainable). A
  user-facing **performance factor** (default 0.90) scales polar speeds.

### 3.2 Frontend PWA (`app/`)

- **Map view** — MapLibre GL + PMTiles protocol. Route overlay: legs colored
  by type (sail port/starboard, motor), maneuver markers, wind barbs overlay
  (from the plan's stored wind grid), boat position marker.
- **Planner UI** — origin/destination picker (searchable harbor list + map
  tap), departure time picker, options panel: safety depth, motor speed,
  motor threshold, maneuver penalty, performance factor. "Plan route" button.
- **Wind service** — Open-Meteo forecast API, hourly `wind_speed_10m`,
  `wind_direction_10m`, `wind_gusts_10m` at grid points ~0.05–0.1° spacing
  over the bbox (batched multi-point requests), covering departure → forecast
  horizon. Bilinear spatial + linear temporal interpolation. The fetched grid
  is stored with the plan (reproducibility + offline viewing).
- **Routing engine** — TypeScript, runs in a **Web Worker**:
  - Isochrone algorithm: expand reachable frontier every Δt (adaptive,
    ~10 min), candidate headings every 5–10°, prune dominated points,
    terminate on destination convergence, backtrack path.
  - Wind interpolated in space and time at each expansion.
  - **Maneuver penalty** (default 45 s per tack/gybe) added when a candidate
    heading crosses the wind relative to the parent leg — this is the
    tack/gybe minimization mechanism.
  - Land/depth mask collision test along every candidate segment (grid
    traversal).
  - **Motor fallback**: where best sailing VMG toward candidate directions
    yields boat speed < threshold, add motor edges at motor speed, flagged.
  - Post-processing: merge near-collinear legs; re-validate merged legs
    against mask and wind.
  - Runs twice (genoa polar, fock polar); recommend faster rig; show both ETAs.
- **Route result** — ordered legs: type (tack/board, reach, run, motor),
  start/end coords + times, compass heading, TWA, TWS, expected boat speed;
  totals: distance, duration, maneuver count, ETA. **GPX export** (optional
  nice-to-have) for chartplotters.
- **Live view** — Geolocation `watchPosition`: boat marker, COG/SOG, active
  leg highlight, heading to steer, distance to next maneuver, ETA projection
  along the planned route (no re-route).
- **Persistence** —
  - IndexedDB: saved plans (route + wind grid + settings snapshot), user
    settings. Plans survive restarts and offline periods; user can delete.
  - Service worker: precache app shell + static data (mask, polars, harbors,
    basemap). After first online visit, everything except *new* planning
    works offline.
- **i18n** — lightweight dictionary (de/en), toggle in UI, persisted.

### 3.3 Hosting / CI

GitHub repository; GitHub Actions workflow builds the app and deploys to
GitHub Pages. HTTPS (required for service worker + geolocation) comes free.
Android install via browser "Add to Home Screen".

## 4. Error handling

| Condition | Behavior |
|---|---|
| Offline / Open-Meteo unreachable | Planning disabled with clear message; saved plans fully usable |
| API transient error | Retry with backoff, then user-visible error |
| No route found (calm + motor off / unreachable / beyond horizon) | Explicit message with reason |
| GPS denied or unavailable | App fully usable, no boat marker; hint shown once |
| Stale forecast (fetch → departure gap > 12 h) | Warning banner on the plan |
| Start/end point on land or shallow | Snap to nearest navigable cell within ~300 m, else error |

## 5. Testing

- **Unit**: polar interpolation, wind space/time interpolation, mask queries,
  maneuver detection/penalty, GPX output.
- **Golden routes** (synthetic wind fields): dead upwind in open water →
  small tack count (bounded, not 20); beam reach → 0 maneuvers; island
  between ports → clean rounding; calm + motor on → straight motor leg;
  calm + motor off → "no route" with reason.
- **Property tests**: no leg crosses land/shallow mask; leg times strictly
  increasing; legs geometrically continuous.
- **E2E (Playwright)**: plan → save → offline reload → plan still visible;
  service worker serves app offline.
- **Manual acceptance**: real forecast plan Flensburg → Marstal and
  Flensburg → Sønderborg reviewed visually.

## 6. Out of scope (v1)

Currents/tides, wave data, AIS, live re-routing, multi-day passages beyond
forecast horizon, route sharing/collaboration, official ENC chart data.

## 7. Caveats (will be stated in the app)

- Polars are **estimates** derived from ORC-style VPP data, tunable via
  performance factor; not race-calibrated.
- SailCommand is a **passage-planning aid, not a navigation device**. Chart
  data is simplified; the official chart/plotter remains authoritative.
- First load downloads ~30–40 MB (basemap + data); subsequent loads cached.

## 8. Post-approval additions (2026-07-15, user-requested during implementation)

- **Movable via-waypoints with auto re-route (in scope, v1):** plans may carry
  ordered via-waypoints (`PlanRequest.viaPoints`); the router solves each
  segment per rig and concatenates. The UI lets the user add vias at plan time
  and drag via markers on the map; on drop the route recomputes against the
  plan's **stored** wind grid (no refetch). Vias snap to navigable water
  (300 m) or fail with `snap-failed-via`. v1 simplification: maneuver state
  does not carry across via joints. (Issue #4; plan tasks B13/E8.)
- **Garmin Boating route sync (backlog, v2):** import routes from Garmin
  Boating and push basic updates back. First increment will be file-based GPX
  import (export already exists); true API sync is constrained by the
  no-backend rule. (Issue #3.)
