"""#1894 Phase 3, stage 1: per-sample table with wind, polar ratio, fetch,
exclusion flags. Implements docs/spikes/1894-land-wind-shadow.md §0, and §6
through two environment variables: SC_SAIL (fock|genoa, default fock) picks
the table, SC_LEG_R_MAX caps the leg median R in both sets.

Usage: python3 -I samples.py <repo> <npz_dir> <wind_dir> <variant> <out.npz> [strict]
"""
import glob
import os
import json
from pathlib import Path
import sys

import numpy as np

R_EARTH = 6371008.8
NM = 1852.0

repo, npz_dir, wind_dir, variant, out_path = sys.argv[1:6]
STRICT = len(sys.argv) > 6 and sys.argv[6] == "strict"

# §0.3 thresholds (normal / strict)
HARBOUR_NM = 1.5 if STRICT else 1.0
END_NM = 1.0
TURN_WIN_S = 90 if STRICT else 60
TURN_DEG = 30.0
WAIT_KN, WAIT_S = 1.0, 60
CLOSE_TWA = 40.0 if STRICT else 35.0
CLOSE_S = 120
LEG_R_MAX = 1.4 if STRICT else 1.6
if os.environ.get("SC_LEG_R_MAX"):  # #1894 §6.3 motoring rule, both sets
    LEG_R_MAX = min(LEG_R_MAX, float(os.environ["SC_LEG_R_MAX"]))
LOWTWS_KN, LOWTWS_SOG = 4.0, 3.0
TWA_MIN, TWS_MIN, TWS_MAX = 45.0, 4.0, 25.0
LEG_MIN_S = 180
HALF_WIN = 15.0  # 30 s centred window
TURN_MIN_DISP_M = 15.0  # both 30 s windows must move >= 15 m (~1 kn) to define a COG

# ---------- static inputs ----------
meta = json.loads(Path(f"{repo}/app/public/data/mask.meta.json").read_text())
mask = np.fromfile(f"{repo}/app/public/data/mask.bin", dtype=np.uint8).reshape(meta["rows"], meta["cols"])
CPD_LAT = round(meta["rows"] / (meta["north"] - meta["south"]))
CPD_LON = round(meta["cols"] / (meta["east"] - meta["west"]))
harbours = json.loads(Path(f"{repo}/app/public/data/harbors.json").read_text())
H_LAT = np.array([h["snap"]["lat"] for h in harbours])
H_LON = np.array([h["snap"]["lon"] for h in harbours])
SAIL = os.environ.get("SC_SAIL", "fock")  # #1894 §6.1: each trip's own sail
assert SAIL in ("fock", "genoa")
pol = json.loads(Path(f"{repo}/app/public/data/polars/salona-44-easy-go-{SAIL}.json").read_text())
P_TWA = np.array(pol["twa"], float)
P_TWS = np.array(pol["tws"], float)
P_SPD = np.array(pol["speeds"], float)  # [twa][tws]
assert P_SPD.shape == (len(P_TWA), len(P_TWS))


def cell_rc(lat, lon):
    r = np.floor((lat - meta["south"]) * CPD_LAT).astype(np.int64)
    c = np.floor((lon - meta["west"]) * CPD_LON).astype(np.int64)
    return r, c


def is_land(lat, lon):
    r, c = cell_rc(lat, lon)
    oob = (r < 0) | (r >= meta["rows"]) | (c < 0) | (c >= meta["cols"])
    rr = np.clip(r, 0, meta["rows"] - 1)
    cc = np.clip(c, 0, meta["cols"] - 1)
    return (mask[rr, cc] == 0) & ~oob, oob


def gc_nm(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(a)) / NM


def enu(lat0, lon0, lat1, lon1):
    """Local flat displacement in metres (east, north)."""
    phi = np.radians((lat0 + lat1) / 2)
    return (
        np.radians(lon1 - lon0) * R_EARTH * np.cos(phi),
        np.radians(lat1 - lat0) * R_EARTH,
    )


