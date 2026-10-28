// #1830: the highest significant wave height a leg meets, from the plan's
// stored WaveGrid. Display only; the router never sees it.
import type { Leg, WaveGrid } from '../types';

const HALF_HOUR_MS = 1_800_000;
const MAX_SAMPLES = 1_000;

export interface SeaStateReading {
  // Max over the cells and hours the leg meets that have data; null when none do.
  maxM: number | null;
  // Some cell or hour the leg meets has no data or lies outside the grid.
  incomplete: boolean;
}

type LegSpan = Pick<Leg, 'start' | 'end' | 'startTimeMs' | 'endTimeMs'>;

function axisStep(axis: readonly number[]): number {
  if (axis.length < 2) return 0.1;
  return Math.abs(axis[axis.length - 1]! - axis[0]!) / (axis.length - 1);
}

// Nearest index, or null once `v` is more than half a step beyond either end:
// clamping to the edge cell would show its sea state for water outside the grid.
function nearestIndex(axis: readonly number[], v: number): number | null {
  const half = axisStep(axis) / 2;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i]! - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 && bestD <= half ? best : null;
}

// Every hour whose +-30 min window overlaps the leg, so the max is over the
// leg's own hours rather than the slider's.
function hourIndices(grid: WaveGrid, startMs: number, endMs: number): number[] {
  const out: number[] = [];
  grid.timesMs.forEach((t, i) => {
    if (t + HALF_HOUR_MS >= startMs && t - HALF_HOUR_MS <= endMs) out.push(i);
  });
  return out;
}

export function legMaxHsM(leg: LegSpan, grid: WaveGrid): SeaStateReading {
  const { lats, lons, timesMs } = grid;
  let incomplete = false;
  const first = timesMs[0];
  const last = timesMs[timesMs.length - 1];
  if (first === undefined || last === undefined) return { maxM: null, incomplete: true };
  if (leg.startTimeMs < first - HALF_HOUR_MS || leg.endTimeMs > last + HALF_HOUR_MS)
    incomplete = true;
  const hours = hourIndices(grid, leg.startTimeMs, leg.endTimeMs);
  if (hours.length === 0) return { maxM: null, incomplete: true };

  const dLat = leg.end.lat - leg.start.lat;
  const dLon = leg.end.lon - leg.start.lon;
  const n = Math.min(
    MAX_SAMPLES,
    Math.max(
      1,
      Math.ceil(Math.max(Math.abs(dLat) / axisStep(lats), Math.abs(dLon) / axisStep(lons)) * 2),
    ),
  );
  const cells = new Set<number>();
  for (let s = 0; s <= n; s++) {
    const f = s / n;
    const la = nearestIndex(lats, leg.start.lat + dLat * f);
    const lo = nearestIndex(lons, leg.start.lon + dLon * f);
    if (la === null || lo === null) incomplete = true;
    else cells.add(la * lons.length + lo);
  }

  const nPoints = lats.length * lons.length;
  let maxM: number | null = null;
  for (const cell of cells) {
    for (const h of hours) {
      const v = grid.waveHeightM[h * nPoints + cell];
      if (v === undefined || !Number.isFinite(v) || v < 0) incomplete = true;
      else if (maxM === null || v > maxM) maxM = v;
    }
  }
  return { maxM, incomplete };
}

export function routeMaxHsM(legs: readonly LegSpan[], grid: WaveGrid): SeaStateReading {
  let maxM: number | null = null;
  let incomplete = legs.length === 0;
  for (const leg of legs) {
    const r = legMaxHsM(leg, grid);
    if (r.incomplete || r.maxM === null) incomplete = true;
    if (r.maxM !== null && (maxM === null || r.maxM > maxM)) maxM = r.maxM;
  }
  return { maxM, incomplete };
}
