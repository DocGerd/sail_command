// #1830: the highest significant wave height a leg meets, from the plan's
// stored WaveGrid. Display only; the router never sees it.
import type { Leg, WaveGrid } from '../types';

const HALF_HOUR_MS = 1_800_000;

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

// Parameters in (0, 1) where the segment a..b crosses a cell edge on one axis:
// midpoints between neighbouring entries plus the two outer half-step edges.
function edgeCrossings(axis: readonly number[], a: number, b: number): number[] {
  const d = b - a;
  if (d === 0 || axis.length === 0) return [];
  const sorted = [...axis].sort((x, y) => x - y);
  const h = axisStep(axis) / 2;
  const edges = [sorted[0]! - h, sorted[sorted.length - 1]! + h];
  for (let i = 1; i < sorted.length; i++) edges.push((sorted[i - 1]! + sorted[i]!) / 2);
  return edges.map((e) => (e - a) / d).filter((f) => f > 0 && f < 1);
}

// Every cell the leg passes through (flattened `lat * nLon + lon`), by exact
// edge-crossing traversal, so a clipped corner counts; a leg lying exactly
// along a cell edge counts the cell on its lower side only. `outside` is set
// when any stretch of the leg lies beyond the grid's half-step margin.
export function crossedCells(
  leg: Pick<Leg, 'start' | 'end'>,
  grid: Pick<WaveGrid, 'lats' | 'lons'>,
): { cells: Set<number>; outside: boolean } {
  const { lats, lons } = grid;
  const { start, end } = leg;
  const fs = [
    0,
    1,
    ...edgeCrossings(lats, start.lat, end.lat),
    ...edgeCrossings(lons, start.lon, end.lon),
  ].sort((x, y) => x - y);
  const cells = new Set<number>();
  let outside = false;
  for (let i = 1; i < fs.length; i++) {
    const f0 = fs[i - 1]!;
    const f1 = fs[i]!;
    if (f1 === f0) continue;
    const f = (f0 + f1) / 2;
    const la = nearestIndex(lats, start.lat + (end.lat - start.lat) * f);
    const lo = nearestIndex(lons, start.lon + (end.lon - start.lon) * f);
    if (la === null || lo === null) outside = true;
    else cells.add(la * lons.length + lo);
  }
  return { cells, outside };
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

  const { cells, outside } = crossedCells(leg, grid);
  if (outside) incomplete = true;

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

// The route reading from its legs' readings; no legs is incomplete.
export function mergeReadings(readings: readonly SeaStateReading[]): SeaStateReading {
  let maxM: number | null = null;
  let incomplete = readings.length === 0;
  for (const r of readings) {
    if (r.incomplete || r.maxM === null) incomplete = true;
    if (r.maxM !== null && (maxM === null || r.maxM > maxM)) maxM = r.maxM;
  }
  return { maxM, incomplete };
}
