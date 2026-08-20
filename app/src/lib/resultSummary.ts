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
//
// DELIBERATELY NOT EXPORTED: every consumer goes through sailLabelKey below.
// A `Record<SailId, MsgKey>` is TOTAL at compile time and PARTIAL at rest —
// services/migratePlan.ts mints SailId from unvalidated stored strings by
// design (its own comment calls that cast load-bearing, and
// migratePlan.catalogueRename.test.ts pins that a renamed catalogue must
// still READ an existing plan), so a stored id the current catalogue lacks is
// a designed-for state. Indexing this map directly with one yielded
// `undefined`, which `useT` (a bare `dicts[lang][key]` lookup, no fallback,
// no throw) passes straight through. MEASURED by reverting this helper to a
// direct index: the rig tab and the per-leg sail chip render NO sail name at
// all, and the recommendation chip renders the literal `Faster: undefined`.
// Keeping the map private makes tsc reject a new direct index from another
// module.
const RIG_LABEL_KEY: Record<SailId, MsgKey> = {
  genoa: 'route.rig.genoa',
  fock: 'route.rig.fock',
};

/**
 * The one way to name a sail in the UI. Takes a plain `string`, not a
 * `SailId`: the whole point is the ids the union does not cover.
 */
export function sailLabelKey(id: string): MsgKey {
  return (RIG_LABEL_KEY as Record<string, MsgKey | undefined>)[id] ?? 'route.rig.unknown';
}

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

/**
 * #553 / spec §N.4: the MsgKey each `RigRecommendation.kind` renders as.
 *
 * Exists because both display surfaces (RouteSummary's rig chip and
 * PlannerPanel's Ergebnis-strip chip) previously wrote the same inline
 * `kind === 'moot' ? 'route.rigMoot' : 'route.rigTie'` ternary, which is
 * EXHAUSTIVE-BY-ACCIDENT: it has no `default`, so adding a fourth variant
 * silently routed it to `route.rigTie` — i.e. a plan where no comparison
 * happened at all would have claimed the two sails were "effectively tied".
 * Neither the compiler nor any existing test can see that, because a ternary
 * over a widened union still typechecks.
 *
 * A `switch` with a `never`-typed exhaustiveness arm reds the BUILD instead,
 * so the next variant added to `RigRecommendation` cannot ship without copy.
 *
 * `'decided'` is EXCLUDED from the parameter rather than handled: its key
 * `route.fasterRig` is `'Faster: {rig}'`, so a caller doing
 * `t(rigVerdictKey(kind))` with no `{ rig }` argument would render the literal
 * `Faster: {rig}` to the user. Documenting that callers must not do it is
 * weaker than making it a type error, and this is an exported helper that
 * otherwise reads like a total mapping. Both call sites already branch on
 * `kind === 'decided'` first, so TypeScript narrows to the remaining members
 * in the else branch and they typecheck unchanged. The exhaustiveness
 * property is unaffected — a new variant still reds the `never` arm.
 */
export function rigVerdictKey(kind: Exclude<RigRecommendation['kind'], 'decided'>): MsgKey {
  switch (kind) {
    case 'tie':
      return 'route.rigTie';
    case 'moot':
      return 'route.rigMoot';
    case 'not-compared':
      return 'route.rigNotCompared';
    default: {
      // `erasableSyntaxOnly`-safe exhaustiveness check: a new variant makes
      // this assignment a type error at BUILD time, naming the file that
      // needs the new string.
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * #540 spec §E.3: the MsgKey a display surface should render for a
 * non-'decided' verdict, given ALSO whether the plan's comparison finished.
 *
 * `rigVerdictKey` alone maps every 'not-compared' cause — N=1, N>=3, one
 * sail failing, tier-C suppression, AND budget exhaustion — onto the single
 * generic `route.rigNotCompared`. That collapses "there was nothing to
 * compare" and "we ran out of time before finishing the comparison" into
 * one sentence, which is exactly the misread spec §E.3 exists to prevent: a
 * budget-truncated plan still returns `status: 'ok'` with a recommendation
 * computed over one completed sail, and presenting that unchanged reads as
 * "we compared both and this one is faster".
 *
 * Driven by `PlanResultOk.comparisonComplete` (already computed by
 * `planRoute.ts`'s `assemble()` — no new field). No new `RigRecommendation`
 * variant: this stays a presentation-only reinterpretation of the existing
 * 'not-compared' kind, so `PlanResult` and `RigRecommendation` stay
 * byte-identical and no `app/sweep/` acceptance sweep is owed.
 *
 * Deliberately narrower than "nothing in this plan's search was ever cut
 * short" — see the #540 issue comment quoted in dict.en.ts's
 * `route.comparisonIncomplete` entry: `comparisonComplete` is computed PER
 * TIER, so a plan that fell back to an earlier tier after a
 * budget-truncated attempt can still report `true` for the tier that
 * produced the result. This only claims the REPORTED comparison did not
 * finish.
 */
export function resultVerdictKey(
  kind: Exclude<RigRecommendation['kind'], 'decided'>,
  comparisonComplete: boolean,
): MsgKey {
  if (kind === 'not-compared' && !comparisonComplete) {
    return 'route.comparisonIncomplete';
  }
  return rigVerdictKey(kind);
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
    distanceText: formatNm(result.distanceNm, lang),
    durationText: formatDuration(result.durationMs),
    avgSpeedKn,
    avgSpeedText: formatKn(avgSpeedKn, lang),
    rigRecommendation,
    sailNm,
    motorNm,
    sailFraction,
    motorFraction,
    sailPct,
    motorPct,
  };
}
