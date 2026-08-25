// #516: presentation-only shallow-exposure figure — how much of a plan's
// route crosses cells the mask charts below the ROUTER'S OWN threshold (pass
// `shallow.requestedDepthM`, matching exactly what #53's flagShallowLegs
// flags a leg for), expressed as a distance rather than a per-leg minimum.
// Derived entirely at RENDER time from the plan's own legs plus the
// currently-loaded NavMask — never persisted, never added to PlanResult (see
// #516's design doc, "Option (a), presentation-only"): app/sweep/'s byte-diff
// acceptance harness stays valid only because nothing here touches
// app/src/types.ts, app/src/routing/**, or app/src/lib/mask.ts. No React, no
// MapLibre — jsdom-safe and unit-testable, same shape as routeProfile.ts's
// exhaustiveMinDepth (#505), the direct precedent for a presentation-side
// function re-walking leg geometry against the mask to produce a safety
// figure PlanResult does not carry.
//
// TWO caveats this precedent already documents for its own sibling figure,
// both equally true here:
// 1. Computed against the CURRENTLY LOADED mask, never the mask the plan was
//    originally routed against — a saved plan re-opened after a mask rebuild
//    (#245/#455) can read a different exposure than the one computed at
//    routing time. Identical residual to exhaustiveMinDepth's.
// 2. Callers pass the ACTIVE RIG's own legs, so this is a per-rig figure —
//    unlike `ShallowInfo.minGateDepthM`, which `planRoute.ts`'s
//    flagShallowLegs folds over BOTH rigs' legs. The two can legitimately
//    disagree on the very same plan; that is not a bug in either.
import { haversineNm } from './geo';
import { MASK_TOLERANCE_M } from './mask';
import { DEFAULT_SETTINGS } from '../types';
import type { LatLon, Leg, MaskMeta, Plan } from '../types';
import type { NavMask } from './mask';

// Matches depthGate.ts's APPROACH_RADIUS_M unit (metres) and mask.ts's own
// local NM_PER_M literal — this repo's established per-file convention (no
// shared exported nm<->m constant exists) rather than a new cross-file one.
const METRES_PER_NM = 1852;

// Mirrors lib/headingDepth.ts's / lib/routeProfile.ts's own private
// withinMask: the mask is a lat/lon rectangle (MaskMeta west/south/east/
// north), so testing both endpoints is enough to know the whole segment
// stays inside coverage. Upper bounds are exclusive, matching
// NavMask.cellOf's row/col range check. Duplicated rather than imported —
// this repo's established precedent for this exact helper (routeProfile.ts's
// own comment: "keep this fix's diff inside [this file] — [the other file]
// is a different feature with its own review surface").
function withinMask(meta: MaskMeta, p: LatLon): boolean {
  return p.lat >= meta.south && p.lat < meta.north && p.lon >= meta.west && p.lon < meta.east;
}

/**
 * The Amanatides-Woo grid traversal of the a->b segment, shared by
 * shallowFractionOfLeg (#516 increment 1) and legConfinedWithin (#516
 * increment 2) so the two features walk the SAME sequence of cells and can
 * never drift onto two independently-maintained copies of this arithmetic —
 * the same duplication-avoidance reasoning as this file's own withinMask
 * duplication from routeProfile.ts, applied WITHIN this file instead of
 * across two. `visit(row, col, tEntry, tExit)` fires once per traversed
 * cell, in order; NOT exposed from mask.ts — extending NavMask's private
 * walkCells to yield a per-cell `t` would put new arithmetic in the solver's
 * hottest path (segmentNavigable / segmentShallowestBelow run per candidate
 * edge, under PLAN_BUDGET_MS). If a future change finds itself editing
 * mask.ts or routing/** to make this cheaper, that changes the #516
 * certification story (see this file's own header) — stop and re-derive it,
 * don't just do it.
 *
 * `t` here is the SAME parametrization NavMask's walk uses internally
 * (grid-space dx/dy normalized so t=0 at a, t=1 at b — a straight line in t
 * moves at constant grid-velocity, so a fixed 1-grid-cell traversal always
 * costs the same Δt regardless of where along the segment it falls) — not
 * grid-cell COUNTS — so summing (tExit - tEntry) over a subset of visited
 * cells yields exactly the fraction of the segment's LENGTH inside them,
 * with no separate unit conversion (shallowFractionOfLeg's use of this).
 *
 * Returns whether the walk actually reached `b` — false when its bounded
 * iteration guard trips. Same `rows + cols + 4` constant as NavMask.walkCells
 * (private), though not the same allowance: walkCells visits its first cell
 * BEFORE its loop and so tolerates one more cell than this loop, which
 * counts the first cell inside the bound. Immaterial in both directions — a
 * full diagonal of the shipped 2400x2200 mask visits `rows + cols - 1` =
 * 4599 cells against a 4604 bound, and this walk's stricter bound fails to
 * `false`, the safe direction. Should be unreachable in practice: both
 * endpoints are bound-checked against `meta` by every caller first, and the
 * mask's coverage rectangle is convex, so a straight segment between two
 * in-rectangle points can never leave it. Kept anyway as a defensive
 * fail-closed guard, per the #251/#255 rule that a safety figure must never
 * silently under-report by trusting a walk that didn't actually complete.
 */
