import type { LatLon, WindGrid, WindSample } from '../types';
import { normalizeDeg360, toDeg, toRad } from './geo';

/** Index of the last element <= x (clamped to [0, xs.length-2]) plus fraction. */
function bracket(xs: number[], x: number): { i: number; f: number } {
  if (x <= xs[0]) return { i: 0, f: 0 };
  const n = xs.length;
  if (n === 1) return { i: 0, f: 0 };
  if (x >= xs[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (xs[i + 1] < x) i++;
  return { i, f: (x - xs[i]) / (xs[i + 1] - xs[i]) };
}

export class WindField {
  private grid: WindGrid;

  constructor(grid: WindGrid) {
    const expected = grid.timesMs.length * grid.lats.length * grid.lons.length;
    if (grid.speedKn.length !== expected)
      throw new Error(`windGrid speedKn length ${grid.speedKn.length} != timesMs*lats*lons ${expected}`);
    if (grid.dirFromDeg.length !== expected)
      throw new Error(`windGrid dirFromDeg length ${grid.dirFromDeg.length} != timesMs*lats*lons ${expected}`);
    if (grid.gustKn.length !== expected)
      throw new Error(`windGrid gustKn length ${grid.gustKn.length} != timesMs*lats*lons ${expected}`);
    this.grid = grid;
  }

  startMs(): number {
    return this.grid.timesMs[0];
  }

  horizonMs(): number {
    return this.grid.timesMs[this.grid.timesMs.length - 1];
  }

  sample(p: LatLon, tMs: number): WindSample {
    const { lats, lons, timesMs, speedKn, dirFromDeg, gustKn } = this.grid;
    const la = bracket(lats, p.lat);
    const lo = bracket(lons, p.lon);
    const tt = bracket(timesMs, tMs);
    const nLon = lons.length;
    const nLat = lats.length;

    // Accumulate u/v (wind vector TOWARD which air moves) and gust bilinearly,
    // then linearly across the two time slices.
    let u = 0, v = 0, g = 0;
    for (const [ti, wt] of [
      [tt.i, 1 - tt.f],
      [tt.i + 1 < timesMs.length ? tt.i + 1 : tt.i, tt.f],
    ] as const) {
      if (wt === 0) continue;
      for (const [lai, wla] of [
        [la.i, 1 - la.f],
        [la.i + 1 < nLat ? la.i + 1 : la.i, la.f],
      ] as const) {
        if (wla === 0) continue;
        for (const [loi, wlo] of [
          [lo.i, 1 - lo.f],
          [lo.i + 1 < nLon ? lo.i + 1 : lo.i, lo.f],
        ] as const) {
          if (wlo === 0) continue;
          const k = (ti * nLat + lai) * nLon + loi;
          const w = wt * wla * wlo;
          const sp = speedKn[k];
          const dir = toRad(dirFromDeg[k]);
          u += w * -sp * Math.sin(dir);
          v += w * -sp * Math.cos(dir);
          g += w * gustKn[k];
        }
      }
    }
    const speed = Math.hypot(u, v);
    const dir = speed < 1e-6 ? 0 : normalizeDeg360(toDeg(Math.atan2(-u, -v)));
    return { speedKn: speed, dirFromDeg: dir, gustKn: g };
  }
}