def ray_fetch_nm(lat, lon, bearing, max_nm=10.0, step_m=20.0):
    """Distance (nm) along `bearing` (deg true) to the first land cell; capped.

    Step 20 m < half a ~46 m cell. Leaving the mask bbox ends the ray at the
    edge distance and sets the edge flag.
    """
    n = lat.size
    out = np.full(n, max_nm)
    edge = np.zeros(n, bool)
    steps = np.arange(0, max_nm * NM + step_m, step_m)
    b = np.radians(bearing)
    for s in range(0, n, 4000):
        la, lo, bb = lat[s : s + 4000, None], lon[s : s + 4000, None], b[s : s + 4000, None]
        d = steps[None, :]
        lat_k = la + np.degrees(d * np.cos(bb) / R_EARTH)
        lon_k = lo + np.degrees(d * np.sin(bb) / (R_EARTH * np.cos(np.radians(la))))
        land, oob = is_land(lat_k, lon_k)
        hit = land | oob
        any_hit = hit.any(axis=1)
        first = np.argmax(hit, axis=1)
        dist = np.where(any_hit, steps[first] / NM, max_nm)
        out[s : s + 4000] = np.minimum(dist, max_nm)
        edge[s : s + 4000] = any_hit & oob[np.arange(first.size), first]
    return out, edge


def angdiff(a, b):
    return (a - b + 180.0) % 360.0 - 180.0


def runs(flag):
    """(start, end_exclusive) index pairs of True runs."""
    f = np.concatenate([[False], flag, [False]]).astype(np.int8)
    d = np.diff(f)
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


# ---------- wind grid (mirrors lib/wind.ts WindField.sample) ----------
def load_grid(name):
    man = json.loads(Path(f"{wind_dir}/MANIFEST.json").read_text())[name]
    lats, lons = man["lats"], man["lons"]
    li = {v: i for i, v in enumerate(lats)}
    oi = {v: j for j, v in enumerate(lons)}
    times = None
    sp = dirr = None
    cell = {}
    for path in sorted(glob.glob(f"{wind_dir}/{name}_[0-9][0-9][0-9].json")):
        ch = json.loads(Path(path).read_text())
        for (la, lo), loc in zip(ch["points"], ch["data"]):
            h = loc["hourly"]
            t = np.array(h["time"], float)
            if times is None:
                times = t
                sp = np.full((t.size, len(lats), len(lons)), np.nan)
                dirr = np.full_like(sp, np.nan)
            assert np.array_equal(t, times)
            i, j = li[la], oi[lo]
            sp[:, i, j] = np.array([np.nan if x is None else x for x in h["wind_speed_10m"]], float)
            dirr[:, i, j] = np.array([np.nan if x is None else x for x in h["wind_direction_10m"]], float)
            cell[(la, lo)] = (loc["latitude"], loc["longitude"], loc.get("elevation"))
    return dict(lats=np.array(lats), lons=np.array(lons), t=times, sp=sp, dir=dirr, cell=cell)


def bracket(xs, x):
    x = np.asarray(x, float)
    n = xs.size
    i = np.clip(np.searchsorted(xs, x, side="right") - 1, 0, n - 2)
    f = (x - xs[i]) / (xs[i + 1] - xs[i])
    f = np.where(x <= xs[0], 0.0, np.where(x >= xs[-1], 1.0, f))
    i = np.where(x <= xs[0], 0, i)
    return i, f


def sample_wind(g, lat, lon, t):
    la_i, la_f = bracket(g["lats"], lat)
    lo_i, lo_f = bracket(g["lons"], lon)
    t_i, t_f = bracket(g["t"], t)
    u = np.zeros(lat.size)
    v = np.zeros(lat.size)
    for dt, wt in ((0, 1 - t_f), (1, t_f)):
        for dla, wla in ((0, 1 - la_f), (1, la_f)):
            for dlo, wlo in ((0, 1 - lo_f), (1, lo_f)):
                w = wt * wla * wlo
                s = g["sp"][t_i + dt, la_i + dla, lo_i + dlo]
                d = np.radians(g["dir"][t_i + dt, la_i + dla, lo_i + dlo])
                # wind.ts skips zero-weight corners, so a NaN there must not leak
                u += np.where(w == 0, 0.0, w * -s * np.sin(d))
                v += np.where(w == 0, 0.0, w * -s * np.cos(d))
    speed = np.hypot(u, v)
    dirr = np.where(speed < 1e-6, 0.0, np.degrees(np.arctan2(-u, -v)) % 360.0)
    return speed, dirr