function walkLegCells(
  mask: NavMask,
  a: LatLon,
  b: LatLon,
  visit: (row: number, col: number, tEntry: number, tExit: number) => void,
): boolean {
  const meta = mask.meta;
  const latStep = (meta.north - meta.south) / meta.rows;
  const lonStep = (meta.east - meta.west) / meta.cols;
  const x0 = (a.lon - meta.west) / lonStep;
  const y0 = (a.lat - meta.south) / latStep;
  const x1 = (b.lon - meta.west) / lonStep;
  const y1 = (b.lat - meta.south) / latStep;
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const ex = Math.floor(x1);
  const ey = Math.floor(y1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
  let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? cx + 1 - x0 : x0 - cx) * tDeltaX;
  let tMaxY = stepY === 0 ? Infinity : (stepY > 0 ? cy + 1 - y0 : y0 - cy) * tDeltaY;

  let tEntry = 0;
  // Same `rows + cols + 4` constant as NavMask.walkCells (private) — see this
  // function's own doc comment for the +4/+1 allowance difference. A
  // bounded guard, not a correctness bound; both endpoints being inside the
  // (convex) mask rectangle is what actually guarantees termination.
  for (let iter = 0; iter < meta.rows + meta.cols + 4; iter++) {
    const atEnd = cx === ex && cy === ey;
    const tExit = atEnd ? 1 : Math.min(tMaxX, tMaxY);
    visit(cy, cx, tEntry, tExit);
    if (atEnd) return true;
    tEntry = tExit;
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      tMaxY += tDeltaY;
    }
  }
  return false;
}

/**
 * Cell-centre function for `meta`, precomputing `meta`'s grid steps once
 * rather than per visited cell. Centre = (south + (row + 0.5) * latStep,
 * west + (col + 0.5) * lonStep) — the +0.5 offset puts the probe maximally
 * far from a cell boundary, so re-deriving (row, col) from that centre
 * through depthInfoM's own floor-based lookup cannot land on a neighbouring
 * cell. Shared by shallowFractionOfLeg and legConfinedWithin so both read
 * the identical centre for the identical (row, col).
 */
function cellCenterFn(meta: MaskMeta): (row: number, col: number) => LatLon {
  const latStep = (meta.north - meta.south) / meta.rows;
  const lonStep = (meta.east - meta.west) / meta.cols;
  return (row, col) => ({
    lat: meta.south + (row + 0.5) * latStep,
    lon: meta.west + (col + 0.5) * lonStep,
  });
}

/**
 * Deep-capped cells (byte 255, "≥25.4 m, actual depth unknown") are NEVER
 * shallow, matching NavMask.segmentShallowestBelow's own rule — a cap is a
 * floor, not a reading; never test `depthM === 25.4` (CLAUDE.md's byte-254
 * rule) — `depthInfoM`'s explicit `capped` flag is the only honest
 * discriminator. Shared by shallowFractionOfLeg and legConfinedWithin so the
 * two can never disagree about which cell is shallow.
 */
function isShallowAt(mask: NavMask, center: LatLon, thresholdM: number): boolean {
  const info = mask.depthInfoM(center);
  return !info.capped && info.depthM < thresholdM;
}

/**
 * Fraction (0..1) of the a->b segment lying in cells NavMask charts strictly
 * below `thresholdM`, via walkLegCells (see its own doc comment for the
 * traversal and the `t` parametrization this sums). Returns null when the
 * walk's iteration guard trips — see walkLegCells's own doc comment for why
 * this should be unreachable given bound-checked endpoints.
 */
