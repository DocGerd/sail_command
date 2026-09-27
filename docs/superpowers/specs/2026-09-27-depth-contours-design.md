# Depth contours (#629) — design

Status: approved in conversation 2026-09-27; this document awaits maintainer review.
Source: issue #629 (the measurement write-up) and the maintainer ruling comment on it dated 2026-09-27.

## 1. Decisions on record

| # | Question | Ruling |
|---|---|---|
| Q1 | Contour basis | The cautious reading (`cautiousDepthLowerBoundM`), named in the legend. |
| Q2 | Labels | Inline numeric labels on the line. |
| Q3 | Levels | 2, 3, 5, 10, 15, 20 m. |
| Q4 | Depth range | Capped at the mask; derived from `mask.bin` (no source-GeoTIFF product). |
| Q5 | Byte-0 edge | An explicit "no depth data" rendering; a level line never silently stops. |
| Q7 | Toggle | Its own persisted toggle, default off. |
| — | Architecture | Build-time: a pipeline script writes a committed asset (issue §D2). |

Deferred: Q10 smoothing, Q11 datum surfacing, per-level colour. Q12 (#599 raster zoom degradation) does not apply to vector lines. Q13 is answered by §2's measurement requirement.

## 2. Data product

`pipeline/build_contours.py` reads `app/public/data/mask.bin` and `mask.meta.json` and writes `app/public/data/contours.json`. It is generated, never hand-edited (`pipeline/README.md`), and gets its own npm script in `pipeline/package.json`.

Cell classification, exact in integers. With mask byte `b`:
- `b = 0` is no-data (land, unsurveyed or drying).
- For `b` in 1–254 the cautious depth in tenths is `b − 9` (`b/10 − 0.9` floored to a decimetre), so a cell is at or above level `L` iff `b ≥ 10·L + 9`.
- `b = 255` (≥ 25.4 m) has a cautious depth of 24.5 m, above every level.

Byte 254 is never emitted by the mask build; the rule covers it anyway.

Geometry:
- **Level lines.** For each level, trace every shared cell edge between a cell at or above `L` and a non-zero cell below it. Merge the segments into polylines. The result is a staircase on the ~46 m grid, deliberately unsmoothed: any smoothing would move part of a cautious line into shallower water.
- **No-data edge.** Trace every cell edge between a byte-0 cell and a non-zero cell, once, as a separate feature. Level lines therefore end where they meet this edge, which is visible, instead of stopping silently.
- The two geometries never share an edge: a level line only ever separates two non-zero cells.

Output: a GeoJSON `FeatureCollection` of `LineString`/`MultiLineString` features.
- Properties: `{ "kind": "contour", "levelM": L }` or `{ "kind": "no-data" }`.
- Coordinates are rounded to 1e-5°.
- Top-level members: `maskSha256` (hex of `mask.bin`), `basis: "cautious"`, `toleranceM: 0.9`, and `levelsM: [2, 3, 5, 10, 15, 20]`.

The build must report feature, vertex and byte counts, raw and gzipped. Figures quoted in #629 were measured on the pre-#295 5.28 M-cell mask and are not reused. The current mask is 9,438,000 cells. If the gzipped size exceeds 2 MB, stop and bring it back to the maintainer before shipping.

Delivery: `globPatterns` already precaches `.json` under `data/`, so no service-worker or Vite config change is needed. The file is fetched lazily (§3) and is outside `loadRoutingAssets()`'s `Promise.all`, so a failure here cannot empty the harbour list or break routing.

## 3. Rendering

`DataLayers.tsx` owns it, through `installStyleSetup` like the depth rasters.
- Source `sc-contours` (GeoJSON). Its data is fetched the first time the toggle turns on and kept in memory afterwards.
- Three layers, all anchored at the same `beforeId` as `sc-depth`, re-derived on every style setup:
  - `sc-contour-lines`: thin line in one chart colour, slightly heavier for `levelM <= 3`.
  - `sc-contour-nodata`: dashed neutral grey line.
  - `sc-contour-labels`: `symbol-placement: 'line'`, `text-field` is the level in metres as a bare number (the chart convention), `text-font: ['Noto Sans Regular']`, a halo, and collision on (`text-allow-overlap: false`, `text-ignore-placement: false`).
- Placement runs top-down, so the basemap's symbol layers win collisions against the contour labels. Accepted: a contour label is the first to be culled.
- Toggle: a new checkbox in the data-layer controls, `usePersistedToggle('sc-contours-visible')`, default off. The label is "Tiefenlinien" / "Depth contours" through the i18n dictionary. It must not contain the substring "Wassertiefen": Playwright's `getByRole` matches names by substring, and existing e2e locators use that string without `exact`.
- Fetch failure: the layers stay absent, and the toggle shows an inline, non-blocking error string. There is no retry loop.

## 4. Legend

While contours are visible, the depth legend gains:
- a line swatch with "Tiefenlinien: vorsichtige Lesart, 0,9 m unter dem Kartenwert" / "Depth contours: cautious reading, 0.9 m below the charted value";
- a dashed swatch with "Grenze der Tiefendaten" / "Edge of depth data".

It does not claim chart authority.

## 5. Guards

| Guard | Fails when |
|---|---|
| `contours.json` `maskSha256` equals sha256 of `mask.bin` (TS, `readFileSync`) | the mask is rebuilt without regenerating contours |
| `toleranceM` equals `MASK_TOLERANCE_M`, and `levelsM` equals the renderer's level list | the basis drifts between Python and TS |
| Differential: for sampled level-line segments, the two adjacent cells classify on opposite sides of the level through TS `cautiousDepthLowerBoundM`; for sampled no-data segments, exactly one side is byte 0 | the pipeline's integer rule diverges from the app's formula |
| e2e: fresh profile has the toggle off and no contour features; toggling on renders level lines and at least one label at a fixed view; `getByRole` locators for "Wassertiefen" still resolve uniquely | rendering or default state regresses, or the label collides |

Each guard gets a mutation check, run at BASE and HEAD: the stale-hash mutant, the tolerance mutant, an off-by-one in the pipeline threshold, and a toggle default of `true`. Run ruff on the new script by hand, since `Python lint` is advisory. The stylesheet (if touched) is read with `readFileSync`, never `?raw`.

## 6. Delivery constraints

- The #282 sweep closure's path prefixes include `pipeline/` and `app/public/data/`, so a sweep is owed. Verify with `closure.mjs diff`. Branch from `a4c0ad3` so T1's BASE double-run at that commit (v0.46.0 cycle) serves as the baseline; only a HEAD run is then needed. Routes cannot move (nothing in the solve reads the new file), so every arm must hash-match BASE.
- It is a user-visible feature, so it ships a `changelog.d/629.added.md` fragment.
- Screenshots: the toggle is off by default, so no docs image changes.
