// #1699: pure sampling and classification of a plan's stored WaveGrid.
// Display only; the routing worker never sees a wave grid.
import type { Plan, WaveGrid } from '../types';
import { nearestHourIndex } from './routeGeoJson';

export interface WavePoint {
  lat: number;
  lon: number;
  heightM: number; // NaN = no data
  periodS: number; // NaN = no data
  dirFromDeg: number; // NaN = no data
}

// WMO sea-state code bands for significant wave height. Each band includes
// its lower edge and excludes its upper one, so 0.1 is smooth and 2.5 is
// rough, matching the spec's "calm < 0.1" and "rough ≥ 2.5".
export type SeaStateBand = 'calm' | 'smooth' | 'slight' | 'moderate' | 'rough' | 'no-data';

export const SEA_STATE_EDGES_M = { smooth: 0.1, slight: 0.5, moderate: 1.25, rough: 2.5 } as const;

// Non-finite or negative Hs is 'no-data', never 'calm': missing water must not
// read as flat water.
export function seaStateBand(heightM: number): SeaStateBand {
  if (!Number.isFinite(heightM) || heightM < 0) return 'no-data';
  if (heightM < SEA_STATE_EDGES_M.smooth) return 'calm';
  if (heightM < SEA_STATE_EDGES_M.slight) return 'smooth';
  if (heightM < SEA_STATE_EDGES_M.moderate) return 'slight';
  if (heightM < SEA_STATE_EDGES_M.rough) return 'moderate';
  return 'rough';
}

const HALF_HOUR_MS = 1_800_000;

// Hour index nearest `tMs`, or null when `tMs` lies outside the grid's time
// axis: clamping to the last hour would show a stale sea state as current.
export function waveHourIndexAt(grid: WaveGrid, tMs: number): number | null {
  const { timesMs } = grid;
  if (timesMs.length === 0 || !Number.isFinite(tMs)) return null;
  if (tMs < timesMs[0]! - HALF_HOUR_MS || tMs > timesMs[timesMs.length - 1]! + HALF_HOUR_MS)
    return null;
  return nearestHourIndex(timesMs, tMs);
}

// Every grid point at one hour. A short or damaged buffer reads as NaN.
export function wavePointsAtHour(grid: WaveGrid, hourIdx: number): WavePoint[] {
  if (!Number.isInteger(hourIdx) || hourIdx < 0 || hourIdx >= grid.timesMs.length)
    throw new RangeError(`wave hour index ${hourIdx} outside 0..${grid.timesMs.length - 1}`);
  const nLon = grid.lons.length;
  const nPoints = grid.lats.length * nLon;
  const points: WavePoint[] = [];
  for (let latIdx = 0; latIdx < grid.lats.length; latIdx++) {
    for (let lonIdx = 0; lonIdx < nLon; lonIdx++) {
      const k = hourIdx * nPoints + latIdx * nLon + lonIdx;
      points.push({
        lat: grid.lats[latIdx]!,
        lon: grid.lons[lonIdx]!,
        heightM: grid.waveHeightM[k] ?? NaN,
        periodS: grid.wavePeriodS[k] ?? NaN,
        dirFromDeg: grid.waveDirFromDeg[k] ?? NaN,
      });
    }
  }
  return points;
}

// Every grid point at the hour nearest `tMs`; null outside the time axis.
export function wavePointsAt(grid: WaveGrid, tMs: number): WavePoint[] | null {
  const idx = waveHourIndexAt(grid, tMs);
  return idx === null ? null : wavePointsAtHour(grid, idx);
}

// Deep copy; a new plan must not alias another plan's buffers, and buffers are
// never transferred.
export function cloneWaveGrid(g: WaveGrid): WaveGrid {
  return {
    lats: [...g.lats],
    lons: [...g.lons],
    timesMs: [...g.timesMs],
    waveHeightM: g.waveHeightM.slice(0),
    wavePeriodS: g.wavePeriodS.slice(0),
    waveDirFromDeg: g.waveDirFromDeg.slice(0),
    fetchedAtMs: g.fetchedAtMs,
    model: g.model,
  };
}

// The plan-level "sea state unavailable" signal for the UI.
export function seaStateUnavailable(plan: Pick<Plan, 'waveGrid'>): boolean {
  return plan.waveGrid === undefined;
}
