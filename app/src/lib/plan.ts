import type { Plan, Rig, RigResult } from '../types';

// Spec §4: "Stale forecast (fetch → departure gap > 12 h)" — strictly
// greater, so a plan departing exactly 12 h after its wind was fetched is
// not flagged.
const STALE_THRESHOLD_MS = 12 * 3_600_000;

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
