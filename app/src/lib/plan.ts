import type { MsgKey } from '../i18n/dict.de';
import type { NoRouteReason, Plan, PlanRequest, RigResult, SailId } from '../types';

// Spec §4: "Stale forecast (fetch → departure gap > 12 h)" — strictly
// greater, so a plan departing exactly 12 h after its wind was fetched is
// not flagged.
const STALE_THRESHOLD_MS = 12 * 3_600_000;

// Shared between usePlanFlow.ts (initial plan) and state/replan.ts (via
// re-route) — both drive a router result to the same user-visible error
// copy, so the mapping lives once here rather than being duplicated.
// snap-failed-via isn't called out by name in the E3 brief's original
// mapping list (which only enumerated unreachable/beyondHorizon/
// calmMotorOff/snapOrigin/snapDestination), but NoRouteReason has more
// members than that list and vias are a first-class waypoint kind
// (routing/viaPoints handling in planRoute.ts) — completing the Record here
// rather than leaving this reason to fall through to error.internal. The
// Record is exhaustive over NoRouteReason, so the compiler, not this
// comment, is what keeps it complete as that union grows.
export const NO_ROUTE_MESSAGE_KEY: Record<NoRouteReason, MsgKey> = {
  unreachable: 'error.noRoute.unreachable',
  'beyond-horizon': 'error.noRoute.beyondHorizon',
  'calm-motor-off': 'error.noRoute.calmMotorOff',
  'snap-failed-origin': 'error.noRoute.snapOrigin',
  'snap-failed-destination': 'error.noRoute.snapDestination',
  'snap-failed-via': 'error.noRoute.snapVia',
  'search-budget-exceeded': 'error.noRoute.searchBudget',
  'calm-sail-only': 'error.noRoute.calmSailOnly',
  'segment-mode-conflict': 'error.noRoute.segmentModeConflict',
  'segment-modes-invalid': 'error.noRoute.segmentModesInvalid',
};

/**
 * #885 §4: the copy for a no-route reason, given the request that produced it.
 * Labels stay a function of the cause (#282); only the remedy sentence depends on
 * the request, so it is chosen here rather than by minting new labels. Every
 * render site uses this; migratePlan's membership check still reads the table.
 */
export function noRouteMessageKey(
  reason: NoRouteReason,
  request: Pick<PlanRequest, 'segmentModes' | 'settings'>,
): MsgKey {
  // With the motor off, unmarking the segment alone cannot help (§3.2).
  if (reason === 'calm-sail-only' && !request.settings.motorEnabled) {
    return 'error.noRoute.calmSailOnlyMotorOff';
  }
  if (reason === 'beyond-horizon' && (request.segmentModes?.includes('sail') ?? false)) {
    return 'error.noRoute.beyondHorizonSailOnly';
  }
  return NO_ROUTE_MESSAGE_KEY[reason];
}

export function isStaleForecast(plan: Plan): boolean {
  return plan.request.departureMs - plan.windGrid.fetchedAtMs > STALE_THRESHOLD_MS;
}

// #748: the actual fetch->departure gap, in whole hours, for the
// route.staleForecast copy's {hours} placeholder — replaces the old static
// ">12 h" threshold label. Rounded (not floored), matching format.ts's
// formatDriftMin — a repo's actual single-unit-discarding formatter.
// formatDuration/formatLegDuration are NOT the precedent here: they floor
// the hours COMPONENT but always print the remainder as minutes, never
// discarding it the way this helper does.
// Round, not floor or ceil. Floor's worst case is a full hour read as
// FRESHER than measured (a 12 h 59 m gap prints "12"), the reassuring
// direction; ceil never understates but overstates by up to an hour at the
// boundary (a 12 h 1 ms gap prints "13"). Round bounds the error at 30
// minutes EITHER way — it does not eliminate the optimistic direction, it
// halves it, and that trade is the right one here: this string states a
// MEASUREMENT, where cautiousDepthLowerBoundM states a provable BOUND and
// may be pessimistic because it is labelled as one. That same helper trims
// its own pessimism with a 1e-9 epsilon so a value never pays "an extra,
// unearned decimetre" (lib/mask.ts) — pessimism is bought where it buys
// safety, not by default. The safety signal here is the warning's
// PRESENCE; the hour count is context on a >= 12 h quantity.
export function staleForecastGapHours(plan: Plan): number {
  return Math.round((plan.request.departureMs - plan.windGrid.fetchedAtMs) / 3_600_000);
}

