import { describe, expect, it } from 'vitest';
import type { LatLon, WindGrid, WindSample } from '../types';
import { normalizeDeg360, toDeg, toRad } from './geo';
import { WindField } from './wind';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bracket(xs: number[], x: number): { i: number; f: number } {
  if (x <= xs[0]) return { i: 0, f: 0 };
  const n = xs.length;
  if (n === 1) return { i: 0, f: 0 };
  if (x >= xs[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (xs[i + 1] < x) i++;
  return { i, f: (x - xs[i]) / (xs[i + 1] - xs[i]) };
}

/** Verbatim pre-cache `WindField.sample`. */
function referenceSample(grid: WindGrid, p: LatLon, tMs: number): WindSample {
  const { lats, lons, timesMs, speedKn, dirFromDeg, gustKn } = grid;
  const la = bracket(lats, p.lat);
  const lo = bracket(lons, p.lon);
  const tt = bracket(timesMs, tMs);
  const nLon = lons.length;
  const nLat = lats.length;
  let u = 0,
    v = 0,
    g = 0;
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

const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;

function makeGrid(nTimes: number, rnd: () => number): WindGrid {
  const lats = [54.0, 54.4, 54.9, 55.3, 55.9];
  const lons = [9.0, 9.7, 10.4, 11.0, 11.9];
  const timesMs = Array.from({ length: nTimes }, (_, i) => T0 + i * HOUR);
  const n = nTimes * lats.length * lons.length;
  const speedKn = new Float32Array(n);
  const dirFromDeg = new Float32Array(n);
  const gustKn = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    speedKn[k] = rnd() * 30;
    dirFromDeg[k] = rnd() * 360;
    gustKn[k] = speedKn[k] * (1 + rnd() * 0.5);
  }
  return { lats, lons, timesMs, speedKn, dirFromDeg, gustKn, fetchedAtMs: T0, model: 'test' };
}

function sameSample(a: WindSample, b: WindSample): boolean {
  return (
    Object.is(a.speedKn, b.speedKn) &&
    Object.is(a.dirFromDeg, b.dirFromDeg) &&
    Object.is(a.gustKn, b.gustKn)
  );
}

describe('WindField.sample time-bracket cache', () => {
  it('is bit-identical to the uncached sample over seeded (lat, lon, tMs), cache state irrelevant', () => {
    const rnd = mulberry32(0xbeef);
    for (const nTimes of [1, 2, 5, 40]) {
      const grid = makeGrid(nTimes, rnd);
      const field = new WindField(grid);
      const last = grid.timesMs[nTimes - 1];
      const edgeTimes = [
        -0,
        0,
        T0 - 1,
        T0,
        T0 + 1,
        last - 1,
        last,
        last + 1,
        last + 10 * HOUR,
        ...grid.timesMs,
        ...grid.timesMs.map((t) => t + HOUR / 2),
      ];
      const repeated: number[] = [];
      for (let k = 0; k < 300; k++) {
        const t = rnd() < 0.5 ? edgeTimes[Math.floor(rnd() * edgeTimes.length)] : null;
        repeated.push(t ?? T0 - 2 * HOUR + rnd() * (nTimes + 4) * HOUR);
      }
      const times = [...edgeTimes, ...repeated, ...repeated.slice().reverse()];
      let n = 0;
      for (const t of times) {
        const pts: LatLon[] = [
          { lat: 54.0, lon: 9.0 },
          { lat: 55.9, lon: 11.9 },
          { lat: 53, lon: 8 },
          { lat: 57, lon: 13 },
          { lat: 54.3 + rnd() * 1.3, lon: 9.4 + rnd() * 2.2 },
          { lat: 54.3 + rnd() * 1.3, lon: 9.4 + rnd() * 2.2 },
        ];
        for (const p of pts) {
          expect(sameSample(field.sample(p, t), referenceSample(grid, p, t))).toBe(true);
          n++;
        }
      }
      expect(n).toBeGreaterThan(1_000);
    }
  });

  it('stays correct once more distinct times than the cache holds have been seen', () => {
    const rnd = mulberry32(7);
    const grid = makeGrid(30, rnd);
    const field = new WindField(grid);
    const p = { lat: 54.77, lon: 10.1 };
    const times: number[] = [];
    for (let k = 0; k < 2_000; k++) times.push(T0 + rnd() * 29 * HOUR);
    for (const t of [...times, ...times.slice(0, 50)]) {
      expect(sameSample(field.sample(p, t), referenceSample(grid, p, t))).toBe(true);
    }
  });
});
