import { DEFAULT_SAIL_IDS } from '../data/boats';
import { planViaPoints } from './planViaPoints';
import {
  boatSnapshot,
  defaultBoatSnapshot,
  DEFAULT_SETTINGS,
  type Plan,
  type PlanRequest,
} from '../types';

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
 *
 * Settings are backfilled from DEFAULT_SETTINGS before the saved snapshot is
 * spread on top (#243 fix wave item 3) — mirrors AppState.tsx's own load-time
 * backfill. A plan saved before a Settings field existed (e.g.
 * depthComfortMarginM, added #243) has that field simply absent from its
 * stored snapshot; without this, recalculating it would silently carry
 * `undefined` forward into a field typed as a required `number`, and for
 * depthComfortMarginM specifically would silently disable the depth comfort
 * preference on every recalculation of a pre-#243 plan.
 *
 * #54 fix round 1: `sailIds` gets the SAME backfill treatment for the SAME
 * reason — a plan saved before this field existed does not carry the key at
 * all, and planRoute.ts's
 * `runAll` calls `req.sailIds.map(...)` unconditionally, so an unbackfilled
 * pre-#54 plan would throw on recalculation rather than degrading. Task 11
 * added `services/migratePlan.ts`, which covers the IndexedDB read path; this
 * covers recalc regardless of how the plan arrived (IndexedDB, or a future
 * import path).
 */
export function recalcRequest(plan: Plan, departureMs: number): PlanRequest {
  return {
    ...plan.request,
    origin: { ...plan.request.origin },
    destination: { ...plan.request.destination },
    // #654: plan.request.viaPoints read through the shared accessor — a
    // plan saved before eb2d7ee never carries the field at all.
    viaPoints: planViaPoints(plan.request).map((v) => ({ ...v })),
    settings: { ...DEFAULT_SETTINGS, ...plan.request.settings },
    sailIds: plan.request.sailIds ?? DEFAULT_SAIL_IDS,
    // #54 Task 11: copied rather than carried through the spread above, for
    // the same "never share a mutable reference with the saved plan" reason
    // as viaPoints/settings, and backfilled for the same reason as sailIds.
    boat: plan.request.boat ? boatSnapshot(plan.request.boat) : defaultBoatSnapshot(),
    departureMs,
  };
}
