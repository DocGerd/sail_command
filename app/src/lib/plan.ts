import type { MsgKey } from '../i18n/dict.de';
import type { NoRouteReason, Plan, Rig, RigResult } from '../types';

// Spec §4: "Stale forecast (fetch → departure gap > 12 h)" — strictly
// greater, so a plan departing exactly 12 h after its wind was fetched is
// not flagged.
const STALE_THRESHOLD_MS = 12 * 3_600_000;

// Shared between usePlanFlow.ts (initial plan) and state/replan.ts (via
// re-route) — both drive a router result to the same user-visible error
// copy, so the mapping lives once here rather than being duplicated.
// snap-failed-via isn't called out by name in the E3 brief's original
// mapping list (which only enumerated unreachable/beyondHorizon/
// calmMotorOff/snapOrigin/snapDestination), but NoRouteReason has six
// members and vias are a first-class waypoint kind (routing/viaPoints
// handling in planRoute.ts) — completing the Record here rather than
// leaving this reason to fall through to error.internal.
export const NO_ROUTE_MESSAGE_KEY: Record<NoRouteReason, MsgKey> = {
  unreachable: 'error.noRoute.unreachable',
  'beyond-horizon': 'error.noRoute.beyondHorizon',
  'calm-motor-off': 'error.noRoute.calmMotorOff',
  'snap-failed-origin': 'error.noRoute.snapOrigin',
  'snap-failed-destination': 'error.noRoute.snapDestination',
  'snap-failed-via': 'error.noRoute.snapVia',
};

export function isStaleForecast(plan: Plan): boolean {
  return plan.request.departureMs - plan.windGrid.fetchedAtMs > STALE_THRESHOLD_MS;
}

// Unlike recommendedResult() (types.ts), which throws when the *recommended*
// rig is missing (an invariant violation), a null result for an arbitrary
// requested rig is an ordinary display state — the router legitimately
// solves only one rig sometimes — so this returns null rather than throwing.
export function activeRigResult(plan: Plan, rig: Rig): RigResult | null {
  return rig === 'genoa' ? plan.result.genoa : plan.result.fock;
}
