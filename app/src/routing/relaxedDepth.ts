import type { LatLon } from '../types';
import type { NavMask } from '../lib/mask';

/**
 * Salona 45 draft — the hard floor for #53's graceful degradation: the relaxed
 * depth gate never goes below this, and a requested safety depth at or below
 * it never relaxes at all.
 */
export const BOAT_DRAFT_M = 2.1;

/** One relaxed-depth connectivity probe, reported as it starts. */
export interface ProbeInfo {
  probeDepthM: number; // the decimeter gate this probe tests
  done: number; // 1-based probe counter
  total: number; // upper bound on probes for this binary search
}

export type ProbeProgress = (info: ProbeInfo) => void;

/**
 * #53 relaxed-depth discovery: binary-search the HIGHEST decimeter-quantized
 * depth gate in [2.1 m, requestedDepthM) at which every consecutive pair of
 * snapped waypoints (origin → vias → destination; the spec's via-less case is
 * destination snap cell ↔ start snap cell) is 4-connected on the mask. Each
 * probe is a cheap mask BFS (NavMask.cellsConnected) — no isochrone run.
 *
 * The search is sound because connectivity is monotone in the gate: the
 * navigable cell set at a lower gate is a superset of the set at a higher one,
 * so connected-at-d implies connected-at-anything-below-d.
 *
 * Returns the relaxed gate in metres, or null when requestedDepthM <= 2.1 m
 * (nothing to relax within the floor) or no candidate gate connects.
 */
export function findRelaxedDepthM(
  mask: NavMask,
  waypoints: LatLon[],
  requestedDepthM: number,
  onProbe?: ProbeProgress,
): number | null {
  const loDm = Math.round(BOAT_DRAFT_M * 10);
  // Highest decimeter strictly below the requested depth. The 1e-9 nudge
  // absorbs IEEE 754 artifacts like 2.2 * 10 === 22.000000000000004, which
  // would otherwise admit the requested depth itself as a candidate.
  const hiDm = Math.ceil(requestedDepthM * 10 - 1e-9) - 1;
  if (hiDm < loDm) return null;

  const connectedAt = (depthM: number): boolean => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!mask.cellsConnected(waypoints[i], waypoints[i + 1], depthM)) return false;
    }
    return true;
  };

  // Binary search over n candidates takes at most ceil(log2(n + 1)) probes.
  const total = Math.ceil(Math.log2(hiDm - loDm + 2));
  let lo = loDm;
  let hi = hiDm;
  let best: number | null = null;
  let done = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const probeDepthM = mid / 10;
    done++;
    onProbe?.({ probeDepthM, done, total });
    if (connectedAt(probeDepthM)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best === null ? null : best / 10;
}
