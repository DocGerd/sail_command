"""#1540: build_contours.py's level-line smoothing never leaves the closure of
the at-or-above-level cells, and stays near the staircase it shortcuts."""

import numpy as np

from build_contours import (
    DeepGrid,
    chord_cells,
    chord_ok,
    level_edges,
    simplify_collinear,
    smooth_trail,
    trace_polylines,
)

DEEP, SHALLOW = 200, 20  # both sides of the 5 m level (threshold byte 59)
LEVEL = 5


def smoothed(grid: np.ndarray) -> list[list[tuple[int, int]]]:
    cols = grid.shape[1]
    deep = DeepGrid(grid, LEVEL)
    lo, hi = level_edges(grid, LEVEL)
    out = []
    for path in trace_polylines(lo, hi):
        trail = [divmod(v, cols + 1) for v in path]
        out.append(simplify_collinear(smooth_trail(trail, deep)))
    return out


def assert_in_deep_closure(grid: np.ndarray, lines: list[list[tuple[int, int]]]) -> None:
    deep = DeepGrid(grid, LEVEL)
    for line in lines:
        for p, q in zip(line, line[1:]):
            axis, cells = chord_cells(p, q)
            if axis:
                for k in range(0, len(cells), 2):
                    assert deep(cells[k]) or deep(cells[k + 1]), (p, q)
            else:
                assert all(deep(c) for c in cells), (p, q)


def staircase_grid() -> np.ndarray:
    """Deep below a 45-degree staircase, shallow above it."""
    g = np.full((8, 8), SHALLOW, np.uint8)
    for r in range(8):
        g[r, : 8 - r] = DEEP
    return g


def test_diagonal_staircase_becomes_a_straight_line():
    g = staircase_grid()
    lines = smoothed(g)
    assert len(lines) == 1
    assert lines[0] == [(1, 8), (1, 7), (7, 1), (8, 1)]
    assert_in_deep_closure(g, lines)


def test_one_cell_shoal_keeps_its_square():
    g = np.full((5, 5), DEEP, np.uint8)
    g[2, 2] = SHALLOW
    assert smoothed(g) == [[(2, 2), (2, 3), (3, 3), (3, 2), (2, 2)]]


def test_small_deep_pockets_keep_their_traced_ring():
    for size in (1, 2):
        g = np.full((6, 6), SHALLOW, np.uint8)
        g[2 : 2 + size, 2 : 2 + size] = DEEP
        (line,) = smoothed(g)
        assert sorted(set(line)) == [(2, 2), (2, 2 + size), (2 + size, 2), (2 + size, 2 + size)]
        assert len(line) == 5


def test_one_cell_deep_channel_mouth_is_not_bridged():
    g = np.full((9, 9), SHALLOW, np.uint8)
    g[:2, :] = DEEP
    g[2:8, 4] = DEEP  # a one-cell-wide deep inlet, six cells long
    lines = smoothed(g)
    assert_in_deep_closure(g, lines)
    rows_reached = {r for line in lines for r, _ in line}
    assert max(rows_reached) == 8


def test_corner_is_cut_only_through_a_deep_cell():
    g = np.full((4, 4), DEEP, np.uint8)
    g[1, 1] = SHALLOW
    deep = DeepGrid(g, LEVEL)
    # The chord across this corner crosses cell (1, 1).
    assert not chord_ok([(1, 1), (1, 2), (2, 2)], 0, 2, deep)
    g[1, 1] = DEEP
    assert chord_ok([(1, 1), (1, 2), (2, 2)], 0, 2, DeepGrid(g, LEVEL))


def test_real_shaped_blob_stays_in_deep_closure():
    rng = np.random.default_rng(1540)
    g = np.where(rng.random((40, 40)) < 0.45, SHALLOW, DEEP).astype(np.uint8)
    g[0, 0] = 0
    assert_in_deep_closure(g, smoothed(g))


# Region guard: the even-odd interior of a level's lines, closed by the deep
# cells' own no-data and grid edges, must lie inside the at-or-above-level
# cells. A point-in-polygon model, independent of chord_cells/chord_ok.
SCALE = 1 << 20
SAMPLE_X, SAMPLE_Y = 523_229, 460_001  # sample at (col + x/SCALE, row + y/SCALE)


def deep_cells(grid: np.ndarray, level_m: int) -> np.ndarray:
    tenths = np.maximum(grid.astype(np.int64) - 9, 0)
    return (grid != 0) & (tenths >= 10 * level_m)


