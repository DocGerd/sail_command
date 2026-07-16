"""Build the packed land/depth mask from EMODnet bathymetry + OSM land polygons.

Encoding (must match app/src/types.ts MaskMeta):
  0        land or unknown/unsurveyed (non-navigable)
  1..254   depth in decimeters, floored (0.1 .. 25.4 m)
  255      deep (>= 25.4 m)
Row 0 = SOUTH edge (the app's convention; numpy arrays are north-first, so flip before writing).
"""

import json
import pathlib
import sys
import urllib.request

import numpy as np
import geopandas as gpd
import rasterio
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

HERE = pathlib.Path(__file__).parent
SRC = HERE / "data-src"
OUT = HERE.parent / "app" / "public" / "data"
WEST, SOUTH, EAST, NORTH = 9.4, 54.3, 11.0, 55.3
COLS, ROWS = 2200, 2400  # ~46 m cells; 2x the original 1100x1200 (~93 m) - see issue #6

WCS_URL = (
    "https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1"
    "&request=GetCoverage&coverageId=emodnet__mean"
    f"&subset=Lat({SOUTH},{NORTH})&subset=Long({WEST},{EAST})&format=image/tiff"
)
LAND_URL = "https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip"

# The OSM coastline-derived land-polygons dataset above only carves the sea
# out of "land" along ways tagged natural=coastline. Large tidal/brackish
# inland fjords that OSM instead tags as natural=water (not coastline) -
# e.g. the Schlei (relation 2340930, tags: water=fjord) - are therefore left
# solid "land" by that dataset alone, even though EMODnet's bathymetry has
# real depth data for them (verified: Kappeln -8.28 m, Arnis -3.90 m below
# LAT). Patch this by explicitly fetching that one named water body and
# excluding it from the land mask. Discovered while debugging verify_mask.py
# probe failures at every Schlei-side harbor (Kappeln, Arnis, Maasholm).
SCHLEI_RELATION_ID = 2340930
SCHLEI_URL = (
    "https://nominatim.openstreetmap.org/lookup"
    f"?osm_ids=R{SCHLEI_RELATION_ID}&format=jsonv2&polygon_geojson=1"
)


def fetch(url: str, dest: pathlib.Path, headers: dict | None = None) -> None:
    # NOTE: cache check is existence-only; delete pipeline/data-src/* to recover from an interrupted download.
    if dest.exists():
        print(f"cached: {dest.name}")
        return
    print(f"downloading {url} -> {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not headers:
        urllib.request.urlretrieve(url, dest)
        return
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)


