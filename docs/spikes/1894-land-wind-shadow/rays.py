"""Per-sample 72-ray (5 deg) fetch from the committed mask, cap 2 nm, 20 m step
(same march as samples.py ray_fetch_nm). Positive control: min over the 36
10-deg rays must reproduce the stored `omni` column.
Usage: python3 -I rays.py <repo> <samples.npz> <out.npz>"""
import json, sys
import numpy as np
R_EARTH = 6371008.8; NM = 1852.0
repo, src, out = sys.argv[1:4]
meta = json.load(open(f"{repo}/app/public/data/mask.meta.json"))
mask = np.fromfile(f"{repo}/app/public/data/mask.bin", dtype=np.uint8).reshape(meta["rows"], meta["cols"])
CPD_LAT = round(meta["rows"] / (meta["north"] - meta["south"]))
CPD_LON = round(meta["cols"] / (meta["east"] - meta["west"]))
def is_land(lat, lon):
    r = np.floor((lat - meta["south"]) * CPD_LAT).astype(np.int64)
    c = np.floor((lon - meta["west"]) * CPD_LON).astype(np.int64)
    oob = (r < 0) | (r >= meta["rows"]) | (c < 0) | (c >= meta["cols"])
    return (mask[np.clip(r, 0, meta["rows"]-1), np.clip(c, 0, meta["cols"]-1)] == 0) & ~oob, oob
def ray(lat, lon, bearing, max_nm=2.0, step_m=20.0):
    n = lat.size; outv = np.full(n, max_nm); edge = np.zeros(n, bool)
    steps = np.arange(0, max_nm * NM + step_m, step_m); b = np.radians(bearing)
    for s in range(0, n, 4000):
        la, lo, bb = lat[s:s+4000, None], lon[s:s+4000, None], b[s:s+4000, None]
        d = steps[None, :]
        lat_k = la + np.degrees(d * np.cos(bb) / R_EARTH)
        lon_k = lo + np.degrees(d * np.sin(bb) / (R_EARTH * np.cos(np.radians(la))))
        land, oob = is_land(lat_k, lon_k); hit = land | oob
        anyh = hit.any(axis=1); first = np.argmax(hit, axis=1)
        outv[s:s+4000] = np.minimum(np.where(anyh, steps[first] / NM, max_nm), max_nm)
        edge[s:s+4000] = anyh & oob[np.arange(first.size), first]
    return outv, edge
S = np.load(src); lat, lon = S["lat"], S["lon"]
B = np.arange(0, 360, 5)
FE = [ray(lat, lon, np.full(lat.size, float(b))) for b in B]
F = np.stack([f for f, _ in FE], axis=1)
E_any = np.any(np.stack([e for _, e in FE], axis=1), axis=1)  # #1894 §6.3: some 2 nm ray ends at the mask edge
om36 = F[:, ::2].min(axis=1)
diff = np.abs(om36 - S["omni"])
print("positive control: max |omni36 - stored omni| =", diff.max(), "n=", diff.size)
# negative control: a different bearing set must NOT match exactly everywhere
om_off = F[:, 1::2].min(axis=1)
print("negative control (offset 5-deg set): share differing >1e-9 =", np.mean(np.abs(om_off - S["omni"]) > 1e-9))
np.savez(out, F=F.astype(np.float32), bearings=B, edge_any=E_any)
