// Single-source results formatter (#64 phase 3). Both surfaces that show a
// plan's result — the compact Ergebnis strip in the Plan tab and the full
// Ergebnis card in the Routes tab — derive their display fields here so the
// two never drift. Pure: reads the in-memory plan + the active rig's result
// only (no re-fetch, no wind-grid sampling, offline-safe).
import type { MsgKey } from '../i18n/dict.de';
import type { Plan, Rig, RigResult } from '../types';
import { formatDateTime, formatDuration, formatKn, formatNm, type Lang } from './format';

// Rig -> its display label key. Shared so RouteSummary and the planner strip
// name the rig identically (the recommended rig is the faster one the router
// picked — see the source spec's twice-per-plan rule).
export const RIG_LABEL_KEY: Record<Rig, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

export interface ResultSummary {
  arrivalText: string;
  distanceText: string;
  durationText: string;
  // Average speed derived from distance/duration — RigResult carries no
  // avgSpeed field, so it is computed here once for both surfaces.
  avgSpeedKn: number;
  avgSpeedText: string;
  // The recommended (= faster) rig, plan-level, independent of which rig is
  // currently displayed.
  recommendedRig: Rig;
  recommendedRigLabelKey: MsgKey;
  // Sail/motor split (motor legs are first-class per the source spec).
  sailNm: number;
  motorNm: number;
  sailFraction: number; // 0..1, of total distance
  motorFraction: number; // 0..1
  sailPct: number; // integer percent, sailPct + motorPct === 100 when distance > 0
  motorPct: number;
}

/** Average speed in knots over the whole passage; 0 for a zero-duration result. */
export function averageSpeedKn(distanceNm: number, durationMs: number): number {
  const hours = durationMs / 3_600_000;
  return hours > 0 ? distanceNm / hours : 0;
}

export function resultSummary(plan: Plan, result: RigResult, lang: Lang): ResultSummary {
  const avgSpeedKn = averageSpeedKn(result.distanceNm, result.durationMs);
  const motorNm = result.motorDistanceNm;
  const sailNm = Math.max(0, result.distanceNm - motorNm);
  const total = result.distanceNm;
  const motorFraction = total > 0 ? motorNm / total : 0;
  const sailFraction = total > 0 ? sailNm / total : 0;
  // Round the motor share and derive sail as the complement so the two always
  // sum to 100 (a proportional two-segment bar must not show 99/2 etc.).
  const motorPct = total > 0 ? Math.round(motorFraction * 100) : 0;
  const sailPct = total > 0 ? 100 - motorPct : 0;
  const recommendedRig = plan.result.recommended;

  return {
    arrivalText: formatDateTime(result.etaMs, lang),
    distanceText: formatNm(result.distanceNm),
    durationText: formatDuration(result.durationMs),
    avgSpeedKn,
    avgSpeedText: formatKn(avgSpeedKn),
    recommendedRig,
    recommendedRigLabelKey: RIG_LABEL_KEY[recommendedRig],
    sailNm,
    motorNm,
    sailFraction,
    motorFraction,
    sailPct,
    motorPct,
  };
}