def main() -> None:
    fetch(WCS_URL, SRC / "emodnet_dtm.tif")
    fetch(LAND_URL, SRC / "land-polygons-split-4326.zip")
    fetch(
        SCHLEI_URL,
        SRC / "schlei_relation.geojson.json",
        headers={"User-Agent": "SailCommand-pipeline/0.1 (build-time script; github.com/DocGerd/sail_command)"},
    )

    dst_transform = from_origin(WEST, NORTH, (EAST - WEST) / COLS, (NORTH - SOUTH) / ROWS)
    elev_max = np.full((ROWS, COLS), np.nan, dtype=np.float32)  # row 0 = north (numpy)
    elev_bilinear = np.full((ROWS, COLS), np.nan, dtype=np.float32)
    with rasterio.open(SRC / "emodnet_dtm.tif") as src:
        # LAST-RESORT DEVIATION (issue #6): Resampling.max on LAT-referenced
        # *elevation* picks the SHALLOWEST contributing source cell, which is
        # the conservative default for navigability - but on the ~115 m
        # native EMODnet DTM it also flattens narrow dredged/buoyed channels
        # that are deeper than their surroundings (verified via approachNote:
        # Kappeln's Schlei fairway "maintained approx 5 m", Marstal "approx
        # 3.2 m (N/W)", Dyvig "approx 3.0-3.5 m, ~30 m wide", Augustenborg
        # "approx 3 m in the upper reaches" - all documented >= 3.0 m yet
        # max-resampled to well under 3.0 m at 46 m cells, disconnecting
        # those harbors from open water even after the resolution/rasterize
        # fixes below).
        #
        # An UNCONDITIONAL switch to Resampling.bilinear (tried first) fixes
        # those channels but is not a free lunch: bilinear interpolates from
        # the nearest source pixels around each destination cell's *center*
        # rather than aggregating a footprint the way max() does, so at a
        # sharp source discontinuity (a tidal flat right next to a dredged
        # channel or a steep drop-off) it can manufacture depth that isn't
        # really there. Measured against pure Resampling.max on this same
        # bbox, in the actual final encoded output (post OSM-land-mask,
        # post-Schlei-carve, post-floor - i.e. what would really ship):
        # unconditional bilinear flips 22,948 cells from LAND (dry/unknown
        # under max) to WATER, of which 1,780 read >= 3.0 m (the app's
        # default safety depth) and 663 read >= 5.0 m; the worst single flip
        # went from a max-depth of 0.00 m to a bilinear-depth of 15.64 m.
        # 97.6% of the >= 3.0 m flips are more than 1 km from any harbor
        # snap - i.e. outside the harbor-scoped channels this fix is
        # actually trying to reconnect, and squarely inside water an
        # unwitting user could route through believing it's surveyed depth.
        # That violates "never overstate depth" project-wide for a fix that
        # only needed to help ~4 named channels.
        #
        # Fix: compute BOTH reprojections and blend per-cell. Trust bilinear
        # only where it's close to max (smooth, gently-varying depth - the
        # kind of local averaging bilinear is legitimately good at); fall
        # back to the conservative max value wherever they diverge by more
        # than TOLERANCE_M (a source discontinuity - shoal/channel boundary,
        # drop-off, or land/water edge - where bilinear's interpolation
        # cannot be trusted). See TOLERANCE_M below for the measured
        # trade-off this tolerance was chosen against.
        reproject(
            source=rasterio.band(src, 1),
            destination=elev_max,
            src_nodata=float("nan"),
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=float("nan"),
            resampling=Resampling.max,
        )
        reproject(
            source=rasterio.band(src, 1),
            destination=elev_bilinear,
            src_nodata=float("nan"),
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=float("nan"),
            resampling=Resampling.bilinear,
        )

    # Tuned against two constraints, in priority order: (a) the connectivity
    # gate in verify_mask.py must still pass every harbor that needed
    # bilinear to reconnect (Aabenraa, Augustenborg's and Marstal's
    # CONNECTIVITY_EXCEPTIONS_M thresholds, and the channels feeding them);
    # (b) minimize land->water flips crossing the 3.0 m default safety
    # depth. At TOLERANCE_M=2.0, both are satisfied: verify_mask.py reports
    # the same 28 OK / 2 exceptions / 5 known-disconnected table as the
    # unconditional-bilinear run, while land->water flips crossing 3.0 m
    # (and 5.0 m) drop from 1,780 (663) under unconditional bilinear to
    # ZERO under the blend - every flip the blend still allows stays below
    # the default safety depth. Total land->water flips (any depth) also
    # drop from 22,948 to 17,724, since most flipped cells were themselves
    # close to the max/bilinear divergence that gates them out.
    # Residual bound: where max() reads 0 (dry), the blend can report at
    # most TOLERANCE_M of depth - the |bilinear - max| <= TOLERANCE_M test
    # against a max of 0 provably never admits more than TOLERANCE_M itself.
    # Measured 38 such cells (0.0007% of the grid), all reading exactly
    # 2.00 m. Only reachable by a user who sets safetyDepthM <= 2.0 m, which
    # is already below the boat's 2.1 m draft - the settings UI should clamp
    # safetyDepthM above draft regardless of this (tracked for Phase E).
    TOLERANCE_M = 2.0
    both_valid = ~np.isnan(elev_max) & ~np.isnan(elev_bilinear)
    diff = np.where(both_valid, np.abs(elev_bilinear - elev_max), np.inf)
    use_bilinear = both_valid & (diff <= TOLERANCE_M)
    # Cells where elev_max itself is NaN (unknown source) stay NaN here
    # regardless of bilinear - bilinear never gets to rescue an unknown
    # cell into "known", only to refine a cell max() already resolved.
    elev = np.where(use_bilinear, elev_bilinear, elev_max)

    print("rasterizing OSM land polygons (bbox-filtered read of the global zip)...")
    # GDAL's shapefile driver does not auto-detect a .shp nested inside a zip
    # subfolder (only at zip root); point at the inner path explicitly via the
    # zip:// VSI handler. This still streams a bbox-filtered read without
    # extracting the ~880 MB archive to disk.
    land_zip = SRC / "land-polygons-split-4326.zip"
    gdf = gpd.read_file(
        f"zip://{land_zip}!land-polygons-split-4326/land_polygons.shp",
        bbox=(WEST, SOUTH, EAST, NORTH),
    )
    # Feature COUNT is a coarse existence check only, not a coverage metric:
    # osmdata.openstreetmap.de regenerates this file periodically and the
    # upstream splitting granularity is not a stable contract - a real
    # regen (2026-07-15) covered our bbox with only 117 features because
    # each was a large multi-hundred-vertex polygon rather than many small
    # ones (independently verified via a full-file bbox-intersect scan, not
    # just this filtered read), so a high threshold here would be testing
    # this dataset's incidental shape, not our correctness. Real coverage is
    # what the land cell count and water fraction asserts below (and the
    # connectivity gate in verify_mask.py) actually check; this just catches
    # a badly wrong zip inner path/CRS returning an empty-ish read.
    assert len(gdf) > 50, f"OSM land polygons: only {len(gdf)} features in bbox - check zip inner path/CRS"
    land = features.rasterize(
        gdf.geometry,
        out_shape=(ROWS, COLS),
        transform=dst_transform,
        # Cell-center sampling, not all_touched. At the original ~93 m cells,
        # all_touched=True ate an entire cell of margin off both banks of
        # every quay-lined basin and narrow channel, disconnecting 14/44
        # harbor snaps from open water (issue #6). At 46 m cells,
        # center-sampling is still conservative for a 4.2 m-beam boat in a
        # planning aid, without erasing basins narrower than ~2 cells.
        all_touched=False,
        fill=0,
        default_value=1,
    ).astype(bool)
    n_land = int(land.sum())
    print(f"land cells: {n_land}")
    # Two competing effects vs. the original threshold (50000 land cells on
    # the 1100x1200/all_touched=True grid): 4x more cells from the 2x/2x
    # resolution bump pushes this up, while all_touched=False drops the
    # thin one-cell-wide coastal fringe that all_touched=True used to count,
    # pushing it back down. Empirically this regen landed at ~2.6M land
    # cells (>10x the naive 4x-only estimate) since most of this bbox's area
    # is actually land (the mainland + islands), not thin fringe - 200000 is
    # a wide-margin floor against a badly broken read, not a tight estimate.
    assert n_land > 200000, f"OSM land raster: only {n_land} land cells - implausible for this coastline"

    print("carving the Schlei (OSM water=fjord relation, not coastline-tagged) out of the land mask...")
    schlei_geojson = json.loads((SRC / "schlei_relation.geojson.json").read_text())
    schlei = gpd.GeoDataFrame.from_features(
        [{"type": "Feature", "geometry": r["geojson"], "properties": {}} for r in schlei_geojson],
        crs="EPSG:4326",
    )
    assert schlei.geometry.geom_type.isin(["Polygon", "MultiPolygon"]).all(), (
        f"Schlei relation returned unexpected geometry types: {set(schlei.geometry.geom_type)}"
    )
    schlei_water = features.rasterize(
        schlei.geometry,
        out_shape=(ROWS, COLS),
        transform=dst_transform,
        all_touched=False,  # don't eat into the real banks; EMODnet depth still gates navigability
        fill=0,
        default_value=1,
    ).astype(bool)
    n_schlei = int(schlei_water.sum())
    print(f"Schlei carve: {n_schlei} cells")
    # Thresholds scale ~4x vs. the original 1100x1200 grid (2x cols * 2x rows).
    assert 8000 < n_schlei < 120000, (
        f"Schlei carve size {n_schlei} implausible - expected a fjord of roughly 40 km x ~10-20 cells width"
    )
    land[schlei_water] = False

    depth_m = np.where(np.isnan(elev), np.nan, np.maximum(-elev, 0.0))
    code = np.zeros((ROWS, COLS), dtype=np.uint8)
    known = ~np.isnan(depth_m)
    dm = np.floor(np.nan_to_num(depth_m) * 10.0)  # floor: never overstate depth
    code[known] = np.clip(dm[known], 0, 255).astype(np.uint8)
    code[known & (dm >= 254)] = 255  # >= 25.4 m -> deep
    code[known & (dm < 1)] = 0  # drying / zero depth -> land
    code[~known] = 0  # unknown -> non-navigable
    code[land] = 0

    water_frac = float((code > 0).mean())
    print(f"water fraction: {water_frac:.3f}")
    assert 0.45 < water_frac < 0.85, "implausible land/water split - inspect inputs"

    code_south_first = np.flipud(code)  # app convention: row 0 = south
    (OUT).mkdir(parents=True, exist_ok=True)
    (OUT / "mask.bin").write_bytes(code_south_first.tobytes())
    meta = {
        "west": WEST, "south": SOUTH, "east": EAST, "north": NORTH,
        "cols": COLS, "rows": ROWS,
        "encoding": "uint8 row-major, row 0 = south; 0=land/unknown, 1-254=depth dm floored, 255=deep(>=25.4m)",
        "verticalDatum": "LAT (EMODnet DTM 2024)",
        "sources": [
            "EMODnet Bathymetry Consortium (2024). EMODnet Digital Bathymetry (DTM 2024). doi:10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1 (CC-BY 4.0)",
            "Land polygons (c) OpenStreetMap contributors (ODbL), osmdata.openstreetmap.de",
            "Schlei fjord water body (c) OpenStreetMap contributors (ODbL), relation 2340930 via nominatim.openstreetmap.org",
            # NOTE: the About dialog currently shows this ODbL statement as a
            # static i18n item (about.sources.osmMask) because the committed
            # mask.meta.json predates this entry. When the mask is next
            # regenerated (and this string lands in mask.meta.json's sources,
            # which the About dialog also renders dynamically), remove the
            # static about.sources.osmMask item from AboutDialog + both i18n
            # dicts (or dedupe) to avoid showing the statement twice.
            "The land/depth mask (mask.bin) is a Derivative Database of OpenStreetMap data and is made available under the Open Database License (ODbL). (c) OpenStreetMap contributors.",
        ],
    }
    (OUT / "mask.meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote mask.bin ({code.size} bytes) + mask.meta.json")


if __name__ == "__main__":
    sys.exit(main())
