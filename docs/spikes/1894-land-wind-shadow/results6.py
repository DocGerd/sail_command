"""#1894 §6.3: decision figures for one table run of the pooled rerun (primary + strict sets).

Usage: python3 -I results6.py <samples_app.npz> <samples_app_strict.npz> <rays_app.npz> <rays_strict.npz>
                              <trips.json> <out.json>
trips.json maps trip index (string) to {"sail": table used for its R, "cohort": "2026"|"2025", "ym": "YYYY-MM"}.
decide.py combines the genoa-table and fock-table runs. Statuses: "met", "not met", "not evaluable".
"""
import json
import sys
from pathlib import Path

import numpy as np

s_app, s_str, r_app, r_str, trips_path, out = sys.argv[1:7]
TRIPS = {int(k): v for k, v in json.load(open(trips_path)).items()}
REPO = Path(__file__).resolve().parents[3]
EDGES = np.array([0, 0.25, 0.5, 1, 2, 4, np.inf])
NAMES = list("ABCDEF")
SHORT, OPEN = {"A", "B"}, {"E", "F"}
MIN_N, B, SEED, BLK, FLOOR, LEG_R_MAX = 60, 2000, 1894, 120, 5, 1.2


def bin_of(f):
    return np.array(NAMES)[np.clip(np.searchsorted(EDGES, f, side="right") - 1, 0, 5)]


def legbins(S, mask, fetch):
    b = bin_of(fetch)
    rows = []
    for lg in np.unique(S["leg"][mask]):
        ml = mask & (S["leg"] == lg)
        for nb in NAMES:
            m = ml & (b == nb)
            if m.sum() >= MIN_N:
                rows.append(dict(trip=int(S["trip"][m][0]), leg=int(lg), bin=nb, r=float(np.median(S["ratio"][m])),
                                 n=int(m.sum())))
    return rows


def delta(rows):
    o = [r["r"] for r in rows if r["bin"] in OPEN]
    s = [r["r"] for r in rows if r["bin"] in SHORT]
    return float(np.mean(o) - np.mean(s)) if o and s else np.nan


def interval(units, fn):
    """§6.4: percentile bootstrap over the sorted pool, default_rng(1894) afresh, undefined draws dropped."""
    units = sorted(units)
    if not units:
        return [np.nan, np.nan], B
    rng = np.random.default_rng(SEED)
    vals = np.array([fn(rng.choice(units, size=len(units), replace=True)) for _ in range(B)], float)
    und = int((~np.isfinite(vals)).sum())
    vals = vals[np.isfinite(vals)]
    return ([float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))] if vals.size else [np.nan, np.nan]), und


def contrast(rows):
    by_trip = {}
    for r in rows:
        by_trip.setdefault(r["trip"], []).append(r)
    per = {t: delta(rr) for t, rr in by_trip.items()}
    ci, und = interval(by_trip, lambda draw: delta([r for t in draw for r in by_trip[t]]))
    both = sum(np.isfinite(v) for v in per.values())
    d = delta(rows)
    return dict(delta=d, ci95=ci, bootstrap_undefined_draws=und, trips_with_both=int(both),
                evaluable=bool(np.isfinite(d) and both >= FLOOR),
                per_trip_delta={str(k): v for k, v in sorted(per.items())},
                legs_short=len({r["leg"] for r in rows if r["bin"] in SHORT}),
                legs_open=len({r["leg"] for r in rows if r["bin"] in OPEN}))


def leave_one_leg_out(rows):
    legs = sorted({r["leg"] for r in rows if r["bin"] in SHORT | OPEN})
    vals = [delta([r for r in rows if r["leg"] != lg]) for lg in legs]
    fin = [v for v in vals if np.isfinite(v)]
    # §6.3 rule 2: a drop that leaves Δ undefined fails
    return dict(legs=len(legs), undefined=len(vals) - len(fin), min_defined=min(fin) if fin else np.nan,
                status="met" if vals and len(fin) == len(vals) and min(fin) >= 0.10 else "not met")


