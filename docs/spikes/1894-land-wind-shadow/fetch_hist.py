"""#1894 §6.2: per-trip icon_seamless wind from Open-Meteo's Historical Forecast API.
Same hourly variables, units, lattice and omitted cell_selection as fetch_wind.py's full_app;
start_date..end_date = the trip's UTC day and the next one. One cache dir per trip.
Usage: python3 -I fetch_hist.py <manifest_json> <out_root> <track_npz>...
"""
import datetime as dt, json, os, sys, time, subprocess, urllib.parse
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from d_points import d_points

API = "https://historical-forecast-api.open-meteo.com/v1/forecast"
man_path, out_root, tracks = sys.argv[1], sys.argv[2], sys.argv[3:]
full = {"full_app": json.load(open(man_path))["full_app"]}
assert full["full_app"]["model"] == "icon_seamless" and full["full_app"]["cell_selection"] is None


def url_for(points, d0, d1):
    p = {"latitude": ",".join(str(a) for a, _ in points), "longitude": ",".join(str(b) for _, b in points),
         "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m", "wind_speed_unit": "kn",
         "timeformat": "unixtime", "timezone": "UTC", "start_date": d0, "end_date": d1, "models": "icon_seamless"}
    return f"{API}?{urllib.parse.urlencode(p)}"


def get(url):
    for attempt in range(15):
        r = subprocess.run(["curl", "-sS", "-m", "90", "-w", "\n%{http_code}", url], capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if r.returncode == 0 and code == "200":
            return json.loads(body)
        print(f"  attempt {attempt}: rc={r.returncode} code={code} {body[:160]!r}", flush=True)
        if "API request limit" in body:
            print("QUOTA: stopping", flush=True)
            sys.exit(3)
        time.sleep(min(90, 20 * (attempt + 1)))
    raise RuntimeError("fetch failed")


for trk in tracks:
    name = os.path.basename(trk)[:-4]
    out = f"{out_root}/{name}"
    os.makedirs(out, exist_ok=True)
    tmp = f"{out}/.man.json"
    json.dump(full, open(tmp, "w"))
    pts = d_points(tmp, trk)["full_app"]
    os.remove(tmp)
    t = np.load(trk)["t"]
    day = dt.datetime.fromtimestamp(float(t.min()), dt.timezone.utc).date()
    assert dt.datetime.fromtimestamp(float(t.max()), dt.timezone.utc).date() == day
    d0, d1 = day.isoformat(), (day + dt.timedelta(days=1)).isoformat()
    print(f"{name}: {len(pts)} points", flush=True)
    for c in range(0, len(pts), 8):
        path = f"{out}/full_app_{c // 8:03d}.json"
        if os.path.exists(path):
            continue
        chunk = pts[c:c + 8]
        url = url_for(chunk, d0, d1)
        data = get(url)
        data = data if isinstance(data, list) else [data]
        json.dump({"url": url, "points": chunk, "data": data}, open(path, "w"))
        print(f"{name} {c // 8} ok", flush=True)
        time.sleep(8)
    json.dump({"full_app": dict(full["full_app"], source="historical-forecast-api")}, open(f"{out}/MANIFEST.json", "w"))
print("DONE", flush=True)
