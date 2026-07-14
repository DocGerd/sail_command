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
COLS, ROWS = 1100, 1200

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
    elev = np.full((ROWS, COLS), np.nan, dtype=np.float32)  # row 0 = north (numpy)
    with rasterio.open(SRC / "emodnet_dtm.tif") as src:
        # Resampling.max on LAT-referenced *elevation* picks the SHALLOWEST
        # contributing source cell -> conservative for navigability.
        reproject(
            source=rasterio.band(src, 1),
            destination=elev,
            src_nodata=float("nan"),
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            dst_nodata=float("nan"),
            resampling=Resampling.max,
        )

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
    assert len(gdf) > 5000, f"OSM land polygons: only {len(gdf)} features in bbox - check zip inner path/CRS"
    land = features.rasterize(
        gdf.geometry,
        out_shape=(ROWS, COLS),
        transform=dst_transform,
        all_touched=True,  # any cell touching land counts as land - conservative for a 45-footer
        fill=0,
        default_value=1,
    ).astype(bool)
    n_land = int(land.sum())
    print(f"land cells: {n_land}")
    assert n_land > 50000, f"OSM land raster: only {n_land} land cells - implausible for this coastline"

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
    assert 2000 < n_schlei < 30000, (
        f"Schlei carve size {n_schlei} implausible - expected a fjord of roughly 40 km x ~5-10 cells width"
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
        ],
    }
    (OUT / "mask.meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote mask.bin ({code.size} bytes) + mask.meta.json")


if __name__ == "__main__":
    sys.exit(main())