def curve(rows):
    o = {}
    for nb in NAMES:
        by_trip = {}
        for r in rows:
            if r["bin"] == nb:
                by_trip.setdefault(r["trip"], []).append(r["r"])
        ci, _ = interval(by_trip, lambda draw: float(np.mean([x for t in draw for x in by_trip[t]])))
        vals = [x for v in by_trip.values() for x in v]
        o[nb] = dict(legs=len(vals), trips=len(by_trip), mean_r=float(np.mean(vals)) if vals else np.nan, ci95=ci,
                     half_width=(ci[1] - ci[0]) / 2 if vals else np.nan)
    return o


def demean(x, g):
    o = x.astype(float).copy()
    for k in np.unique(g):
        o[g == k] -= o[g == k].mean()
    return o


def design(C):
    return np.column_stack([demean(C[:, c], C[:, 1]) for c in (3, 4)])


def fit(C):
    X = design(C)
    if np.linalg.matrix_rank(X) < 2:  # §6.4: not identified -> undefined
        return np.array([np.nan, np.nan])
    return np.linalg.lstsq(X, demean(C[:, 2], C[:, 1]), rcond=None)[0]


def within_legs(S, width):
    """§6.4 regression; §6.3 rule 5."""
    rows = []
    for lg in np.unique(S["leg"]):
        idx = np.where(S["leg"] == lg)[0]
        for s in range(0, idx.size - BLK + 1, BLK):
            m = idx[s:s + BLK]
            if np.median(width[m]) >= 1.0:
                rows.append([S["trip"][m][0], lg, np.median(S["ratio"][m]),
                             float(np.median(S["fetch_up"][m]) < 0.5), float(np.median(S["fetch_down"][m]) < 0.5)])
    C = np.array(rows, float).reshape(-1, 5)
    L = np.unique(C[:, 1])
    vary = [int(sum(0 < C[C[:, 1] == lg, c].mean() < 1 for lg in L)) for c in (3, 4)]
    info = dict(blocks=int(C.shape[0]), legs=int(L.size), trips=int(np.unique(C[:, 0]).size),
                blocks_up=int(C[:, 3].sum()), blocks_down=int(C[:, 4].sum()), legs_varying_up=vary[0], legs_varying_down=vary[1])
    if min(vary) < 5:
        return dict(info, status="not met", reason="fewer than five legs vary in an indicator")
    beta = fit(C)
    if not np.all(np.isfinite(beta)):
        return dict(info, status="not met", reason="indicators have rank below two")
    groups = {lg: C[C[:, 1] == lg] for lg in L}

    def one(draw):
        parts = []
        for i, lg in enumerate(draw):
            p = groups[lg].copy()
            p[:, 1] = i  # a leg drawn twice counts as two legs
            parts.append(p)
        return fit(np.vstack(parts))

    rng = np.random.default_rng(SEED)
    bs = np.array([one(rng.choice(sorted(L), size=L.size, replace=True)) for _ in range(B)])
    ok = np.all(np.isfinite(bs), axis=1)
    bs = bs[ok]
    if not bs.size:
        return dict(info, status="not met", reason="every draw undefined", bootstrap_undefined_draws=int((~ok).sum()))
    ci_up = [float(np.percentile(bs[:, 0], q)) for q in (2.5, 97.5)]
    ci_dn = [float(np.percentile(bs[:, 1], q)) for q in (2.5, 97.5)]
    met = beta[0] < beta[1] and ci_up[1] < ci_dn[0] and ci_up[1] < 0
    return dict(info, b_up=float(beta[0]), ci_up=ci_up, b_down=float(beta[1]), ci_down=ci_dn,
                bootstrap_undefined_draws=int((~ok).sum()), status="met" if met else "not met")


