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

import geopandas as gpd
import numpy as np
import rasterio
from rasterio import features
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

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
SCHLEI_URL = f"https://nominatim.openstreetmap.org/lookup?osm_ids=R{SCHLEI_RELATION_ID}&format=jsonv2&polygon_geojson=1"


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
        # cannot be trusted). See TOLERANCE_M below: it is a safety bound
        # tied to the boat's draft, not a tuning knob.
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

    # TOLERANCE_M is a SAFETY BOUND, not a tuned constant (#455).
    #
    # The blend substitutes bilinear for max only where the two agree within
    # TOLERANCE_M, so by construction every cell satisfies
    #     depth_blend <= depth_max + TOLERANCE_M
    # Read that contrapositively, which is the property that matters: a cell
    # the app calls navigable at safety depth G has a CONSERVATIVE
    # (max-resampled) depth of at least G - TOLERANCE_M. At the default gate
    # G = 3.0 m, TOLERANCE_M = 0.9 puts that floor at exactly 2.1 m -
    # BOAT_DRAFT_M (app/src/routing/relaxedDepth.ts). So no cell the router
    # may plan through at default settings is shallower than the hull, however
    # far bilinear wanted to stray. This value is derived from the blend rule
    # and the draft; it is not fitted to an outcome.
    #
    # THE GUARANTEE IS GATE-CONDITIONAL - never restate it as unconditional.
    # It bounds G - TOLERANCE_M, so it decays as a user lowers safetyDepthM.
    # Measured on this mask (cells navigable at the gate whose conservative
    # depth is below the 2.1 m draft):
    #     G = 3.0 m (default)     floor 2.1 m       0 cells
    #     G = 2.5 m               floor 1.6 m   1,722 cells
    #     G = 2.2 m (UI minimum)  floor 1.3 m   6,752 cells
    # SAFETY_DEPTH_FIELD (app/src/components/OptionsPanel.tsx) does clamp the
    # input to >= 2.2 m and NumberInput enforces it on commit, so the last row
    # is the worst case actually reachable through the UI, not a hypothetical.
    # That clamp holds the GATE above draft; it cannot hold this mask's floor
    # above draft, and nothing here can.
    #
    # Why the previous TOLERANCE_M = 2.0 looked safe and was not: the comment
    # here bounded only the sub-case where max() reads 0 (dry), where the
    # |bilinear - max| test provably admits no more than TOLERANCE_M itself -
    # 38 such cells, all at exactly 2.00 m, reachable only below a 2.0 m gate.
    # That measurement was right and was mistaken for the whole bound. It says
    # nothing about a cell whose max reads 2.0 m and whose blend reads 4.0 m,
    # and 924 such below-draft cells were navigable at the DEFAULT 3.0 m gate.
    #
    # LOWER IS NOT SAFER - 0.9 sits just above a hard floor. verify_mask.py's
    # connectivity gate must keep passing Marstal, whose approach reconnects
    # only through bilinear-refined cells. MEASURED on this DTM: Marstal is
    # DISCONNECTED at its 2.0 m exception gate for TOLERANCE_M <= 0.87 and
    # connected from 0.88 up, so 0.9 clears the wall by ~0.03 m, not by a
    # comfortable margin. Never tighten this without re-running verify_mask.py.
    #
    # Cost against TOLERANCE_M = 2.0: cells navigable at the 3.0 m default fall
    # 2,473,845 -> 2,470,330 (-3,515, -0.14%), and cells the blend pushes
    # across that gate fall 14,715 -> 10,746 (-27%). verify_mask.py's table is
    # unchanged (28 OK, 2 of them via exception, 5 known-disconnected). 91,877
    # of 5,280,000 mask bytes change value; the file size does not.
    #
    # That -3,515 is a NET, and reading it as a pure subset is wrong: it
    # decomposes into -3,969 cells lost and +454 GAINED at the 3.0 m gate.
    # The gain is not new optimism - it is the same convergence, seen from the
    # other side. Bilinear is NOT bounded above by max here (a ~46 m
    # destination cell is smaller than an EMODnet source pixel, so bilinear
    # interpolates between pixel CENTRES the max window never covered, and can
    # land either side of it). Wherever bilinear read SHALLOWER than max, the
    # old tolerance shipped that pessimistic value; reverting to max makes the
    # cell deeper. MEASURED: all 8,461 such cells now equal the max-resample
    # EXACTLY - none exceeds it - and all 454 newly-navigable-at-3.0 cells have
    # a conservative depth >= 3.0. Both directions land on the conservative
    # reading, which is the whole point.
    TOLERANCE_M = 0.9
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
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE), which
    # would let a badly wrong zip inner path/CRS write the mask with no
    # plausibility check at all.
    if not (len(gdf) > 50):
        raise AssertionError(f"OSM land polygons: only {len(gdf)} features in bbox - check zip inner path/CRS")
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
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE).
    if not (n_land > 200000):
        raise AssertionError(f"OSM land raster: only {n_land} land cells - implausible for this coastline")

    print("carving the Schlei (OSM water=fjord relation, not coastline-tagged) out of the land mask...")
    schlei_geojson = json.loads((SRC / "schlei_relation.geojson.json").read_text())
    schlei = gpd.GeoDataFrame.from_features(
        [{"type": "Feature", "geometry": r["geojson"], "properties": {}} for r in schlei_geojson],
        crs="EPSG:4326",
    )
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE).
    if not schlei.geometry.geom_type.isin(["Polygon", "MultiPolygon"]).all():
        raise AssertionError(f"Schlei relation returned unexpected geometry types: {set(schlei.geometry.geom_type)}")
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
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE).
    if not (8000 < n_schlei < 120000):
        raise AssertionError(
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
    # #613: was a bare `assert` (stripped under -O/PYTHONOPTIMIZE) - without
    # it, a badly broken read would write the mask with no plausibility
    # check on the land/water split at all.
    if not (0.45 < water_frac < 0.85):
        raise AssertionError("implausible land/water split - inspect inputs")

    code_south_first = np.flipud(code)  # app convention: row 0 = south
    (OUT).mkdir(parents=True, exist_ok=True)
    (OUT / "mask.bin").write_bytes(code_south_first.tobytes())
    meta = {
        "west": WEST,
        "south": SOUTH,
        "east": EAST,
        "north": NORTH,
        "cols": COLS,
        "rows": ROWS,
        "encoding": "uint8 row-major, row 0 = south; 0=land/unknown, 1-254=depth dm floored, 255=deep(>=25.4m)",
        "verticalDatum": "LAT (EMODnet DTM 2024)",
        "sources": [
            "EMODnet Bathymetry Consortium (2024). EMODnet Digital Bathymetry (DTM 2024). doi:10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1 (CC-BY 4.0)",  # noqa: E501 -- DOI citation, not code; unwrappable
            "Land polygons (c) OpenStreetMap contributors (ODbL), osmdata.openstreetmap.de",
            "Schlei fjord water body (c) OpenStreetMap contributors (ODbL), relation 2340930 via nominatim.openstreetmap.org",  # noqa: E501 -- attribution string, not code; unwrappable
            # The About dialog renders mask.meta.json's `sources` dynamically,
            # so this string reaches the UI from here. It used to ALSO exist as
            # a static i18n item (about.sources.osmMask) because the committed
            # mask.meta.json predated this entry; #455's regeneration made that
            # copy a visible duplicate, and it was removed from AboutDialog and
            # both dicts then. Don't reintroduce a static copy.
            "The land/depth mask (mask.bin) is a Derivative Database of OpenStreetMap data and is made available under the Open Database License (ODbL). (c) OpenStreetMap contributors.",  # noqa: E501 -- license statement, not code; unwrappable
        ],
    }
    (OUT / "mask.meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote mask.bin ({code.size} bytes) + mask.meta.json")


if __name__ == "__main__":
    sys.exit(main())
