"""#1894 §6: concatenate per-trip samples (each run alone, trip 0) into one file, trip k = argument order.
Usage: python3 -I merge_trips.py <out.npz> <trip0.npz> <trip1.npz> ..."""
import json, sys
import numpy as np
out, parts = sys.argv[1], sys.argv[2:]
cols, acct = {}, []
for k, p in enumerate(parts):
    z = dict(np.load(p))
    assert np.all(z["trip"] == 0) and np.all(z["leg"] < 10000)
    z["trip"] = np.full(z["trip"].size, k)
    z["leg"] = z["leg"] + k * 10000
    for c, v in z.items():
        cols.setdefault(c, []).append(v)
    a = json.load(open(p.replace(".npz", ".acct.json")))
    for t in a["accounting"]:
        t["trip"] = k
        t["sail"], t["leg_r_max"] = a.get("sail"), a.get("leg_r_max")
        t["source"] = p.rsplit("/", 2)[-2]
        acct.append(t)
np.savez(out, **{c: np.concatenate(v) for c, v in cols.items()})
json.dump(dict(accounting=acct, parts=parts), open(out.replace(".npz", ".acct.json"), "w"), indent=1)
print(out, sum(v.size for v in cols["trip"]))