def between_legs(S):
    """§6.3 rule 6, §1.4 classes at omnidirectional distance < 0.25 nm."""
    near = S["omni"] < 0.25
    up_cls = near & (S["fetch_up"] < 0.5)
    dn_cls = near & (S["fetch_down"] < 0.5) & (S["fetch_up"] >= 0.5)
    vals = {"up": {}, "down": {}}
    for k, mk in (("up", up_cls), ("down", dn_cls)):
        for lg in np.unique(S["leg"][mk]):
            m = mk & (S["leg"] == lg)
            if m.sum() >= MIN_N:
                vals[k].setdefault(int(S["trip"][m][0]), []).append(float(np.median(S["ratio"][m])))
    per = {t: float(np.mean(vals["up"][t]) - np.mean(vals["down"][t])) for t in sorted(set(vals["up"]) & set(vals["down"]))}
    met = len(per) >= 3 and all(v < 0 for v in per.values())
    return dict(legs_up=sum(len(v) for v in vals["up"].values()), legs_down=sum(len(v) for v in vals["down"].values()),
                per_trip={str(k): v for k, v in per.items()}, trips_both=len(per), status="met" if met else "not met")


def evaluate(S, rays, trips=None):
    F = rays["F"].astype(float)
    E = rays["edge_any"]
    if trips is not None:
        k = np.isin(S["trip"], list(trips))
        S = {c: v[k] for c, v in S.items()}
        F, E = F[k], E[k]
    half = F.shape[1] // 2
    width = np.min(F[:, :half] + F[:, half:], axis=1)
    allm = np.ones(S["ratio"].size, bool)
    up_rows = legbins(S, allm, S["fetch_up"])
    prim = contrast(up_rows)
    d = prim["delta"]
    pl = {"downwind": contrast(legbins(S, allm, S["fetch_down"])),
          "plus90": contrast(legbins(S, allm, S["fetch_p90"])),
          "minus90_up_ge_0.5": contrast(legbins(S, S["fetch_up"] >= 0.5, S["fetch_m90"]))}
    for c in pl.values():
        if not c["evaluable"]:
            c["status"] = "not evaluable"
        else:
            below = np.isfinite(d) and c["delta"] < d / 2
            inc0 = np.isfinite(c["ci95"][0]) and c["ci95"][0] <= 0 <= c["ci95"][1]
            c["status"] = "met" if (below or inc0) else "not met"
    if not prim["evaluable"]:
        rule1 = "not evaluable"
    else:
        rule1 = "met" if (d >= 0.10 and np.isfinite(prim["ci95"][0]) and prim["ci95"][0] > 0) else "not met"
    cohorts = {}
    for coh in sorted({TRIPS[t]["cohort"] for t in np.unique(S["trip"]).tolist()}):
        tr = [t for t in np.unique(S["trip"]).tolist() if TRIPS[t]["cohort"] == coh]
        dc = delta([r for r in up_rows if r["trip"] in tr])
        cohorts[coh] = dict(trips=tr, delta=dc)
    rule3 = "met" if len(cohorts) == 2 and all(np.isfinite(v["delta"]) and v["delta"] > 0 for v in cohorts.values()) else "not met"
    edges = {k: float(np.mean(S[f"fetch_{k}_edge"])) if S["ratio"].size else np.nan for k in ("up", "down", "p90", "m90")}
    edges["rays_2nm_any"] = float(np.mean(E)) if E.size else np.nan
    return dict(samples=int(S["ratio"].size), legs=int(np.unique(S["leg"]).size), trips=int(np.unique(S["trip"]).size),
                primary=prim, resolvable=bool(prim["trips_with_both"] >= FLOOR),
                rule1=rule1, leave_one_leg_out=leave_one_leg_out(up_rows), cohort_delta=cohorts, rule3=rule3,
                placebo=pl, within_legs=within_legs(S, width), between_legs=between_legs(S), curve=curve(up_rows),
                ray_edge_share=edges)


