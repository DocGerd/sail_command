# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SailCommand — an offline-capable PWA that plans time-optimal sailing routes
for a Salona 45 in the Flensburg Fjord / Danish South Sea area
(54.3–55.3°N, 9.4–11.0°E), using hourly Open-Meteo wind forecasts and an
isochrone router that prices tacks/gybes as time penalties.

**Source of truth:** `docs/superpowers/specs/2026-07-14-sail-command-design.md`
(user-approved). Read it before making design-level decisions; do not silently
deviate from it.

## Layout

- `pipeline/` — build-time data preparation (Node/Python scripts). Outputs are
  committed static assets in `app/public/data/`: land/depth mask (packed
  binary, ~100 m cells, quantized depth per cell), curated harbor list JSON,
  PMTiles regional basemap, Salona 45 polar tables (main+genoa, main+fock).
  Pipeline runs on demand, never at app runtime.
- `app/` — the PWA: Vite + React + TypeScript, MapLibre GL + PMTiles,
  routing engine in a Web Worker, IndexedDB persistence, service-worker
  offline caching, de/en i18n. Tests: Vitest (unit/property), Playwright (E2E
  incl. offline reload).

Commands will be documented here as the scaffold lands (npm scripts in
`app/package.json` and `pipeline/package.json`).

## Domain rules that are easy to get wrong

- **Navigability is decided at query time** (`cellDepth >= safetyDepth`), not
  baked into the mask — safety depth (default 3.0 m; boat draft 2.1 m) is a
  user setting and must never require regenerating data.
- **Wind grids are stored with each plan** (IndexedDB). A saved route must
  always render against the forecast it was computed from, never a re-fetched
  one.
- **Tack/gybe minimization is not a separate pass**: it emerges from the
  maneuver time penalty (default 45 s) inside the isochrone cost. Don't add a
  post-hoc "tack reducer" that can violate wind/depth constraints; the only
  allowed post-processing is merging near-collinear legs with re-validation.
- **The router runs twice per plan** (genoa polar, fock polar) and recommends
  the faster rig. Both results are user-visible.
- **Motor legs are first-class**: planned when sailing speed < threshold
  (default 2.5 kn) at motor speed (default 6.5 kn), and always flagged as
  motor in the result.
- Angles: wind direction is meteorological (coming FROM, degrees true);
  polars are TWA × TWS → boat speed in knots. Positions are WGS84.
  Distances in nautical miles, speeds in knots.
- Open-Meteo is called directly from the browser (CORS is open, no API key).
  There is deliberately **no backend** — do not introduce one.

## Working style for this repo

- Planning requires network; everything else must keep working offline. Any
  new feature that silently assumes connectivity is a bug.
- The app is a passage-planning aid, not a navigation device — user-facing
  copy must not claim chart authority.
- UI strings always go through the i18n dictionary (de/en), never hardcoded.
