import { NavMask } from '../lib/mask';
import type { MaskMeta, WaveGrid } from '../types';

// #1699: a small WaveGrid filled from a per-point function, using the WindGrid
// flattened index. Kept out of test/fixtures.ts, which is in the #282 sweep
// closure.
export function makeWaveGrid(
  fn: (
    latIdx: number,
    lonIdx: number,
    hourIdx: number,
  ) => {
    heightM: number;
    periodS: number;
    dirFromDeg: number;
  },
  opts: { lats?: number[]; lons?: number[]; hours?: number; t0Ms?: number } = {},
): WaveGrid {
  const lats = opts.lats ?? [54.5, 54.6, 54.7];
  const lons = opts.lons ?? [10.0, 10.1];
  const hours = opts.hours ?? 4;
  const t0Ms = opts.t0Ms ?? Date.UTC(2026, 6, 15, 6, 0, 0);
  const timesMs = Array.from({ length: hours }, (_, i) => t0Ms + i * 3_600_000);
  const nPoints = lats.length * lons.length;
  const waveHeightM = new Float32Array(hours * nPoints);
  const wavePeriodS = new Float32Array(hours * nPoints);
  const waveDirFromDeg = new Float32Array(hours * nPoints);
  for (let t = 0; t < hours; t++)
    for (let la = 0; la < lats.length; la++)
      for (let lo = 0; lo < lons.length; lo++) {
        const k = t * nPoints + la * lons.length + lo;
        const v = fn(la, lo, t);
        waveHeightM[k] = v.heightM;
        wavePeriodS[k] = v.periodS;
        waveDirFromDeg[k] = v.dirFromDeg;
      }
  return {
    lats,
    lons,
    timesMs,
    waveHeightM,
    wavePeriodS,
    waveDirFromDeg,
    fetchedAtMs: t0Ms - 3_600_000,
    model: 'ewam',
  };
}

// A small mask whose cells are centred on the 0.1° lattice from 54.0–55.0N,
// 9.5–10.5E; `byteAt` gets each cell centre (0 = land, 1–255 = water).
export const WAVE_TEST_MASK_META: MaskMeta = {
  south: 53.95,
  north: 55.05,
  west: 9.45,
  east: 10.55,
  rows: 11,
  cols: 11,
};

export function waveTestMask(byteAt: (lat: number, lon: number) => number = () => 50): NavMask {
  const m = WAVE_TEST_MASK_META;
  const data = new Uint8Array(m.rows * m.cols);
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++)
      data[r * m.cols + c] = byteAt(
        Number((m.south + (r + 0.5) * 0.1).toFixed(6)),
        Number((m.west + (c + 0.5) * 0.1).toFixed(6)),
      );
  return new NavMask(m, data);
}
