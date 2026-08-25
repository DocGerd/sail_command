import type { LatLon, PlanRequest } from '../types';

/**
 * #654: the single read accessor for `PlanRequest.viaPoints`.
 *
 * `viaPoints` was introduced by `eb2d7ee` ("feat: via-waypoint segmented
 * routing", 2026-07-15) — the SAME commit that introduced the via-points
 * feature itself. No earlier `PlanRequest` shape could have used via points
 * without the field existing, so a stored plan whose record predates that
 * field genuinely never had any via points: normalising an absent/invalid
 * value to `[]` is the FAITHFUL reading, not a fabricated default (see
 * `docs/adr/0002-pre-1.0-db-migration-low-priority.md`).
 *
 * `services/migratePlan.ts` already normalises this at read time for any
 * `Plan` loaded through `getPlan()`, so by the time a component sees
 * `plan.request`, `viaPoints` should always be a real array. This accessor
 * is the belt to that suspenders — ADR-0002 explicitly does NOT waive
 * defensive reads at the point of use ("This ADR waives migration
 * machinery. It does NOT waive defensive reads."): every direct read of
 * `plan.request.viaPoints` in app/src goes through this function instead of
 * the bare property, so a future bypass of migratePlan (a test fixture, a
 * new load path, a refactor) degrades to an empty via list rather than
 * throwing on an old stored record. `PlanRequest.viaPoints`'s TYPE says
 * `LatLon[]` unconditionally — that type is a lie for a record that reached
 * this accessor without going through migrateRequest's normalisation, which
 * is exactly the case this guards against, so the `Array.isArray` check
 * here is deliberate belt-and-braces against a value the type system
 * insists cannot occur.
 */
export function planViaPoints(request: Pick<PlanRequest, 'viaPoints'>): LatLon[] {
  return Array.isArray(request.viaPoints) ? request.viaPoints : [];
}
