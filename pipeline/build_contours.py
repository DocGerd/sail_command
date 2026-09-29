"""Build vector depth contours from the packed land/depth mask (#629).

Traces cautious-reading level lines plus the no-data edge from
app/public/data/mask.bin + mask.meta.json into a committed GeoJSON asset,
app/public/data/contours.json. Deterministic: rerunning against an
unchanged mask produces a byte-identical file.

Cell classification (design doc §2, exact in integers): mask byte 0 is
no-data; for b in 1..254 the cautious depth in tenths is max(0, b - 9), so a
cell is at or above level L iff b >= 10*L + 9; b = 255 (>= 25.4 m cautious
24.5 m) satisfies that inequality for every shipped level, so no special
case is needed.

Level lines are smoothed (#1540) by shortcutting the staircase, never by
moving it: a line keeps a subsequence of its own staircase vertices, joined by
chords that stay in the closure of the at-or-above-L cells, so no point of a
smoothed line lies on the shallow side of the edges it was traced from. The
no-data edge is left as traced. app/src/test/contoursAsset.test.ts re-checks
the same predicate against mask.bin.
"""

import hashlib
import json
import math
import pathlib
import sys
from collections import defaultdict

import numpy as np

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent / "app" / "public" / "data"
PRECACHE_MAX_FILE_SIZE_BYTES = 40 * 1024 * 1024  # app/vite.config.ts
GZIP_BUDGET_BYTES = 2 * 1024 * 1024

# Mirrors app/src/lib/contours.ts's CONTOUR_LEVELS_M and app/src/lib/mask.ts's
# MASK_TOLERANCE_M. Nothing compiles across the Python/TypeScript boundary;
# app/src/test/contoursAsset.test.ts pins both against this file's output.
LEVELS_M = [2, 3, 5, 10, 15, 20]
TOLERANCE_M = 0.9


def cells_per_degree(lo: float, hi: float, cells: int) -> int:
    """Mirrors app/src/lib/mask.ts's cellsPerDegree / verify_mask.py's copy
    of it (#1259/#1458)."""
    raw = cells / (hi - lo)
    cpd = round(raw)
    if not (math.isfinite(raw) and cpd > 0 and abs(raw - cpd) <= 1e-9):
        raise AssertionError(f"mask axis is not an integer cells-per-degree: {cells} cells over [{lo}, {hi}]")
    return cpd


def load_mask() -> tuple[dict, np.ndarray]:
    meta = json.loads((OUT / "mask.meta.json").read_text())
    grid = np.frombuffer((OUT / "mask.bin").read_bytes(), dtype=np.uint8).reshape(
        meta["rows"], meta["cols"]
    )  # row 0 = south
    return meta, grid


