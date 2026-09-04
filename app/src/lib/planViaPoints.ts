import type { PlanRequest, ViaPoint } from '../types';

/**
 * #654: the single read accessor for `PlanRequest.viaPoints`.
 *
 * `viaPoints` was introduced by `eb2d7ee` ("feat: via-waypoint segmented
 * routing", 2026-07-15) — the SAME commit that introduced the via-points
 * feature itself; `git show eb2d7ee^:app/src/types.ts` shows a
 * `PlanRequest` with no via field of any spelling, so it is not a rename of
 * an earlier key either (verified 2026-08-25 — see
 * `services/migratePlan.ts`'s `normaliseViaPoints` for the full dated
 * argument, plus a controlled, corrected pickaxe sweep for a rename spread
 * across earlier commits, which this docstring intentionally does not
 * duplicate). That does NOT make an
 * absent key reachable for a genuine stored record, though: `services/db.ts`,
 * the only IndexedDB writer this app has ever shipped, was created ~3 hours
 * AFTER eb2d7ee (both predate `v0.1.0`, git-verified 2026-08-25) —
 * persistence itself did not exist until after the field did. So this
 * function's `[]` fallback below defends a HAND-EDITED/corrupted stored
 * record or a future regression, never a real "plan from before via points
 * existed" (see `services/migratePlan.ts`'s `normaliseViaPoints` for the
 * full dated argument, which this accessor's docstring intentionally does
 * not duplicate further).
 *
 * `services/migratePlan.ts` already normalises this at read time for any
 * `Plan` loaded through `getPlan()`, so `plan.request.viaPoints` is normally
 * already a real array by the time a component reads it. The accessor is
 * NOT redundant on that account, and
 * that is measured rather than assumed (Minor 3, self-review of PR #687 —
 * the earlier "PROVEN" phrasing here was wrong: it attached that measurement
 * to the property `plan.request.viaPoints` itself, which the accessor
 * cannot make true — in the cited experiment that property genuinely WAS
 * `undefined`, which the reviewer confirmed directly by un-guarding one
 * `App.tsx` call site at a time under the same revert and getting the
 * `TypeError`): reverting
 * only `migratePlan.ts`'s normalisation — keeping every call site below on
 * this accessor — left the #654 regression tests green, because this
 * accessor's own `Array.isArray` fallback independently caught the crash
 * that revert reintroduces. This accessor is the belt to that
 * suspenders — ADR-0002
 * explicitly does NOT waive defensive reads at the point of use ("This ADR
 * waives migration machinery. It does NOT waive defensive reads."): every
 * direct read of `plan.request.viaPoints` in app/src goes through this
 * function instead of the bare property, so a future bypass of migratePlan
 * (a test fixture, a new load path, a refactor) degrades to an empty via
 * list rather than throwing.
 *
 * DELIBERATE ASYMMETRY with `normaliseViaPoints` (migratePlan.ts), which
 * fails CLOSED (refuses the whole record) on a present-but-malformed
 * `viaPoints`, while this accessor fails OPEN (substitutes `[]`) on the
 * identical input shape. Both are correct for the guard-asymmetry rule
 * (CLAUDE.md "Working style"), because the two guards are not deciding the
 * same question:
 * - `normaliseViaPoints` is the BLOCKING admission gate for a whole record —
 *   it decides whether an untrusted stored `PlanRequest` (every field of
 *   it, `viaPoints` included) is trustworthy enough to open at all, so it
 *   must fail closed: a wrong-but-plausible via-point list is exactly the
 *   "confident wrong number" ADR-0002 forbids fabricating on a record this
 *   consequential.
 * - This accessor is a NUDGE-class, POST-validation redundancy read: by its
 *   own documented precondition, everything reaching it has already passed
 *   `normaliseViaPoints` (or is fresh, live-form state that was never
 *   malformed to begin with — a via point can only enter `draftViaPoints`
 *   through a map click/drag, which always yields a well-typed `{lat, lon}`
 *   pair). Degrading to `[]` here is the CHEAP direction: for the one
 *   consumer where this list feeds a safety reading —
 *   `RouteSummary.tsx`'s `confinedWithin`, via `shallowConfinedWithinM` — a
 *   SHORTER waypoint list can only make "every shallow cell lies within
 *   APPROACH_RADIUS_M of a waypoint" HARDER to satisfy, never easier, so
 *   dropping via points can only move the result toward `false` — NOT
 *   toward `null` (re-verified 2026-08-25 against `lib/shallowExposure.ts`:
 *   `waypoints`/`allowanceM` are read ONLY inside `legConfinedWithin`'s
 *   per-cell loop, which can only flip its own `confined` boolean; `null`
 *   comes exclusively from `shallowConfinedWithinM`'s `mask.inBounds`
 *   check on each leg's endpoints and from `legConfinedWithin`'s
 *   `walkLegCells` completion guard, NEITHER of which ever reads
 *   `waypoints` at all, so a shorter waypoint list cannot produce or
 *   suppress a `null`). `false` is what that component already treats as
 *   "suppress the reassuring sentence silently" (its own comment). An empty
 *   fallback can therefore only suppress a positive claim, never fabricate
 *   one — it cannot manufacture a false "confined" reassurance. Every other
 *   consumer (App.tsx's
 *   draft-dirty comparison, recalc.ts's re-seeded request) is UI/product
 *   state with no safety reading riding on it at all. That is why this
 *   accessor is allowed to fail open where `normaliseViaPoints` may not.
 *
 * The `Array.isArray` check itself is retained deliberately even though its
 * branch is unreachable via any load path this app has today (see above) —
 * it is what makes the belt-and-suspenders claim two sentences up true
 * rather than aspirational, and it is what the reverted-migratePlan.ts test
 * above actually exercises.
 *
 * Reviewer's own summary (Minor 2, self-review of PR #687), adopted
 * verbatim as the NECESSITY half of the argument above (the SAFETY half —
 * why an empty fallback cannot fabricate a false reassurance — is the
 * bulleted argument above it, and the two are complementary, not
 * duplicates): a present-but-malformed value also normalises to `[]` here,
 * deliberately diverging from `services/migratePlan.ts`'s
 * `normaliseViaPoints`, which refuses such a record outright — that refusal
 * is the authoritative gate and runs first, so any malformed value reaching
 * *this* accessor has already bypassed it, and a component has no way to
 * refuse a record, only to render one. Degrading to an empty via list is
 * the only non-throwing option at this layer.
 *
 * #846: return type widened LatLon[] -> ViaPoint[] deliberately, as its own
 * explicit checklist item (design spec §3) — TypeScript array covariance
 * means a LatLon[]-typed return here would still compile against a caller
 * expecting ViaPoint[] (a LatLon literal structurally satisfies ViaPoint,
 * since `name` is optional), so a forgotten widening here produces NO
 * compiler error, only a `.name` that silently never reaches the UI through
 * this accessor's callers. There is no compiler backstop for this one;
 * only reading this comment is.
 */
export function planViaPoints(request: Pick<PlanRequest, 'viaPoints'>): ViaPoint[] {
  return Array.isArray(request.viaPoints) ? request.viaPoints : [];
}
