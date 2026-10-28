import { describe, expect, it } from 'vitest';
import { makeWaveGrid } from '../test/waveFixtures';
import { crossedCells, legMaxHsM, mergeReadings } from './routeSeaState';

const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);
const H = 3_600_000;
const LATS = [54.5, 54.6, 54.7];
const LONS = [10.0, 10.1, 10.2];

type Fn = (la: number, lo: number, h: number) => number;
function grid(fn: Fn, opts: { lats?: number[]; lons?: number[]; hours?: number } = {}) {
  return makeWaveGrid((la, lo, h) => ({ heightM: fn(la, lo, h), periodS: 4, dirFromDeg: 270 }), {
    lats: LATS,
    lons: LONS,
    hours: 4,
    t0Ms: T0,
    ...opts,
  });
}
function leg(start: [number, number], end: [number, number], fromH = 1, toH = 1.5) {
  return {
    start: { lat: start[0], lon: start[1] },
    end: { lat: end[0], lon: end[1] },
    startTimeMs: T0 + fromH * H,
    endTimeMs: T0 + toH * H,
  };
}
const EAST = leg([54.6, 10.0], [54.6, 10.2]);

describe('legMaxHsM', () => {
  it('reads a uniform grid', () => {
    expect(
      legMaxHsM(
        EAST,
        grid(() => 0.6),
      ),
    ).toEqual({ maxM: Math.fround(0.6), incomplete: false });
  });

  it('reports all-NaN as no data, never 0, and finite cells as a number', () => {
    expect(
      legMaxHsM(
        EAST,
        grid(() => NaN),
      ),
    ).toEqual({ maxM: null, incomplete: true });
    expect(
      legMaxHsM(
        EAST,
        grid(() => 0.4),
      ).maxM,
    ).toBe(Math.fround(0.4));
  });

  it('treats Hs exactly 0 as a real calm reading', () => {
    expect(
      legMaxHsM(
        EAST,
        grid(() => 0),
      ),
    ).toEqual({ maxM: 0, incomplete: false });
  });

  it('takes the max of the finite cells and flags the gap', () => {
    const g = grid((_la, lo) => (lo === 0 ? NaN : lo === 1 ? 0.8 : 0.3));
    expect(legMaxHsM(EAST, g)).toEqual({ maxM: Math.fround(0.8), incomplete: true });
  });

  it('flags a negative reading as no data', () => {
    expect(
      legMaxHsM(
        EAST,
        grid(() => -1),
      ),
    ).toEqual({ maxM: null, incomplete: true });
  });

  it('sees a peak between the endpoint cells', () => {
    const g = grid((_la, lo) => (lo === 1 ? 2 : 0.3));
    expect(legMaxHsM(EAST, g).maxM).toBe(2);
  });

  it('takes the max over every hour the leg spans, not one of them', () => {
    const byHour = [0.1, 0.5, 0.9, 0.3];
    const g = grid((_la, _lo, h) => byHour[h]!);
    const r = legMaxHsM(leg([54.6, 10.0], [54.6, 10.2], 1, 2), g);
    expect(r).toEqual({ maxM: Math.fround(0.9), incomplete: false });
    expect(legMaxHsM(leg([54.6, 10.0], [54.6, 10.2], 1, 1.2), g).maxM).toBe(Math.fround(0.5));
    expect(legMaxHsM(leg([54.6, 10.0], [54.6, 10.2], 2.1, 2.2), g).maxM).toBe(Math.fround(0.9));
  });

  it('gives null for a leg wholly after the time axis', () => {
    const g = grid(() => 0.6);
    expect(legMaxHsM(leg([54.6, 10.0], [54.6, 10.2], 4, 5), g)).toEqual({
      maxM: null,
      incomplete: true,
    });
  });

  it('keeps the known max and flags a leg that runs past the horizon', () => {
    const r = legMaxHsM(
      leg([54.6, 10.0], [54.6, 10.2], 3, 6),
      grid(() => 0.6),
    );
    expect(r).toEqual({ maxM: Math.fround(0.6), incomplete: true });
  });

  it('gives null for a leg wholly outside the extent, not an edge cell', () => {
    expect(
      legMaxHsM(
        leg([54.6, 11.0], [54.6, 11.2]),
        grid(() => 0.6),
      ),
    ).toEqual({
      maxM: null,
      incomplete: true,
    });
  });

  it('keeps the known max for a leg that starts outside the extent', () => {
    const r = legMaxHsM(
      leg([54.6, 9.5], [54.6, 10.1]),
      grid(() => 0.6),
    );
    expect(r).toEqual({ maxM: Math.fround(0.6), incomplete: true });
  });

  it('flags a leg that starts before the time axis', () => {
    const r = legMaxHsM(
      leg([54.6, 10.0], [54.6, 10.2], -2, 1),
      grid(() => 0.6),
    );
    expect(r).toEqual({ maxM: Math.fround(0.6), incomplete: true });
  });

  it('counts a cell between the endpoint cells that endpoint sampling skips', () => {
    // Crosses the lat edge at 54.55 (f = 0.5) and the lon edge at 10.15 (f = 0.75): (0,1) -> (1,1) -> (1,2).
    const clip = leg([54.54, 10.12], [54.56, 10.16]);
    const g = grid((la, lo) => (la === 1 && lo === 1 ? 5 : 0.3));
    expect(legMaxHsM(clip, g)).toEqual({ maxM: 5, incomplete: false });
  });

  it('copes with a single-point axis', () => {
    const g = grid(() => 0.7, { lats: [54.6], lons: [10.1] });
    expect(legMaxHsM(leg([54.6, 10.1], [54.62, 10.12]), g).maxM).toBe(Math.fround(0.7));
  });
});

