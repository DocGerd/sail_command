# SailCommand data pipeline

Build-time-only scripts that produce the static assets committed under
`app/public/data/`. Nothing here runs at app runtime — the PWA reads the
generated files directly and stays offline-capable. Regenerate an asset only
when its source data or generation logic changes; never hand-edit a generated
file (`polar-*.json`, `harbors.json`, `mask.bin`, `mask.meta.json`).

## Setup

```
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
npm --prefix pipeline install   # only needed if pipeline/node_modules is absent; the two .mjs scripts use no npm deps beyond Node's stdlib
```

## Assets

### `polar-genoa.json` / `polar-fock.json` — Salona 45 boat-speed polars

Boat speed (knots) as a function of true wind angle (TWA) and true wind speed
(TWS), one table for the main+genoa rig and one for main+fock (working jib).
Source: estimate derived from the ORC International 2026 certificate for
Salona 45 "Miles Ahead" (AUT 035/26), with downwind angles corrected to
white-sails-only performance via a 23-boat ORC non-spinnaker ratio study. The
certificate's measured jib is a ~110% foretriangle, which makes the **fock**
table effectively the certificate configuration; the **genoa** (~135%) table
is a modeled overlay on top of it (+3–5% light-air upwind/reach, 0 at
14–20 kn, −2% upwind at 25 kn). This is a flat-water racing VPP estimate —
tune with the app's performance factor — and is explicitly **not**
race-calibrated. Full citation is embedded in each output file's `source`
field (worded per-rig — the fock's note names it as the certificate
configuration, the genoa's note names it as the overlay).

Regenerate:

```
node pipeline/build_polars.mjs
```

Edit `pipeline/polars-source.json` (raw table + sanity-check anchors) to
change the data; `build_polars.mjs` validates monotonicity and a couple of
known-magnitude anchor points before writing.

### `harbors.json` — curated harbor list

33 harbors in the Flensburg Fjord / Danish South Sea area, each with a
navigable snap point (`snap.lat`/`snap.lon`) validated against `mask.bin`
(depth ≥ 2.2 m — see below) and a de/en approach note for harbors with a
genuine draft caveat for a 2.1 m-draft boat. Harbors whose approach is
*never* adequately deep (e.g. Ristinge) are excluded outright rather than
included with a misleadingly "safe" snap point.

Regenerate:

```
node pipeline/build_harbors.mjs
```

Edit `pipeline/harbors-source.json` (id, de/da/en names, country, snap
lat/lon, English approach note) and `pipeline/harbors-notes-de.json` (German
translation, required for every non-null English note) to change the data.
**Snap points must be re-validated against the current `mask.bin` after any
edit to either source file or after any mask rebuild** — run
`pipeline/.venv/bin/python pipeline/verify_mask.py`, which checks all 33
snap points. If a rebuild moves a snap point's cell below 2.2 m, move the
coordinate further out along the harbor's real approach fairway (checked
against OSM) rather than weakening the threshold or fudging the mask.

### `mask.bin` / `mask.meta.json` — land/depth mask

**Hook-protected binary — regenerate, never hand-edit `mask.bin`.**

