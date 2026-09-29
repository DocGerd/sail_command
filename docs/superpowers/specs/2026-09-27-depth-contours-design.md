# Depth contours (#629) — design

Status: approved by the maintainer 2026-09-28, with the amendments from PR #1522's review.
Source: issue #629 (the measurement write-up); the maintainer ruling comment on it dated 2026-09-27 (Q1, Q2, Q4, Q5); the maintainer rulings of 2026-09-28 recorded at https://github.com/DocGerd/sail_command/issues/629#issuecomment-5873587510 (contour-label anchor, outer-boundary edge; its toggle-placement ruling is superseded, §3); and this document's approval (Q3, Q7, architecture).

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

Q10 smoothing landed in #1540 (§2). Deferred: Q11 datum surfacing, per-level colour. Q12 (#599 raster zoom degradation) does not apply to vector lines. Q13 is answered by §2's measurement requirement.

## 2. Data product

`pipeline/build_contours.py` reads `app/public/data/mask.bin` and `mask.meta.json` and writes `app/public/data/contours.json`. It is generated, never hand-edited (`pipeline/README.md`), and gets its own npm script in `pipeline/package.json`.

Cell classification, exact in integers. With mask byte `b`:
- `b = 0` is no-data (land, unsurveyed or drying).
- For `b` in 1–254 the cautious depth in tenths is `max(0, b − 9)` (`b/10 − 0.9` floored to a decimetre and clamped at 0, as `cautiousDepthLowerBoundM` does), so a cell is at or above level `L` iff `b ≥ 10·L + 9`.
- `b = 255` (≥ 25.4 m) has a cautious depth of 24.5 m, above every level.

Byte 254 is never emitted by the mask build; the rule covers it anyway.

