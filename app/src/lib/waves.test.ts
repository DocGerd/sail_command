import { describe, expect, it } from 'vitest';
import {
  cloneWaveGrid,
  seaStateBand,
  seaStateUnavailable,
  waveHourIndexAt,
  wavePointsAt,
  wavePointsAtHour,
  type SeaStateBand,
} from './waves';
import { makeWaveGrid } from '../test/waveFixtures';

describe('seaStateBand (#1699, WMO bands, lower edge inclusive)', () => {
  it.each<[number, SeaStateBand]>([
    [0, 'calm'],
    [0.0999, 'calm'],
    [0.1, 'smooth'],
    [Math.fround(0.1), 'smooth'], // the Float32 a stored 0.1 becomes
    [0.4999, 'smooth'],
    [0.5, 'slight'],
    [1.2499, 'slight'],
    [1.25, 'moderate'],
    [2.4999, 'moderate'],
    [2.5, 'rough'],
    [9, 'rough'],
  ])('%s m -> %s', (h, band) => {
    expect(seaStateBand(h)).toBe(band);
  });

  it.each([NaN, Infinity, -Infinity, -0.01, -3])('%s m -> no-data, never calm', (h) => {
    expect(seaStateBand(h)).toBe('no-data');
  });
});

describe('wave sampling (#1699)', () => {
  // Hs encodes hour, lat and lon index; period and direction differ from it.
  const grid = makeWaveGrid((la, lo, t) => ({
    heightM: t * 100 + la * 10 + lo,
    periodS: 5 + la,
    dirFromDeg: 90 * lo + t,
  }));
  const t0 = grid.timesMs[0]!;

  it('reads every point at an hour with the WindGrid flattened index', () => {
    const pts = wavePointsAtHour(grid, 2);
    expect(pts).toHaveLength(6);
    expect(pts[0]).toEqual({ lat: 54.5, lon: 10.0, heightM: 200, periodS: 5, dirFromDeg: 2 });
    expect(pts[1]).toEqual({ lat: 54.5, lon: 10.1, heightM: 201, periodS: 5, dirFromDeg: 92 });
    expect(pts[5]).toEqual({ lat: 54.7, lon: 10.1, heightM: 221, periodS: 7, dirFromDeg: 92 });
  });

  it('propagates NaN as no data', () => {
    const g = makeWaveGrid((la) => ({
      heightM: la === 1 ? NaN : 0.3,
      periodS: la === 1 ? NaN : 4,
      dirFromDeg: la === 1 ? NaN : 180,
    }));
    const pts = wavePointsAtHour(g, 0);
    expect(Number.isNaN(pts[2]!.heightM)).toBe(true);
    expect(seaStateBand(pts[2]!.heightM)).toBe('no-data');
    expect(seaStateBand(pts[0]!.heightM)).toBe('smooth');
  });

  it('picks the nearest hour inside the axis and null outside it', () => {
    expect(waveHourIndexAt(grid, t0 + 3_600_000 + 1_000_000)).toBe(1);
    expect(waveHourIndexAt(grid, t0 + 3_600_000 + 2_000_000)).toBe(2);
    expect(waveHourIndexAt(grid, t0 - 1_800_000)).toBe(0);
    expect(waveHourIndexAt(grid, t0 - 1_800_001)).toBeNull();
    expect(waveHourIndexAt(grid, t0 + 3 * 3_600_000 + 1_800_001)).toBeNull();
    expect(wavePointsAt(grid, t0 + 10 * 3_600_000)).toBeNull();
    expect(wavePointsAt(grid, t0)?.[3]?.heightM).toBe(11);
  });

  it('rejects an out-of-range hour index', () => {
    expect(() => wavePointsAtHour(grid, 4)).toThrow(RangeError);
    expect(() => wavePointsAtHour(grid, -1)).toThrow(RangeError);
  });

  it('clones without aliasing any buffer', () => {
    const c = cloneWaveGrid(grid);
    expect(c).toEqual(grid);
    expect(c.waveHeightM).not.toBe(grid.waveHeightM);
    expect(c.wavePeriodS).not.toBe(grid.wavePeriodS);
    expect(c.waveDirFromDeg).not.toBe(grid.waveDirFromDeg);
    expect(c.timesMs).not.toBe(grid.timesMs);
  });

  it('flags a plan without a wave grid as sea-state unavailable', () => {
    expect(seaStateUnavailable({})).toBe(true);
    expect(seaStateUnavailable({ waveGrid: grid })).toBe(false);
  });
});