function shallowFractionOfLeg(
  mask: NavMask,
  a: LatLon,
  b: LatLon,
  thresholdM: number,
): number | null {
  const centerOf = cellCenterFn(mask.meta);
  let fraction = 0;
  const completed = walkLegCells(mask, a, b, (row, col, tEntry, tExit) => {
    if (isShallowAt(mask, centerOf(row, col), thresholdM)) fraction += tExit - tEntry;
  });
  return completed ? fraction : null;
}

/**
 * Whether every sub-`thresholdM` cell the a->b segment's walk visits lies
 * within `radiusM` metres (great-circle, via haversineNm) of some
 * `waypoints[j]` — after adding that waypoint's own `allowanceM[j]` to the
 * measured distance FIRST, per shallowConfinedWithinM's own contract (a
 * larger allowance can only make confinement HARDER to establish, since it
 * is added on the distance side of a `<=` test). A leg with no shallow cell
 * at all is vacuously confined (`true`, never checked against). Returns null
 * on the same iteration-guard trip as shallowFractionOfLeg — see
 * walkLegCells's own doc comment.
 */
function legConfinedWithin(
  mask: NavMask,
  a: LatLon,
  b: LatLon,
  thresholdM: number,
  waypoints: readonly LatLon[],
  allowanceM: readonly number[],
  radiusM: number,
): boolean | null {
  const centerOf = cellCenterFn(mask.meta);
  let confined = true;
  const completed = walkLegCells(mask, a, b, (row, col) => {
    const center = centerOf(row, col);
    if (!isShallowAt(mask, center, thresholdM)) return;
    let within = false;
    for (let j = 0; j < waypoints.length; j++) {
      if (haversineNm(center, waypoints[j]) * METRES_PER_NM + allowanceM[j] <= radiusM) {
        within = true;
        break;
      }
    }
    if (!within) confined = false;
  });
  return completed ? confined : null;
}

/**
 * How far along `legs` the router's own mask charts water below
 * `thresholdM` — pass `shallow.requestedDepthM` as the threshold to match
 * exactly what #53's flagShallowLegs flags a leg for. Cell-exact, NOT a
 * whole-leg metric: this repo's own realmask.repro.test.ts::exposureNm doc
 * comment records that charging a whole leg whenever ANY cell is shallow
 * over-states exposure by a measured 3-4x and is not comparable across
 * routes with different leg counts — never regress to that shape. This is
 * ALSO not a promotion of that same test helper: despite calling itself
 * "EXACT" it is a 15 m point sampler over a 46 m grid and can miss a
 * corner-clipped cell, i.e. UNDERSTATE a safety figure — this instead walks
 * the grid directly (shallowFractionOfLeg above), so it cannot skip a
 * touched cell.
 *
 * Each leg's fraction multiplies `leg.distanceNm` (the leg's OWN recorded
 * distance), never a recomputed chord — per CLAUDE.md's #410 note a merged
 * leg's distanceNm is its chord or a SUM of sub-chords, hence >= the chord,
 * so this can only over-state and stays arithmetically consistent with the
 * distance the legs table already shows for the same leg.
 *
 * Returns null for the WHOLE route (never silently skips one leg) when any
 * leg's endpoints fall outside the mask's coverage rectangle, or when a
 * leg's walk trips its iteration guard — per the #251/#255 rule, a skipped
 * leg could have carried the true exposure, and reading shorter than the
 * truth is the unsafe direction for a safety figure. Callers must render
 * "unknown" (omit the sentence), never substitute a fallback number.
 */
export function shallowExposureNm(
  legs: readonly Leg[],
  mask: NavMask,
  thresholdM: number,
): number | null {
  let totalNm = 0;
  for (const leg of legs) {
    if (!withinMask(mask.meta, leg.start) || !withinMask(mask.meta, leg.end)) return null;
    const fraction = shallowFractionOfLeg(mask, leg.start, leg.end, thresholdM);
    if (fraction === null) return null;
    totalNm += fraction * leg.distanceNm;
  }
  return totalNm;
}

