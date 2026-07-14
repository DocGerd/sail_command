import type {
  PlanRequest, PlanResult, PolarTable, Rig, RigResult, WindGrid,
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
  const origin = mask.snapToNavigable(req.origin, s.safetyDepthM, 500);
  if (!origin) return { status: 'error', reason: 'snap-failed-origin' };
  const destination = mask.snapToNavigable(req.destination, s.safetyDepthM, 500);
  if (!destination) return { status: 'error', reason: 'snap-failed-destination' };

  const wind = new WindField(windGrid);
  const run = (rig: Rig, table: PolarTable) => {
    const res = solve({
      origin, destination, departureMs: req.departureMs,
      polar: new Polar(table, s.performanceFactor),
      wind, mask, settings: s,
      onProgress: (info) => onProgress?.(rig, info),
    });
    if (res.status !== 'ok') return { rigResult: null, reason: res.reason };
    const legs = mergeCollinearLegs(res.legs, mask, wind, s);
    const rigResult: RigResult = {
      rig, legs, etaMs: res.etaMs,
      durationMs: res.etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { rigResult, reason: null };
  };

  const genoa = run('genoa', deps.polarGenoa);
  const fock = run('fock', deps.polarFock);
  if (!genoa.rigResult && !fock.rigResult)
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