describe('route reading', () => {
  const routeMaxHsM = (legs: ReturnType<typeof leg>[], g: ReturnType<typeof grid>) =>
    mergeReadings(legs.map((l) => legMaxHsM(l, g)));
  const g = grid((_la, lo) => (lo === 2 ? 1.5 : 0.3));
  const west = leg([54.6, 10.0], [54.6, 10.05]);
  const east = leg([54.6, 10.15], [54.6, 10.2]);
  const out = leg([54.6, 11.0], [54.6, 11.2]);

  it('takes the max over legs', () => {
    expect(routeMaxHsM([west, east], g)).toEqual({ maxM: Math.fround(1.5), incomplete: false });
  });

  it('gives null for no legs and for all-null legs', () => {
    expect(routeMaxHsM([], g).maxM).toBeNull();
    expect(routeMaxHsM([out, out], g)).toEqual({ maxM: null, incomplete: true });
  });

  it('is incomplete when one leg has no data', () => {
    expect(routeMaxHsM([west, out], g)).toEqual({ maxM: Math.fround(0.3), incomplete: true });
  });
});

describe('mergeReadings', () => {
  it('folds readings and treats none as incomplete', () => {
    expect(mergeReadings([])).toEqual({ maxM: null, incomplete: true });
    expect(
      mergeReadings([
        { maxM: 0.4, incomplete: false },
        { maxM: 1.1, incomplete: false },
      ]),
    ).toEqual({ maxM: 1.1, incomplete: false });
    expect(mergeReadings([{ maxM: 0.4, incomplete: true }]).incomplete).toBe(true);
  });
});

describe('crossedCells against dense sampling', () => {
  // Reference: 0.1-degree lattice, nearest cell by rounding, outside beyond a
  // half step; shares no code with the edge-crossing traversal.
  const N = 12;
  const STEP = 0.1;
  const lats = Array.from({ length: N }, (_, i) => 54 + i * STEP);
  const lons = Array.from({ length: N }, (_, i) => 10 + i * STEP);
  const SAMPLES = 40_000;

  function rng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function dense(s: [number, number], e: [number, number]) {
    const cells = new Set<number>();
    let outside = false;
    for (let i = 0; i <= SAMPLES; i++) {
      const f = i / SAMPLES;
      const la = Math.round((s[0] + (e[0] - s[0]) * f - lats[0]!) / STEP);
      const lo = Math.round((s[1] + (e[1] - s[1]) * f - lons[0]!) / STEP);
      if (la < 0 || la >= N || lo < 0 || lo >= N) outside = true;
      else cells.add(la * N + lo);
    }
    return { cells, outside };
  }

  it('visits exactly the cells a dense walk visits, for seeded random legs', () => {
    const rand = rng(1830);
    let multiCell = 0;
    let outsideCases = 0;
    for (let k = 0; k < 300; k++) {
      // Spans a little beyond the extent so the outside flag is exercised too.
      const pt = (): [number, number] => [54 - 0.15 + rand() * 1.4, 10 - 0.15 + rand() * 1.4];
      const s = pt();
      const e = pt();
      const got = crossedCells(
        { start: { lat: s[0], lon: s[1] }, end: { lat: e[0], lon: e[1] } },
        { lats, lons },
      );
      const want = dense(s, e);
      expect([...got.cells].sort((x, y) => x - y)).toEqual([...want.cells].sort((x, y) => x - y));
      expect(got.outside).toBe(want.outside);
      if (want.cells.size > 3) multiCell++;
      if (want.outside) outsideCases++;
    }
    expect(multiCell).toBeGreaterThan(100);
    expect(outsideCases).toBeGreaterThan(20);
  });
});
