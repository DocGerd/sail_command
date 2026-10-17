"""#1721: build_mask.py's charted-channel depth correction.

channel_cells() rasterizes a lat/lon centreline to a 4-connected run of cells;
raise_charted_channels() raises (never lowers) the mask along it.
"""

import json
import pathlib

import numpy as np
import pytest

from build_mask import CHARTED_CHANNELS_PATH, COLS, ROWS, channel_cells, raise_charted_channels

REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / "app" / "public" / "data"

# 10x10 grid over a 1x1 degree box: one cell = 0.1 deg, cell (row, col) centre
# = (0.05 + 0.1 * row, 0.05 + 0.1 * col).
GRID = {"west": 0.0, "south": 0.0, "east": 1.0, "north": 1.0, "cols": 10, "rows": 10}


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


def line_channel(start, end):
    (lat0, lon0), (lat1, lon1) = centre(*start), centre(*end)
    return {
        "id": "t",
        "depthM": 4.0,
        "centreline": [{"lat": lat0, "lon": lon0}, {"lat": lat1, "lon": lon1}],
    }


def raise_on_grid(code, channel):
    return raise_charted_channels(code, [channel], GRID["west"], GRID["south"], GRID["east"], GRID["north"])


def test_raise_only_and_off_line_cells_untouched():
    code = np.full((10, 10), 20, dtype=np.uint8)
    code[3, 2] = 55
    code[3, 4] = 255
    before = code.copy()
    changed = raise_on_grid(code, line_channel((3, 1), (3, 6)))
    assert code[3, 2] == 55 and code[3, 4] == 255
    assert [(r, c) for r, c, _, _ in changed] == [(3, 1), (3, 3), (3, 5), (3, 6)]
    assert all(b == 20 and a == 40 for _, _, b, a in changed)
    off_line = np.ones(code.shape, dtype=bool)
    off_line[3, 1:7] = False
    assert np.array_equal(code[off_line], before[off_line])
    assert (code[3, 1:7] >= 40).all()


def test_land_cell_on_centreline_raises():
    code = np.full((10, 10), 20, dtype=np.uint8)
    code[3, 3] = 0
    with pytest.raises(ValueError, match="land/unknown"):
        raise_on_grid(code, line_channel((3, 1), (3, 6)))


def load_channels():
    return json.loads(CHARTED_CHANNELS_PATH.read_text())["channels"]


def test_centreline_points_are_midpoints_of_their_seamarks():
    features = json.loads((DATA / "seamarks.json").read_text())["features"]
    for ch in load_channels():
        for p in ch["centreline"]:
            assert p["marks"], "a centreline point needs at least one source mark"
            for m in p["marks"]:
                lon, lat = features[m["seamarkIndex"]]["geometry"]["coordinates"][:2]
                props = features[m["seamarkIndex"]]["properties"]
                assert props["seamarkType"] == "buoy_lateral" and props["category"] == m["category"]
                assert (lat, lon) == (m["lat"], m["lon"])
            assert p["lat"] == pytest.approx(sum(m["lat"] for m in p["marks"]) / len(p["marks"]), abs=1e-7)
            assert p["lon"] == pytest.approx(sum(m["lon"] for m in p["marks"]) / len(p["marks"]), abs=1e-7)


def test_committed_mask_carries_every_charted_channel():
    mask = np.fromfile(DATA / "mask.bin", dtype=np.uint8).reshape(ROWS, COLS)
    for ch in load_channels():
        want = int(round(ch["depthM"] * 10))
        run = channel_cells([(p["lat"], p["lon"]) for p in ch["centreline"]])
        assert run
        assert_four_connected(run)
        low = [(r, c, int(mask[r, c])) for r, c in run if mask[r, c] < want]
        assert not low, f"{ch['id']}: cells below {want} dm in committed mask.bin: {low}"
