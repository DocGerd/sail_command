"""Lattice points track D's trilinear sampling reads, per wind variant (shared by fetch and merge)."""
import json
import numpy as np


def d_points(manifest_path, track_npz):
    z = np.load(track_npz)
    la, lo = z["lat"], z["lon"]
    out = {}
    for name, m in json.load(open(manifest_path)).items():
        lats, lons = np.array(m["lats"]), np.array(m["lons"])
        i = np.clip(np.searchsorted(lats, la, side="right") - 1, 0, len(lats) - 2)
        j = np.clip(np.searchsorted(lons, lo, side="right") - 1, 0, len(lons) - 2)
        s = set()
        for di in (0, 1):
            for dj in (0, 1):
                s |= {(float(a), float(b)) for a, b in zip(lats[i + di], lons[j + dj])}
        out[name] = sorted(s)
    return out
