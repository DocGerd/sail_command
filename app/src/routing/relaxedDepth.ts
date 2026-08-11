import type { LatLon } from '../types';
import type { NavMask } from '../lib/mask';
import { approachGate, type DepthGate } from '../lib/depthGate';

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
  // Upper bound on probes across BOTH phases of the search below (#452): the
  // shared binary search, plus one per-disc ascent per waypoint. Under the
  // `approachRadiusM = Infinity` kill switch phase 2 does not run, and this
  // reports the phase-1 bound exactly.
  total: number;
}

export type ProbeProgress = (info: ProbeInfo) => void;

/** What {@link findRelaxedGate} discovered. */
export interface RelaxedGate {
  /**
   * The gate to solve at: an `ApproachGate` for a finite radius, a
   * `UniformGate` under the kill switch.
   */
  readonly gate: DepthGate;
  /**
   * The SHALLOWEST gate granted anywhere = the minimum over the disc gates.
   * This is the conservative reading — the shallowest licence the plan hands
   * out — and it is what `ShallowInfo.usedDepthM` reports.
   */
  readonly usedDepthM: number;
}

/**
 * #53 relaxed-depth discovery, scoped to waypoint approaches by #452 P3.
 *
 * PHASE 1 (unchanged in shape from the pre-#452 `findRelaxedDepthM`):
 * binary-search the HIGHEST decimeter-quantized depth gate in
 * [2.1 m, requestedDepthM) at which every consecutive pair of snapped
 * waypoints is 4-connected. Each probe is a cheap mask BFS
 * (NavMask.cellsConnected) — no isochrone run. The only change is that the
 * probe consults a per-cell FIELD (relaxed inside each waypoint's disc, the
 * requested depth everywhere else) instead of a route-wide scalar.
 *
 * Monotonicity — the soundness licence — still holds: lowering the probe
 * depth lowers only IN-DISC gates and leaves out-of-disc cells at
 * `requestedDepthM`, so the navigable set at a lower probe is still a
 * superset of the set at a higher one.
 *
 * PHASE 2 (#452 spike §3.2 graft 1), skipped under the kill switch: per-DISC
 * coordinate ascent. Phase 1 hands every disc the SAME gate, so a waypoint
 * whose approach needs nothing is granted the depth the worst pinch on the
 * chain needed. Here each disc is raised, one at a time, to the highest gate
 * at which the whole chain still connects with every other disc held where it
 * is. Sound because raising ONE disc's gate only REMOVES cells, so
 * connectivity is monotone decreasing in that one coordinate; it terminates
 * by construction, only ever raises gates from a configuration already known
 * to connect, and re-probes at every step, so the returned configuration
 * provably connects.
 *
 * This is P1's per-patch idea applied per DISC, not per PATCH — it runs no
 * witness BFS, performs no dilation, and carries none of P1's unmeasured
 * dilation radius. Read it as an adaptation, not as P1's mechanism.
 *
 * CONTAINMENT, stated exactly: the final licensed set is a provable SUBSET of
 * phase 1's own uniform-gate set (every disc gate only rises; out-of-disc
 * cells sit at `requestedDepthM`, which is at or above any probe). It is NOT
 * a subset of the pre-#452 globally-relaxed set — a localized connectivity
 * search is strictly harder to satisfy, so the gate it finds can come out
 * LOWER than the global search's. That is spike §2.3's named trade.
 *
 * `approachRadiusM` is a PARAMETER, never read from a module constant here:
 * tests inject `Infinity` for the kill switch, and the production constant's
 * single use site stays visible at the `planRoute.ts` call.
 *
 * Returns null when requestedDepthM <= 2.1 m (nothing to relax within the
 * floor) or no candidate gate connects.
 */
export function findRelaxedGate(
  mask: NavMask,
  waypoints: LatLon[],
  requestedDepthM: number,
  approachRadiusM: number,
  onProbe?: ProbeProgress,
): RelaxedGate | null {
  const loDm = Math.round(BOAT_DRAFT_M * 10);
  // Highest decimeter strictly below the requested depth. The 1e-9 nudge
  // absorbs IEEE 754 artifacts like 2.2 * 10 === 22.000000000000004, which
  // would otherwise admit the requested depth itself as a candidate.
  const hiDm = Math.ceil(requestedDepthM * 10 - 1e-9) - 1;
  if (hiDm < loDm) return null;

  const scopedGate = (gatesDm: readonly number[]): DepthGate =>
    approachGate(
      mask.meta,
      waypoints,
      requestedDepthM,
      gatesDm.map((dm) => dm / 10),
      approachRadiusM,
    );

  const connectsWith = (gatesDm: readonly number[]): boolean => {
    const gate = scopedGate(gatesDm);
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!mask.cellsConnected(waypoints[i], waypoints[i + 1], gate)) return false;
    }
    return true;
  };

  // Binary search over n candidates takes at most ceil(log2(n + 1)) probes.
  const phase1Total = Math.ceil(Math.log2(hiDm - loDm + 2));
  const scoped = Number.isFinite(approachRadiusM);
  const total = scoped ? phase1Total * (1 + waypoints.length) : phase1Total;
  let lo = loDm;
  let hi = hiDm;
  let best: number | null = null;
  let done = 0;
  const probe = (depthDm: number, gatesDm: readonly number[]): boolean => {
    done++;
    onProbe?.({ probeDepthM: depthDm / 10, done, total });
    return connectsWith(gatesDm);
  };

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (
      probe(
        mid,
        waypoints.map(() => mid),
      )
    ) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === null) return null;

  const gatesDm = waypoints.map(() => best);
  if (scoped) {
    for (let i = 0; i < gatesDm.length; i++) {
      let ascentLo = gatesDm[i] + 1;
      let ascentHi = hiDm;
      let found = gatesDm[i];
      while (ascentLo <= ascentHi) {
        const mid = (ascentLo + ascentHi) >> 1;
        const trial = [...gatesDm];
        trial[i] = mid;
        if (probe(mid, trial)) {
          found = mid;
          ascentLo = mid + 1;
        } else {
          ascentHi = mid - 1;
        }
      }
      gatesDm[i] = found;
    }
  }

  return {
    gate: scopedGate(gatesDm),
    usedDepthM: Math.min(...gatesDm) / 10,
  };
}
