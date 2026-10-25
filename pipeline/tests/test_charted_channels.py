"""#1875: build_mask.py's charted-channel override.

channel_cells() rasterizes a lat/lon centreline to a 4-connected run of cells;
raise_charted_channels() raises (never lowers) the mask along it, inside the
source's extent only, and refuses a centreline that crosses OSM land.
"""

import json
import math
import pathlib

import numpy as np
import pytest

from build_mask import CHARTED_CHANNELS_PATH, COLS, ROWS, channel_cells, charted_cells, raise_charted_channels

REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / "app" / "public" / "data"

# 10x10 grid over a 1x1 degree box: one cell = 0.1 deg, cell (row, col) centre
# = (0.05 + 0.1 * row, 0.05 + 0.1 * col); row 0 = south.
GRID = {"west": 0.0, "south": 0.0, "east": 1.0, "north": 1.0, "cols": 10, "rows": 10}
WHOLE_GRID = {"south": 0.0, "north": 1.0, "west": 0.0, "east": 1.0}


def centre(row, col):
    return (0.05 + 0.1 * row, 0.05 + 0.1 * col)


def cells(points):
    return channel_cells(points, **GRID)


def assert_four_connected(run):
    for (r0, c0), (r1, c1) in zip(run, run[1:], strict=False):
        assert abs(r1 - r0) + abs(c1 - c0) == 1, f"{(r0, c0)} -> {(r1, c1)} is not a 4-neighbour step"


def test_horizontal_run_visits_every_cell_once():
    assert cells([centre(3, 1), centre(3, 6)]) == [(3, c) for c in range(1, 7)]


def test_diagonal_run_is_four_connected_and_keeps_endpoints():
    run = cells([centre(1, 1), centre(6, 5)])
    assert run[0] == (1, 1) and run[-1] == (6, 5)
    assert_four_connected(run)


@pytest.mark.parametrize(
    ("start", "end"),
    [((0, 0), (9, 9)), ((9, 0), (0, 9)), ((2, 8), (7, 1)), ((5, 5), (5, 5)), ((0, 4), (9, 5))],
)
def test_any_direction_is_four_connected(start, end):
    run = cells([centre(*start), centre(*end)])
    assert run[0] == start and run[-1] == end
    assert_four_connected(run)


def test_multi_segment_polyline_has_no_duplicate_joint():
    run = cells([centre(0, 0), centre(0, 3), centre(4, 3)])
    assert run == [(0, 0), (0, 1), (0, 2), (0, 3), (1, 3), (2, 3), (3, 3), (4, 3)]


def line_channel(start, end, extent=WHOLE_GRID, depth_m=4.0):
    (lat0, lon0), (lat1, lon1) = centre(*start), centre(*end)
    return {
        "id": "t",
        "depthM": depth_m,
        "sourceExtent": extent,
        "centreline": [{"lat": lat0, "lon": lon0}, {"lat": lat1, "lon": lon1}],
    }


def raise_on_grid(code, channel, land=None):
    if land is None:
        land = np.zeros(code.shape, dtype=bool)
    return raise_charted_channels(code, land, [channel], GRID["west"], GRID["south"], GRID["east"], GRID["north"])


def test_raise_only_and_off_line_cells_untouched():
    code = np.full((10, 10), 20, dtype=np.uint8)
    code[3, 2] = 55
    code[3, 4] = 255
    code[3, 5] = 0  # DTM-dry water, the Alssund barrier case: raised
    before = code.copy()
    changed = raise_on_grid(code, line_channel((3, 1), (3, 6)))
    assert code[3, 2] == 55 and code[3, 4] == 255
    assert [(r, c) for r, c, _, _ in changed] == [(3, 1), (3, 3), (3, 5), (3, 6)]
    assert [(b, a) for _, _, b, a in changed] == [(20, 40), (20, 40), (0, 40), (20, 40)]
    off_line = np.ones(code.shape, dtype=bool)
    off_line[3, 1:7] = False
    assert np.array_equal(code[off_line], before[off_line])
    assert (code >= before).all()


