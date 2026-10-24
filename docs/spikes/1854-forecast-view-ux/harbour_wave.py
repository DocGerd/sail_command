import json, math, sys

root = sys.argv[1]
m = open(root + '/app/public/data/mask.bin', 'rb').read()
cols, rows = 3025, 3120
CX, CY = 1375, 2400
LATS = [round(54.3 + i * 0.1, 1) for i in range(14)]
LONS = [round(9.4 + i * 0.1, 1) for i in range(23)]


def cell(lat, lon):
    if lat >= 55.6 or lon >= 11.6 or lat < 54.3 or lon < 9.4:
        return None
    r = math.floor((lat - 54.3) * CY)
    c = math.floor((lon - 9.4) * CX)
    return m[r * cols + c]


water = [(a, b) for a in LATS for b in LONS if (cell(a, b) or 0) > 0]


def km(a, b):
    dlat = (a[0] - b[0]) * 111.2
    dlon = (a[1] - b[1]) * 111.2 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


H = json.load(open(root + '/app/public/data/harbors.json'))
bad = []
dists = []
for h in H:
    p = (h['snap']['lat'], h['snap']['lon'])
    la = min(LATS, key=lambda x: abs(x - p[0]))
    lo = min(LONS, key=lambda x: abs(x - p[1]))
    v = cell(la, lo)
    near = min(water, key=lambda w: km(p, w))
    d = km(p, near)
    dists.append((h['id'], (v or 0) > 0, round(d, 1)))
    if not (v or 0) > 0:
        bad.append(h['id'])
print('harbours', len(H), 'nearest-point-not-water', len(bad))
print(bad)
for row in sorted(dists, key=lambda r: -r[2]):
    print(row)
