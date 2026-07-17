import type {
  LatLon,
  Leg,
  NoRouteReason,
  PlanRequest,
  PlanResult,
  PolarTable,
  Rig,
  RigResult,
  Settings,
  ShallowInfo,
  WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { BOAT_DRAFT_M, findRelaxedDepthM, type ProbeProgress } from './relaxedDepth';

export interface PlanDeps {
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  mask: NavMask;
}

export type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;

interface RunOut {
  rigResult: RigResult | null;
  reason: NoRouteReason | null;
}

/**
 * #68 reason propagation: fold the two rigs' failure reasons from the RELAXED
 * re-solve into one plan-level reason. Precedence encodes actionability, so the
 * class the user can act on wins when the rigs disagree:
 *   'beyond-horizon' (change departure / refresh forecast)
 *   > 'calm-motor-off' (enable motor)
 *   > 'unreachable' (mask-level, nothing the user can change).
 * Both rigs share mask/wind/waypoints and differ only in polar table, so a
 * disagreement is rare — but the fold is deterministic so the result is stable.
 */
function combineNoRouteReason(a: NoRouteReason | null, b: NoRouteReason | null): NoRouteReason {
  if (a === 'beyond-horizon' || b === 'beyond-horizon') return 'beyond-horizon';
  if (a === 'calm-motor-off' || b === 'calm-motor-off') return 'calm-motor-off';
  return 'unreachable';
}

/**
 * #53: flag every leg whose geometry crosses cells charted below the REQUESTED
 * safety depth with that leg's minimum charted depth, across both rig results,
 * and derive the plan-level ShallowInfo (minGateDepthM = shallowest such cell
 * actually traversed). Returns null when no leg of either rig crosses
 * sub-requested cells — the relaxed gate merely widened the search without the
 * route using it, so the route is requested-depth-valid and carries no warning.
 */
function flagShallowLegs(
  mask: NavMask,
  rigs: { genoa: RunOut; fock: RunOut },
  requestedDepthM: number,
  usedDepthM: number,
): ShallowInfo | null {
  let minGateDepthM = Infinity;
  const flagLeg = (leg: Leg): Leg => {
    const minDepthM = mask.segmentShallowestBelow(leg.start, leg.end, requestedDepthM);
    if (minDepthM === null) return leg;
    if (minDepthM < minGateDepthM) minGateDepthM = minDepthM;
    // Narrow on kind (never cast) so each variant's spread keeps its own shape.
    return leg.kind === 'sail'
      ? { ...leg, shallow: { minDepthM } }
      : { ...leg, shallow: { minDepthM } };
  };
  for (const out of [rigs.genoa, rigs.fock]) {
    if (out.rigResult) out.rigResult.legs = out.rigResult.legs.map(flagLeg);
  }
  return minGateDepthM === Infinity ? null : { requestedDepthM, usedDepthM, minGateDepthM };
}

export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
  onProbe?: ProbeProgress,
): PlanResult {
  const { mask } = deps;
  const s = req.settings;
  const origin = mask.snapToNavigable(req.origin, s.safetyDepthM);
  if (!origin) return { status: 'error', reason: 'snap-failed-origin' };
  const destination = mask.snapToNavigable(req.destination, s.safetyDepthM);
  if (!destination) return { status: 'error', reason: 'snap-failed-destination' };

  const viaPoints: LatLon[] = [];
  for (const v of req.viaPoints) {
    const snapped = mask.snapToNavigable(v, s.safetyDepthM);
    if (!snapped) return { status: 'error', reason: 'snap-failed-via' };
    viaPoints.push(snapped);
  }
  const waypoints = [origin, ...viaPoints, destination];

  const wind = new WindField(windGrid);
  const run = (rig: Rig, table: PolarTable, settings: Settings): RunOut => {
    const polar = new Polar(table, settings.performanceFactor);
    const legs: Leg[] = [];
    // Segments are solved sequentially, each departing at the previous
    // segment's ETA. Maneuver state (board, tack/gybe count) is v1-simplified
    // to reset at each via-point joint: a board change across a via is not
    // charged a maneuver penalty.
    let departureMs = req.departureMs;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const res = solve({
        origin: waypoints[i],
        destination: waypoints[i + 1],
        departureMs,
        polar,
        wind,
        mask,
        settings,
        onProgress: (info) => onProgress?.(rig, info),
      });
      if (res.status !== 'ok') return { rigResult: null, reason: res.reason };
      legs.push(...mergeCollinearLegs(res.legs, mask, wind, settings));
      departureMs = res.etaMs;
    }
    const etaMs = departureMs;
    const rigResult: RigResult = {
      rig,
      legs,
      etaMs,
      durationMs: etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { rigResult, reason: null };
  };
  const runBoth = (settings: Settings) => ({
    genoa: run('genoa', deps.polarGenoa, settings),
    fock: run('fock', deps.polarFock, settings),
  });

  const assemble = (genoa: RunOut, fock: RunOut, shallow: ShallowInfo | null): PlanResult => {
    const recommended: Rig =
      genoa.rigResult && fock.rigResult
        ? genoa.rigResult.etaMs <= fock.rigResult.etaMs
          ? 'genoa'
          : 'fock'
        : genoa.rigResult
          ? 'genoa'
          : 'fock';
    return {
      status: 'ok',
      genoa: genoa.rigResult,
      fock: fock.rigResult,
      genoaReason: genoa.rigResult ? null : genoa.reason,
      fockReason: fock.rigResult ? null : fock.reason,
      recommended,
      snappedOrigin: origin,
      snappedDestination: destination,
      // exactOptionalPropertyTypes: omit the key entirely when there is no
      // warning — never assign undefined explicitly.
      ...(shallow ? { shallow } : {}),
    };
  };

  const connectedAt = (depthM: number): boolean => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!mask.cellsConnected(waypoints[i], waypoints[i + 1], depthM)) return false;
    }
    return true;
  };

  // #53 fast path: any solver route implies a 4-connected navigable cell chain
  // between consecutive snapped waypoints (segmentNavigable's traversal steps
  // one cell at a time in x or y, so every validated leg sweeps such a chain).
  // A mask disconnected at the requested gate therefore makes both full solves
  // a foregone 'unreachable' — classify directly (one cheap BFS) instead of
  // burning two doomed isochrone runs first. This also classifies a
  // disconnected-AND-calm plan as 'unreachable' rather than the solver's
  // death-count heuristic guess, which is the more accurate class.
  let reason: NoRouteReason = 'unreachable';
  if (connectedAt(s.safetyDepthM)) {
    const attempt = runBoth(s);
    if (attempt.genoa.rigResult || attempt.fock.rigResult)
      return assemble(attempt.genoa, attempt.fock, null);
    // Arbitrary tie-break: report genoa's reason (checked first); both rigs solve
    // identical mask/wind/waypoints and differ only in polar table, so their
    // failure reasons rarely differ in practice.
    reason = attempt.genoa.reason!;
  }

  // #53 graceful degradation below safety depth: ONLY the mask-unreachability
  // class relaxes — calm-motor-off and beyond-horizon keep their errors — and
  // never at or below the boat-draft floor. The relaxed gate is discovered
  // once (cheap mask BFS probes, no solver runs), then BOTH rigs solve at that
  // single gate, so the rig comparison stays apples-to-apples by construction.
  // The user's safetyDepthM setting is NEVER mutated: the relaxed gate lives
  // only in a solver-local Settings copy, per-plan, never sticky.
  if (reason === 'unreachable' && s.safetyDepthM > BOAT_DRAFT_M) {
    const usedDepthM = findRelaxedDepthM(mask, waypoints, s.safetyDepthM, onProbe);
    if (usedDepthM !== null) {
      const relaxed = runBoth({ ...s, safetyDepthM: usedDepthM });
      if (relaxed.genoa.rigResult || relaxed.fock.rigResult) {
        const shallow = flagShallowLegs(mask, relaxed, s.safetyDepthM, usedDepthM);
        return assemble(relaxed.genoa, relaxed.fock, shallow);
      }
      // #68: relaxation FOUND a connected gate but both rigs still failed to
      // solve there, so this is no longer a mask-level failure — propagate the
      // relaxed solve's OWN class (beyond-horizon / calm-motor-off are
      // actionable) rather than leaving the stale 'unreachable'. See
      // combineNoRouteReason for the rig-disagreement precedence.
      reason = combineNoRouteReason(relaxed.genoa.reason, relaxed.fock.reason);
    }
  }
  // The relaxed solve failed (or no gate connected / relaxation not attempted):
  // report `reason` — 'unreachable' when the mask never connected, else the
  // propagated relaxed-solve class.
  return { status: 'error', reason };
}
