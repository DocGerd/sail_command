"""#1894 §6.2 report: Historical Forecast API vs the past_days cache at the 2026 trips' read point-hours.
Usage: python3 -I compare_sources.py <hist_root> <pastdays_dir> <track_npz>...   (aggregates only)"""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_coverage import read_point_hours  # noqa: E402

root, pd_dir, tracks = sys.argv[1], sys.argv[2], sys.argv[3:]


def load(paths):
    d = {}
    for p in paths:
        ch = json.load(open(p))
        for (la, lo), loc in zip(ch["points"], ch["data"]):
            h = loc["hourly"]
            for k, t in enumerate(h["time"]):
                d[(la, lo, int(t))] = (h["wind_speed_10m"][k], h["wind_direction_10m"][k])
    return d


old = load(sorted(glob.glob(f"{pd_dir}/full_app_[0-9][0-9][0-9].json")))
out = {}
for trk in tracks:
    name = os.path.basename(trk)[:-4]
    need, _ = read_point_hours(f"{root}/{name}", trk)
    new = load(sorted(glob.glob(f"{root}/{name}/full_app_[0-9][0-9][0-9].json")))
    common = [k for k in sorted(need) if k in new and k in old and None not in new[k] and None not in old[k]]
    a = np.array([new[k] for k in common], float).reshape(-1, 2)
    b = np.array([old[k] for k in common], float).reshape(-1, 2)
    dd = np.abs((a[:, 1] - b[:, 1] + 180) % 360 - 180)
    out[name] = dict(read_point_hours=len(need), compared=len(common),
                     both_exact=int(np.sum(np.all(a == b, axis=1))),
                     speed_max_abs_kn=float(np.max(np.abs(a[:, 0] - b[:, 0]))) if a.size else None,
                     speed_mean_abs_kn=float(np.mean(np.abs(a[:, 0] - b[:, 0]))) if a.size else None,
                     dir_max_abs_deg=float(np.max(dd)) if a.size else None,
                     dir_mean_abs_deg=float(np.mean(dd)) if a.size else None)
print(json.dumps(out, indent=1))
