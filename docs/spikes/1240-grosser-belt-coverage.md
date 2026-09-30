# Spike #1240 — extending coverage over the full Großer Belt

- **Issue:** #1240 (deferred from #295; `priority: low`, milestone v0.50.0)
- **Date:** 2026-09-30. **Merge-base:** `4d2d138`.
- **Status:** Recommendation only. No pipeline command was run and no asset
  was rebuilt.
- **Verdict:** **The issue's premise is inverted: the belt's eastern shore is
  already inside the mask, and what is cut off is its northern half.** The
  strait runs north-south, the mask's east edge (11.6°E) lies beyond the
  Zealand shore, and the strait is truncated by the 55.6°N edge (§1).
  Extending "east" buys none of the belt. Two slices follow: **A**, curate the
  harbours on the belt's far shore inside the existing box, which changes no
  area, wind lattice, basemap or stored plan (§7.1); and **B**, a north
  extension of the whole mask width, which is moderate in bytes but breaks
  every stored plan's replan path and needs three measurements first (§7.2).
  **Go on A. B is no-go until a named harbour north of 55.6°N justifies it.**

Companions: [`1163-295-coverage-scoping.md`](1163-295-coverage-scoping.md)
(the coupled-site method this reuses, and the §5 question this answers),
[`296-lazy-load-map-data.md`](296-lazy-load-map-data.md),
[`245-depth-mask-resolution.md`](245-depth-mask-resolution.md).

## 0. Basis

- **Measured** figures are read from committed files at `4d2d138`:
  `app/public/data/mask.bin` (a read-only scan; row 0 = south per
  `mask.meta.json`), the PMTiles headers of the three basemap archives
  (bbox at header bytes 102–117), `seamarks.json` and `harbors.json`.
- **Derived** figures are arithmetic from constants named beside them.
- **Estimates** are marked as such. `pipeline/data-src/` is empty in a new
  worktree, so nothing that needs the EMODnet raster, the Protomaps build or
  Overpass was measured.
- Place coordinates for Korsør, Skælskør, Kalundborg and Samsø are from
  general knowledge. **`git grep` finds none of them in the repo** (outside
  #1163's prose), and `seamarks.json` carries no names (properties are
  `seamarkType`, `category`, `colour`), so no committed file can anchor them.
  The harbours that define "full" must be fixed from OSM at implementation
  time.

## 1. Where the bound is

Water runs in `mask.bin` (byte > 0; runs shorter than 4 cells, about 190 m,
dropped from the middle rows):

| Latitude | Water span in the belt, °E |
|---|---|
| 55.6 (north row) | 10.64–11.139 (also 9.81–10.158) |
| 55.55 | 10.69–11.15 |
| 55.4 | 10.74–11.21 |
| 55.3 | 10.85–11.20 |
| 55.25 | 10.80–11.17 |

- **North:** at the north row the strait is still 0.499° wide, about 32 km
  at `P ≈ 64312 m/deg` (`pipeline/README.md`). It is open water cut by the
  box edge, not a shore.
- **East:** for 55.3–55.55°N no water run wider than 3 cells lies between
  11.3°E and the 11.6°E edge, so the Zealand shore is inside the box.
- **East edge, elsewhere:** at 11.6°E water is open over 54.852–55.189°N and
  54.3–54.663°N. Those spans are not the belt (§8 rejects following them).
- Region archives: `region-north` covers 9.4–11.0°E × 55.304–55.6°N and
  `region-east` covers 11.03–11.6°E × 54.3–55.6°N (PMTiles headers), so the
  basemap over the whole belt below 55.6°N is already lazily available.
- `MapView.tsx`'s `MAX_BOUNDS` north edge (55.85) is a camera limit, not a
  data bound. Nothing in the repo says where the belt ends northward; that
  also needs OSM.

## 2. What "full" means

The mask is one rectangle, so any north extension spans the full 9.4–11.6°E
width and brings Jutland's east coast and everything else in that band with
it. Harbour curation and the water-fraction gate apply to the whole strip,
not to the belt alone.

Harbour candidates (names from general knowledge, coordinates unverified):

- **Inside the current box:** Korsør and Skælskør, on the Zealand shore.
  `harbors.json`'s only harbours east of Nyborg (10.7975°E) are Fehmarn's
  Orth and Burgstaaken (about 54.4°N).
- **North of 55.6°N:** Kalundborg and Samsø's harbours.