def test_cells_outside_the_source_extent_are_traversed_but_untouched():
    code = np.full((10, 10), 20, dtype=np.uint8)
    # Extent covers cell centres in cols 3..5 only.
    extent = {"south": 0.0, "north": 1.0, "west": 0.3, "east": 0.6}
    run, inside = charted_cells(line_channel((3, 1), (3, 7), extent), **GRID)
    assert run == [(3, c) for c in range(1, 8)]
    assert inside == [(3, 3), (3, 4), (3, 5)]
    changed = raise_on_grid(code, line_channel((3, 1), (3, 7), extent))
    assert [(r, c) for r, c, _, _ in changed] == [(3, 3), (3, 4), (3, 5)]
    assert code[3, 1] == code[3, 2] == code[3, 6] == code[3, 7] == 20


def test_no_cell_inside_the_extent_raises():
    code = np.full((10, 10), 20, dtype=np.uint8)
    extent = {"south": 0.8, "north": 1.0, "west": 0.0, "east": 1.0}
    with pytest.raises(ValueError, match="sourceExtent"):
        raise_on_grid(code, line_channel((3, 1), (3, 6), extent))


def test_land_cell_on_centreline_raises_and_land_is_south_first():
    # Land on row 3 only: not flip-symmetric (a north-first array would put it on row 6).
    land = np.zeros((10, 10), dtype=bool)
    land[3, 4] = True
    code = np.full((10, 10), 20, dtype=np.uint8)
    with pytest.raises(ValueError, match="OSM land"):
        raise_on_grid(code, line_channel((3, 1), (3, 6)), land)
    assert (code == 20).all(), "nothing may be raised once the centreline is rejected"
    assert len(raise_on_grid(code, line_channel((6, 1), (6, 6)), land)) == 6


def test_land_outside_the_extent_still_raises():
    land = np.zeros((10, 10), dtype=bool)
    land[3, 1] = True
    extent = {"south": 0.0, "north": 1.0, "west": 0.3, "east": 0.6}
    with pytest.raises(ValueError, match="OSM land"):
        raise_on_grid(np.full((10, 10), 20, dtype=np.uint8), line_channel((3, 1), (3, 6), extent), land)


@pytest.mark.parametrize("depth_m", [0.0, 0.05, 25.5])
def test_depth_outside_the_encoding_raises(depth_m):
    with pytest.raises(ValueError, match="encoding"):
        raise_on_grid(np.full((10, 10), 20, dtype=np.uint8), line_channel((3, 1), (3, 6), depth_m=depth_m))


def test_land_shape_mismatch_raises():
    with pytest.raises(ValueError, match="shape"):
        raise_on_grid(np.zeros((10, 10), dtype=np.uint8), line_channel((3, 1), (3, 6)), np.zeros((9, 10), dtype=bool))


def load_channels():
    return json.loads(CHARTED_CHANNELS_PATH.read_text())["channels"]


def test_centreline_points_are_mark_midpoints_or_state_a_basis():
    features = json.loads((DATA / "seamarks.json").read_text())["features"]
    for ch in load_channels():
        for p in ch["centreline"]:
            marks = p.get("marks", [])
            if not marks:
                assert p.get("basis", "").strip(), "a centreline point needs source marks or a stated basis"
                continue
            for m in marks:
                f = features[m["seamarkIndex"]]
                props = f["properties"]
                assert tuple(f["geometry"]["coordinates"][:2]) == (m["lon"], m["lat"])
                assert props["seamarkType"] == m["seamarkType"]
                assert props["seamarkType"] in ("buoy_lateral", "beacon_lateral", "light_minor")
                key = "category" if "category" in props else "lightColour"
                assert props[key] == m[key]
            assert p["lat"] == pytest.approx(sum(m["lat"] for m in marks) / len(marks), abs=1e-7)
            assert p["lon"] == pytest.approx(sum(m["lon"] for m in marks) / len(marks), abs=1e-7)


def test_committed_mask_carries_every_charted_channel():
    mask = np.fromfile(DATA / "mask.bin", dtype=np.uint8).reshape(ROWS, COLS)
    for ch in load_channels():
        want = int(math.floor(ch["depthM"] * 10 + 1e-9))
        run, inside = charted_cells(ch)
        assert inside
        assert_four_connected(run)
        low = [(r, c, int(mask[r, c])) for r, c in inside if mask[r, c] < want]
        assert not low, f"{ch['id']}: cells below {want} dm in committed mask.bin: {low}"
