import type { Plan, PlanRequest } from '../types';

/**
 * #114 recalculate-with-fresh-forecast: seeds a fresh planning request from a
 * saved plan — same origin/destination/vias/harbor ids/settings, with only the
 * departure time replaced by the caller's (possibly edited) value. The result
 * feeds usePlanFlow.run(), i.e. a full fresh run: new Open-Meteo fetch, both
 * rigs solved, saved as its own plan.
 *
 * Sharply distinct from state/replan.ts's replanWithVias: a via-replan reuses
 * the plan's STORED windGrid (offline-capable, same plan id, never refetches);
 * a recalculation is an explicit new online run against a fresh forecast.
 *
 * viaPoints/settings are copied, never aliased, so nothing downstream of the
 * run can share mutable references with the saved plan's own request — the
 * original plan must stay untouched regardless of what the run does.
 */
export function recalcRequest(plan: Plan, departureMs: number): PlanRequest {
  return {
    ...plan.request,
    viaPoints: plan.request.viaPoints.map((v) => ({ ...v })),
    settings: { ...plan.request.settings },
    departureMs,
  };
}
