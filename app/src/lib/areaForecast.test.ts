import { describe, expect, it } from 'vitest';
import {
  VARIABLE_RESULTANT,
  nearestLatticePoint,
  stripWindows,
  summariseScope,
  waterLatticePoints,
  windowOf,
} from './areaForecast';
import type { WaveGrid, WindGrid } from '../types';

const HOUR = 3_600_000;
const T0 = new Date(2026, 9, 29, 0, 0).getTime();
const LATS = [54.5, 54.6];
const LONS = [10.0, 10.1];

type Cell = { s: number; d: number; g: number };

function wind(hours: Cell[][]): WindGrid {
  const n = LATS.length * LONS.length;
  const speedKn = new Float32Array(hours.length * n);
  const dirFromDeg = new Float32Array(hours.length * n);
  const gustKn = new Float32Array(hours.length * n);
  hours.forEach((cells, h) =>
    cells.forEach((c, k) => {
      speedKn[h * n + k] = c.s;
      dirFromDeg[h * n + k] = c.d;
      gustKn[h * n + k] = c.g;
    }),
  );
  return {
    lats: LATS,
    lons: LONS,
    timesMs: hours.map((_, h) => T0 + h * HOUR),
    speedKn,
    dirFromDeg,
    gustKn,
    fetchedAtMs: T0,
    model: 'test',
  };
}

function wave(hs: number[][]): WaveGrid {
  const n = LATS.length * LONS.length;
  const waveHeightM = new Float32Array(hs.length * n);
  hs.forEach((cells, h) => cells.forEach((v, k) => (waveHeightM[h * n + k] = v)));
  return {
    lats: LATS,
    lons: LONS,
    timesMs: hs.map((_, h) => T0 + h * HOUR),
    waveHeightM,
    wavePeriodS: new Float32Array(hs.length * n).fill(NaN),
    waveDirFromDeg: new Float32Array(hs.length * n).fill(NaN),
    fetchedAtMs: T0,
    model: 'test',
  };
}

const c = (s: number, d = 270, g = s + 4): Cell => ({ s, d, g });
const ALL = [0, 1, 2, 3];

describe('#1854 waterLatticePoints', () => {
  it('keeps points whose own cell is in-bounds water', () => {
    const mask = {
      inBounds: (p: { lat: number; lon: number }) => p.lon < 10.05,
      depthM: (p: { lat: number }) => (p.lat > 54.55 ? 5 : 0),
    };
    // Only (54.6, 10.0) is both in bounds and water: lat index 1, lon index 0.
    expect(waterLatticePoints(mask, { lats: LATS, lons: LONS })).toEqual([2]);
  });
});