Each new harbour follows `pipeline-refresh`: `harbors-source.json` row, a
mandatory German note for every non-null English note, snap on the real
fairway, then `verify_mask.py`. #245 recorded that harbours sitting exactly on
their gate disconnect, so expect a `KNOWN_DISCONNECTED` or
`CONNECTIVITY_EXCEPTIONS_M` outcome for some; that is unmeasured.

## 3. Cost of a north extension

Two candidate north edges, chosen to bracket the question and **not** fixed
by this spike. Row step is 1/2400° (`ROWS` 3120 over 1.3°), so 0.1° is 240
rows, and rows append after the existing bytes because row 0 is south.

| | Today | To 55.8°N | To 56.0°N |
|---|---|---|---|
| Rows × 3025 cols | 3120 | 3600 | 4080 |
| Cells = `mask.bin` bytes | 9,438,000 | 10,890,000 (×1.154) | 12,342,000 (×1.308) |
| `defaultMaxFrontier` (0.2 × prune cells) | 95,333 | 110,000 | 124,667 |
| BFS scratch, resident (5 B/cell) | 47.2 MB | 54.5 MB | 61.7 MB |
| Wind lattice points (lats × 23) | 322 | 368 | 414 |
| Wind grid, 3 × Float32 × 144 h | 556,416 B | 635,904 B | 715,392 B |

- **Frontier cap** derives from the domain in degrees over `PRUNE_LAT` 0.002
  and `PRUNE_LON` 0.003 (476,667 prune cells today) in
  `defaultMaxFrontier`, so it rises for **every** plan, not only new ones.
  #1496 measured no truncation at the current cap.
