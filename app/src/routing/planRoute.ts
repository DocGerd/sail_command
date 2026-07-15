import type {
  LatLon, Leg, PlanRequest, PlanResult, PolarTable, Rig, RigResult, WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';

export interface PlanDeps {
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  mask: NavMask;
}

export type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;

export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
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
  const run = (rig: Rig, table: PolarTable) => {
    const polar = new Polar(table, s.performanceFactor);
    const legs: Leg[] = [];
    // Segments are solved sequentially, each departing at the previous
    // segment's ETA. Maneuver state (board, tack/gybe count) is v1-simplified
    // to reset at each via-point joint: a board change across a via is not
    // charged a maneuver penalty.
    let departureMs = req.departureMs;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const res = solve({
        origin: waypoints[i], destination: waypoints[i + 1], departureMs,
        polar, wind, mask, settings: s,
        onProgress: (info) => onProgress?.(rig, info),
      });
      if (res.status !== 'ok') return { rigResult: null, reason: res.reason };
      legs.push(...mergeCollinearLegs(res.legs, mask, wind, s));
      departureMs = res.etaMs;
    }
    const etaMs = departureMs;
    const rigResult: RigResult = {
      rig, legs, etaMs,
      durationMs: etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { rigResult, reason: null };
  };

  const genoa = run('genoa', deps.polarGenoa);
  const fock = run('fock', deps.polarFock);
  if (!genoa.rigResult && !fock.rigResult)
    // Arbitrary tie-break: report genoa's reason (checked first); both rigs solve
    // identical mask/wind/waypoints and differ only in polar table, so their
    // failure reasons rarely differ in practice.
    return { status: 'error', reason: genoa.reason! };

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
    recommended,
    snappedOrigin: origin,
    snappedDestination: destination,
  };
}
