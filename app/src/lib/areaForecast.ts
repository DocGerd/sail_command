// #1854: summaries of the Wetter tab's area forecast over a set of lattice
// points (spike §3, §5). Missing values are skipped, never read as calm: a
// scope with no finite value yields null, as #1830's route readout does.
import type { LatLon, WaveGrid, WindGrid } from '../types';
import type { NavMask } from './mask';
import { seaStateBand, waveHourIndexAt } from './waves';

const STRIP_STEP_H = 3;
/** Below this mean resultant length the direction reads as variable. */
export const VARIABLE_RESULTANT = 0.5;

type Lattice = Pick<WindGrid, 'lats' | 'lons'>;

/** Flat indices of the lattice points whose own cell is in-mask water. */
export function waterLatticePoints(
  mask: Pick<NavMask, 'inBounds' | 'depthM'>,
  grid: Lattice,
): number[] {
  const out: number[] = [];
  const nLon = grid.lons.length;
  for (let la = 0; la < grid.lats.length; la++)
    for (let lo = 0; lo < nLon; lo++) {
      const p = { lat: grid.lats[la]!, lon: grid.lons[lo]! };
      if (mask.inBounds(p) && mask.depthM(p) > 0) out.push(la * nLon + lo);
    }
  return out;
}

export function latticePoint(grid: Lattice, k: number): LatLon {
  const nLon = grid.lons.length;
  return { lat: grid.lats[Math.floor(k / nLon)]!, lon: grid.lons[k % nLon]! };
}

/** The point nearest `p` (equirectangular), or null for an empty set. */
export function nearestLatticePoint(
  grid: Lattice,
  points: readonly number[],
  p: LatLon,
): number | null {
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  let best: number | null = null;
  let bestD = Infinity;
  for (const k of points) {
    const q = latticePoint(grid, k);
    const d = (q.lat - p.lat) ** 2 + ((q.lon - p.lon) * cosLat) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export interface WindSummary {
  minKn: number;
  maxKn: number;
  /** Null when no gust value is finite. */
  gustKn: number | null;
  /** Speed-weighted circular mean (FROM); null when variable. */
  dirFromDeg: number | null;
}

export interface ScopeSummary {
  wind: WindSummary | null;
  seaMaxM: number | null;
}

/** Min/max mean wind, max gust, mean direction and max Hs over points × hours. */
export function summariseScope(
  wind: WindGrid,
  wave: WaveGrid | null,
  windPoints: readonly number[],
  wavePoints: readonly number[],
  hoursMs: readonly number[],
): ScopeSummary {
  const nWind = wind.lats.length * wind.lons.length;
  let minKn = Infinity;
  let maxKn = -Infinity;
  let gustKn = -Infinity;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let seaMaxM = -Infinity;
  for (const h of hoursMs) {
    const i = wind.timesMs.indexOf(h);
    if (i >= 0)
      for (const k of windPoints) {
        const s = wind.speedKn[i * nWind + k] ?? NaN;
        const g = wind.gustKn[i * nWind + k] ?? NaN;
        const d = wind.dirFromDeg[i * nWind + k] ?? NaN;
        if (Number.isFinite(g)) gustKn = Math.max(gustKn, g);
        if (!Number.isFinite(s) || s < 0) continue;
        minKn = Math.min(minKn, s);
        maxKn = Math.max(maxKn, s);
        if (!Number.isFinite(d)) continue;
        const r = (d * Math.PI) / 180;
        sx += s * Math.sin(r);
        sy += s * Math.cos(r);
        sw += s;
      }
    if (!wave) continue;
    const j = waveHourIndexAt(wave, h);
    if (j === null) continue;
    const nWave = wave.lats.length * wave.lons.length;
    for (const k of wavePoints) {
      const hs = wave.waveHeightM[j * nWave + k] ?? NaN;
      if (seaStateBand(hs) !== 'no-data') seaMaxM = Math.max(seaMaxM, hs);
    }
  }
  let dirFromDeg: number | null = null;
  if (sw > 0 && Math.hypot(sx, sy) / sw >= VARIABLE_RESULTANT) {
    dirFromDeg = ((((Math.atan2(sx, sy) * 180) / Math.PI) % 360) + 360) % 360;
  }
  return {
    wind:
      minKn === Infinity
        ? null
        : { minKn, maxKn, gustKn: gustKn === -Infinity ? null : gustKn, dirFromDeg },
    seaMaxM: seaMaxM === -Infinity ? null : seaMaxM,
  };
}

export interface StripWindow {
  startMs: number;
  hoursMs: number[];
}

/**
 * The 3-hour local windows (00–21) of the day holding `dayMs`, each with the
 * `options` hours it holds. Windows without an option (past, or beyond the
 * horizon) are left out.
 */
export function stripWindows(options: readonly number[], dayMs: number): StripWindow[] {
  const starts: number[] = [];
  for (let h = 0; h <= 24; h += STRIP_STEP_H) {
    const d = new Date(dayMs);
    d.setHours(h, 0, 0, 0);
    starts.push(d.getTime());
  }
  const out: StripWindow[] = [];
  for (let w = 0; w + 1 < starts.length; w++) {
    const from = starts[w]!;
    const to = starts[w + 1]!;
    const hoursMs = options.filter((t) => t >= from && t < to);
    if (hoursMs.length > 0) out.push({ startMs: from, hoursMs });
  }
  return out;
}

/** The window holding `hourMs`, by start; null when none does. */
export function windowOf(windows: readonly StripWindow[], hourMs: number): number | null {
  for (const w of windows) if (w.hoursMs.includes(hourMs)) return w.startMs;
  return null;
}
