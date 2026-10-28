"""Split a multi-track Navionics GPX into per-day segments and validate each (intake only, no analysis).
Usage: python3 -I intake_multi.py <gpx> <out_dir> <existing_npz_dir>"""
import glob, json, sys
from pathlib import Path
from datetime import datetime, timezone
import numpy as np
from defusedxml import ElementTree as ET

G = "{http://www.topografix.com/GPX/1/1}"
gpx, out, old = sys.argv[1:4]
BB = dict(west=9.4, south=54.3, east=11.6, north=55.6)
root = ET.parse(gpx).getroot()
old_spans = []
for p in sorted(glob.glob(f"{old}/track*.npz")):
    z = np.load(p)
    t = z["t"] / (1000 if z["t"].max() > 1e11 else 1)
    old_spans.append((p.split("/")[-1], t.min(), t.max()))
rows, k = [], 0
for ti, trk in enumerate(root.iter(f"{G}trk")):
    name = (trk.find(f"{G}name").text if trk.find(f"{G}name") is not None else "")
    pts = []
    for p in trk.iter(f"{G}trkpt"):
        te = p.find(f"{G}time")
        s = h = np.nan
        ext = p.find(f"{G}extensions")
        if ext is not None:
            for c in ext:
                tag = c.tag.split("}")[-1]
                if tag == "navionics_speed": s = float(c.text)
                if tag == "navionics_haccuracy": h = float(c.text)
        pts.append((float(p.get("lat")), float(p.get("lon")),
                    datetime.fromisoformat(te.text.replace("Z", "+00:00")).timestamp() if te is not None else np.nan, s, h))
    a = np.array(pts, float)
    order = np.argsort(a[:, 2], kind="stable")
    a = a[order]
    day = np.array([datetime.fromtimestamp(x, timezone.utc).date().isoformat() for x in a[:, 2]])
    gap = np.r_[True, (np.diff(a[:, 2]) > 1800) | (day[1:] != day[:-1])]
    starts = np.where(gap)[0]
    for si, st in enumerate(starts):
        en = starts[si + 1] if si + 1 < len(starts) else len(a)
        seg = a[st:en]
        lat, lon, t = seg[:, 0], seg[:, 1], seg[:, 2]
        dt = np.diff(t)
        inb = ((lat >= BB["south"]) & (lat <= BB["north"]) & (lon >= BB["west"]) & (lon <= BB["east"])).mean()
        R = 6371008.8
        dlat = np.radians(np.diff(lat)); dlon = np.radians(np.diff(lon)) * np.cos(np.radians(lat[:-1]))
        nm = float(np.sum(R * np.hypot(dlat, dlon)) / 1852) if seg.shape[0] > 1 else 0.0
        ov = [n for n, a0, a1 in old_spans if not (t.max() < a0 or t.min() > a1)]
        tag = f"S{k:02d}"
        np.savez(f"{out}/track{tag}.npz", lat=lat, lon=lon, t=t, spd=seg[:, 3], hacc=seg[:, 4])
        rows.append(dict(seg=tag, trk=ti, name=name, day=day[st], points=int(seg.shape[0]),
                         span_h=round(float((t.max() - t.min()) / 3600), 2),
                         dt_median_s=round(float(np.median(dt)), 2) if dt.size else None,
                         gaps_gt_60s=int((dt > 60).sum()), max_gap_s=round(float(dt.max()), 1) if dt.size else None,
                         inside_bbox=round(float(inb), 4), path_nm=round(nm, 1),
                         moving_share=round(float(np.nanmean(seg[:, 3] > 0.5)), 3) if np.isfinite(seg[:, 3]).any() else None,
                         overlaps_existing=ov))
        k += 1
Path(f"{out}/intake6.json").write_text(json.dumps(rows, indent=1))
for r in rows:
    print(r)
