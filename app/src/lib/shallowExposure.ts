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
import type { LatLon, Leg, MaskMeta } from '../types';
import type { NavMask } from './mask';

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
 * Fraction (0..1) of the a->b segment lying in cells NavMask charts strictly
 * below `thresholdM` — the SAME Amanatides-Woo grid traversal NavMask's
 * private walkCells runs internally, duplicated here rather than exposed
 * from mask.ts: extending the private walk to yield a per-cell `t` would put
 * new arithmetic in the solver's hottest path (segmentNavigable /
 * segmentShallowestBelow run per candidate edge, under PLAN_BUDGET_MS). The
 * duplication is the cheaper risk, precedented by routeProfile.ts's own
 * duplicated withinMask. If a future change finds itself editing mask.ts or
 * routing/** to make this cheaper, that changes the #516 certification story
 * (see this file's own header) — stop and re-derive it, don't just do it.
 *
 * `t` here is the SAME parametrization NavMask's walk uses internally
 * (grid-space dx/dy normalized so t=0 at a, t=1 at b — a straight line in t
 * moves at constant grid-velocity, so a fixed 1-grid-cell traversal always
 * costs the same Δt regardless of where along the segment it falls) — not
 * grid-cell COUNTS — so summing (tExit - tEntry) over every shallow cell
 * yields exactly the fraction of the segment's LENGTH inside shallow cells,
 * with no separate unit conversion.
 *
 * Each visited cell is read via mask.depthInfoM at the cell CENTRE
 * (south + (row + 0.5) * latStep, west + (col + 0.5) * lonStep) — the +0.5
 * offset puts the probe maximally far from a cell boundary, so re-deriving
 * (row, col) from that centre through depthInfoM's own floor-based lookup
 * cannot land on a neighbouring cell.
 *
 * Deep-capped cells (byte 255, "≥25.4 m, actual depth unknown") are NEVER
 * shallow, matching NavMask.segmentShallowestBelow's own rule — a cap is a
 * floor, not a reading; never test `depthM === 25.4` (CLAUDE.md's byte-254
 * rule) — `depthInfoM`'s explicit `capped` flag is the only honest
 * discriminator.
 *
 * Returns null when the walk's bounded iteration guard trips — mirrors
 * NavMask.walkCells's own guard exactly (same `rows + cols + 4` bound).
 * Should be unreachable in practice: both endpoints are bound-checked
 * against `meta` by the caller first, and the mask's coverage rectangle is
 * convex, so a straight segment between two in-rectangle points can never
 * leave it. Kept anyway as a defensive fail-to-null, per the #251/#255 rule
 * that a safety figure must never silently under-report by trusting a
 * walk that didn't actually complete.
 */
function shallowFractionOfLeg(
  mask: NavMask,
  a: LatLon,
  b: LatLon,
  thresholdM: number,
): number | null {
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

  const cellShallow = (row: number, col: number): boolean => {
    const center: LatLon = {
      lat: meta.south + (row + 0.5) * latStep,
      lon: meta.west + (col + 0.5) * lonStep,
    };
    const info = mask.depthInfoM(center);
    return !info.capped && info.depthM < thresholdM;
  };

  let fraction = 0;
  let tEntry = 0;
  // Same iteration bound as NavMask.walkCells (private) — a bounded guard,
  // not a correctness bound; both endpoints being inside the (convex) mask
  // rectangle is what actually guarantees termination.
  for (let iter = 0; iter < meta.rows + meta.cols + 4; iter++) {
    const atEnd = cx === ex && cy === ey;
    const tExit = atEnd ? 1 : Math.min(tMaxX, tMaxY);
    if (cellShallow(cy, cx)) fraction += tExit - tEntry;
    if (atEnd) return fraction;
    tEntry = tExit;
    if (tMaxX < tMaxY) {
      cx += stepX;
      tMaxX += tDeltaX;
    } else {
      cy += stepY;
      tMaxY += tDeltaY;
    }
  }
  return null;
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
