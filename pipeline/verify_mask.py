"""Sanity-probe the generated mask. Fails loudly if the mask is unusable."""

import json
import pathlib
import sys

import numpy as np

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "app" / "public" / "data"

meta = json.loads((OUT / "mask.meta.json").read_text())
grid = np.frombuffer((OUT / "mask.bin").read_bytes(), dtype=np.uint8).reshape(
    meta["rows"], meta["cols"]
)  # row 0 = south


def depth_m(lat: float, lon: float) -> float:
    row = int((lat - meta["south"]) / (meta["north"] - meta["south"]) * meta["rows"])
    col = int((lon - meta["west"]) / (meta["east"] - meta["west"]) * meta["cols"])
    assert 0 <= row < meta["rows"] and 0 <= col < meta["cols"], f"probe {lat},{lon} maps outside the mask grid"
    b = int(grid[row, col])
    return 0.0 if b == 0 else (25.4 if b == 255 else b / 10.0)


WATER_PROBES = [  # (name, lat, lon, min expected depth m)
    ("Flensburg Fjord mid", 54.7996, 9.8895, 5.0),
    ("Sonderborg Bucht", 54.88, 9.83, 5.0),
    ("Als Fjord", 55.0338, 9.6815, 5.0),
    ("Little Belt south", 55.10, 9.85, 10.0),
    ("Aeroe SE open water", 54.75, 10.55, 5.0),
    ("Kiel Bight edge", 54.55, 10.30, 10.0),
]
LAND_PROBES = [
    ("Flensburg city", 54.79, 9.42),
    ("Als island center", 54.95, 9.85),
    ("Aeroe center", 54.87, 10.35),
    ("Langeland center", 54.90, 10.75),
    ("Angeln inland", 54.70, 9.70),
]

failures = []
for name, lat, lon, want in WATER_PROBES:
    d = depth_m(lat, lon)
    if d < want:
        failures.append(f"WATER {name} ({lat},{lon}): {d} m < {want} m")
for name, lat, lon in LAND_PROBES:
    d = depth_m(lat, lon)
    if d != 0.0:
        failures.append(f"LAND {name} ({lat},{lon}): depth {d} m, expected land")

harbors = json.loads((OUT / "harbors.json").read_text())
for h in harbors:
    d = depth_m(h["snap"]["lat"], h["snap"]["lon"])
    if d < 2.2:
        failures.append(f"HARBOR {h['id']} snap ({h['snap']['lat']},{h['snap']['lon']}): {d} m < 2.2 m")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} mask probe failures")
print(f"all probes OK ({len(WATER_PROBES)} water, {len(LAND_PROBES)} land, {len(harbors)} harbor snaps)")