def polar_check(S):
    """§6.1 data assertion: every fix's stored table speed is its own trip's table, and the 1.2 cap held."""
    for t in np.unique(S["trip"]).tolist():
        pol = json.load(open(REPO / f"app/public/data/polars/salona-44-easy-go-{TRIPS[t]['sail']}.json"))
        P_TWA, P_TWS, P = np.array(pol["twa"], float), np.array(pol["tws"], float), np.array(pol["speeds"], float)
        k = S["trip"] == t
        a = np.clip(S["twa"][k], P_TWA[0], P_TWA[-1])
        w = np.clip(S["tws"][k], P_TWS[0], P_TWS[-1])
        i = np.clip(np.searchsorted(P_TWA, a, side="left"), 1, P_TWA.size - 1)
        j = np.clip(np.searchsorted(P_TWS, w, side="left"), 1, P_TWS.size - 1)
        fa = (a - P_TWA[i - 1]) / (P_TWA[i] - P_TWA[i - 1])
        fw = (w - P_TWS[j - 1]) / (P_TWS[j] - P_TWS[j - 1])
        lo = P[i - 1, j - 1] + fw * (P[i - 1, j] - P[i - 1, j - 1])
        hi = P[i, j - 1] + fw * (P[i, j] - P[i, j - 1])
        assert np.allclose(S["polar"][k], lo + fa * (hi - lo), rtol=0, atol=1e-9), f"trip {t}: table is not {TRIPS[t]['sail']}"
    for lg in np.unique(S["leg"]):
        assert np.median(S["ratio"][S["leg"] == lg]) <= LEG_R_MAX + 1e-12, f"leg {lg}: median R above {LEG_R_MAX}"


SA, SS = dict(np.load(s_app)), dict(np.load(s_str))
RA, RS = dict(np.load(r_app)), dict(np.load(r_str))
assert RA["F"].shape[0] == SA["ratio"].size and RS["F"].shape[0] == SS["ratio"].size
polar_check(SA)
polar_check(SS)
res = {"trips": {str(k): v for k, v in TRIPS.items()}}
res["primary_set"] = evaluate(SA, RA)
res["strict_set"] = evaluate(SS, RS)
p, s = res["primary_set"], res["strict_set"]


def both(get):
    a, b = get(p), get(s)
    if "not evaluable" in (a, b) and "not met" not in (a, b):
        return "not evaluable"
    return "met" if a == b == "met" else "not met"


months = {v["ym"] for v in TRIPS.values()}  # trips.json lists the trips kept after §6.2
res["months"] = len(months)
res["resolvable"] = p["resolvable"]
res["option2_rules"] = {
    "1 delta and interval": both(lambda r: r["rule1"]),
    "2 leave one leg out": both(lambda r: r["leave_one_leg_out"]["status"]),
    "3 cohort deltas above 0": both(lambda r: r["rule3"]),
    "4 placebo per term": both(lambda r: ("not met" if any(v["status"] == "not met" for v in r["placebo"].values())
                                          else "not evaluable" if any(v["status"] == "not evaluable" for v in r["placebo"].values())
                                          else "met")),
    "5 within legs": both(lambda r: r["within_legs"]["status"]),
    "6 between legs": both(lambda r: r["between_legs"]["status"]),
    "7 more than one month": "met" if len(months) > 1 else "not met",
}
res["option2_this_run"] = bool(res["resolvable"] and all(v == "met" for v in res["option2_rules"].values()))
res["curve_bins_meeting_criterion"] = [nb for nb in NAMES if p["curve"][nb]["trips"] >= 5 and p["curve"][nb]["half_width"] <= 0.05]


def clean(x):
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, (float, np.floating)):
        return float(x) if np.isfinite(x) else None
    if isinstance(x, np.integer):
        return int(x)
    if isinstance(x, np.bool_):
        return bool(x)
    return x


json.dump(clean(res), open(out, "w"), indent=1, allow_nan=False)
print(json.dumps(dict(resolvable=res["resolvable"], option2_rules=res["option2_rules"], option2_this_run=res["option2_this_run"])))
