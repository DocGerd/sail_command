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
    above = grid >= (10 * level_m + 9)
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
    ids match. Deterministic: adjacency lists are sorted and walked
    smallest-neighbour-first, and start vertices are visited in sorted order."""
    adj: dict[int, list[int]] = defaultdict(list)
    for u, v in zip(lo.tolist(), hi.tolist()):
        adj[u].append(v)
        adj[v].append(u)
    for lst in adj.values():
        lst.sort()

    paths: list[list[int]] = []
    for start in sorted(adj.keys()):
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
    """Merge consecutive staircase vertices that fall on the same straight
    run — lossless (grid edges are axis-aligned unit steps, so "collinear"
    reduces to "same direction as the previous step"), never smoothing."""
    if len(points) < 3:
        return points
    out = [points[0]]
    for i in range(1, len(points) - 1):
        prev = out[-1]
        cur = points[i]
        nxt = points[i + 1]
        d1 = (cur[0] - prev[0], cur[1] - prev[1])
        d2 = (nxt[0] - cur[0], nxt[1] - cur[1])
        if d1 == d2:
            continue
        out.append(cur)
    out.append(points[-1])
    return out


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
) -> tuple[dict, int]:
    paths = trace_polylines(lo, hi)
    coord_paths = []
    vertex_count = 0
    for path in paths:
        decoded = [divmod(v, cols + 1) for v in path]  # (row, col)
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
        feature, vc = build_feature(lo, hi, {"kind": "contour", "levelM": level}, meta, lat_cpd, lon_cpd, cols)
        features.append(feature)
        total_vertices += vc
        print(f"level {level} m: {len(feature['geometry']['coordinates'])} lines, {vc} vertices")

    lo, hi = nodata_edges(grid)
    feature, vc = build_feature(lo, hi, {"kind": "no-data"}, meta, lat_cpd, lon_cpd, cols)
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
