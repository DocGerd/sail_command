import type { PolarTable, WindGrid, MaskMeta } from '../types';
import { NavMask } from '../lib/mask';

/** Tiny synthetic polar: symmetric, monotone in TWS, humped over TWA. */
export const TEST_POLAR: PolarTable = {
  rig: 'genoa',
  boat: 'test',
  tws: [4, 8, 12, 16, 20],
  twa: [40, 60, 90, 120, 150, 180],
  speeds: [
    [2.0, 4.0, 5.5, 6.0, 6.2], // 40
    [2.6, 5.0, 6.5, 7.2, 7.4], // 60
    [3.0, 5.6, 7.2, 8.2, 8.6], // 90
    [2.8, 5.2, 7.0, 8.4, 8.8], // 120
    [2.0, 4.0, 5.8, 7.0, 7.8], // 150
    [1.6, 3.2, 4.8, 6.0, 6.8], // 180
  ],
  beat: { tws: [4, 8, 12, 16, 20], angle: [47, 44, 42, 40, 40] },
  gybe: { tws: [4, 8, 12, 16, 20], angle: [150, 155, 165, 170, 175] },
  source: 'synthetic test fixture',
};

export interface WindGridOpts {
  south?: number; north?: number; west?: number; east?: number;
  latStep?: number; lonStep?: number; hours?: number; t0Ms?: number;
}

export function makeWindGrid(
  fn: (lat: number, lon: number, hourIdx: number) => { speedKn: number; dirFromDeg: number },
  opts: WindGridOpts = {},
): WindGrid {
  const {
    south = 54.3, north = 55.3, west = 9.4, east = 11.0,
    latStep = 0.1, lonStep = 0.1, hours = 48,
    t0Ms = Date.UTC(2026, 6, 15, 6, 0, 0),
  } = opts;
  const lats: number[] = [];
  const lons: number[] = [];
  for (let la = south; la <= north + 1e-9; la += latStep) lats.push(Number(la.toFixed(6)));
  for (let lo = west; lo <= east + 1e-9; lo += lonStep) lons.push(Number(lo.toFixed(6)));
  const timesMs = Array.from({ length: hours }, (_, i) => t0Ms + i * 3_600_000);
  const n = timesMs.length * lats.length * lons.length;
  const speedKn = new Float32Array(n);
  const dirFromDeg = new Float32Array(n);
  const gustKn = new Float32Array(n);
  let k = 0;
  for (let ti = 0; ti < timesMs.length; ti++)
    for (const lat of lats)
      for (const lon of lons) {
        const w = fn(lat, lon, ti);
        speedKn[k] = w.speedKn;
        dirFromDeg[k] = w.dirFromDeg;
        gustKn[k] = w.speedKn * 1.3;
        k++;
      }
  return { lats, lons, timesMs, speedKn, dirFromDeg, gustKn, fetchedAtMs: t0Ms, model: 'test' };
}

export const uniformWindGrid = (speedKn: number, dirFromDeg: number, opts: WindGridOpts = {}) =>
  makeWindGrid(() => ({ speedKn, dirFromDeg }), opts);

export const TEST_MASK_META: MaskMeta = {
  west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 320, rows: 200,
};

export function makeMask(fn: (row: number, col: number) => number, meta = TEST_MASK_META): NavMask {
  const data = new Uint8Array(meta.rows * meta.cols);
  for (let r = 0; r < meta.rows; r++)
    for (let c = 0; c < meta.cols; c++) data[r * meta.cols + c] = fn(r, c);
  return new NavMask(meta, data);
}

/** All water, 20 m deep. */
export const openWaterMask = () => makeMask(() => 200);

/** Land wall at col 160 (lon ≈ 10.2), except rows 90..99 (a gap). */
export const wallMask = () =>
  makeMask((r, c) => (c === 160 && (r < 90 || r > 99) ? 0 : 200));

// Adjust mask in tests with c < 161 instead of c < 162 due to floating-point precision in col indexing
export const testSnapMask = () =>
  makeMask((_, c) => (c < 161 ? 0 : 200));
