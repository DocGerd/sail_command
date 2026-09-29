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