/**
 * #516 increment 2 (requires #518): whether EVERY sub-`thresholdM` cell any
 * of `legs`'s walk visits lies within `radiusM` of at least one of
 * `waypoints` — `waypoints[j]`'s own `allowanceM[j]` is added to the
 * measured distance before the `<= radiusM` test, so a larger allowance can
 * only make confinement HARDER to establish, never easier. Callers pass 0
 * for a SNAPPED waypoint (`snappedOrigin`/`snappedDestination`, exact) and
 * `snapToNavigable`'s documented `maxRadiusM` default (300 m) for an
 * UNSNAPPED via point (`request.viaPoints` — the snapped vias are not
 * stored anywhere in `Plan`), spent in the conservative direction.
 *
 * MEASURED, never asserted from the router: nothing in a `Plan` records
 * which mechanism produced it, so a plan saved BEFORE #518 shipped would
 * otherwise be given a confinement guarantee it never had. A measured check
 * is also an independent twin of #518's own invariant rather than a second
 * copy of the same claim.
 *
 * Same bound-check / null-for-the-whole-route contract as shallowExposureNm
 * (the #251/#255 rule): any leg whose endpoints fall outside `mask.meta`'s
 * coverage rectangle nulls the WHOLE route, never just that leg. Callers
 * must treat `false` and `null` identically — SUPPRESS the confinement
 * sentence silently in both cases, never render a negation. An alarming "not
 * confined" line would fire on every legitimately pre-#518 saved plan; the
 * absence of a reassurance is safe, a false one is not.
 */
export function shallowConfinedWithinM(
  legs: readonly Leg[],
  mask: NavMask,
  thresholdM: number,
  waypoints: readonly LatLon[],
  allowanceM: readonly number[],
  radiusM: number,
): boolean | null {
  let confined = true;
  for (const leg of legs) {
    if (!withinMask(mask.meta, leg.start) || !withinMask(mask.meta, leg.end)) return null;
    const result = legConfinedWithin(
      mask,
      leg.start,
      leg.end,
      thresholdM,
      waypoints,
      allowanceM,
      radiusM,
    );
    if (result === null) return null;
    if (!result) confined = false;
  }
  return confined;
}

/**
 * Round a measured exposure UP to the displayed 0.1 nm precision — the
 * deliberate mirror of #493/#504's cautiousDepthLowerBoundM (mask.ts), which
 * FLOORS a depth so it can never read deeper than provable; an exposure
 * LENGTH must never read SHORTER than measured, so this ceils instead. A
 * genuine 0.02 nm renders "0.1 nm", never "0.0 nm" — the latter would
 * flatly contradict the warning banner it sits inside.
 *
 * The `1e-9` nudge mirrors cautiousDepthLowerBoundM's own epsilon, applied
 * in the opposite (subtracted-before-ceil) direction: IEEE754 double
 * precision can land a hair ABOVE a value that is really exactly on a
 * 0.1 nm boundary, and a bare Math.ceil on that residue would round a clean
 * value up an extra, unearned 0.1 nm. The epsilon is far smaller than any
 * real 0.1 nm step, so it can never round a genuine fractional exposure
 * down. The trailing `+ 0` normalizes a -0 result (nm === 0 rounds to -0
 * under `Math.ceil(-1e-9)`, per the ECMA-262 rule that Math.ceil of a value
 * in (-1, 0) is -0) back to +0 — `Object.is(-0, 0)` is `false`, so an
 * un-normalized -0 would intermittently fail a `toBe(0)` assertion even
 * though it prints and formats identically (the same gotcha CLAUDE.md
 * documents for a counter-rotating compass bearing, #203).
 */
export function roundExposureNm(nm: number): number {
  return Math.ceil(nm * 10 - 1e-9) / 10 + 0;
}

// Sub-decimetre nudge, matching cautiousDepthLowerBoundM's own epsilon
// (mask.ts) and roundExposureNm's above: it absorbs IEEE754 residue in
// `safetyDepthM * 10` without ever being large enough to cross a real 0.1 m
// step. Applied SUBTRACTED-before-ceil, so a gate that is exactly on the
// decimetre grid cannot be nudged up an unearned decimetre.
const DECIMETRE_EPS = 1e-9;

