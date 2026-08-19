# SailCommand data pipeline

Build-time-only scripts that produce the static assets committed under
`app/public/data/`. Nothing here runs at app runtime — the PWA reads the
generated files directly and stays offline-capable. Regenerate an asset only
when its source data or generation logic changes; never hand-edit a generated
file (`polars/*.json`, `harbors.json`, `mask.bin`, `mask.meta.json`).

## Setup

```
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
npm --prefix pipeline install   # needed for build_icons.mjs (sharp); every other .mjs script here uses Node's stdlib only
```

## Style (#220)

`build_mask.py` and `verify_mask.py` are linted/formatted with
[ruff](https://docs.astral.sh/ruff/), configured in `pipeline/pyproject.toml`
(select rules + line-length rationale documented there). CI enforces this in
`.github/workflows/python-lint.yml` — an OPTIONAL job, deliberately not part
of `protect-main`'s required checks (only `app` + `e2e` are required; see
CLAUDE.md's Release & branching section). Run locally before committing:

```
ruff check pipeline/
ruff format pipeline/
```

JS/TS style is ESLint (`app/eslint.config.js`), enforced by the `app`
required check.

## Assets

### `polars/<boat-id>-<sail-id>.json` — boat-speed polars

Boat speed (knots) as a function of true wind angle (TWA) and true wind speed
(TWS), two tables per catalogue boat — main+genoa and main+fock (working jib).
The Salona 45's provenance is described first; the two tier-C fleet boats added
by #54 spec N are covered under "Estimated (tier C) tables" below and are
derived FROM the Salona 45's, so read this first.
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

Edit `pipeline/polars-source.json` to change the data. It is keyed by boat
(`boats[]`), each carrying its own `tws`/`twa` grid, its `sails` map, and a
`validation` block holding that boat's plausibility bound and sanity anchors;
each sail carries a `provenance` tier (`certificate` / `modelled` /
`estimated`, spec G.3) and note. `build_polars.mjs` derives the sail set from
that map — there is no second list to fall out of step with it — and **fails
closed**. The identity and provenance contract specifically, stated as what is
actually checked: a boat id that is missing, unsafe or duplicated; a sail id
that is unsafe; any two sails resolving to the same output file; a boat with no
anchors or no plausibility bound; a sail with no provenance tier or note. Each
throws and names itself rather than inheriting another boat's values — an
anchor that silently validates the wrong hull is worse than no anchor. That
list is not an inventory of every guard the script runs; the structural
validation (grid shapes, numeric types, TWS monotonicity, anchor bands) is
separate and additional.

Both halves of the output filename are validated: validating only the boat id
let a sail keyed `../../../ESCAPED` write outside this directory entirely. And
the duplicate check runs on the boat id *and* on the output filename, because
`-` is both the separator and a legal id character — boat `a-b` with sail `c`
and boat `a` with sail `b-c` are two legal, distinct, non-duplicate ids that
resolve to the same `a-b-c.json`. Neither check subsumes the other: two boats
sharing an id with disjoint sail sets collide on no filename at all.

#### Estimated (tier C) tables — `estimate_polars.mjs`

No ORC/IRC certificate and no published VPP was obtainable for any Skipperteam
fleet model, so the Salona 44 (SPEEDY GO!) and Elan Impression 444 (PIRANJA)
ship at provenance tier `estimated`: the Salona 45's certificate-anchored
**fock** table scaled by one uniform hull scalar
`k = sqrt((SA/D)_target / (SA/D)_salona45)`, and a second sail derived from
that scaled table times the Salona 45's documented genoa overlay ramp. Inputs
are public brochure dimensions and the already-shipped Salona 45 tables and
nothing else, so the estimator downloads nothing and ingests no third-party
table. The method, its measured accuracy ceiling, the near-miss that motivates
the one-source rule, and the four things it structurally cannot do are all
documented in `estimate_polars.mjs`'s header — read that before changing any
input.

```
node pipeline/estimate_polars.mjs                     # --check (also `npm run estimate`)
node pipeline/estimate_polars.mjs --report            # + scalars and anchor margins
node pipeline/estimate_polars.mjs --emit <boat> <sail>  # formatted rows to paste
```

The committed `speeds` literals are the artifact; this script is the generator
(`--emit`) and the keeper (`--check`). There is deliberately no mode that
rewrites `polars-source.json`: it is hand-formatted, and a whole-file
re-serialiser would churn the Salona 45's block on every run.

`build_polars.mjs` enforces spec N.6's rules **E1–E8** on top of everything
above, and imports this module so E5 and E7 run the same code the tables were
generated with rather than a second implementation of it:

- **E1** tier `estimated` requires a complete `estimator` block — and, in the
  converse direction, a non-estimated sail may not carry one.
- **E2** every `estimator.inputs.*` names a source, and the input list may not
  be empty (an empty one satisfies "every input has a source" vacuously). A
  RAMP sail must carry **no** `inputs` at all — it derives from its base sail,
  whose block owns the figures, and a second copy is data nothing reads.
- **E3** every anchor names a source, on **every** boat including the
  reference one — E4 compares against those strings, so it needs them. Its
  sibling: `validation.maxSpeedKnSource` is required too, because N.3 step 5
  holds the plausibility ceiling to the same standard as the anchors.
- **E4** an anchor whose band **and** source both equal the donor's at the same
  cell is refused. Conjunctive: same band with an independent source, or the
  same source with a different band, is legitimate.
- **E5** `0.80 <= k <= 1.25`; outside it the donor is not a comparable hull.
- **E1/N.3 step 3** the base must *be* the certificate-anchored table — not the
  modelled genoa overlay and not another estimate — and a ramp may not map a
  sail onto itself or come from a boat other than the donor.
- **E6** the second sail declares which base sail and which ramp it came from,
  and exactly one sail per boat may be the scaled base.
- **E7** re-running the estimator on the committed inputs reproduces the
  committed `speeds` byte-for-byte — both tables — and the declared `scalar`.
- **E8** every pre-existing structural guard still applies to a tier-C boat.

`app/src/test/buildPolars.failClosed.test.ts` runs the real script against
mutated copies of the real source. The battery is per **condition**, not per
rule: each individual `requireField` above was deleted on its own and must red
at least one row. Three conditions once red zero — two of them because
`estimate_polars.mjs` independently refuses the same input with a
byte-identical message, so the row could not tell which layer had refused.
Those messages now carry a `spec N.6 E1`/`E2` marker and the rows assert it.

There is deliberately **no** duplicate-sail-id check — sail ids are not unique
across boats by design, and a repeated key inside one boat's `sails` map is
collapsed by `JSON.parse` before the script sees it.

The Salona 45's two anchors restate the bands the pre-#54 script hardcoded:
`8.26..9.46` at TWA 90 / TWS 16 and `6.5..8.5` at TWA 52 / TWS 12. The second is
exactly the old `6.5 || 8.5` test. The first is *not* exactly `8.86 ± 0.6`: the
lower bound is (`8.86 - 0.6 === 8.26`), but `8.86 + 0.6` evaluates to
`9.459999999999999`, so the declared `9.46` is looser than the old predicate by
one representable step — it accepts a table reading exactly `9.46`, which the
old test rejected. Both sails read exactly `8.86` there, so nothing sits near
either bound; tighten the upper literal rather than widen it if that ever
changes.

Output filenames carry the boat id (spec F.1): the previous `polar-<sail>.json`
had no boat identifier, so a second boat's tables would have overwritten the
first's.

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

### `seamarks.json` — aids-to-navigation overlay (#7)

Core aids-to-navigation (`seamark:type` nodes tagged `buoy_*`, `beacon_*`, or
`light_*`) in the app bbox — 1,794 nodes as of the 2026-07-22 build, a
GeoJSON `FeatureCollection` of Point features trimmed to `seamarkType`,
`category`, `colour`, `shape`, and light `lightCharacter`/`lightPeriod`/
`lightColour` where tagged. Presentation-only overlay (`app/src/lib/
seamarkGlyphs.ts` draws the glyphs, `DataLayers.tsx` hosts the `sc-seamarks`
layer, default OFF) — no routing/solver input.

Regenerate:

```
node pipeline/build_seamarks.mjs
```

Pulled live from the Overpass API (one query, filtered client-side to the
core-AtoN prefixes) — needs network, and Overpass occasionally 504s under
load; just retry. NOT wired into app runtime (Overpass has no CORS guarantee
and rate-limits per IP) — regenerate on the same ad-hoc "when it visibly
matters" cadence as `harbors.json`; seamark data (buoy positions, ice-season
removals) drifts faster than coastline, so treat a rebuild as a fresh
point-in-time extract, not a continuously-verified feed.

