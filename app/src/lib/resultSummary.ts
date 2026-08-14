// Single-source results formatter (#64 phase 3). Both surfaces that show a
// plan's result — the compact Ergebnis strip in the Plan tab and the full
// Ergebnis card in the Routes tab — derive their display fields here so the
// two never drift. Pure: reads the in-memory plan + the active rig's result
// only (no re-fetch, no wind-grid sampling, offline-safe).
import type { MsgKey } from '../i18n/dict.de';
import type { Plan, PlanResultOk, RigResult, RigRecommendation, SailId } from '../types';
import { formatDateTime, formatDuration, formatKn, formatNm, type Lang } from './format';

// SailId -> its display label key. Shared so RouteSummary and the planner
// strip name the sail identically (the recommended sail is the faster one
// the router picked — see the source spec's twice-per-plan rule).
export const RIG_LABEL_KEY: Record<SailId, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

// #340/#54: the router's actual, fixed solve order used to drive the
// planner panel's "sail N of 2" phase readout is now `request.sailIds`
// itself (types.ts's PlanRequest field) — no longer a module constant here
// or in types.ts (the deleted RIG_ORDER). usePlanFlow.ts computes index/total
// from it directly; that coupling is enforced by
// routing/planRoute.test.ts's "#340/#54: solve order matches
// request.sailIds" guard test.

export interface ResultSummary {
  arrivalText: string;
  distanceText: string;
  durationText: string;
  // Average speed derived from distance/duration — RigResult carries no
  // avgSpeed field, so it is computed here once for both surfaces.
  avgSpeedKn: number;
  avgSpeedText: string;
  // #259: the honest rig comparison, plan-level, independent of which rig is
  // currently displayed. A 'decided' pick names the faster rig; 'tie'/'moot'
  // mean neither rig should be badged as recommended. See rigRecommendationOf
  // below for the resolution rule. This is deliberately the ONLY
  // rig-comparison field on ResultSummary (#275 review, Minor 6): an earlier
  // draft also carried an unqualified `recommendedRig`/`recommendedRigLabelKey`
  // pair with zero production consumers once PlannerPanel switched to this
  // field, and keeping an unqualified duplicate right next to the qualified
  // one is the exact ambiguity #259 was filed to remove — a future component
  // reaching for the obvious-looking unqualified pick would reintroduce the
  // silent-genoa badge with no test failing. If a consumer ever needs *a*
  // rig unconditionally again, derive it from `rigRecommendation` at the call
  // site (`kind === 'decided' ? rig : <fallback>`) rather than re-adding an
  // unqualified field here.
  rigRecommendation: RigRecommendation;
  // Sail/motor split (motor legs are first-class per the source spec).
  sailNm: number;
  motorNm: number;
  sailFraction: number; // 0..1, of total distance
  motorFraction: number; // 0..1
  sailPct: number; // integer percent, sailPct + motorPct === 100 when distance > 0
  motorPct: number;
}

/**
 * #259: the honest rig comparison for a plan. Falls back to a plain
 * 'decided' pick of the recorded `recommended` rig when `rigRecommendation`
 * is absent — pre-#259 PlanResultOk literals across the test suite (and any
 * plan solved before this field existed) never set it, and a bare
 * `recommended: SailId` is exactly what those literals always meant. Exported so
 * both display surfaces (this file's resultSummary() below, and RouteSummary
 * directly for the plan-level tab star that renders even when the active
 * rig's own result is null) resolve it identically — see the file banner on
 * why the two must never drift.
 */
export function rigRecommendationOf(result: PlanResultOk): RigRecommendation {
  return result.rigRecommendation ?? { kind: 'decided', rig: result.recommended };
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
  const rigRecommendation = rigRecommendationOf(plan.result);

  return {
    arrivalText: formatDateTime(result.etaMs, lang),
    distanceText: formatNm(result.distanceNm),
    durationText: formatDuration(result.durationMs),
    avgSpeedKn,
    avgSpeedText: formatKn(avgSpeedKn),
    rigRecommendation,
    sailNm,
    motorNm,
    sailFraction,
    motorFraction,
    sailPct,
    motorPct,
  };
}