/**
 * #612: the depth threshold at which a cell counts as MARGINAL — the
 * conservative criterion, `depth < safetyDepthM + MASK_TOLERANCE_M`, expressed
 * so it lands on the mask's own decimetre grid exactly.
 *
 * WHY THIS EXISTS AS A NAMED FUNCTION rather than a bare `+ MASK_TOLERANCE_M`
 * at each call site: this inequality already has a SECOND consumer that
 * predates it — `depthColor.ts`'s `buildNavigabilityHatchImageData` builds its
 * per-byte LUT as `marginal[b] = cautiousDepthLowerBoundM(byteToDepthM(b)) <
 * safetyDepthM`, which is the SAME inequality written the other way round
 * (cautiousDepthLowerBoundM floors `d - T` to a decimetre, so
 * `floor10(d - T) < G` iff `d < G + T`). No compiler spans the two
 * expressions, so `test/maskTolerance.test.ts` pins them against each other
 * behaviourally — a route line counting exposure over cells the map does not
 * hatch (or the reverse) is a user-visible contradiction between two views of
 * one hazard.
 *
 * WHY NOT THE LITERAL `safetyDepthM + MASK_TOLERANCE_M`: it is not equivalent
 * to that LUT at the boundary byte. MEASURED over the reachable gate domain
 * (2.0 m — the Elan's, via `safetyDepthFieldFor`, NOT `SAFETY_DEPTH_FIELD.min`,
 * which is the DEFAULT boat's 2.2 — through `SAFETY_DEPTH_FIELD.max` 10, in
 * 0.1 steps) against bytes 1..254,
 * the naive sum disagrees with the LUT on **18** (gate, byte) pairs — among
 * them a gate of 3.2 m at byte 41 (4.1 m) and 3.7 m at byte 46 — because
 * `3.2 + 0.9` lands a hair above the real 4.1 and `4.1 < 4.1000000000000005`
 * is true while `floor10(4.1 - 0.9) = 3.2 < 3.2` is false. Rebuilding the
 * threshold from integer decimetres removes the residue: `gateDm` is the
 * gate in whole decimetres (`ceil`, so a non-grid gate rounds the way the
 * floor-based LUT does), `MASK_TOLERANCE_M * 10` is exactly 9 for T = 0.9, and
 * `(gateDm + 9) / 10` is bit-identical to the `byte / 10` NavMask decodes for
 * that same byte — so the strict `<` decides the boundary case identically on
 * both sides. Re-measured across T ∈ {0.5, 0.85, 0.87, 0.9, 1.2}: zero
 * divergences, so the form is not fitted to today's constant.
 */
export function marginalDepthThresholdM(safetyDepthM: number): number {
  const gateDm = Math.ceil(safetyDepthM * 10 - DECIMETRE_EPS);
  return (gateDm + MASK_TOLERANCE_M * 10) / 10;
}

/**
 * #612: how far along `legs` the route crosses MARGINAL water — cells the
 * shipped mask charts AT OR ABOVE `safetyDepthM` (so the solver validated
 * them, and the route did not have to relax) but whose more cautious reading
 * of the same EMODnet product falls below it.
 *
 * This is the only sound predicate for a route that did NOT relax, and that is
 * MEASURED rather than argued (#455 spike §9): a control walk at the bare gate
 * reads 0.0 nm on 67/67 non-relaxed plans, because a non-relaxed success is
 * validated at `uniformGate(safetyDepthM)` and so
 * `segmentShallowestBelow(a, b, safetyDepthM)` returns null for every
 * solver-validated segment by construction. "Also flag the non-relaxed path
 * with the existing threshold" compiles, leaves every test green, and
 * discloses nothing.
 *
 * Deliberately a thin wrapper over shallowExposureNm rather than a second
 * walk: same cell-exact traversal, same null-for-the-whole-route contract (see
 * shallowExposureNm's own doc comment — callers must omit the sentence, never
 * substitute a fallback number), same per-rig / currently-loaded-mask caveats.
 * Only the threshold differs, and it comes from marginalDepthThresholdM above
 * so the two consumers of that one inequality cannot drift.
 */
export function marginalExposureNm(
  legs: readonly Leg[],
  mask: NavMask,
  safetyDepthM: number,
): number | null {
  return shallowExposureNm(legs, mask, marginalDepthThresholdM(safetyDepthM));
}

