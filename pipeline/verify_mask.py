"""Sanity-probe the generated mask. Fails loudly if the mask is unusable."""

import json
import pathlib
import sys

import numpy as np
from scipy import ndimage

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "app" / "public" / "data"

meta = json.loads((OUT / "mask.meta.json").read_text())
grid = np.frombuffer((OUT / "mask.bin").read_bytes(), dtype=np.uint8).reshape(
    meta["rows"], meta["cols"]
)  # row 0 = south


def rc_of(lat: float, lon: float) -> tuple[int, int]:
    row = int((lat - meta["south"]) / (meta["north"] - meta["south"]) * meta["rows"])
    col = int((lon - meta["west"]) / (meta["east"] - meta["west"]) * meta["cols"])
    assert 0 <= row < meta["rows"] and 0 <= col < meta["cols"], f"probe {lat},{lon} maps outside the mask grid"
    return row, col


def depth_m(lat: float, lon: float) -> float:
    row, col = rc_of(lat, lon)
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

# ---- Connectivity gate (issue #6) ----
# A harbor snap can sit on an individually-navigable cell (checked above) yet
# still be cut off from open water by land/depth artifacts elsewhere on the
# grid - that was exactly issue #6 (14/44 harbors, incl. Flensburg, stranded
# in disconnected pockets despite passing the per-cell probe). This gate
# 4-connected-flood-fills the navigable cells from a fixed open-water seed
# and asserts every harbor snap's cell is reachable. 4-connectivity (not 8)
# is deliberate: a diagonal-only "connection" through a single pinched corner
# is not something a 4.2 m-beam boat can reliably thread, and this pipeline's
# rule is to never overstate navigability.
SEED_LAT, SEED_LON = 54.8455, 9.5216  # open Flensburg Fjord water
DEFAULT_GATE_DEPTH_M = 3.0  # matches the app's default safety depth

# Per-harbor override for a gate depth below the 3.0 m default, used ONLY
# when the harbor's own approachNote documents a genuinely shallower
# approach that the DTM/rasterization can't resolve as >= 3.0 m even at the
# current 46 m cell size - never by fudging the bathymetry. The assert below
# only checks that an approachNote *exists*; it can't verify the note's text
# actually supports the chosen number, so treat every entry here as a
# manual-review item at PR time, cited in the comment next to it (see PR #8,
# github.com/DocGerd/sail_command/pull/8, for the full investigation).
# Values were derived by scanning gate depths against the regenerated mask
# to find the threshold at which each harbor's snap cell actually reconnects
# to open water, then rounded down from that measured threshold to match
# the harbor's own documented figure, so the exception is never more
# permissive than the source text.
CONNECTIVITY_EXCEPTIONS_M: dict[str, float] = {
    # "Buoyed fairway up Augustenborg Fjord, approx 3 m in the upper
    # reaches." Reconnects at gate <= 2.8 m; matches the approx-3 m note.
    "augustenborg": 2.8,
    # "Buoyed approaches approx 3.2 m (N and W), 4.5 m from S; parts of the
    # yacht basin only approx 2 m." Reconnects at gate <= 2.3 m; 2.0 m is
    # the harbor's own documented figure for its shallowest reach and keeps
    # a safety margin below the measured 2.3 m threshold.
    "marstal": 2.0,
}

# Harbors investigated and confirmed disconnected at every gate depth this
# mask can offer - NOT a depth problem an exception could fix (see PR #8's
# report for the per-harbor evidence). Listing them here means a run against
# the shipped mask exits 0: a harbor in this map that's STILL disconnected
# is a known, already-tracked limitation, not a new regression, so it's
# reported but doesn't fail the build. To keep this list honest as the data
# improves, the gate below also fails the run if a listed harbor turns out
# to be connected - that means the entry is stale and must be removed.
KNOWN_DISCONNECTED: dict[str, str] = {
    "arnis": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "kappeln": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "maasholm": "Schlei fairway ribbon narrower than EMODnet native resolution - issue #9",
    "dyvig": "~30 m buoyed channel narrower than one 46 m cell - issue #9",
    "graasten": "Egernsund bascule bridge deck land-rasterized - issue #9",
}