def polar_kn(twa, tws):
    """Bilinear TWA x TWS on the raw table, performance factor 1.0 (polar.ts)."""
    a = np.clip(twa, P_TWA[0], P_TWA[-1])
    w = np.clip(tws, P_TWS[0], P_TWS[-1])
    i = np.clip(np.searchsorted(P_TWA, a, side="left"), 1, P_TWA.size - 1)
    j = np.clip(np.searchsorted(P_TWS, w, side="left"), 1, P_TWS.size - 1)
    fa = (a - P_TWA[i - 1]) / (P_TWA[i] - P_TWA[i - 1])
    fw = (w - P_TWS[j - 1]) / (P_TWS[j] - P_TWS[j - 1])
    lo = P_SPD[i - 1, j - 1] + fw * (P_SPD[i - 1, j] - P_SPD[i - 1, j - 1])
    hi = P_SPD[i, j - 1] + fw * (P_SPD[i, j] - P_SPD[i, j - 1])
    return lo + fa * (hi - lo)


grid = load_grid(variant)
water_cells = []
for (la, lo), (cla, clo, elev) in grid["cell"].items():
    land, oob = is_land(np.array([cla]), np.array([clo]))
    water_cells.append((cla, clo, bool(~land[0] & ~oob[0])))
WC = np.array([(a, b) for a, b, w in water_cells if w]) if any(w for *_, w in water_cells) else np.zeros((0, 2))