describe('#1854 summariseScope', () => {
  it('reduces mean wind to min–max, gusts and Hs to max, over points and hours', () => {
    const w = wind([
      [c(5), c(8), c(6), c(7)],
      [c(9), c(4, 270, 20), c(6), c(7)],
    ]);
    const v = wave([
      [0.4, 0.6, 0.5, 0.2],
      [0.3, 0.9, 0.5, 0.2],
    ]);
    const s = summariseScope(w, v, ALL, ALL, [T0, T0 + HOUR]);
    expect(s.wind).toMatchObject({ minKn: 4, maxKn: 9, gustKn: 20 });
    expect(s.seaMaxM).toBeCloseTo(0.9, 5);
  });

  it('only counts the listed points and hours', () => {
    const w = wind([
      [c(5), c(30), c(6), c(7)],
      [c(40), c(40), c(40), c(40)],
    ]);
    const s = summariseScope(w, null, [0, 2], [], [T0]);
    expect(s.wind).toMatchObject({ minKn: 5, maxKn: 6 });
    expect(s.seaMaxM).toBeNull();
  });

  it('skips missing wind instead of reading it as calm', () => {
    const w = wind([[c(NaN, NaN, NaN), c(8), c(-1), c(6)]]);
    const s = summariseScope(w, null, ALL, [], [T0]);
    expect(s.wind?.minKn).toBe(6);
    expect(s.wind?.maxKn).toBe(8);
  });

  it('is null for wind and sea when nothing is finite', () => {
    const w = wind([[c(NaN, NaN, NaN), c(NaN, NaN, NaN), c(NaN, NaN, NaN), c(NaN, NaN, NaN)]]);
    const v = wave([[NaN, NaN, -1, NaN]]);
    expect(summariseScope(w, v, ALL, ALL, [T0])).toEqual({ wind: null, seaMaxM: null });
  });

  it('skips missing Hs instead of reading it as calm', () => {
    const w = wind([[c(5), c(5), c(5), c(5)]]);
    const v = wave([[NaN, 0.05, NaN, NaN]]);
    expect(summariseScope(w, v, ALL, ALL, [T0]).seaMaxM).toBeCloseTo(0.05, 5);
  });

  it('has no sea value for an hour the wave axis does not hold', () => {
    const w = wind([
      [c(5), c(5), c(5), c(5)],
      [c(5), c(5), c(5), c(5)],
      [c(5), c(5), c(5), c(5)],
    ]);
    const v = wave([[0.5, 0.5, 0.5, 0.5]]);
    expect(summariseScope(w, v, ALL, ALL, [T0 + 2 * HOUR]).seaMaxM).toBeNull();
  });

  it('averages direction on the circle, weighted by speed', () => {
    const w = wind([[c(10, 350), c(10, 10), c(10, 350), c(10, 10)]]);
    const d = summariseScope(w, null, ALL, [], [T0]).wind?.dirFromDeg ?? NaN;
    expect(Math.min(d, 360 - d)).toBeCloseTo(0, 5);
    const weighted = wind([[c(30, 90), c(1, 180), c(1, 180), c(1, 180)]]);
    expect(summariseScope(weighted, null, ALL, [], [T0]).wind?.dirFromDeg).toBeLessThan(100);
  });

  it(`reads as variable below a resultant of ${VARIABLE_RESULTANT}`, () => {
    // Two equal winds 2θ apart have resultant cos θ: θ = 60° gives exactly 0.5.
    const at = (half: number) =>
      summariseScope(wind([[c(10, 90 - half), c(10, 90 + half), c(0), c(0)]]), null, ALL, [], [T0])
        .wind?.dirFromDeg;
    expect(at(59)).toBeCloseTo(90, 5);
    expect(at(61)).toBeNull();
    expect(summariseScope(wind([[c(0), c(0), c(0), c(0)]]), null, ALL, [], [T0]).wind).toEqual({
      minKn: 0,
      maxKn: 0,
      gustKn: 4,
      dirFromDeg: null,
    });
  });
});

describe('#1854 stripWindows', () => {
  const day = (h: number) => new Date(2026, 9, 29, h).getTime();
  const hours = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => day(from + i));

  it('keeps the window holding the first option and drops earlier ones', () => {
    const w = stripWindows(hours(14, 23), day(14));
    expect(w.map((x) => new Date(x.startMs).getHours())).toEqual([12, 15, 18, 21]);
    expect(w[0]!.hoursMs).toEqual([day(14)]);
    expect(w[1]!.hoursMs).toEqual([day(15), day(16), day(17)]);
  });

  it('drops windows beyond the horizon and other days', () => {
    const opts = [...hours(0, 7), new Date(2026, 9, 30, 1).getTime()];
    const w = stripWindows(opts, day(5));
    expect(w.map((x) => new Date(x.startMs).getHours())).toEqual([0, 3, 6]);
    expect(w[2]!.hoursMs).toEqual([day(6), day(7)]);
  });

  it('windowOf names the window holding an hour', () => {
    const w = stripWindows(hours(0, 23), day(0));
    expect(windowOf(w, day(14))).toBe(day(12));
    expect(windowOf(w, day(14) + 30 * 60_000)).toBeNull();
  });
});

describe('#1854 nearestLatticePoint', () => {
  it('picks the nearest of the given points, or null for none', () => {
    const g = { lats: LATS, lons: LONS };
    expect(nearestLatticePoint(g, [0, 3], { lat: 54.58, lon: 10.09 })).toBe(3);
    expect(nearestLatticePoint(g, [0, 1], { lat: 54.58, lon: 10.09 })).toBe(1);
    expect(nearestLatticePoint(g, [], { lat: 54.58, lon: 10.09 })).toBeNull();
  });
});