FOUR_CONNECTIVITY = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=np.uint8)
_depth_grid = np.where(grid == 255, 25.4, np.where(grid == 0, 0.0, grid / 10.0))
_label_cache: dict[float, np.ndarray] = {}


def labeled_for(min_depth_m: float) -> np.ndarray:
    if min_depth_m not in _label_cache:
        labeled, _ = ndimage.label(_depth_grid >= min_depth_m, structure=FOUR_CONNECTIVITY)
        _label_cache[min_depth_m] = labeled
    return _label_cache[min_depth_m]


seed_row, seed_col = rc_of(SEED_LAT, SEED_LON)
default_labeled = labeled_for(DEFAULT_GATE_DEPTH_M)
seed_label = int(default_labeled[seed_row, seed_col])
assert seed_label != 0, f"connectivity seed ({SEED_LAT},{SEED_LON}) is not itself navigable at {DEFAULT_GATE_DEPTH_M} m"
main_component_size = int((default_labeled == seed_label).sum())
print(f"open-water seed component: {main_component_size} cells at >= {DEFAULT_GATE_DEPTH_M} m")

connectivity_report = []
for h in harbors:
    hid = h["id"]
    if hid in CONNECTIVITY_EXCEPTIONS_M:
        assert "approachNote" in h, f"CONNECTIVITY_EXCEPTIONS_M[{hid}] has no approachNote to justify it"
    gate_depth = CONNECTIVITY_EXCEPTIONS_M.get(hid, DEFAULT_GATE_DEPTH_M)
    labeled = labeled_for(gate_depth)
    row, col = rc_of(h["snap"]["lat"], h["snap"]["lon"])
    harbor_label = int(labeled[row, col])
    seed_label_here = int(labeled[seed_row, seed_col])
    connected = harbor_label != 0 and harbor_label == seed_label_here

    if connected:
        status = "OK"
        if hid in KNOWN_DISCONNECTED:
            status = "FAIL"
            failures.append(
                f"CONNECTIVITY {hid} is now connected at gate depth {gate_depth} m but is still listed "
                f"in KNOWN_DISCONNECTED ({KNOWN_DISCONNECTED[hid]}) - remove the stale entry"
            )
    elif hid in KNOWN_DISCONNECTED:
        status = "KNOWN"
    else:
        status = "FAIL"
        failures.append(
            f"CONNECTIVITY {hid} snap ({h['snap']['lat']},{h['snap']['lon']}) not reachable from open "
            f"water at gate depth {gate_depth} m"
        )
    connectivity_report.append((hid, gate_depth, status))

n_connected = sum(1 for _, _, status in connectivity_report if status == "OK")
n_known = sum(1 for _, _, status in connectivity_report if status == "KNOWN")
n_exceptions = sum(1 for hid, _, status in connectivity_report if status == "OK" and hid in CONNECTIVITY_EXCEPTIONS_M)
print(
    f"connectivity: {n_connected}/{len(connectivity_report)} harbors reach open water "
    f"({n_exceptions} via exception, {n_known} known-disconnected and tracked)"
)
for hid, gate_depth, status in connectivity_report:
    exc = f" (exception @ {gate_depth} m)" if hid in CONNECTIVITY_EXCEPTIONS_M and status == "OK" else ""
    known = f" [{KNOWN_DISCONNECTED[hid]}]" if hid in KNOWN_DISCONNECTED else ""
    print(f"  {status:5} {hid}{exc}{known}")

if failures:
    print("\n".join(failures))
    sys.exit(f"{len(failures)} mask probe failures")
print(f"all probes OK ({len(WATER_PROBES)} water, {len(LAND_PROBES)} land, {len(harbors)} harbor snaps)")