- **BFS scratch** is `Uint8Array` + `Int32Array` sized to the largest grid
  seen (#1256, `mask.ts`); the 5 B/cell is from that comment.
- **Water fraction** is 0.488 today against the `0.45 < frac < 0.85` gate in
  `build_mask.py`. A strip only breaks the lower bound if its own water
  fraction falls below 0.20 (to 55.8°N) or 0.33 (to 56.0°N), by solving
  `0.488·N + w·Δ ≥ 0.45·(N+Δ)`. That is not a binding risk unless the strip
  is mostly land.
- **Eager precache growth** (estimate): `mask.bin` +1.45 / +2.90 MB (derived)
  plus `contours.json` and `seamarks.json`. Scaling `contours.json`
  (3,219,087 B) by the cell ratio gives about +0.5 / +1.0 MB, but contour
  size tracks bathymetric complexity, not area. `seamarks.json` is 559,816 B
  for 2,905 nodes (193 B each); 151 nodes sit in the current top 0.1° band,
  so at that density the strip adds about 0.06 / 0.12 MB. Every file stays far
  under the 41,943,040 B per-file precache cap.
- **Boundary cells:** the #295 addendum recorded that cells on the old edge
  changed by −1.0 to +0.8 m because the old download was clipped to the old
  box. Expect the same class of change on the 55.6°N row; measurement owed.
- **Raster cache trap:** `build_mask.py`'s `fetch()` is existence-only and
  `WCS_URL` bakes the bbox in. Delete `pipeline/data-src/emodnet_dtm.tif` and
  nothing else before the first run (#1163 §4). Whether EMODnet's WCS covers
  the extended box was not checked.

## 4. Coupled sites

Enumerated by claim shape, re-read at `4d2d138`. #1163 §1 listed the pre-#295
sites, and its #295 fixes have landed; this is what a north edge moves now.

**Constants that must move (production and pipeline):**

- `pipeline/build_mask.py`: `WEST, SOUTH, EAST, NORTH`, `COLS, ROWS`,
  `WCS_URL`. `mask.meta.json` and `contours.json` follow by regeneration
  (`contours.json` pins `maskSha256`).
- `pipeline/build_harbors.mjs` `BBOX`, `pipeline/build_seamarks.mjs` `BBOX`
  and its Overpass `QUERY`, `pipeline/extract_basemap.sh` region invocation.
- `app/src/lib/gpx.ts` `DATA_AREA` (also drives `isInViaDataArea`).
- `app/src/services/openMeteo.ts` `LATS` (14 → 16 or 18 entries).
- `app/src/components/MapView.tsx` `MAX_BOUNDS`. Its north edge (55.85) leaves
  0.05° over a 55.8°N mask, under `maxBoundsMaskCoverage.test.ts`'s 0.2°
  minimum, so it must reach at least 56.0 (or 56.2 for a 56.0°N mask).

**Guarded twins (fail loudly if missed):** `gpx.parse.test.ts`
(`DATA_AREA` vs `mask.meta.json`), `windLatticeMaskCoverage.test.ts`,
`maxBoundsMaskCoverage.test.ts`, and `contoursAsset.test.ts`.

**Unguarded twins (fail silently or late):**

- `openMeteo.test.ts` hand-written `LATS`/`LONS` arrays (fail closed, by
  design).
- `app/scripts/gen-wind-fixture.mjs` `N_LATS` and
  `gen-docs-wind-fixture.mjs` `N_POINTS_LAT`: `fetchWindGrid` rejects a
  fixture whose length differs from `LATS.length × LONS.length`, so e2e and
  the docs capture would break at run time.
- `app/e2e/seamarks.spec.ts` `SEAMARK_REGION` and `verify_mask.py`'s water and
  land probes (add a probe north of 55.6°N).
- `depthColor.ts` `HATCH_BAND_LAT_DEG = 54.8`: `cos` deviates from `cos 54.8°`
  by 1.99% at 55.6°N today (the comment says about 2%), and 2.49% / 2.99% at
  55.8 / 56.0°N. Cosmetic per #1163 §1.1. `MASK_CELL_M` is unaffected, since
  the longitude step is unchanged.

**Prose:** the covered-area copy in `dict.de.ts` and `dict.en.ts` (two
strings naming "western Great Belt approach") and its three
`PlannerPanel.test.tsx` quotes, `docs/acceptance.md`, `vite.config.ts`'s
manifest description, README, `pipeline/README.md`, the `pipeline-refresh`
skill's bbox line, ROADMAP's "no unbounded expansion" bullet, and the spec's
Area row and Great Belt line. The spec edit is a main-session act.

## 5. Stored plans and the wind lattice

`windGridCoversBounds` requires the grid to cover the mask bounds. A plan
saved on the current 14 × 23 lattice therefore fails it after a north
extension, exactly as pre-#295 plans did:

- Replan paths that reuse the stored grid (departure compare/confirm, Live
  reroute) return the typed `wind-grid-coverage` error
  (`RoutingClient.plan()`, copy key `error.windGridCoverage`).
- **Backup import is stricter:** `decodeWindGrid` rejects a non-covering grid
  unless `isLegacyWindLattice` matches, and that helper is hardcoded to the
  pre-#295 11 × 17 shape. `SettingsPanel.tsx` passes `DATA_AREA` to
  `parseExportFile`, so the check is live. Without a second admitted shape,
  every plan in a v0.35+ backup is rejected at import (counted invalid, the
  rest of the file still imports). The fix is a list of admitted legacy lattices, not a
  looser predicate.
- Recalculate and a fresh Plan-route fetch a new forecast and are unaffected.
- #295's precedent: no migration pre-1.0, and a BREAKING-CHANGE changelog
  line.

The lattice must widen in the same change as the mask. `WindField`'s
constructor throws on a non-covering grid when given mask bounds (#1178).
That is the guard that stops a plan from silently clamping to the edge.

One request carries all points today (322 locations). The extended lattice
adds 14% or 29%. **Whether Open-Meteo accepts it, and how the rate limit
weighs it, was not measured** (the app already maps 429 to `rate-limited`);
one live call in the implementing PR settles it.

## 6. Basemap

- **The precache cap does not gate a region archive.** `globIgnores` excludes
  `data/region-*.pmtiles*`, and `assertCoreWithinPrecacheCap` checks the core
  only. Core headroom is 41,943,040 − 27,201,789 = 14,741,251 B, and the core
  is untouched by a north extension. The cost is the per-plan download the
  readiness chip shows (#295).
- **A third region composes, if its seam is snapped.** `selectTileArchive`
  serves core-overlapping tiles from the core, otherwise the first
  overlapping region in manifest order, and the manifest is sorted by id, so
  a new id such as `belt` would win any tile it overlaps. `overlaps` is
  strict, so a new strip whose south edge sits at or past the first z13 tile
  boundary at 55.6°N (the snap `pipeline/README.md` describes) never
  overlaps `north` or `east`. The existing archives already hold the
  straddling tiles whole (`pmtiles extract --bbox` keeps whole tiles), so
  they serve every seam tile whatever the id. `verify_region_split.py` must
  then be run with all regions against a single whole-box extract.
- **Size (estimate).** Byte density: core 17.0, `region-east` 12.5,
  `region-north` 26.6 MB/deg² (archive bytes over header bbox area). A
  full-width strip is 0.44 deg² to 55.8°N and 0.88 deg² to 56.0°N, giving
  about **5.5–11.7 MB** and **11.0–23.4 MB**. Vector density tracks coast and
  settlement, not area (#295), so a trial
  `extract_basemap.sh --region … --out-dir <tmp>` must replace this range
  before any commitment.
- **Tileset drift.** Protomaps prunes old daily builds, so the core's
  `20260714` build 404'd on 2026-09-15 (`pipeline/README.md`); the regions use
  `20260720` (tileset 4.14.11, the core's schema). A new archive from a newer
  build may not match the schema. If so, all three archives, the core
  included, would need rebuilding together. The core is precached production
  bytes, so that is a heavier change than one new region.

## 7. Recommendation

### 7.1 Slice A — GO: far-shore harbours inside the existing box

Curate the harbours on the Zealand shore that already lie in 54.3–55.6°N ×
9.4–11.6°E (Korsør and Skælskør are the candidates, §2), so Fyn-to-Zealand
crossings become plannable.

- **No changes to:** mask area, wind lattice, `MAX_BOUNDS`, `DATA_AREA`,
  basemap regions (`region-east` covers the shore) or stored plans (§5).
- **Owed:** `harbors-source.json` and German notes, `build_harbors.mjs`,
  `verify_mask.py` and `verifyMaskConnectivity.test.ts` (which runs every
  catalogue boat in the required `app` check).
- **#282 sweep is OWED.** `app/public/data` and `pipeline` are
  `PATH_PREFIXES` in `closure.mjs`, and the arm-set is every arm name times
  every harbour, so it grows with each row. Confirm with
  `closure.mjs diff <merge-base> <head>`. Also run `realmask.repro` locally.
- **Spec:** the addendum's "Great Belt. Western approach only" line needs a
  main-session amendment.
- **Risk:** whether these harbours snap to cells at or above 2.2 m at 46 m
  resolution is unmeasured. That risk is the reason for the gate.

### 7.2 Slice B — NO-GO now: a north extension to a harbour-defined bound

Preconditions that would flip it to go:

1. A target harbour north of 55.6°N is named and its latitude read from OSM.
   The edge is then set from that latitude plus a margin chosen at that
   point, not one of the §3 illustrative edges.
2. A trial region extract plus a tileset-version check on the newest
   Protomaps build (§6).
3. One live Open-Meteo call at the new point count (§5).
4. **The one measurement that gates go/no-go:** a Flensburg-to-north-belt plan
   against `PLAN_BUDGET_MS` (360 s). #1350's tablet measurement gates on
   Flensburg-to-Burgstaaken and #1490 measures another plan (per
   `1350-per-rig-budget-vs-parallel-rigs.md`); neither is a north-belt
   route. Per the 2026-09-18
   ruling this is a budget-gating measurement, not a routine timing.

If it goes: full mask width, one new lazy region, a second admitted legacy
lattice (§5), the coupled sites of §4, a BREAKING-CHANGE changelog line,
and a sweep with the BASE double-run control (OWED unconditionally, and the
raised frontier cap in §3 may move plans that never enter the strip).

## 8. Considered and rejected

| Option | Why it lost |
|---|---|
| **Extend the mask east of 11.6°E** | The belt's Zealand shore is inside 11.6°E (§1). The water still open at the east edge (54.852–55.189°N) is not the belt. |
| **Widen the core basemap archive** | #296 ruled against a widened monolith. The core is precached bytes with 14,741,251 B of headroom, and rebuilding it invites tileset drift (§6). |
| **Coarsen the grid to fit** | Reopens #245's `TOLERANCE_M` re-derivation for the whole existing grid (branch (a) of #1163 §2.1, rejected in its §8). |
| **A belt-only mask (not full width)** | The mask is one rectangle (§2). A belt-only basemap archive is possible but leaves blank tiles under mask water at the west end of the strip, so it was not preferred. |
| **Relax `wind-grid-coverage` to the plan's own extent** | Reopens the #1178 silent-clamp hazard to spare stored plans a typed error. Pre-1.0 precedent (#295) accepts the break. |
| **Ship B without a named harbour** | `priority: low` and a breaking stored-plan change, for water no curated harbour can start or end in. |

## 9. Follow-ups

- **Slice A** as an implementable issue (curation, `verify_mask.py`, sweep).
- **Retitle #1240** to say north, not east, and repoint the ROADMAP and spec
  references once A is ruled on.
- **Slice B** stays on Backlog with §7.2's four preconditions.
- `isLegacyWindLattice` as a list of admitted lattices is worth doing before
  any second lattice change, independent of B.