/**
 * #651: per-leg RENDER-TIME minimum charted depth, one entry per `legs`, in
 * order — the presentation-only counterpart of `planRoute.ts`'s
 * `flagShallowLegs`, which only ever runs inside the #53 relaxation branch
 * (CLAUDE.md's "disclosure stack" domain rule), so `leg.shallow` is
 * `undefined` on every cleanly-solved route. This is what lets the legs-table
 * cautious chip and the map's `sc-route-shallow` casing surface a signal for
 * an ORDINARY route too — never by widening `flagShallowLegs`' own call
 * sites, which would move a field onto `Leg`/`PlanResult` and cost a #282
 * acceptance sweep. `PlanResult` gains no field here; this is computed fresh
 * from the plan's own legs against the CURRENTLY LOADED mask, exactly the
 * #516/#612 shape (see this file's own header).
 *
 * Calls `NavMask.segmentMinDepthInfoM` — mask.ts's own PUBLIC min-depth walk,
 * the same one `routeProfile.ts`'s `exhaustiveMinDepth` calls for the depth
 * profile's headline figure — rather than a new traversal: per CLAUDE.md's
 * own rule, a duplicated TRAVERSAL is a safety-figure risk with no signal at
 * all (must be proven equivalent by differential testing), while a
 * duplicated CALL to an already-public method carries none of that risk.
 *
 * Same bound-check / null-for-the-WHOLE-ARRAY contract as shallowExposureNm
 * above (the #251/#255 rule): any leg whose endpoints fall outside
 * `mask.meta`'s coverage rectangle, or whose walk trips its iteration guard,
 * makes this return `null` for EVERY leg rather than silently omitting just
 * that one — a caller dropping one leg's contribution could be hiding the
 * very cell that was actually the worst, and reading "no data there" is the
 * unsafe direction for a safety disclosure. Callers must render the WHOLE
 * disclosure as NOT-YET-KNOWN in that case (no per-leg marker, no map
 * casing), never fall back to a plausible-looking partial result.
 */
export function legMinDepthsM(
  legs: readonly Leg[],
  mask: NavMask,
): ReadonlyArray<{ depthM: number; capped: boolean }> | null {
  const out: { depthM: number; capped: boolean }[] = [];
  for (const leg of legs) {
    if (!withinMask(mask.meta, leg.start) || !withinMask(mask.meta, leg.end)) return null;
    const info = mask.segmentMinDepthInfoM(leg.start, leg.end);
    if (info === null) return null;
    out.push(info);
  }
  return out;
}

/**
 * #651: whether one `legMinDepthsM` entry counts as MARGINAL at `gateM` —
 * #612's own criterion (`marginalDepthThresholdM`), reused rather than
 * re-derived, so the legs-table chip, the map casing and #612's route-scoped
 * `MarginalDepthNotice` sentence can never disagree about which cells count.
 * `null` (mask not loaded, or the leg's own walk was inconclusive per
 * `legMinDepthsM`'s own contract above) is NOT-YET-KNOWN, never treated as
 * "not marginal" — callers must gate on `legMinDepthsM`'s own null return for
 * the whole array BEFORE calling this per leg, never let an individual
 * `null` entry read as an all-clear.
 *
 * Deep-capped cells (byte 255, "≥25.4 m, actual depth unknown") never
 * qualify, matching `isShallowAt` above: `marginalDepthThresholdM` never
 * reaches 25.4 m within this app's reachable safety-depth range, so the
 * exclusion is here for the same documented reason `isShallowAt` carries it,
 * not because it is reachable today.
 */
export function isMarginalDepthM(
  info: { depthM: number; capped: boolean } | null,
  gateM: number,
): boolean {
  return info !== null && !info.capped && info.depthM < marginalDepthThresholdM(gateM);
}

/**
 * #651 (the SAME derivation `MarginalDepthNotice` below already inlines for
 * its own use — extracted here so a THIRD call site, #651's legs-table and
 * map-casing computation, cannot silently drift from it): the REQUESTED
 * safety-depth gate a plan was computed at, read from the plan's own frozen
 * `request.settings` snapshot — never the live OptionsPanel value, so a
 * re-opened plan keeps describing the gate it was actually solved against.
 *
 * GUARDED per #624/#551: `migratePlan.ts` never validates `request.settings`,
 * so a plan stored before that field existed migrates NON-NULL and a bare
 * `settings.safetyDepthM` read throws `TypeError`. `Number.isFinite`, not
 * `typeof === 'number'` and not an object-spread default — see
 * `MarginalDepthNotice`'s own comment (this file's sibling,
 * `components/RouteSummary.tsx`) for why each of those alternatives is
 * unsound (a `NaN`/`Infinity` both pass `typeof === 'number'`, and an object
 * spread copies an own key whose value is `undefined`). This form closes all
 * of that while still accepting a legitimate 0.
 */
export function requestedGateM(plan: Plan): number {
  return Number.isFinite(plan.request.settings?.safetyDepthM)
    ? (plan.request.settings.safetyDepthM as number)
    : DEFAULT_SETTINGS.safetyDepthM;
}
