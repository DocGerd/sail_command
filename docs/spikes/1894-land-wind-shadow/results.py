"""#1894 Phase 3, stage 2: aggregate per §0.4-§0.6 of the spike.

Usage: python3 -I results.py <samples.npz> <out.json>
"""
import json
import sys

import numpy as np

src, out = sys.argv[1], sys.argv[2]
S = dict(np.load(src))
EDGES = np.array([0, 0.25, 0.5, 1, 2, 4, np.inf])
NAMES = list("ABCDEF")
SHORT, OPEN = {"A", "B"}, {"E", "F"}
MIN_N = 60
B = 2000
SEED = 1894
TWA_BANDS = [(45, 80), (80, 120), (120, 180.0001)]
TWS_BANDS = [(4, 8), (8, 14), (14, 25.0001)]


def bin_of(f):
    return np.array(NAMES)[np.clip(np.searchsorted(EDGES, f, side="right") - 1, 0, 5)]


def leg_bin_values(mask, fetch, extra=None):
    """One value per (leg, fetch bin): median ratio, kept if >= MIN_N samples."""
    rows = []
    b = bin_of(fetch)
    legs = S["leg"]
    for leg in np.unique(legs[mask]):
        m_leg = mask & (legs == leg)
        for nb in NAMES:
            m = m_leg & (b == nb)
            if m.sum() >= MIN_N:
                rows.append(
                    dict(
                        trip=int(S["trip"][m][0]),
                        leg=int(leg),
                        bin=nb,
                        n=int(m.sum()),
                        r=float(np.median(S["ratio"][m])),
                        twa=float(np.mean(S["twa"][m])),
                        tws=float(np.mean(S["tws"][m])),
                    )
                )
    return rows


def delta(rows, trips=None):
    if trips is not None:
        rows = [r for t in trips for r in rows if r["trip"] == t]
    o = [r["r"] for r in rows if r["bin"] in OPEN]
    s = [r["r"] for r in rows if r["bin"] in SHORT]
    if not o or not s:
        return np.nan
    return float(np.mean(o) - np.mean(s))


def boot(rows, fn, with_undefined=False):
    """Trip-level percentile interval; draws where fn is undefined are dropped and counted."""
    trips = sorted({r["trip"] for r in rows})
    if not trips:
        return ([np.nan, np.nan], B) if with_undefined else [np.nan, np.nan]
    rng = np.random.default_rng(SEED)
    vals = []
    for _ in range(B):
        draw = rng.choice(trips, size=len(trips), replace=True)
        vals.append(fn([r for t in draw for r in rows if r["trip"] == t]))
    vals = np.array(vals, float)
    undefined = int((~np.isfinite(vals)).sum())
    vals = vals[np.isfinite(vals)]
    ci = [np.nan, np.nan] if vals.size == 0 else [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))]
    return (ci, undefined) if with_undefined else ci


def contrast(rows):
    trips = sorted({r["trip"] for r in rows})
    both = [t for t in trips if any(r["trip"] == t and r["bin"] in OPEN for r in rows)
            and any(r["trip"] == t and r["bin"] in SHORT for r in rows)]
    per_trip = {t: delta(rows, [t]) for t in trips}
    ci, undefined = boot(rows, delta, with_undefined=True)
    return dict(
        delta=delta(rows),
        ci95=ci,
        bootstrap_undefined_draws=undefined,
        trips_with_both=len(both),
        per_trip_delta={str(k): v for k, v in per_trip.items()},
        n_short=sum(r["bin"] in SHORT for r in rows),
        n_open=sum(r["bin"] in OPEN for r in rows),
    )


def curve(rows):
    out = {}
    for nb in NAMES:
        rr = [r for r in rows if r["bin"] == nb]
        if not rr:
            out[nb] = dict(legs=0, trips=0)
            continue
        twa = np.array([r["twa"] for r in rr])
        tws = np.array([r["tws"] for r in rr])
        out[nb] = dict(
            mean_r=float(np.mean([r["r"] for r in rr])),
            ci95=boot(rr, lambda x: float(np.mean([r["r"] for r in x])) if x else np.nan),
            legs=len(rr),
            trips=len({r["trip"] for r in rr}),
            samples=int(sum(r["n"] for r in rr)),
            twa_mix=[float(np.mean((twa >= a) & (twa < b))) for a, b in TWA_BANDS],
            tws_mix=[float(np.mean((tws >= a) & (tws < b))) for a, b in TWS_BANDS],
            mean_twa=float(np.mean(twa)),
            mean_tws=float(np.mean(tws)),
        )
    return out


ALL = np.ones(S["ratio"].size, bool)
res = {"samples_kept": int(ALL.sum()), "trips": int(np.unique(S["trip"]).size), "legs": int(np.unique(S["leg"]).size)}
res["own_cell_land_share"] = float(np.mean(S["own_land"]))
res["fetch_up_edge_share"] = float(np.mean(S["fetch_up_edge"]))
res["overall_median_r"] = float(np.median(S["ratio"]))
res["dgrid_water_nm"] = [float(np.percentile(S["dgrid_water"], p)) for p in (10, 50, 90)]

up = leg_bin_values(ALL, S["fetch_up"])
res["primary"] = dict(contrast=contrast(up), curve=curve(up))
res["resolvable"] = res["primary"]["contrast"]["trips_with_both"] >= 5

