"""#295: check that region archives serve the same tiles as one whole extract.

Usage:
  python3 pipeline/verify_region_split.py --whole WHOLE --core CORE REGION...

WHOLE is a single extract of the union bbox from the SAME build as the
regions (extract_basemap.sh --region whole <union bbox>). CORE is the core
archive. REGIONs are passed in manifest order (sorted by id), because
compositeBasemapProtocol.ts's selectTileArchive serves a non-core tile from
the first region whose bbox strictly overlaps it.

For every tile of WHOLE that does not overlap the core bbox, the region the
protocol would pick must hold byte-identical tile data. Also counted: tiles no
region would serve, and non-core tiles a region holds that WHOLE lacks.
Exits 0 only when every count but "identical" is zero. Standard library only.
"""

import argparse
import gzip
import math
import struct
import sys


def varint(buf, pos):
    shift = val = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if b < 0x80:
            return val, pos
        shift += 7


def read_directory(raw):
    d = gzip.decompress(raw)
    n, p = varint(d, 0)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        v, p = varint(d, p)
        last += v
        ids.append(last)
    for _ in range(n):
        v, p = varint(d, p)
        runs.append(v)
    for _ in range(n):
        v, p = varint(d, p)
        lens.append(v)
    for i in range(n):
        v, p = varint(d, p)
        offs.append(offs[i - 1] + lens[i - 1] if (v == 0 and i > 0) else v - 1)
    return list(zip(ids, runs, lens, offs))


def load_archive(path):
    """Returns (bbox, {tile_id: tile bytes}) for a PMTiles v3 archive."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:7] != b"PMTiles" or data[7] != 3:
        sys.exit(f"{path}: not a PMTiles v3 archive")
    (root_off, root_len, _mo, _ml, leaf_off, _ll, tdata_off, _tl, addressed) = struct.unpack_from("<9Q", data, 8)
    if data[97] != 2:
        sys.exit(f"{path}: internal compression must be gzip")
    bbox = tuple(v / 1e7 for v in struct.unpack_from("<4i", data, 102))
    entries = {}

    def walk(off, length):
        for tid, run, ln, o in read_directory(data[off : off + length]):
            if run == 0:
                walk(leaf_off + o, ln)
            else:
                for k in range(run):
                    entries[tid + k] = (o, ln)

    walk(root_off, root_len)
    if len(entries) != addressed:
        sys.exit(f"{path}: {len(entries)} tiles read, header says {addressed}")
    tiles = {t: data[tdata_off + o : tdata_off + o + ln] for t, (o, ln) in entries.items()}
    return bbox, tiles


def tile_id_to_zxy(tid):
    acc = 0
    for z in range(27):
        n = 1 << (2 * z)
        if acc + n > tid:
            t = tid - acc
            x = y = 0
            s = 1
            size = 1 << z
            while s < size:
                rx = 1 & (t // 2)
                ry = 1 & (t ^ rx)
                if ry == 0:
                    if rx == 1:
                        x, y = s - 1 - x, s - 1 - y
                    x, y = y, x
                x += s * rx
                y += s * ry
                t //= 4
                s *= 2
            return z, x, y
        acc += n
    raise ValueError(tid)


def tile_bbox(z, x, y):
    n = 2**z

    def lat(r):
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * r / n))))

    return (x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y))


def overlaps(a, b):
    """compositeBasemapProtocol.ts's strict bbox overlap."""
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--whole", required=True)
    ap.add_argument("--core", required=True)
    ap.add_argument("regions", nargs="+")
    args = ap.parse_args()

    core_bbox, _ = load_archive(args.core)
    _, whole = load_archive(args.whole)
    regions = [load_archive(p) for p in args.regions]

    identical = missing = mismatch = no_region = region_only = 0
    for tid, body in whole.items():
        tb = tile_bbox(*tile_id_to_zxy(tid))
        if overlaps(core_bbox, tb):
            continue
        pick = next((r for r in regions if overlaps(r[0], tb)), None)
        if pick is None:
            no_region += 1
        elif tid not in pick[1]:
            missing += 1
        elif pick[1][tid] != body:
            mismatch += 1
        else:
            identical += 1
    for _, tiles in regions:
        for tid in tiles:
            tb = tile_bbox(*tile_id_to_zxy(tid))
            if not overlaps(core_bbox, tb) and tid not in whole:
                region_only += 1

    print(
        f"identical {identical}, missing {missing}, content-mismatch {mismatch}, "
        f"no-region {no_region}, region-only {region_only}"
    )
    return 0 if identical > 0 and missing == mismatch == no_region == region_only == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