// Unlike recommendedResult() (types.ts), which throws when the *recommended*
// sail is missing (an invariant violation), a null result for an arbitrary
// requested sail is an ordinary display state — the router legitimately
// solves only one sail sometimes — so this returns null rather than
// throwing. #54: derived from `plan.result.sails` rather than a genoa/fock
// ternary — naturally centralises without a bare sail-id literal.
export function activeRigResult(plan: Plan, sailId: SailId): RigResult | null {
  return plan.result.sails.find((s) => s.sailId === sailId)?.result ?? null;
}

// #1399c (spike 1022 §10): forecast age against NOW, distinct from
// isStaleForecast above, which compares the plan's OWN departure to its OWN
// fetch time — both frozen at save time, so a plan reopened weeks later
// reports the identical status it had on the day it was created. This pair
// answers "is the wind data this plan carries stale RIGHT NOW", off
// `windGrid.fetchedAtMs` (the actual forecast datum), never `createdAtMs`.
// `nowMs` is an EXPLICIT parameter, never `Date.now()` in here — same
// purity rule as format.ts's tier chooser: callers snapshot the wall clock
// once (`useState(() => Date.now())`, RouteLayer.tsx's pattern), not on
// every render. Same >12 h strict threshold and rounding as
// staleForecastGapHours above, for the same reason (round, not floor/ceil,
// bounds the error at 30 min either way rather than reading fresher than
// measured).
export function isForecastStaleNow(plan: Plan, nowMs: number): boolean {
  return nowMs - plan.windGrid.fetchedAtMs > STALE_THRESHOLD_MS;
}

export function forecastAgeNowHours(plan: Plan, nowMs: number): number {
  return Math.round((nowMs - plan.windGrid.fetchedAtMs) / 3_600_000);
}

// #1398b (spike 1022 §8, "route.rigNotCompared" unexplained): true exactly
// when planRoute.ts's `comparisonSuppressed` (assemble()'s
// `!comparisonSuppressed && sails.length === 2 && a.rigResult && b.rigResult`
// guard) is WHY `RigRecommendation.kind` reads 'not-compared' — not one of
// the two other causes lib/resultSummary.ts's `resultVerdictKey` already
// gives more specific copy: a truncated search
// (`!comparisonComplete` -> route.comparisonIncomplete) or a single solver
// failure among exactly two requested sails (`partiallyFailedSail` ->
// route.rigOneFailed). Requiring BOTH sails to carry a non-null `result` is
// what excludes those two without re-deriving resultVerdictKey's own
// precedence here (`lib/resultSummary.ts` is out of this change's file
// scope) — a tier-C suppression fires with both results present, since
// assemble()'s guard tests `comparisonSuppressed` before either result is
// inspected. `plan.request.boat` is the by-value snapshot (never a
// catalogue lookup — the boat may have left it), and `BoatSnapshot.sails[]`
// carries `polarProvenance` per #54 spec §I.3, so no field is added here.
export function rigComparisonSuppressedByTier(plan: Plan): boolean {
  if (plan.result.rigRecommendation?.kind !== 'not-compared') return false;
  if (!plan.result.comparisonComplete) return false;
  if (plan.result.sails.length !== 2) return false;
  if (plan.result.sails.some((s) => s.result === null)) return false;
  return plan.request.boat.sails.some((s) => s.polarProvenance.tier === 'estimated');
}