res["placebo"] = {
    name: dict(contrast=contrast(leg_bin_values(ALL, S[key])), curve=curve(leg_bin_values(ALL, S[key])))
    for name, key in (("downwind", "fetch_down"), ("plus90", "fetch_p90"), ("minus90", "fetch_m90"))
}

# (b) within strata of omnidirectional distance to land: lee (upwind < 0.5 nm)
# vs windward shore (downwind < 0.5 nm, upwind >= 0.5 nm)
strata = {}
for lo, hi in ((0, 0.25), (0.25, 0.5), (0.5, 1.0), (1.0, np.inf)):
    m = (S["omni"] >= lo) & (S["omni"] < hi)
    lee = m & (S["fetch_up"] < 0.5)
    wws = m & (S["fetch_down"] < 0.5) & (S["fetch_up"] >= 0.5)
    vals = {}
    for nm_, mm in (("lee", lee), ("windward_shore", wws)):
        rr = []
        for leg in np.unique(S["leg"][mm]):
            k = mm & (S["leg"] == leg)
            if k.sum() >= MIN_N:
                rr.append(dict(trip=int(S["trip"][k][0]), r=float(np.median(S["ratio"][k]))))
        vals[nm_] = dict(
            legs=len(rr),
            trips=len({r["trip"] for r in rr}),
            mean_r=float(np.mean([r["r"] for r in rr])) if rr else None,
        )
    strata[f"{lo}-{hi}"] = vals
res["strata_omni"] = strata

bands = {}
for lab, key, bb in (("twa", "twa", TWA_BANDS), ("tws", "tws", TWS_BANDS)):
    for a, b in bb:
        m = (S[key] >= a) & (S[key] < b)
        rows = leg_bin_values(m, S["fetch_up"])
        bands[f"{lab}_{a}-{round(b)}"] = dict(contrast=contrast(rows), curve=curve(rows))
res["bands"] = bands

# §0.6 polar check: open-water legs, per table cell
from pathlib import Path

pol = json.load(open(Path(__file__).resolve().parents[3] / "app/public/data/polars/salona-44-easy-go-fock.json"))
P_TWA, P_TWS = np.array(pol["twa"], float), np.array(pol["tws"], float)
ow = S["fetch_up"] >= 2.0
ci = np.searchsorted(P_TWA, S["twa"], side="right") - 1
cj = np.clip(np.searchsorted(P_TWS, S["tws"], side="right") - 1, 0, P_TWS.size - 2)
cells = []
for leg in np.unique(S["leg"][ow]):
    k_leg = ow & (S["leg"] == leg)
    for i in np.unique(ci[k_leg]):
        for j in np.unique(cj[k_leg & (ci == i)]):
            k = k_leg & (ci == i) & (cj == j)
            if k.sum() >= MIN_N:
                cells.append(dict(trip=int(S["trip"][k][0]), i=int(i), j=int(j), r=float(np.median(S["ratio"][k]))))
overall = float(np.median([c["r"] for c in cells])) if cells else float("nan")
trip_med = {t: float(np.median([c["r"] for c in cells if c["trip"] == t])) for t in {c["trip"] for c in cells}}
ptab = {}
for i, j in sorted({(c["i"], c["j"]) for c in cells}):
    cc = [c for c in cells if c["i"] == i and c["j"] == j]
    trips = sorted({c["trip"] for c in cc})
    per_trip_shape = {
        str(t): float(np.median([c["r"] for c in cc if c["trip"] == t]) / trip_med[t]) for t in trips
    }
    ptab[f"TWA {P_TWA[i]:g}-{P_TWA[i + 1]:g} / TWS {P_TWS[j]:g}-{P_TWS[j + 1]:g}"] = dict(
        legs=len(cc),
        trips=len(trips),
        level=float(np.median([c["r"] for c in cc])),
        shape=float(np.median([c["r"] for c in cc]) / overall),
        per_trip_shape=per_trip_shape,
        insufficient=len(trips) < 3,
        flag_shape=sum(abs(v - 1) > 0.15 for v in per_trip_shape.values()) >= 3
        and (all(v > 1.15 for v in per_trip_shape.values()) or all(v < 0.85 for v in per_trip_shape.values())),
    )
res["polar_check"] = dict(open_water_overall_level=overall, per_trip_level={str(k): v for k, v in trip_med.items()}, cells=ptab)

def clean(x):
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, (float, np.floating)):
        return float(x) if np.isfinite(x) else None
    if isinstance(x, (np.integer,)):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    return x


json.dump(clean(res), open(out, "w"), indent=1, allow_nan=False)
p = res["primary"]["contrast"]
print(f"kept={res['samples_kept']} legs={res['legs']} trips={res['trips']} resolvable={res['resolvable']}")
print(f"PRIMARY delta={p['delta']} ci={p['ci95']} trips_with_both={p['trips_with_both']} per_trip={p['per_trip_delta']}")
for k, v in res["placebo"].items():
    print(f"placebo {k}: delta={v['contrast']['delta']} ci={v['contrast']['ci95']}")
for nb, c in res["primary"]["curve"].items():
    print(nb, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in c.items() if k in ('mean_r', 'legs', 'trips', 'samples', 'mean_tws', 'mean_twa')})