def closing_segments(grid: np.ndarray, deep: np.ndarray) -> np.ndarray:
    """Vertical unit edges between a deep cell and a byte-0 or out-of-grid neighbour, as (r0, c0, r1, c1)."""
    pad_deep = np.pad(deep, ((0, 0), (1, 1)))
    pad_zero = np.pad(grid == 0, ((0, 0), (1, 1)), constant_values=True)
    left_deep, right_deep = pad_deep[:, :-1], pad_deep[:, 1:]
    left_zero, right_zero = pad_zero[:, :-1], pad_zero[:, 1:]
    rs, cs = np.nonzero((left_deep & right_zero) | (right_deep & left_zero))
    return np.stack([rs, cs, rs + 1, cs], axis=1)


def even_odd_interior(shape: tuple[int, int], segs: np.ndarray) -> tuple[np.ndarray, int]:
    rows, cols = shape
    segs = segs[segs[:, 0] != segs[:, 2]].astype(np.int64)
    flip = segs[:, 0] > segs[:, 2]
    segs[flip] = segs[flip][:, [2, 3, 0, 1]]
    ya, xa, yb, xb = segs.T
    dy, dx = yb - ya, xb - xa
    idx = np.repeat(np.arange(len(segs)), dy)
    r = ya[idx] + (np.arange(dy.sum()) - np.repeat(np.cumsum(dy) - dy, dy))
    num = SCALE * xa[idx] * dy[idx] + (SCALE * (r - ya[idx]) + SAMPLE_Y) * dx[idx] - SAMPLE_X * dy[idx]
    den = SCALE * dy[idx]
    ties = int(np.count_nonzero(num % den == 0))
    first = np.clip(num // den + 1, 0, cols)
    toggles = np.zeros((rows, cols + 1), np.int64)
    np.add.at(toggles, (r, first), 1)
    inside = (np.cumsum(toggles, axis=1)[:, :cols] % 2) == 1
    return inside, ties


def staircase_segments(grid: np.ndarray, level_m: int) -> np.ndarray:
    cols = grid.shape[1]
    lo, hi = level_edges(grid, level_m)
    a = np.stack(np.divmod(lo, cols + 1), axis=1)
    b = np.stack(np.divmod(hi, cols + 1), axis=1)
    return np.concatenate([a, b], axis=1)


def smoothed_segments(grid: np.ndarray, level_m: int) -> np.ndarray:
    cols = grid.shape[1]
    deep = DeepGrid(grid, level_m)
    lo, hi = level_edges(grid, level_m)
    segs = []
    for path in trace_polylines(lo, hi):
        line = simplify_collinear(smooth_trail([divmod(v, cols + 1) for v in path], deep))
        segs.extend((*p, *q) for p, q in zip(line, line[1:]))
    return np.array(segs, np.int64).reshape(-1, 4)


def region(grid: np.ndarray, level_m: int, segs: np.ndarray) -> tuple[np.ndarray, np.ndarray, int]:
    deep = deep_cells(grid, level_m)
    inside, ties = even_odd_interior(grid.shape, np.concatenate([segs, closing_segments(grid, deep)]))
    return inside, deep, ties


def assert_region_within_deep(grid: np.ndarray, level_m: int) -> None:
    inside, deep, ties = region(grid, level_m, staircase_segments(grid, level_m))
    assert ties == 0
    assert np.array_equal(inside, deep), "control: the unsmoothed staircase must enclose exactly the deep set"
    inside, deep, ties = region(grid, level_m, smoothed_segments(grid, level_m))
    assert ties == 0
    shown = np.argwhere(inside & ~deep)
    assert len(shown) == 0, f"level {level_m} m: {len(shown)} shallow cells shown deep, e.g. {shown[:3].tolist()}"


def test_region_minimal_shortcut_case():
    rows = ["..###..", ".#..#.#", "#.#.#..", ".#.##.#", "##.##.#", "..##..#", "###...."]  # row 6 first
    g = np.array([[DEEP if ch == "#" else SHALLOW for ch in row] for row in reversed(rows)], np.uint8)
    assert_region_within_deep(g, LEVEL)


def test_region_random_grids():
    rng = np.random.default_rng(1540)
    for _ in range(200):
        g = rng.choice(np.array([0, SHALLOW, DEEP], np.uint8), size=(12, 12), p=[0.1, 0.45, 0.45])
        assert_region_within_deep(g, LEVEL)


def test_region_whole_mask_every_level():
    from build_contours import LEVELS_M, load_mask

    _, grid = load_mask()
    for level_m in LEVELS_M:
        assert_region_within_deep(grid, level_m)
