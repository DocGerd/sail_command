---
name: pipeline-refresh
description: Use when regenerating SailCommand data assets (harbors, polars, mask, basemap, icons), editing pipeline source files, or when a mask/harbor/polar change is requested — before running any pipeline build or committing rebuilt artifacts.
---

# Regenerate SailCommand data assets safely

Edit **source** files under `pipeline/`, run the generator, pass the gates.
Generated outputs (`app/public/data/*.json`, `mask.bin`, `basemap.pmtiles`)
are hook-protected against hand-edits — regenerate, never edit.

## Iron rules

- **Never delete `pipeline/data-src/` wholesale** (~888 MB gitignored cache;
  ~1 h re-download). Delete only the one file you intend to refresh. Preserve
  it when removing worktrees.
- **A plain mask rebuild is a no-op**: `build_mask.py`'s cache check is
  existence-only, so with a warm cache it rewrites a byte-identical
  `mask.bin`. To actually change output, either delete the specific cached
  input (`schlei_relation.geojson.json` is 132 KB/cheap; `emodnet_dtm.tif`
  and the ~880 MB land zip are not) or change generation logic. If neither
  applies, there is nothing to rebuild — say so.

## Setup (once per clone/worktree)

`python3 -m venv pipeline/.venv && pipeline/.venv/bin/pip install -r pipeline/requirements.txt`
(`npm --prefix pipeline install` only for icons/sharp; harbors/polars use Node stdlib.)

## Per asset

| Asset | Edit | Run |
|---|---|---|
| Harbors | `harbors-source.json` (+ `harbors-notes-de.json` — German note mandatory for every non-null English note) | `node pipeline/build_harbors.mjs` |
| Polars | `polars-source.json` | `node pipeline/build_polars.mjs` |
| Mask | `build_mask.py` (logic) or delete a cached input | `npm --prefix pipeline run mask` |
| Basemap | — | `pipeline/extract_basemap.sh [YYYYMMDD]` |
| Icons | `app/public/icons/icon.svg` | `node pipeline/build_icons.mjs` |

Harbor rows: unique kebab-case id, inside bbox 9.4–11.0°E / 54.3–55.3°N,
country DE|DK; snap point on the real approach fairway (cross-check OSM).
Order matters: rebuild harbors **before** running mask verify.

## Gates (all must pass before committing)

1. `build_mask.py` asserts water fraction 0.45–0.85 — on failure inspect
   inputs; never relax a bound.
2. `pipeline/.venv/bin/python pipeline/verify_mask.py` must exit 0 printing
   `all probes OK (N water, M land, K harbor snaps)` (counts derived at
   runtime from its probe lists and harbors.json).
3. Verify-failure triage:
   - Snap < 2.2 m → move the coordinate out along the real fairway in
     `harbors-source.json`; never weaken the threshold.
   - New harbor unreachable from open water → `CONNECTIVITY_EXCEPTIONS_M`
     entry (the gate asserts an approachNote exists; by convention it must
     cite the documented depth) or, if disconnected at any gate depth
     (sub-cell channel), `KNOWN_DISCONNECTED` with an issue reference
     (#9 pattern).
   - A `KNOWN_DISCONNECTED` harbor now reported connected → the gate fails on
     purpose; remove the stale entry.
   - Narrow inland water masked as land (Schlei pattern) → add that water
     body's OSM relation carve-out in `build_mask.py`; never weaken
     `all_touched` or depth thresholds.
4. Diff must contain only intended files (`data-src/` never appears);
   `npm --prefix app run typecheck` and, for routing-relevant data,
   `npm --prefix app run test -- realmask.repro` stay green.