Geometry:
- **Level lines.** For each level, trace every shared cell edge between a cell at or above `L` and a non-zero cell below it. Merge the segments into polylines. Level lines are shortcut greedily over their own staircase vertices; a chord is accepted only if it and every shorter chord from the same start stay in the closure of the at-or-above-L cells and it touches a cell beside every edge it skips (#1540). Guarantees, pinned jointly by the "#1540 region" rows and the "#1540 smoothed level lines" closure rows in `contoursAsset.test.ts`: the region a line set shows as at-or-above L, closed by the deep cells' own no-data and grid edges, is a subset of the at-or-above-L cells, and every line segment lies in the closure of those cells. The no-data edge is unsmoothed. Corners that point into deep water stay square where a shortcut would cross a shallow cell (shoal tips, one-cell shoals); along a diagonal run of steps a line passes straight through them.
- **No-data edge.** Trace every cell edge between a byte-0 cell and a non-zero cell, and every outer-boundary edge of a non-zero cell, once, as a separate feature. Level lines therefore end where they meet this edge, which is visible, instead of stopping silently.
- Before smoothing the two geometries share no edge: a traced level edge only ever separates two non-zero cells. A smoothed chord can lie along a deep-cell/byte-0 edge, so a level line may overlap the no-data edge (measured on the asset #1549 merged, axis-aligned unit edges: 18, 26, 12, 1, 0 and 0 at 2, 3, 5, 10, 15 and 20 m).

Output: a GeoJSON `FeatureCollection` of `LineString`/`MultiLineString` features.
- Properties: `{ "kind": "contour", "levelM": L }` or `{ "kind": "no-data" }`.
- Coordinates are rounded to 1e-5°.
- Top-level members: `maskSha256` (hex of `mask.bin`), `basis: "cautious"`, `toleranceM: 0.9`, and `levelsM: [2, 3, 5, 10, 15, 20]`.

The build must report feature, vertex and byte counts, raw and gzipped. Figures quoted in #629 were measured on the pre-#295 5.28 M-cell mask and are not reused. At `6ff19f2` the mask is 3025 × 3120 = 9,438,000 cells. If the gzipped size exceeds 2 MB, stop and bring it back to the maintainer before shipping.

Delivery: `globPatterns` already precaches `.json` under `data/`, so no service-worker or Vite config change is needed. Precaching means the first service-worker install, and every install after the file changes, downloads it whether or not contours are ever shown; that is the price of offline use. The 2 MB gate bounds the gzipped transfer; the build must also report the raw size against `PRECACHE_MAX_FILE_SIZE_BYTES` (`app/vite.config.ts`), above which the file is left out of the precache with only a build-log warning, not a build failure. Only the map source is loaded on demand (§3). The runtime fetch is outside `loadRoutingAssets()`'s `Promise.all`, so a failure here cannot empty the harbour list or break online routing; like every precached file, it does share the service-worker install, which fails as a whole if any entry fails.

## 3. Rendering

`DataLayers.tsx` owns it, through `installStyleSetup` like the depth rasters.
- Source `sc-contours` (GeoJSON). Its data is fetched the first time the toggle turns on and kept in memory afterwards.
- Three layers, re-derived on every style setup:
  - `sc-contour-lines`: thin line in one chart colour, slightly heavier for `levelM <= 3`.
  - `sc-contour-nodata`: dashed neutral grey line.
  - `sc-contour-labels`: `symbol-placement: 'line'`, `text-field` is the level in metres as a bare number (the chart convention), `text-font: ['Noto Sans Regular']`, a halo, and collision on (`text-allow-overlap: false`, `text-ignore-placement: false`).
- `sc-contour-lines` and `sc-contour-nodata` are anchored at the same `beforeId` as `sc-depth`.
- `sc-contour-labels` is anchored directly below the first basemap `symbol` layer in style order, found from the loaded style at setup, not hard-coded. Placement runs top-down, so basemap labels are placed first and win collisions; a contour label is the first to be culled (maintainer ruling 2026-09-28). The anchor puts the labels beneath every layer the app adds, including `sc-depth`'s shading, the `sc-depth-hatch` overlay (on by default, and when on it covers the shallow side of every 2 m line at any allowed gate) and the contour lines. The implementation checks label legibility in a browser with depth shading and hatch both on, including at z14 and above where the hatch is a full wash, and stops and reports if the labels are not legible.
- Toggle: a top-level row of "Anzeigeoptionen", beside the hatch toggle (maintainer ruling on #1541, 2026-09-29, superseding the 2026-09-28 legend placement): with no plan, in DataLayers' own "Anzeigeoptionen" disclosure alongside Wassertiefen and Seezeichen; with a plan, in `RouteLayer`'s "Anzeigeoptionen". It uses `usePersistedToggle('sc-contours-visible', false)`, default off. The label is "Tiefenlinien" / "Depth contours" through the i18n dictionary. It must not contain the substring "Wassertiefen": Playwright's `getByRole` matches names by substring, and existing e2e locators use that string without `exact`.
- Fetch failure: the layers stay absent, and the toggle shows an inline, non-blocking error string. There is no retry loop.

## 4. Legend

While contours are visible, the depth legend gains the entries below: in DataLayers' `.depth-legend` when no plan is active, and in `RouteLegend`'s depth section when one is (the two are complementary, #813):
- a line swatch with "Tiefenlinien: vorsichtige Lesart, 0,9 m unter dem Kartenwert" / "Depth contours: cautious reading, 0.9 m below the charted value";
- a dashed swatch with "Grenze der Tiefendaten" / "Edge of depth data".

It does not claim chart authority.

## 5. Guards

| Guard | Fails when |
|---|---|
| `contours.json` `maskSha256` equals sha256 of `mask.bin` (TS, `readFileSync`) | the mask is rebuilt without regenerating contours |
| `toleranceM` equals `MASK_TOLERANCE_M`, and `levelsM` equals the renderer's level list | the basis drifts between Python and TS |
| Level lines: per level, every segment lies in the closure of the at-or-above-L cells, every vertex is a vertex of the level's staircase, every qualifying staircase edge borders a cell a segment touches, and the area the lines enclose, closed by the deep cells' own no-data and grid edges, contains no below-L cell (the "#1540 region" rows; cells classified through TS `cautiousDepthLowerBoundM`). No-data: for sampled segments, either the segment is interior and its two adjacent cells are one byte-0 and one non-zero, or it lies on the mask's outer boundary and its one adjacent cell is non-zero | the pipeline's integer rule or its smoothing diverges from the app's formula |
| unit: `sc-contour-labels` is added with `beforeId` equal to the style's first basemap `symbol` layer | the labels-yield anchor regresses |
| e2e: fresh profile has the toggle off and no contour features; toggling on renders level lines and at least one label at a fixed view; `getByRole` locators for "Wassertiefen" still resolve uniquely | rendering or default state regresses, or the label collides |

Each guard gets a mutation check, run at BASE and HEAD: the stale-hash mutant, the tolerance mutant, an off-by-one in the pipeline threshold, a chord accepted across a shallow cell, boundary edges traced for byte-0 cells too, and a toggle default of `true`. Run ruff on the new script by hand, since `Python lint` is advisory. The stylesheet (if touched) is read with `readFileSync`, never `?raw`.

## 6. Delivery constraints

- The #282 sweep closure's path prefixes include `pipeline/` and `app/public/data/`, so a sweep is owed. Verify with `closure.mjs diff`. The baseline is a BASE double-run at the branch's own merge-base with `develop`, unless `closure.mjs reuse <recorded-sha> <merge-base>` returns REUSE for an entry in `.claude/skills/sweep-closure/recorded-runs.json`. Routes cannot move (nothing in the solve reads the new file), so every arm must hash-match BASE.
- It is a user-visible feature, so it ships a `changelog.d/629.added.md` fragment.
- Screenshots: #1541 moves the toggle into "Anzeigeoptionen", so regenerate the README images with `docs/screenshots/capture.mjs` at the next release sweep.