def _edge_pairs(u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return np.minimum(u, v), np.maximum(u, v)


def level_edges(grid: np.ndarray, level_m: int) -> tuple[np.ndarray, np.ndarray]:
    """Shared cell edges between a cell at/above `level_m` and a non-zero
    cell below it (design doc §2, "Level lines")."""
    rows, cols = grid.shape
    nz = grid != 0
    above = grid >= (10 * level_m + round(TOLERANCE_M * 10))
    los, his = [], []

    # Horizontal: between row r and r+1, at column c.
    hmask = nz[:-1, :] & nz[1:, :] & (above[:-1, :] != above[1:, :])
    rs, cs = np.nonzero(hmask)
    u = (rs + 1) * (cols + 1) + cs
    v = (rs + 1) * (cols + 1) + (cs + 1)
    lo, hi = _edge_pairs(u, v)
    los.append(lo)
    his.append(hi)

    # Vertical: between col c and c+1, at row r.
    vmask = nz[:, :-1] & nz[:, 1:] & (above[:, :-1] != above[:, 1:])
    rs, cs = np.nonzero(vmask)
    u = rs * (cols + 1) + (cs + 1)
    v = (rs + 1) * (cols + 1) + (cs + 1)
    lo, hi = _edge_pairs(u, v)
    los.append(lo)
    his.append(hi)

    return np.concatenate(los), np.concatenate(his)


def nodata_edges(grid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Every cell edge between a byte-0 cell and a non-zero cell, plus every
    outer-boundary edge of a non-zero cell (design doc §2, "No-data edge")."""
    rows, cols = grid.shape
    nz = grid != 0
    los, his = [], []

    # Interior horizontal: byte-0-ness differs across row r/r+1.
    hmask = nz[:-1, :] != nz[1:, :]
    rs, cs = np.nonzero(hmask)
    u = (rs + 1) * (cols + 1) + cs
    v = (rs + 1) * (cols + 1) + (cs + 1)
    lo, hi = _edge_pairs(u, v)
    los.append(lo)
    his.append(hi)

    # Interior vertical: byte-0-ness differs across col c/c+1.
    vmask = nz[:, :-1] != nz[:, 1:]
    rs, cs = np.nonzero(vmask)
    u = rs * (cols + 1) + (cs + 1)
    v = (rs + 1) * (cols + 1) + (cs + 1)
    lo, hi = _edge_pairs(u, v)
    los.append(lo)
    his.append(hi)

    # Outer boundary: one edge per non-zero cell touching the grid edge.
    def boundary(u: np.ndarray, v: np.ndarray) -> None:
        lo, hi = _edge_pairs(u, v)
        los.append(lo)
        his.append(hi)

    cs = np.nonzero(nz[0, :])[0]
    boundary(cs, cs + 1)  # south, row index 0
    cs = np.nonzero(nz[rows - 1, :])[0]
    boundary(rows * (cols + 1) + cs, rows * (cols + 1) + cs + 1)  # north
    rs = np.nonzero(nz[:, 0])[0]
    boundary(rs * (cols + 1), (rs + 1) * (cols + 1))  # west
    rs = np.nonzero(nz[:, cols - 1])[0]
    boundary(rs * (cols + 1) + cols, (rs + 1) * (cols + 1) + cols)  # east

    return np.concatenate(los), np.concatenate(his)


def trace_polylines(lo: np.ndarray, hi: np.ndarray) -> list[list[int]]:
    """Decompose an undirected multigraph of vertex-id edges into maximal
    edge-disjoint trails (vertex-id sequences). Every edge is consumed
    exactly once; a closed ring comes back as a path whose first and last
    ids match. Odd-degree vertices are tried as starts first, so an open line
    is not split at an interior vertex (a seam smoothing cannot cross).
    Deterministic: adjacency lists are sorted and walked smallest-neighbour-first,
    and start vertices are visited in sorted order within each group."""
    adj: dict[int, list[int]] = defaultdict(list)
    for u, v in zip(lo.tolist(), hi.tolist()):
        adj[u].append(v)
        adj[v].append(u)
    for lst in adj.values():
        lst.sort()

    paths: list[list[int]] = []
    starts = sorted(adj.keys(), key=lambda v: (len(adj[v]) % 2 == 0, v))
    for start in starts:
        while adj[start]:
            path = [start]
            cur = start
            while adj[cur]:
                nxt = adj[cur].pop(0)
                adj[nxt].remove(cur)
                path.append(nxt)
                cur = nxt
            paths.append(path)
    return paths


def simplify_collinear(points: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Drop vertices that sit on a straight continuation of the previous
    segment — lossless: the drawn point set is unchanged."""
    if len(points) < 3:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        prev = out[-1]
        cur = points[i]
        nxt = points[i + 1]
        d1 = (cur[0] - prev[0], cur[1] - prev[1])
        d2 = (nxt[0] - cur[0], nxt[1] - cur[1])
        if d1[0] * d2[1] - d1[1] * d2[0] == 0 and d1[0] * d2[0] + d1[1] * d2[1] > 0:
            continue
        out.append(cur)
    out.append(points[-1])
    return out


def _ceil_div(a: int, b: int) -> int:
    return -((-a) // b)


def chord_cells(p: tuple[int, int], q: tuple[int, int]) -> tuple[bool, list[tuple[int, int]]]:
    """Cells a chord between two lattice vertices (row, col) touches.

    Axis-aligned chord: returns (True, cells on either side of each unit edge
    it lies on). Otherwise: (False, cells whose open interior the open chord
    crosses), exact in integers. Cells may lie outside the grid."""
    (r0, c0), (r1, c1) = p, q
    if r0 == r1:
        cells = []
        for c in range(min(c0, c1), max(c0, c1)):
            cells.append((r0 - 1, c))
            cells.append((r0, c))
        return True, cells
    if c0 == c1:
        cells = []
        for r in range(min(r0, r1), max(r0, r1)):
            cells.append((r, c0 - 1))
            cells.append((r, c0))
        return True, cells
    if c0 > c1:
        (r0, c0), (r1, c1) = (r1, c1), (r0, c0)
    dc, dr = c1 - c0, r1 - r0
    cells = []
    for c in range(c0, c1):
        # Row at column x is r0 + dr * (x - c0) / dc; scaled by dc.
        ya = r0 * dc + dr * (c - c0)
        yb = r0 * dc + dr * (c + 1 - c0)
        lo, hi = min(ya, yb), max(ya, yb)
        for r in range(lo // dc, _ceil_div(hi, dc)):
            cells.append((r, c))
    return False, cells


def edge_cells(p: tuple[int, int], q: tuple[int, int]) -> tuple[tuple[int, int], tuple[int, int]]:
    """The two cells a unit staircase edge separates."""
    (r0, c0), (r1, c1) = p, q
    if r0 == r1:
        c = min(c0, c1)
        return (r0 - 1, c), (r0, c)
    r = min(r0, r1)
    return (r, c0 - 1), (r, c0)


class DeepGrid:
    """At-or-above-level classification with out-of-grid cells counted as
    not deep."""

    def __init__(self, grid: np.ndarray, level_m: int) -> None:
        self.rows, self.cols = grid.shape
        self.flags = (grid >= (10 * level_m + round(TOLERANCE_M * 10))).tobytes()

    def __call__(self, cell: tuple[int, int]) -> bool:
        r, c = cell
        return 0 <= r < self.rows and 0 <= c < self.cols and self.flags[r * self.cols + c] == 1


def chord_ok(trail: list[tuple[int, int]], i: int, j: int, deep: DeepGrid) -> bool:
    """Whether trail[i]..trail[j] may be replaced by one chord.

    Safety: every crossed cell is deep; an axis-aligned chord needs a deep
    cell beside every unit edge it lies on. Either way the chord stays in the
    closure of the deep cells. Fidelity: every skipped staircase edge borders
    a cell the chord touches, which keeps the chord within about a cell of
    its source and stops it bridging a deep inlet."""
    p, q = trail[i], trail[j]
    if p == q:
        return False
    axis, cells = chord_cells(p, q)
    if axis:
        for k in range(0, len(cells), 2):
            if not (deep(cells[k]) or deep(cells[k + 1])):
                return False
    elif not all(deep(cell) for cell in cells):
        return False
    touched = set(cells)
    for k in range(i, j):
        a, b = edge_cells(trail[k], trail[k + 1])
        if a not in touched and b not in touched:
            return False
    return True


def smooth_trail(trail: list[tuple[int, int]], deep: DeepGrid) -> list[tuple[int, int]]:
    """Greedy longest-chord shortcut of one staircase trail (see module doc)."""
    n = len(trail)
    closed = n >= 4 and trail[0] == trail[-1]
    if closed:
        # Start a ring at a vertex no chord can skip, so the seam is not an
        # artificial corner.
        ring = trail[:-1]
        m = len(ring)
        for k in range(m):
            window = [ring[(k - 1) % m], ring[k], ring[(k + 1) % m]]
            if not chord_ok(window, 0, 2, deep):
                trail = ring[k:] + ring[:k] + [ring[k]]
                break
    out = [trail[0]]
    i = 0
    while i < n - 1:
        j = i + 1
        while j + 1 < n and chord_ok(trail, i, j + 1, deep):
            j += 1
        out.append(trail[j])
        i = j
    if closed and (len(set(simplify_collinear(out))) < 4 or _twice_area(out) == 0):
        # A small ring would collapse to a tick or a sliver; keep it as traced.
        return trail
    return out


def _twice_area(ring: list[tuple[int, int]]) -> int:
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))


def _round5(x: float) -> float:
    v = round(x, 5)
    return 0.0 if v == 0 else v


def build_feature(
    lo: np.ndarray,
    hi: np.ndarray,
    properties: dict,
    meta: dict,
    lat_cpd: int,
    lon_cpd: int,
    cols: int,
    deep: DeepGrid | None,
) -> tuple[dict, int]:
    paths = trace_polylines(lo, hi)
    coord_paths = []
    vertex_count = 0
    for path in paths:
        decoded = [divmod(v, cols + 1) for v in path]  # (row, col)
        if deep is not None:
            decoded = smooth_trail(decoded, deep)
        simplified = simplify_collinear(decoded)
        vertex_count += len(simplified)
        coord_paths.append(
            [[_round5(meta["west"] + col / lon_cpd), _round5(meta["south"] + row / lat_cpd)] for row, col in simplified]
        )
    coord_paths.sort()
    feature = {
        "type": "Feature",
        "properties": properties,
        "geometry": {"type": "MultiLineString", "coordinates": coord_paths},
    }
    return feature, vertex_count


def main() -> None:
    mask_bytes = (OUT / "mask.bin").read_bytes()
    mask_sha256 = hashlib.sha256(mask_bytes).hexdigest()
    meta, grid = load_mask()
    rows, cols = grid.shape
    lat_cpd = cells_per_degree(meta["south"], meta["north"], rows)
    lon_cpd = cells_per_degree(meta["west"], meta["east"], cols)

    features = []
    total_vertices = 0
    for level in LEVELS_M:
        lo, hi = level_edges(grid, level)
        feature, vc = build_feature(
            lo, hi, {"kind": "contour", "levelM": level}, meta, lat_cpd, lon_cpd, cols, DeepGrid(grid, level)
        )
        features.append(feature)
        total_vertices += vc
        print(f"level {level} m: {len(feature['geometry']['coordinates'])} lines, {vc} vertices")

    lo, hi = nodata_edges(grid)
    feature, vc = build_feature(lo, hi, {"kind": "no-data"}, meta, lat_cpd, lon_cpd, cols, None)
    features.append(feature)
    total_vertices += vc
    print(f"no-data: {len(feature['geometry']['coordinates'])} lines, {vc} vertices")

    doc = {
        "type": "FeatureCollection",
        "maskSha256": mask_sha256,
        "basis": "cautious",
        "toleranceM": TOLERANCE_M,
        "levelsM": LEVELS_M,
        "features": features,
    }

    raw = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    (OUT / "contours.json").write_bytes(raw)

    import gzip as gzip_mod

    gzipped_len = len(gzip_mod.compress(raw, 9))

    print(f"features: {len(features)}, vertices: {total_vertices}")
    print(f"raw bytes: {len(raw)} (PRECACHE_MAX_FILE_SIZE_BYTES={PRECACHE_MAX_FILE_SIZE_BYTES})")
    print(f"gzipped bytes: {gzipped_len} (budget {GZIP_BUDGET_BYTES})")
    if len(raw) > PRECACHE_MAX_FILE_SIZE_BYTES:
        print(
            f"WARNING: raw size {len(raw)} exceeds PRECACHE_MAX_FILE_SIZE_BYTES "
            f"{PRECACHE_MAX_FILE_SIZE_BYTES} — the built service worker will drop this "
            "file from the precache with only a build-log warning.",
            file=sys.stderr,
        )
    if gzipped_len > GZIP_BUDGET_BYTES:
        print(
            f"STOP: gzipped size {gzipped_len} exceeds the {GZIP_BUDGET_BYTES}-byte budget "
            "(design doc §2) — bring this back to the maintainer before shipping.",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