### `mask.bin` / `mask.meta.json` — land/depth mask

**Hook-protected binary — regenerate, never hand-edit `mask.bin`.**

A packed 2200×2400 grid (dLon ≈ 46.8 m, dLat ≈ 46.4 m at 54.8°N; 2× the
original 1100×1200 grid — see issue #6) covering
9.4–11.0°E, 54.3–55.3°N. Derived from `mask.meta.json`'s `cols: 2200, rows:
2400`, bounds 9.4–11.0°E / 54.3–55.3°N: `dLat_deg = (55.3-54.3)/2400 =
0.00041667°`, `dLon_deg = (11.0-9.4)/2200 = 0.00072727°`; WGS84 arc length
per degree at 54.8°N via the standard series (`M ≈ 111319.80 m/deg`,
`P ≈ 64312.03 m/deg`) gives `dLat = M·dLat_deg ≈ 46.38 m`,
`dLon = P·dLon_deg ≈ 46.77 m` (#393). Each cell is one byte: `0` = land or
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

### `basemap.pmtiles.png` — regional basemap

**Hook-protected binary — regenerate, never hand-edit.**

The `.png` suffix is deliberate (#118) and the file is NOT a PNG: GitHub
Pages/Fastly gzip-compresses `application/octet-stream` Range responses into
un-inflatable fragments, while `image/png` is served identity with true 206s
— so the PMTiles archive masquerades under a `.png` extension. Never rename
it back.

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
  glyph range files (SIL Open Font License 1.1; the verbatim license text
  ships as `fonts/OFL.txt`).
- `sprites/v4/` — the `light` sprite sheet, standard + `@2x`, as
  `.json`/`.png` pairs (MIT — derived from
  [tangrams/icons](https://github.com/tangrams/icons), © 2017 Mapzen; text
  committed as `sprites/LICENSE.txt`). Not to be confused with the
  BSD-3-Clause license of the `@protomaps/basemaps` styles *library* used at
  app runtime — that covers the style code, not these sprite assets.

Regeneration (re-run if upstream assets change; not part of the mask/polar/
harbor build):

```
git clone --depth 1 https://github.com/protomaps/basemaps-assets pipeline/data-src/basemaps-assets
cp -r "pipeline/data-src/basemaps-assets/fonts/Noto Sans Regular" \
      "pipeline/data-src/basemaps-assets/fonts/Noto Sans Medium" \
      "pipeline/data-src/basemaps-assets/fonts/Noto Sans Italic" \
      app/public/basemap-assets/fonts/
cp pipeline/data-src/basemaps-assets/fonts/OFL.txt \
   app/public/basemap-assets/fonts/OFL.txt
cp pipeline/data-src/basemaps-assets/sprites/v4/light.json \
   pipeline/data-src/basemaps-assets/sprites/v4/light.png \
   pipeline/data-src/basemaps-assets/sprites/v4/light@2x.json \
   pipeline/data-src/basemaps-assets/sprites/v4/light@2x.png \
   app/public/basemap-assets/sprites/v4/
```

`app/public/basemap-assets/sprites/LICENSE.txt` (MIT, tangrams/icons) is
committed in this repo — preserve it when refreshing the sprite files above.

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