cols = {}
acct = []
for trip_i, path in enumerate(sorted(glob.glob(f"{npz_dir}/track*.npz"))):
    d = np.load(path)
    lat, lon, t = d["lat"], d["lon"], d["t"]
    n = lat.size
    # 30 s centred window SOG/COG (time-based)
    lo_idx = np.clip(np.searchsorted(t, t - HALF_WIN, side="left"), 0, n - 1)
    hi_idx = np.clip(np.searchsorted(t, t + HALF_WIN, side="right") - 1, 0, n - 1)
    e, nn = enu(lat[lo_idx], lon[lo_idx], lat[hi_idx], lon[hi_idx])
    span = t[hi_idx] - t[lo_idx]
    valid_win = span >= 0.8 * 2 * HALF_WIN  # >= 24 s; jitter puts ~3 % of full windows at 27.98 s
    sog = np.where(span > 0, np.hypot(e, nn) / np.maximum(span, 1e-9) * 3600 / NM, 0.0)
    cog = np.degrees(np.arctan2(e, nn)) % 360.0

    # rule 1: harbours, start/end
    dh = np.min(gc_nm(lat[:, None], lon[:, None], H_LAT[None, :], H_LON[None, :]), axis=1)
    d_start = gc_nm(lat, lon, lat[0], lon[0])
    d_end = gc_nm(lat, lon, lat[-1], lon[-1])
    r1 = (dh < HARBOUR_NM) | (d_start < END_NM) | (d_end < END_NM)

    # rule 2: turns (COG before vs after over 30 s windows, both moving)
    b_idx = np.clip(np.searchsorted(t, t - 2 * HALF_WIN, side="left"), 0, n - 1)
    a_idx = np.clip(np.searchsorted(t, t + 2 * HALF_WIN, side="right") - 1, 0, n - 1)
    eb, nb = enu(lat[b_idx], lon[b_idx], lat, lon)
    ea, na = enu(lat, lon, lat[a_idx], lon[a_idx])
    moving = (np.hypot(eb, nb) >= TURN_MIN_DISP_M) & (np.hypot(ea, na) >= TURN_MIN_DISP_M)
    turn_ev = moving & (np.abs(angdiff(np.degrees(np.arctan2(ea, na)), np.degrees(np.arctan2(eb, nb)))) > TURN_DEG)
    r2 = np.zeros(n, bool)
    ev_t = t[turn_ev]
    if ev_t.size:
        k = np.searchsorted(ev_t, t)
        near_prev = np.abs(t - ev_t[np.clip(k - 1, 0, ev_t.size - 1)]) <= TURN_WIN_S
        near_next = np.abs(t - ev_t[np.clip(k, 0, ev_t.size - 1)]) <= TURN_WIN_S
        r2 = near_prev | near_next

    # rule 3: waiting / drifting
    r3 = np.zeros(n, bool)
    for s, e_ in runs(sog < WAIT_KN):
        if t[e_ - 1] - t[s] >= WAIT_S:
            r3[s:e_] = True

    tws, twd = sample_wind(grid, lat, lon, t)
    assert np.isfinite(tws).all(), "missing wind at a read point-hour (§6.2 drops such a trip)"
    twa = np.abs(angdiff(cog, twd))
    pol_kn = polar_kn(twa, tws)
    ratio = np.where(pol_kn > 0, sog / pol_kn, np.nan)

    # rule 4 (sample-level parts): sustained pinching, light-air motoring
    r4 = np.zeros(n, bool)
    for s, e_ in runs(twa < CLOSE_TWA):
        if t[e_ - 1] - t[s] >= CLOSE_S:
            r4[s:e_] = True
    r4 |= (tws < LOWTWS_KN) & (sog > LOWTWS_SOG)
    # rule 5: polar domain
    r5 = (twa < TWA_MIN) | (tws < TWS_MIN) | (tws > TWS_MAX) | ~valid_win

    keep = ~(r1 | r2 | r3 | r4 | r5)
    # legs: maximal runs of kept samples (gap <= 2 s), >= 180 s
    leg = np.full(n, -1)
    r4_leg = np.zeros(n, bool)
    short_leg = np.zeros(n, bool)
    leg_no = 0
    gap_break = np.concatenate([[True], np.diff(t) > 2.0])
    seg_flag = keep.copy()
    for s, e_ in runs(seg_flag):
        # split on time gaps inside the run
        cuts = [s] + [k for k in range(s + 1, e_) if gap_break[k]] + [e_]
        for a_, b_ in zip(cuts[:-1], cuts[1:]):
            if t[b_ - 1] - t[a_] < LEG_MIN_S:
                short_leg[a_:b_] = True
                continue
            if np.nanmedian(ratio[a_:b_]) > LEG_R_MAX:
                r4_leg[a_:b_] = True
                continue
            leg[a_:b_] = leg_no
            leg_no += 1
    kept = leg >= 0

    # accounting: sequential in §0.3 order, plus standalone shares
    seq = []
    rem = np.ones(n, bool)
    for name, f in (
        ("1 harbour/start/end", r1),
        ("2 turn window", r2),
        ("3 waiting/drifting", r3),
        ("4 motoring (pinch, light air)", r4),
        ("5 polar domain / window", r5),
        ("leg < 180 s", short_leg),
        ("4 motoring (leg median R)", r4_leg),
    ):
        removed = rem & f
        seq.append((name, int(removed.sum()), int(f.sum())))
        rem &= ~f
    acct.append(dict(trip=trip_i, n=int(n), kept=int(kept.sum()), legs=int(leg_no), rules=seq))

    idx = np.where(kept)[0]
    la_k, lo_k = lat[idx], lon[idx]
    up, up_edge = ray_fetch_nm(la_k, lo_k, twd[idx])
    down, down_edge = ray_fetch_nm(la_k, lo_k, (twd[idx] + 180) % 360)
    p90, p90_edge = ray_fetch_nm(la_k, lo_k, (twd[idx] + 90) % 360)
    m90, m90_edge = ray_fetch_nm(la_k, lo_k, (twd[idx] - 90) % 360)
    omni = np.full(idx.size, 10.0)
    for brg in range(0, 360, 10):
        f_, _ = ray_fetch_nm(la_k, lo_k, np.full(idx.size, float(brg)), max_nm=2.0)
        omni = np.minimum(omni, f_)
    own_land, _ = is_land(la_k, lo_k)
    if WC.shape[0]:
        dgrid = np.min(gc_nm(la_k[:, None], lo_k[:, None], WC[None, :, 0], WC[None, :, 1]), axis=1)
    else:
        dgrid = np.full(idx.size, np.nan)

    rows = dict(
        trip=np.full(idx.size, trip_i),
        leg=leg[idx] + trip_i * 10000,
        t=t[idx],
        lat=la_k,
        lon=lo_k,
        sog=sog[idx],
        cog=cog[idx],
        tws=tws[idx],
        twd=twd[idx],
        twa=twa[idx],
        polar=pol_kn[idx],
        ratio=ratio[idx],
        fetch_up=up,
        fetch_up_edge=up_edge,
        fetch_down=down,
        fetch_down_edge=down_edge,
        fetch_p90_edge=p90_edge,
        fetch_m90_edge=m90_edge,
        fetch_p90=p90,
        fetch_m90=m90,
        omni=omni,
        own_land=own_land,
        dgrid_water=dgrid,
    )
    for k, v in rows.items():
        cols.setdefault(k, []).append(v)

np.savez(out_path, **{k: np.concatenate(v) for k, v in cols.items()})
with open(out_path.replace(".npz", ".acct.json"), "w") as acct_f:
    json.dump(
        dict(variant=variant, strict=STRICT, sail=SAIL, leg_r_max=LEG_R_MAX, accounting=acct, water_grid_cells=int(WC.shape[0]), grid_points=len(water_cells)),
        acct_f,
        indent=1,
    )
print(json.dumps(acct, indent=1))
