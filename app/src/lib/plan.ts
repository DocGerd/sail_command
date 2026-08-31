import type { MsgKey } from '../i18n/dict.de';
import type { NoRouteReason, Plan, RigResult, SailId } from '../types';

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
};

export function isStaleForecast(plan: Plan): boolean {
  return plan.request.departureMs - plan.windGrid.fetchedAtMs > STALE_THRESHOLD_MS;
}

// #748: the actual fetch->departure gap, in whole hours, for the
// route.staleForecast copy's {hours} placeholder — replaces the old static
// ">12 h" threshold label. Rounded (not floored), matching format.ts's
// formatDriftMin — the repo's actual single-unit-discarding formatter.
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
