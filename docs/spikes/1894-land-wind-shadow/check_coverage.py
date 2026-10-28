"""#1894 §6.2 drop rule: a trip is dropped if any lattice point-hour read with non-zero trilinear weight
at any of its fixes (before §0.3's exclusions) lacks wind speed or direction, or if any fix lies outside
the returned hours. Usage: python3 -I check_coverage.py <wind_dir> <track_npz>   (prints one JSON line)"""
import glob
import json
import sys

import numpy as np


def load_valid(wd):
    man = json.load(open(f"{wd}/MANIFEST.json"))["full_app"]
    val, times = {}, None
    for p in sorted(glob.glob(f"{wd}/full_app_[0-9][0-9][0-9].json")):
        ch = json.load(open(p))
        for (la, lo), loc in zip(ch["points"], ch["data"]):
            h = loc["hourly"]
            t = np.array(h["time"], float)
            times = t if times is None else times
            assert np.array_equal(t, times)
            val[(la, lo)] = np.array([a is not None and b is not None
                                      for a, b in zip(h["wind_speed_10m"], h["wind_direction_10m"])])
    return np.array(man["lats"]), np.array(man["lons"]), times, val


def bracket(xs, x):
    i = np.clip(np.searchsorted(xs, x, side="right") - 1, 0, xs.size - 2)
    f = (x - xs[i]) / (xs[i + 1] - xs[i])
    f = np.where(x <= xs[0], 0.0, np.where(x >= xs[-1], 1.0, f))
    return np.where(x <= xs[0], 0, i), f


def read_point_hours(wd, trk):
    """(lat, lon, unix hour) read with non-zero weight by samples.py's sample_wind, plus coverage facts."""
    lats, lons, times, val = load_valid(wd)
    z = np.load(trk)
    la, lo, tt = z["lat"], z["lon"], z["t"]
    ia, fa = bracket(lats, la)
    io, fo = bracket(lons, lo)
    it, ft = bracket(times, tt)
    need = set()
    for dt_, wt in ((0, 1 - ft), (1, ft)):
        for da, wa in ((0, 1 - fa), (1, fa)):
            for do, wo in ((0, 1 - fo), (1, fo)):
                k = wt * wa * wo > 0
                need |= set(zip(lats[ia[k] + da].tolist(), lons[io[k] + do].tolist(), times[it[k] + dt_].astype(int).tolist()))
    hour = {int(t): i for i, t in enumerate(times)}
    missing = [x for x in need if (x[0], x[1]) not in val or not val[(x[0], x[1])][hour[x[2]]]]
    outside = int(np.sum((tt < times[0]) | (tt > times[-1])))
    return need, dict(point_hours_read=len(need), missing=len(missing), fixes_outside_hours=outside,
                      drop=bool(missing or outside))


if __name__ == "__main__":
    print(json.dumps(read_point_hours(sys.argv[1], sys.argv[2])[1]))