A packed 2200×2400 grid (dLon ≈ 46.6 m, dLat ≈ 46.3 m at 54.8°N; 2× the
original 1100×1200 grid — see issue #6) covering
9.4–11.0°E, 54.3–55.3°N. Each cell is one byte: `0` = land or
unknown/unsurveyed (non-navigable), `1..254` = depth in decimeters (floored,
never rounded up — 0.1–25.4 m), `255` = deep (≥ 25.4 m). Row 0 is the
**south** edge (`mask.meta.json` carries the full encoding description plus
the bbox and grid dimensions so the app never has to hardcode them).
Navigability itself is decided at query time by the app against the user's
safety-depth setting — this file only stores raw depth, never a baked-in
safe/unsafe bit.

Sources (also embedded in `mask.meta.json.sources` and surfaced in the app's
About dialog):

- **Bathymetry**: EMODnet Bathymetry Consortium (2024). EMODnet Digital
  Bathymetry (DTM 2024). doi:10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1
  (CC-BY 4.0). Fetched as a WCS `GetCoverage` request against the
  `emodnet__mean` coverage. Values are elevation relative to LAT (Lowest
  Astronomical Tide) — negative is depth. **This coverage ID tracks
  EMODnet's latest DTM release, so a rebuild months from now may return
  slightly different values than the run that produced the committed
  `mask.bin`; the exact build's provenance is pinned by this file's git
  history, not by a version tag on the EMODnet side.**
- **Land**: OpenStreetMap contributors (ODbL), via
  `osmdata.openstreetmap.de`'s daily-rebuilt
  `land-polygons-split-4326.zip` (~880 MB global file; the build reads only
  the ~1 MB of geometry inside our bbox via a `zip://` VSI path, so the
  archive is never extracted to disk).
- **Schlei fjord water body**: OpenStreetMap contributors (ODbL), relation
  [2340930](https://www.openstreetmap.org/relation/2340930) (`water=fjord`),
  fetched from `nominatim.openstreetmap.org`. The Schlei's banks are tagged
  `natural=water`, not `natural=coastline`, in OSM — correct OSM practice
  for a tidal/brackish inland fjord, but it means the coastline-derived land
  polygons above leave the *entire* Schlei (Schleswig to Maasholm, including
  the Kappeln and Arnis harbor approaches) marked solid land even though
  EMODnet has real bathymetry there. `build_mask.py` fetches this one named
  relation and explicitly excludes it from the land mask before applying
  depth. If the mask starts failing near a currently-unlisted narrow inland
  water body, the fix is almost always the same: find its OSM relation and
  add the same carve-out, not to weaken `all_touched` or the depth
  threshold. Note: Nominatim-fetched relation geometry may drift on future
  re-fetches (same caveat as the EMODnet coverage ID), and Nominatim's usage
  policy makes this a manual on-demand step, not CI-suitable.

Regenerate:

```
pipeline/.venv/bin/python pipeline/build_mask.py     # downloads ~900 MB total on first run, cached in pipeline/data-src/ (gitignored) after
pipeline/.venv/bin/python pipeline/verify_mask.py    # sanity probes: must print "all probes OK (6 water, 5 land, 33 harbor snaps)"
```

`build_mask.py` asserts the overall water fraction is between 0.45 and 0.85
(implausible otherwise — inspect inputs, don't relax the bound) and
`verify_mask.py` checks known water/land points plus every harbor snap point
(≥ 2.2 m). Both must pass before committing a rebuilt `mask.bin`.

### `basemap.pmtiles` — regional basemap

**Hook-protected binary — regenerate, never hand-edit.**

Generated by `pipeline/extract_basemap.sh` from the Protomaps daily build
(build date `20260714`, UTC), extracting the bbox 9.4,54.3–11.0,55.3 at
`--maxzoom=13`. Result: ~26 MB, PMTiles spec version 3. The tiles are an
[ODbL](https://opendatacommons.org/licenses/odbl/) *Produced Work* derived
from OpenStreetMap data — attribution "© OpenStreetMap contributors" is
required wherever the map is shown; Protomaps attribution is customary
alongside it (both are surfaced in the app's About dialog).

Regenerate:

```
pipeline/extract_basemap.sh [YYYYMMDD]   # defaults to yesterday's UTC build
```

The script installs the `pmtiles` CLI into `pipeline/bin/` on first run
(gitignored), extracts the regional slice, asserts the output is larger than
10 MB (catches a truncated/failed extract), and prints `pmtiles show` output
for a final sanity check.

### `app/public/basemap-assets/` — offline map fonts + sprites

Self-hosted glyph (font) and sprite assets for MapLibre GL, so the basemap
style renders fully offline (no runtime fetch to a Protomaps/third-party
CDN). Copied from the
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets)
repo:

- `fonts/` — Noto Sans Regular, Medium, and Italic, as pre-rendered `.pbf`
  glyph range files (SIL Open Font License).
- `sprites/v4/` — the `light` sprite sheet, standard + `@2x`, as
  `.json`/`.png` pairs (repo license: BSD-3-Clause).

Regeneration (re-run if upstream assets change; not part of the mask/polar/
harbor build):

```
git clone --depth 1 https://github.com/protomaps/basemaps-assets pipeline/data-src/basemaps-assets
cp -r "pipeline/data-src/basemaps-assets/fonts/Noto Sans Regular" \
      "pipeline/data-src/basemaps-assets/fonts/Noto Sans Medium" \
      "pipeline/data-src/basemaps-assets/fonts/Noto Sans Italic" \
      app/public/basemap-assets/fonts/
cp pipeline/data-src/basemaps-assets/sprites/v4/light.json \
   pipeline/data-src/basemaps-assets/sprites/v4/light.png \
   pipeline/data-src/basemaps-assets/sprites/v4/light@2x.json \
   pipeline/data-src/basemaps-assets/sprites/v4/light@2x.png \
   app/public/basemap-assets/sprites/v4/
```

`pipeline/data-src/basemaps-assets/` is a scratch clone, gitignored like the
rest of `pipeline/data-src/`.

### `app/public/icons/icon-*.png` — installable-PWA icons

Rasterized from the hand-authored `app/public/icons/icon.svg` (the sail-and-hull
delta mark — edit the SVG directly to change the artwork). `build_icons.mjs` uses
`sharp` (pipeline dev-dep) to render the sizes `manifest.icons` in
`app/vite.config.ts` expects: 192, 512, and a maskable 512 with 20%
safe-zone padding (artwork scaled to 60% of the canvas, composited onto a
full-bleed `#10243D` background so an OS mask crop never reveals
transparency).

Regenerate:

```
node pipeline/build_icons.mjs
```
