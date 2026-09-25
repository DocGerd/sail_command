import type { Board, Leg, LegKind, LatLon, ManeuverKind, SegmentMode, Settings } from '../types';
import type { Polar } from '../lib/polar';
import type { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { gateFloorM, uniformGate, type DepthGate } from '../lib/depthGate';
import { destinationPoint, haversineNm, initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { boardForCandidate, classifyManeuver } from './maneuver';

export interface SolveParams {
  origin: LatLon;
  destination: LatLon;
  departureMs: number;
  polar: Polar;
  wind: WindField;
  mask: NavMask;
  settings: Settings;
  onProgress?: (info: { tMs: number; frontierSize: number }) => void;
  /**
   * Perf-cap on the per-ring frontier size. Defaults to {@link defaultMaxFrontier}.
   * Injectable so tests can drive the cap into a regime where it actually
   * truncates the frontier (issue #67) without building a 30 000-node mask.
   */
  maxFrontier?: number;
  /**
   * #243 depth comfort preference: an absolute depth (metres), always
   * anchored by the caller to the REQUESTED safety depth (never the #53
   * relaxed gate — that anchoring is the entire mechanism-2 fix, see
   * planRoute.ts). Absent ⇒ no preference ⇒ byte-identical behaviour to a
   * pre-#243 solve (every `edgeFactor` call collapses to plain
   * `segmentNavigable`, and `Node.costMs` tracks `Node.tMs` exactly). When
   * present it must be strictly greater than `settings.safetyDepthM` for the
   * preference to have any effect (`edgeFactor` degrades gracefully to "no
   * preference" otherwise rather than dividing by a non-positive span).
   */
  comfortDepthM?: number;
  /**
   * #452 P3 per-cell depth gate. ABSENT ⇒ `uniformGate(settings.safetyDepthM)`
   * ⇒ byte-identical to a pre-#452 solve, the same optional-means-unchanged
   * idiom `comfortDepthM`, `maxFrontier` and `deadline` already use here.
   *
   * When present it REPLACES `settings.safetyDepthM` as the navigability gate
   * for every edge this solve considers — which is what lets `planRoute.ts`
   * stop overwriting `Settings.safetyDepthM` with a relaxed value.
   */
  gate?: DepthGate;
  /**
   * #432 plan-level wall-clock budget. ABSENT ⇒ unbudgeted ⇒ byte-identical
   * to a pre-#432 solve (the check below is the only new statement in the
   * ring loop, and `p.deadline?.expired()` on an absent deadline is a single
   * undefined test). Deliberately NOT defaulted here: `solve()` and
   * `planRoute()` are pure functions with test call sites whose wall-clock
   * cost is environment-dependent (CLAUDE.md's ~2.1x CI / 8x coverage
   * solver multipliers), so a default would make the vitest suite fail on a
   * slow runner. The deadline is imposed by the one caller that has a human
   * waiting on it — routing/protocol.ts, from the budget routing/
   * workerClient.ts ships in the plan request.
   */
  deadline?: SolveDeadline;
  /**
   * #1136 salvage. ABSENT ⇒ byte-identical to a pre-#1136 solve. When true, a
   * ring that ends with no surviving child and no `best` is re-expanded over the
   * SAME frontier at the SAME clock with `visitedDominates` skipped, never twice
   * in a row: motor-off solves die holding mask-validated children that
   * domination discards (spike `docs/spikes/1136-motor-off-solve-termination.md`
   * §1). No count cap — the horizon and the deadline terminate it (§11.2).
   * Only `planRoute`'s pass 2 sets it, and it reads a pass-2 cause only as
   * `budget-exhausted` (for `comparisonComplete`).
   */
  salvage?: boolean;
  /**
   * #885: the captain-forced mode for this segment. ABSENT ⇒ the solver decides,
   * byte-identical to a pre-#885 solve. 'sail' behaves as motor-off; 'motor'
   * generates only motor candidates (see FORCED_MOTOR_HEADINGS).
   */
  forcedKind?: SegmentMode;
}

/**
 * #432: the plan-level wall-clock budget, as seen by `solve()`. A one-method
 * interface rather than a raw `deadlineMs` + clock pair so a test can inject
 * a deterministic "expire after N rings" fake without faking Date.now() for
 * the whole module, and so the budget stays PER-PLAN even though it is
 * enforced inside a per-segment, per-rig `solve()`: every solve of one plan
 * shares ONE deadline object, so four tier-3/tier-4 solves cannot each get a
 * fresh allowance.
 */
export interface SolveDeadline {
  /** True once the plan's wall-clock budget is spent. */
  expired(): boolean;
}

/**
 * #282: WHY a solve failed, in the solver's own INTERNAL control vocabulary.
 *
 * This is deliberately a DIFFERENT type from the user-facing `NoRouteReason`,
 * and deliberately NOT exported through `types.ts`, so it cannot leak into UI
 * code. `planRoute.ts` translates it to a label exactly once, at its own
 * presentation boundary (`NO_ROUTE_LABEL_OF_CAUSE`); nothing else in the app
 * ever sees a cause.
 *
 * Why the solver must not speak the presentational vocabulary: the #243 retry
 * gate and the #53 relaxation gate both branch on why a solve failed. While
 * `solve()` returned a `NoRouteReason`, those gates were reading — one
 * lookup-table hop away — the very string the planner shows the user, so
 * rewording or re-granularising that string changed which retry tiers ran, and
 * therefore which route the boat got. It lives HERE rather than in
 * `planRoute.ts` because `planRoute.ts` already imports from this module: a
 * back-import would be a cycle, and because this is `solve()`'s OWN output the
 * solver is its natural owner.
 *
 * WHAT THIS DOES NOT FIX, stated plainly because the next reader will ask:
 * changing the CLASSIFICATION — the `blockedDeaths >= calmDeaths` heuristic
 * below, or the horizon guard's placement — still changes which cause comes
 * out and therefore still moves routes. That coupling is intrinsic and is
 * meant to exist: a gate has to know why the solve failed. What #282 removes is
 * the ACCIDENTAL half — a change to the user-facing label set can no longer
 * reach the solver at all. A classification change is now visibly an edit to a
 * control value rather than to a display string, and per #282 it still needs
 * the full Flensburg->all-harbours sweep before it is trusted.
 */
export type SolveFailureCause =
  | 'mask-blocked'
  | 'calm-without-motor'
  | 'horizon-exceeded'
  // #432: the plan's wall-clock budget ran out mid-search.
  //
  // Unlike the other three this is NOT a product of the classification
  // heuristic at the bottom of solve() — it is returned by the deadline check
  // at the top of the ring loop, on a path no completing solve ever reaches.
  // That is what keeps it outside #282's "a classification change moves
  // routes" hazard: the partition of the pre-existing three is untouched, an
  // UNBUDGETED solve (`SolveParams.deadline` absent — every vitest call site)
  // can never produce it, and a budgeted one can only produce it where the
  // client's own deadline was already about to abandon the plan.
  //
  // It shares the `no-route` arm with the others rather than getting a
  // separate SolveResult arm, which is a deliberate reversal of this change's
  // first draft: that draft predated PR #450 and needed the separate arm
  // only because `solve()` was still typed against the presentational
  // `NoRouteReason`, so a fourth member would have leaked a label into the
  // solver. #450 removed that constraint. The remaining semantic objection —
  // "no-route" overstates what a truncated search knows — is real but already
  // true of 'horizon-exceeded', which is likewise a search LIMIT rather than
  // a finding about the water; the honesty is carried where the user actually
  // reads it, by the 'search-budget-exceeded' label's own copy.
  | 'budget-exhausted'
  // #885: the calm arm of the heuristic below, on a forced-sail segment. Kept
  // apart from 'calm-without-motor' because the remedy differs (unmark the
  // segment), and neither retry gate may admit it.
  | 'forced-sail-calm';

export type SolveResult =
  | {
      status: 'ok';
      legs: Leg[];
      etaMs: number;
      /**
       * #1303: the winning arrival's RANKING clock (`Node.costMs`), equal to
       * `etaMs` whenever `comfortDepthM` is absent. Exposed because the search
       * optimises cost, not ETA, so only cost can state "this search found a
       * better route" — a finer prune grid can lower cost while ETA rises
       * (measured on PR #1304). `planRoute` never reads it and `PlanResult`
       * never carries it.
       */
      costMs: number;
    }
  | { status: 'no-route'; cause: SolveFailureCause };

interface Node {
  lat: number;
  lon: number;
  // TRUE elapsed wall-clock time since departure — drives wind.sample, both
  // horizon guards, backtrack's leg timestamps and the reported etaMs (#243
  // §D.5). Always advances by an edge's true duration, NEVER divided by a
  // depth-comfort factor: geometry and every user-visible time stay honest
  // regardless of the preference.
  tMs: number;
  // #243 ranking clock: advances by an edge's true duration DIVIDED BY that
  // edge's depth-comfort factor (<=1 in shallower-than-comfort water, else
  // exactly 1). Drives ONLY better(), visitedDominates and the arrival
  // comparison that picks `best` in solve() — never wind sampling, horizon
  // guards, or anything backtrack()/callers observe. costMs >= tMs always
  // (factor <= 1), and costMs === tMs identically throughout a solve whose
  // SolveParams.comfortDepthM is absent (factor is always exactly 1), which
  // is what makes the no-preference path byte-identical to pre-#243.
  costMs: number;
  kind: LegKind | 'start';
  board: Board | null; // null for motor/start
  headingDeg: number;
  twaSigned: number; // NaN for motor/start
  stepSpeedKn: number; // through-water speed used on this edge
  twsKn: number;
  maneuverAtStart: ManeuverKind | null;
  maneuvers: number;
  distToDestNm: number;
  parent: Node | null;
}

const MIN_SAIL_KN = 0.2;
const CAPTURE_NM = 0.1;
const PRUNE_LAT = 0.002; // ~220 m
const PRUNE_LON = 0.003; // ~190 m at 55°N
// Perf safeguard, not a correctness bound: when the frontier exceeds the cap,
// non-dominated candidates are discarded by count (see `better()` below for
// the ordering) rather than by geometry. A no-route in that regime may
// reflect search capacity rather than actual unreachability; surfacing that
// distinction to the caller is deferred (plan-amendment pending).
//
// #1257: the FLOOR, and the cap for masks too small for the scaling rule
// below to exceed it (every synthetic mask in the suite). It is #67's
// original figure, never derived from a measurement.
const MAX_FRONTIER = 30_000;
/**
 * #1257: frontier cap per prune cell of the mask's domain.
 *
 * Basis is PRUNE cells, not mask cells: the frontier is `byKey`-collapsed to
 * one node per prune key, so its size SCALES with the domain's prune-cell
 * count, which is fixed in degrees (`PRUNE_LAT`/`PRUNE_LON`) and therefore
 * independent of mask RESOLUTION. Scales with, never bounded by — the true
 * ceiling is higher by a constant factor this rule deliberately ignores, since
 * a constant cancels out of a scaling law: three board suffixes per cell
 * (`P`/`S`/`M`), and the confined divisor squared in fine keys inside every
 * confined cell since #1322 (`CONFINED_PRUNE_DIV`, or
 * `MOTOR_OFF_CONFINED_PRUNE_DIV` since #1168). Scaling by mask cells would
 * inflate the cap on a mask refined over the same water (#245's rejected
 * direction) where nothing about the frontier changed. The two bases coincide
 * exactly today — #295 widened the domain at unchanged resolution, so both give
 * 1.7875x the pre-#295 mask.
 *
 * Grid extent, never NAVIGABLE cells, although #1257 asks for the latter:
 * navigability is decided per query against a gate, so a navigable count
 * would vary with `safetyDepthM` and with each #53 relaxation tier, giving
 * one solve several different caps.
 *
 * DERIVATION of 0.2. Post-#1322 peak frontier, uncapped, real committed mask
 * and polars, `breeze` arm aperture (Flensburg origin, DEFAULT_SETTINGS,
 * uniform 12 kn / 225 deg, tier 1), solo: 61 653 (svendborg S45 fock),
 * 61 883 (orth S45 genoa), 62 482 (burgstaaken S45 genoa), 64 402
 * (rudkoebing S44 genoa), 38 758 (aeroeskoebing S45 genoa), 52 848 (marstal
 * S44 genoa), and 578 / 2 988 on the two short routes that never truncate.
 * Worst measured is 64 402 over 8 of the sweep's 440 plans, so the
 * population maximum is NOT measured — 0.2 buys 1.48x headroom over it
 * (0.2 x 476 667 prune cells = 95 333). Eight samples do not bound a
 * population: read this as headroom chosen against the worst route family
 * found, not as a proof that truncation can no longer fire.
 */
const FRONTIER_PER_PRUNE_CELL = 0.2;

/**
 * #1257: the default frontier cap for a mask's domain — see
 * {@link FRONTIER_PER_PRUNE_CELL} for the basis and the derivation. Floored
 * at {@link MAX_FRONTIER} so small (synthetic) masks keep the historical cap
 * and every existing starved-cap test is unaffected.
 */
export function defaultMaxFrontier(meta: {
  north: number;
  south: number;
  east: number;
  west: number;
}): number {
  const pruneCells =
    ((meta.north - meta.south) / PRUNE_LAT) * ((meta.east - meta.west) / PRUNE_LON);
  return Math.max(MAX_FRONTIER, Math.round(FRONTIER_PER_PRUNE_CELL * pruneCells));
}
/**
 * #1280 part B: how many frontier nodes one ring expands between wall-clock
 * budget checks. Sized from a measured per-node cost recorded in commit
 * 0859518's message (no PR body carries it), so a batch sits orders of
 * magnitude below the 15 s client grace the old one-ring granularity
 * overshot, while the added per-node overhead is an increment and a compare.
 */
export const DEADLINE_CHECK_NODES = 128;
const EXTRA_TWAS = [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175];
const MOTOR_TWAS = [0, 20, 35];
// #885: a forced-motor segment has no sail up, so candidates are headings, not
// TWAs. 10° spacing gives 36 headings (+ the direct bearing), against today's
// ~39-entry per-node TWA set with motor enabled.
const FORCED_MOTOR_FAN_DEG = 10;
const FORCED_MOTOR_HEADINGS = Array.from(
  { length: 360 / FORCED_MOTOR_FAN_DEG },
  (_, i) => i * FORCED_MOTOR_FAN_DEG,
);
// #243 depth comfort preference: the maximum fraction by which a segment's
// clock cost is inflated when its clearance sits exactly at the gate (linear
// ramp to 0 extra cost at `comfortDepthM`). Fixed, not user-configurable —
// see the design addendum's rationale (dimensionless, no seamanlike meaning;
// exposing it invites the search-capacity regime the parameter sweep found
// past ~0.5). Re-validated by the §E.3-equivalent sweep on this
// implementation before being locked at 0.30 (see PR description).
//
// Known residual (design §D.4 "minimum vs. integral"): the factor prices
// each edge's OWN clearance, but the search optimizes the resulting COST,
// which composes over the whole route — so this is closer to minimizing an
// integral of shortfall than the route's minimum clearance, and the two can
// diverge. Measured case: Ærøskøbing → Drejø, 270°, DEFAULT_SETTINGS — the
// recommended rig's minimum clearance settles at 3.0 m instead of the
// pre-#243 3.7 m, even though total shallow exposure elsewhere improves.
// Derate-insensitive (present identically at every tested value 0.15-0.40 —
// retuning this constant does not fix it) and margin-sensitive (absent at
// margin 1.0 m, present at >= 1.5 m). Safety-inert: every leg is still
// gate-validated, and 3.0 m is exactly what this same passage's OTHER rig
// already touches today. Not eliminated by any tested parameter combination
// — see realmask.repro.depthComfort.test.ts's pinned threshold test
// (Aeroeskoebing -> Drejoe) and CHANGELOG.md.
const DEPTH_DERATE_MAX = 0.3;

/**
 * #243: the depth-comfort multiplicative factor for the a→b edge, or null
 * when the edge is blocked outright — exactly `segmentNavigable(a, b, gateM)
 * ? 1 : null` when `comfortDepthM` is absent (or not strictly deeper than the
 * gate, which would make the ramp's denominator non-positive). A factor of 1
 * means "free" (clearance at or above the comfort depth); a factor
 * approaching `1 - DEPTH_DERATE_MAX` means "at the gate itself". Callers
 * spend the factor on the edge's CLOCK (dividing the true duration by it),
 * never on its geometry — see the Node.costMs doc comment.
 *
 * Exported for direct unit testing of the shortfall/derate arithmetic
 * (#243 §G.2) — the exact numbers are hand-derivable and don't need a full
 * solve() run to pin.
 */
export function edgeFactor(
  mask: NavMask,
  a: LatLon,
  b: LatLon,
  gate: DepthGate,
  comfortDepthM: number | undefined,
): number | null {
  // #452: the ramp is a SEGMENT-level scalar, so it anchors at the most
  // permissive gate anywhere in the field. For a UniformGate that is the gate
  // itself, which is what keeps every pre-#452 call byte-identical; for an
  // ApproachGate it is `minGateM` — this plan's own `usedDepthM`, the slot
  // the pre-#452 relaxed tiers filled by overwriting `settings.safetyDepthM`.
  // Anchoring it anywhere else would be the
  // ramp RE-ANCHOR that spike §3.2 graft 6 requires to be a separate PR.
  const floorM = gateFloorM(gate);
  if (comfortDepthM === undefined || comfortDepthM <= floorM) {
    return mask.segmentNavigable(a, b, gate) ? 1 : null;
  }
  const clearanceM = mask.segmentClearanceM(a, b, gate);
  if (clearanceM === null) return null; // === segmentNavigable === false
  if (clearanceM >= comfortDepthM) return 1;
  // clearanceM is >= every touched cell's own gate, and every cell's gate is
  // >= floorM, so clearanceM >= floorM and shortfall lands in (0, 1]. The
  // clamp is therefore INERT — it is defence against a future field whose
  // floor stops bounding the clearance, not a live correction, and no
  // reachable change to today's code makes it fire (so nothing tests it).
  const shortfall = Math.min(1, (comfortDepthM - clearanceM) / (comfortDepthM - floorM));
  return 1 - DEPTH_DERATE_MAX * shortfall;
}

/**
 * #1303/#1305: how much finer the prune grid gets, per axis, inside CONFINED
 * water, for motor-on solves ({@link MOTOR_OFF_CONFINED_PRUNE_DIV} is the
 * motor-off twin). `1` disables the refinement and restores the pre-#1303 key
 * exactly — the off switch every re-pin in this change was measured against
 * (the BASE control), not decoration. Typed `number` so that comparison
 * typechecks.
 */
const CONFINED_PRUNE_DIV: number = 2;
/**
 * #1168: the confined divisor for a motor-off solve (`motorEnabled` false or
 * `forcedKind: 'sail'`). In a motor-off solve, most full steps in a narrow
 * are blocked and the accepted children are substeps, which a cheaper
 * arrival elsewhere in the same key prunes — so the frontier can die on
 * connected water (`docs/spikes/1168-motor-off-prune-instability.md` §3).
 * Motor-on solves keep {@link CONFINED_PRUNE_DIV}, so they are byte-identical
 * by construction; the spike's §6 is why the finer grid is not applied to
 * them.
 */
const MOTOR_OFF_CONFINED_PRUNE_DIV: number = 3;
/**
 * Mask cells of dilation around a prune cell when classifying confinement. A
 * prune cell is ~220x190 m against ~46 m mask cells, so one cell of margin
 * asks "is there land or sub-gate water within ~46 m of this cell". Calibrated
 * on the #1303/#1305 narrows — see the PR body.
 */
const CONFINEMENT_MARGIN_CELLS = 1;

/**
 * True when the prune cell `(latIdx, lonIdx)`, dilated by `marginCells` mask
 * cells, touches any cell that is NOT navigable at this solve's gate — land,
 * sub-gate water, or outside the mask (which reads confined, so the refinement
 * fails toward MORE pruning resolution rather than less).
 *
 * This is the general form of PR #1304's destination-only rule: dominance
 * treats position within a prune cell as irrelevant, which is wrong wherever a
 * passage is narrower than a prune cell — a cheaper arrival with no navigable
 * onward edge seals the cell against a better-placed later one (#1303 at a
 * harbour approach, #1305 at a pass-through narrow). Open water keeps the
 * coarse grid and its cost.
 *
 * #1333 — WHAT THIS DOES NOT GUARANTEE. Refining the key changes which cells
 * share a prune key; it does NOT make the resulting node set a superset of
 * the coarse one, in EITHER regime, and a route reachable before CAN be lost.
 * The superset argument holds for one ring from a fixed frontier and does not
 * survive induction: once the fine run's frontier differs, its extra children
 * fall into the same FINE sub-cells as the coarse winners and can beat them
 * under `better()`, evicting them — the #1303 shape turned on the refinement
 * itself. Measured at divisor 2 on Flensburg -> Bagenkop,
 * `motorEnabled: false`, TWS 3.0 unsnapped (#1168's comment 5727667435):
 * ring 4 has 7 fine nodes to the coarse run's 3, ring 5 has ZERO fine to the
 * coarse run's 3, and the route
 * goes `mask-blocked` where it routed before — at a peak frontier of 38
 * against a 30 000 cap, so truncation is not involved. An earlier revision of
 * this comment claimed the uncapped regime was safe; it is refuted, not
 * merely unproven. Truncation is a SECOND, independent way the node set
 * moves: a larger winner set changes which nodes survive the cap — measured,
 * the starved-cap pin moved 5 -> 4.
 *
 * Exported for direct testing of the classification itself, which is cheaper
 * to interrogate than a 100 s solve.
 */
export function pruneCellConfined(
  mask: NavMask,
  gate: DepthGate,
  latIdx: number,
  lonIdx: number,
  marginCells: number,
): boolean {
  const { lat: latAxis, lon: lonAxis } = mask.grid;
  const rowLo = latAxis.index(latIdx * PRUNE_LAT) - marginCells;
  const rowHi = latAxis.index((latIdx + 1) * PRUNE_LAT) + marginCells;
  const colLo = lonAxis.index(lonIdx * PRUNE_LON) - marginCells;
  const colHi = lonAxis.index((lonIdx + 1) * PRUNE_LON) + marginCells;
  for (let row = rowLo; row <= rowHi; row++) {
    const lat = latAxis.centre(row);
    for (let col = colLo; col <= colHi; col++) {
      // A degenerate segment walks exactly this one cell, so this is the
      // per-cell gate test `segmentNavigable` already applies to every edge —
      // the same predicate the solver navigates by, never a second copy of it.
      const p = { lat, lon: lonAxis.centre(col) };
      if (!mask.segmentNavigable(p, p, gate)) return true;
    }
  }
  return false;
}

function pruneKey(lat: number, lon: number, kind: LegKind | 'start', board: Board | null): string {
  const b = kind === 'motor' ? 'M' : board === 'port' ? 'P' : 'S';
  return `${Math.floor(lat / PRUNE_LAT)}:${Math.floor(lon / PRUNE_LON)}:${b}`;
}

/** Componentwise minima of the arrivals a prune cell has seen in completed rings. */
export interface VisitedStamp {
  // #243 §D.5: the RANKING clock (Node.costMs), not true elapsed time — see
  // visitedDominates.
  costMs: number;
  maneuvers: number;
}

/**
 * True when the stamp dominates the candidate on BOTH axes (issue #21 gap 1):
 * a candidate is pruned only when nothing about it — ranking clock or
 * maneuver count — improves on what already reached the cell. Substepped
 * threads carry earlier clocks than full-step threads (see the
 * blocked-candidate retry in solve), so a maneuvers-only rule could let a
 * later-clock arrival prune an earlier-clock one. Componentwise minima can
 * combine two different stampers into a dominator neither of them was alone —
 * a conservative residual, but strictly less pruning than the maneuvers-only
 * rule this replaces. Uses `costMs`, not true elapsed time (#243 §D.5): when
 * no depth comfort preference is active the two are identical, so this is
 * byte-identical to the pre-#243 tMs-based rule in that case.
 */
export function visitedDominates(seen: VisitedStamp, cand: VisitedStamp): boolean {
  return seen.costMs <= cand.costMs && seen.maneuvers <= cand.maneuvers;
}

/**
 * Lower the stored componentwise minima for `key` with one more arrival.
 * The arrival is passed as a single `VisitedStamp` so the two axes can never be
 * swapped at a call site (issue #21 gap 1): `costMs` and `maneuvers` are named
 * fields, not two same-typed positional numbers.
 */
export function stampVisited(
  visited: Map<string, VisitedStamp>,
  key: string,
  stamp: VisitedStamp,
): void {
  const seen = visited.get(key);
  if (seen === undefined) {
    visited.set(key, { costMs: stamp.costMs, maneuvers: stamp.maneuvers });
  } else {
    if (stamp.costMs < seen.costMs) seen.costMs = stamp.costMs;
    if (stamp.maneuvers < seen.maneuvers) seen.maneuvers = stamp.maneuvers;
  }
}

/** Deterministic "is a better than b" for same-cell pruning and frontier capping. */
function better(a: Node, b: Node): boolean {
  // Substepped nodes (see the blocked-candidate retry in solve) carry earlier
  // clocks than full-step nodes; prefer the earlier arrival in a cell. No-op
  // while the frontier is time-synchronized (no substeps taken). Ranks on
  // costMs, not true elapsed time (#243 §D.5) — identical to ranking on tMs
  // when no depth comfort preference is active.
  if (a.costMs !== b.costMs) return a.costMs < b.costMs;
  if (a.maneuvers !== b.maneuvers) return a.maneuvers < b.maneuvers;
  if (a.distToDestNm !== b.distToDestNm) return a.distToDestNm < b.distToDestNm;
  if (a.headingDeg !== b.headingDeg) return a.headingDeg < b.headingDeg;
  return a.lat !== b.lat ? a.lat < b.lat : a.lon < b.lon;
}

export function solve(p: SolveParams): SolveResult {
  const { polar, wind, mask, settings, destination } = p;
  const maxFrontier = p.maxFrontier ?? defaultMaxFrontier(mask.meta);
  const horizonMs = wind.horizonMs();
  const comfortDepthM = p.comfortDepthM;
  // #452: resolved ONCE per solve and passed down by reference. `edgeFactor`
  // runs per candidate edge — millions of times per plan — so a gate object
  // must never be constructed inside it or any loop body.
  const gate = p.gate ?? uniformGate(settings.safetyDepthM);
  const forcedKind = p.forcedKind;
  // #885: a forced-sail segment solves as motor-off. Absent forcedKind this is
  // exactly settings.motorEnabled, so every read below is unchanged.
  const motorEnabled = forcedKind === 'sail' ? false : settings.motorEnabled;
  // #254: the sail-speed floor. A heading motors when sailing it would be more
  // than settings.sailPreferenceKn slower than motoring. motorThresholdKn is the
  // seaworthiness floor underneath, so a small engine can never be handed legs
  // slower than sailing. When motoring is disabled the floor is the bare
  // threshold and the branch below falls through to the MIN_SAIL_KN path.
  const sailFloorKn = motorEnabled
    ? Math.max(settings.motorThresholdKn, settings.motorSpeedKn - settings.sailPreferenceKn)
    : settings.motorThresholdKn;

  const start: Node = {
    lat: p.origin.lat,
    lon: p.origin.lon,
    tMs: p.departureMs,
    costMs: p.departureMs,
    kind: 'start',
    board: null,
    headingDeg: NaN,
    twaSigned: NaN,
    stepSpeedKn: 0,
    twsKn: 0,
    maneuverAtStart: null,
    maneuvers: 0,
    distToDestNm: haversineNm(p.origin, destination),
    parent: null,
  };

  let frontier: Node[] = [start];
  let tMs = p.departureMs;
  // #243 §D.5: `costMs` ranks candidates, `etaMs` is the TRUE arrival clock
  // reported to callers and used in every horizon check. The two coincide
  // exactly when comfortDepthM is absent.
  let best: { costMs: number; etaMs: number; last: Node } | null = null;
  const visited = new Map<string, VisitedStamp>(); // pruneKey → min cost + min maneuvers seen
  let blockedDeaths = 0;
  let calmDeaths = 0;
  // #1303/#1305: confinement is classified per COARSE prune cell, never per
  // node, so a cell is wholly coarse-keyed or wholly fine-keyed and a node
  // gets the same key at the dominance lookup and at the stamp. Cached per
  // solve because the gate is fixed per solve (a relaxed tier builds its own
  // cache, with its own gate).
  const confinedCells = new Map<string, boolean>();
  const confinedDiv = motorEnabled ? CONFINED_PRUNE_DIV : MOTOR_OFF_CONFINED_PRUNE_DIV;
  const keyOf = (
    lat: number,
    lon: number,
    kind: LegKind | 'start',
    board: Board | null,
  ): string => {
    const coarse = pruneKey(lat, lon, kind, board);
    if (confinedDiv === 1) return coarse;
    const cell = `${Math.floor(lat / PRUNE_LAT)}:${Math.floor(lon / PRUNE_LON)}`;
    let confined = confinedCells.get(cell);
    if (confined === undefined) {
      confined = pruneCellConfined(
        mask,
        gate,
        Math.floor(lat / PRUNE_LAT),
        Math.floor(lon / PRUNE_LON),
        CONFINEMENT_MARGIN_CELLS,
      );
      confinedCells.set(cell, confined);
    }
    if (!confined) return coarse;
    const b = kind === 'motor' ? 'M' : board === 'port' ? 'P' : 'S';
    const k = confinedDiv;
    // The `f` prefix keeps the two key spaces disjoint (a coarse key starts
    // with a digit or `-`), so a coarse stamp can never dominate a fine-keyed
    // node or the reverse.
    return `f${Math.floor((lat * k) / PRUNE_LAT)}:${Math.floor((lon * k) / PRUNE_LON)}:${b}`;
  };
  // #1136: `skipDominance` marks the current ring as a salvage pass.
  let skipDominance = false;

  while (frontier.length > 0) {
    // #432 plan-level wall-clock budget. Checked FIRST in the ring, before
    // any expansion work, so a solve entered with an already-spent budget
    // (a later tier, or a later waypoint segment) costs one predicate rather
    // than one ring.
    //
    // ABORT GRANULARITY is DEADLINE_CHECK_NODES frontier nodes since #1280
    // part B — this ring-entry check is kept because a solve entered with an
    // already-spent budget must cost one predicate, not one node batch. The
    // pre-#1280 granularity was one whole ring, which under CPU contention
    // overshot the client's 15 s grace and surfaced as `error.routingTimeout`
    // instead of the typed budget failure (#1280).
    // The client-side backstop is sized to absorb the remaining overshoot —
    // see PLAN_TIMEOUT_GRACE_MS in workerClient.ts.
    //
    // A `best` already found is DISCARDED rather than returned. It is a
    // complete, fully mask-validated route, but the loop has not yet proven
    // no cheaper one exists (that is the `minCostMs >= best.costMs` guard
    // right below), so returning it would be returning a route of unproven
    // optimality with nothing in PlanResult saying so. #432's requirement is
    // that exceeding the budget is a FAILURE and says so; a silently
    // possibly-suboptimal route is the one outcome it rules out. The
    // alternative — return it with a `truncated` warning alongside, mirroring
    // ShallowInfo — is a real design and is recorded as rejected-for-now in
    // the PR body, not foreclosed.
    if (p.deadline?.expired()) return { status: 'no-route', cause: 'budget-exhausted' };
    // Substepped nodes lag the global clock, so the termination guards use the
    // earliest node clock in the frontier (=== tMs/costMs when no substeps
    // occurred). The "no further improvement possible" guard below ranks on
    // costMs (#243 §D.5: costMs >= tMs always, so a frontier already past
    // best's TRUE arrival could still contain a cheaper-COST candidate under
    // an active depth preference — ranking the guard on tMs would risk
    // terminating before finding it). The forecast-horizon guard right after
    // it stays on minTMs: the horizon is a real-world forecast boundary, never
    // a ranking quantity.
    let minDist = Infinity;
    let minTMs = Infinity;
    let minCostMs = Infinity;
    for (const n of frontier) {
      if (n.distToDestNm < minDist) minDist = n.distToDestNm;
      if (n.tMs < minTMs) minTMs = n.tMs;
      if (n.costMs < minCostMs) minCostMs = n.costMs;
    }
    if (best && minCostMs >= best.costMs) break;
    const dtS = minDist < 2 ? 150 : minDist < 5 ? 300 : 600;
    if (minTMs + dtS * 1000 > horizonMs) {
      if (best) break;
      return { status: 'no-route', cause: 'horizon-exceeded' };
    }

    const byKey = new Map<string, Node>();
    let sinceDeadlineCheck = 0;
    for (const node of frontier) {
      // #1280 part B: the budget check, every DEADLINE_CHECK_NODES nodes. It
      // sits at a NODE BOUNDARY and reads the deadline only — it never
      // reorders or skips a node's children, so the ring either completes or
      // the whole solve aborts, and an UNBUDGETED solve (no deadline: every
      // vitest call site and the #282 sweep) is a counter increment and one
      // `undefined?.expired()` — byte-identical results either way.
      // `best` is discarded for the same reason as at ring entry above.
      if (++sinceDeadlineCheck >= DEADLINE_CHECK_NODES) {
        sinceDeadlineCheck = 0;
        if (p.deadline?.expired()) return { status: 'no-route', cause: 'budget-exhausted' };
      }
      const from = { lat: node.lat, lon: node.lon };
      const w = wind.sample(from, node.tMs);
      const bearingToDest = initialBearingDeg(from, destination);

      // Candidates: signed TWAs (deduped within 1°) plus the direct TWA; on a
      // forced-motor segment, headings (#885) plus the direct bearing.
      let candidates: number[];
      if (forcedKind === 'motor') {
        candidates = FORCED_MOTOR_HEADINGS.some(
          (h) => Math.abs(normalizeDeg180(h - bearingToDest)) < 0.5,
        )
          ? FORCED_MOTOR_HEADINGS
          : [...FORCED_MOTOR_HEADINGS, bearingToDest];
      } else {
        const mags = [
          polar.beatAngleDeg(w.speedKn),
          polar.gybeAngleDeg(w.speedKn),
          ...EXTRA_TWAS,
          ...(motorEnabled ? MOTOR_TWAS : []),
        ];
        const twas: number[] = [];
        for (const m of mags)
          for (const s of [1, -1]) {
            const t = s * m;
            if (!twas.some((x) => Math.abs(x - t) < 1)) twas.push(t);
          }
        if (!twas.includes(180)) twas.push(180);
        const directTwa = normalizeDeg180(w.dirFromDeg - bearingToDest);
        if (!twas.some((x) => Math.abs(x - directTwa) < 0.5)) twas.push(directTwa);
        candidates = twas;
      }

      let produced = 0;
      let sawBlocked = false;
      let sawCalm = false;

      for (const candidate of candidates) {
        let headingDeg: number;
        let twa: number;
        let kind: LegKind;
        let speed: number;
        if (forcedKind === 'motor') {
          headingDeg = candidate;
          twa = NaN; // no sail up: never read on a motor candidate
          kind = 'motor';
          speed = settings.motorSpeedKn;
        } else {
          twa = candidate;
          headingDeg = (((w.dirFromDeg - twa) % 360) + 360) % 360;
          const sailSpeed = polar.speedKn(twa, w.speedKn);
          if (sailSpeed >= sailFloorKn) {
            kind = 'sail';
            speed = sailSpeed;
          } else if (motorEnabled) {
            kind = 'motor';
            speed = settings.motorSpeedKn;
          } else if (sailSpeed >= MIN_SAIL_KN) {
            kind = 'sail';
            speed = sailSpeed;
          } else {
            sawCalm = true;
            continue;
          }
        }

        const board = kind === 'sail' ? boardForCandidate(twa, node.board) : null;
        let maneuver: ManeuverKind | null = null;
        let effS = dtS;
        if (kind === 'sail' && node.kind === 'sail' && node.board && board !== node.board) {
          maneuver = classifyManeuver(node.twaSigned, twa);
          effS = Math.max(dtS - settings.maneuverPenaltyS, 0);
        }
        const distNm = (speed * effS) / 3600;
        if (distNm <= 0) continue;

        // Direct-candidate arrival test (exact leg to destination)
        const isDirect = Math.abs(normalizeDeg180(headingDeg - bearingToDest)) < 0.5;
        if (isDirect && node.distToDestNm <= distNm) {
          const directFactor = edgeFactor(mask, from, destination, gate, comfortDepthM);
          if (directFactor !== null) {
            const penaltyS = dtS - effS;
            // TRUE elapsed time for this hop — unaffected by the depth
            // comfort factor (#243 §D.5: geometry and true time stay honest;
            // only the ranking cost below is scaled). Split into the
            // maneuver-penalty term and the travel term because only the
            // LATTER gets re-priced below (fix-wave item 5: the design
            // prices water crossed, not maneuvers executed — a tack/gybe
            // costs the same real seconds regardless of what's under the
            // keel at that instant).
            const travelMs = (node.distToDestNm / speed) * 3600 * 1000;
            const durMs = penaltyS * 1000 + travelMs;
            const etaMs = node.tMs + durMs;
            // Only the travel term is divided by the factor — the maneuver
            // penalty is charged at its real cost on both tMs and costMs.
            const candCostMs = node.costMs + penaltyS * 1000 + travelMs / directFactor;
            if (etaMs <= horizonMs && (!best || candCostMs < best.costMs)) {
              const last: Node = {
                lat: destination.lat,
                lon: destination.lon,
                tMs: etaMs,
                costMs: candCostMs,
                kind,
                board,
                headingDeg,
                twaSigned: kind === 'motor' ? NaN : twa,
                stepSpeedKn: speed,
                twsKn: w.speedKn,
                maneuverAtStart: maneuver,
                maneuvers: node.maneuvers + (maneuver ? 1 : 0),
                distToDestNm: 0,
                parent: node,
              };
              best = { costMs: candCostMs, etaMs, last };
            }
            continue; // the direct edge is consumed by the arrival attempt
          }
          // Blocked direct arrival: fall through to the normal step below so
          // this heading gets the same substep retry as every other candidate
          // (issue #21 gap 2 — the destination-pocket mirror of the #20
          // origin-pocket fix) instead of dying consumed.
        }

        let stepMs = dtS * 1000;
        let end = destinationPoint(from, headingDeg, distNm);
        const fullFactor = edgeFactor(mask, from, end, gate, comfortDepthM);
        let factor: number;
        if (fullFactor !== null) {
          factor = fullFactor;
        } else {
          // A full step can be far longer than the local channel is straight
          // (issue #20: harbor arms are ~200-400 m wide while steps run
          // 0.5-2 km, so every heading died on the first expansion out of
          // Flensburg). Retry the same heading over dtS/2, dtS/4, dtS/8 and
          // take the largest substep that fits; the child keeps the honest
          // (shorter) clock, which better()/the loop guards account for.
          // Clearance is re-measured on whichever segment the fit test
          // actually accepts (#243 §D.3: "measured on the segment the fit
          // test accepted"), never on the rejected full step.
          let fitted: number | null = null;
          for (const div of [2, 4, 8]) {
            const subDtS = dtS / div;
            const subEffS = maneuver ? Math.max(subDtS - settings.maneuverPenaltyS, 0) : subDtS;
            const d = (speed * subEffS) / 3600;
            if (d <= 0) break; // maneuver penalty swallows this and every shorter substep
            const e = destinationPoint(from, headingDeg, d);
            const subFactor = edgeFactor(mask, from, e, gate, comfortDepthM);
            if (subFactor !== null) {
              end = e;
              stepMs = subDtS * 1000;
              fitted = subFactor;
              break;
            }
          }
          if (fitted === null) {
            sawBlocked = true;
            continue;
          }
          factor = fitted;
        }
        if (node.tMs + stepMs > horizonMs) continue;

        const child: Node = {
          lat: end.lat,
          lon: end.lon,
          tMs: node.tMs + stepMs,
          costMs: node.costMs + stepMs / factor,
          kind,
          board,
          headingDeg,
          twaSigned: kind === 'motor' ? NaN : twa,
          stepSpeedKn: speed,
          twsKn: w.speedKn,
          maneuverAtStart: maneuver,
          maneuvers: node.maneuvers + (maneuver ? 1 : 0),
          distToDestNm: haversineNm(end, destination),
          parent: node,
        };

        // Endpoint-capture arrival (covers non-direct approaches, e.g. beating
        // in). The capture hop end→destination is validated like any other
        // edge (issue #21 gap 3): without the check the final hop could cross
        // non-navigable cells that segmentNavigable rejects everywhere else.
        // The cheap distance/ETA gates run first and the expensive mask walk
        // runs last: candCostMs >= finalEtaMs always (#243 §D.5 — cost only
        // ever inflates relative to true time), so failing the finalEtaMs
        // pre-filter already proves this candidate cannot beat `best`,
        // without needing the factor that only the mask walk can produce.
        // When comfortDepthM is absent this pre-filter IS the final
        // comparison (factor === 1 identically), matching the pre-#243 code.
        if (child.distToDestNm < CAPTURE_NM) {
          const durMs = (child.distToDestNm / Math.max(speed, MIN_SAIL_KN)) * 3600 * 1000;
          const finalEtaMs = child.tMs + durMs;
          if (finalEtaMs <= horizonMs && (!best || finalEtaMs < best.costMs)) {
            const captureFactor = edgeFactor(mask, end, destination, gate, comfortDepthM);
            if (captureFactor !== null) {
              const candCostMs = child.costMs + durMs / captureFactor;
              if (!best || candCostMs < best.costMs) {
                const last: Node = {
                  ...child,
                  lat: destination.lat,
                  lon: destination.lon,
                  tMs: finalEtaMs,
                  costMs: candCostMs,
                  distToDestNm: 0,
                  parent: child,
                  maneuverAtStart: null,
                  headingDeg: initialBearingDeg(end, destination),
                };
                best = { costMs: candCostMs, etaMs: finalEtaMs, last };
              }
            }
          }
        }

        const key = keyOf(child.lat, child.lon, child.kind, child.board);
        const seen = visited.get(key);
        if (seen !== undefined && visitedDominates(seen, child) && !skipDominance) continue;
        const incumbent = byKey.get(key);
        if (!incumbent || better(child, incumbent)) byKey.set(key, child);
        produced++;
      }

      if (produced === 0) {
        if (sawBlocked) blockedDeaths++;
        if (sawCalm && !sawBlocked) calmDeaths++;
      }
    }

    let next = [...byKey.values()];
    const wasSalvagePass = skipDominance;
    skipDominance = false;
    if (p.salvage === true && next.length === 0 && best === null && !wasSalvagePass) {
      // #1136: re-expand this frontier without reassigning it, advancing the
      // clock or reporting progress. A salvage pass that also empties the
      // frontier falls through and ends the solve.
      skipDominance = true;
      continue;
    }
    if (next.length > maxFrontier) {
      next.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
      next = next.slice(0, maxFrontier);
    }
    // Stamp visited ONLY for the nodes that survive the frontier cap (issue
    // #67). A capped-out node never expands, so stamping it would permanently
    // seal its prune cell against every later arrival — even though that
    // capped node grew no subtree there — and a sole gateway cell whose first
    // arrival is capped out gets sealed, reporting a still-connected
    // destination as unreachable. Stamping after the slice keeps every
    // existing domination guarantee for the survivors (each surviving cell's
    // live representative still stamps its arrival) while no longer sealing
    // cells that have no surviving expander. When the frontier fits under the
    // cap, `next` === all byKey winners, so this is byte-identical to stamping
    // every winner — the uncapped path (the common case, incl. every real-mask
    // route whose frontier peaks below the cap) is unchanged.
    for (const n of next)
      stampVisited(visited, keyOf(n.lat, n.lon, n.kind, n.board), {
        costMs: n.costMs,
        maneuvers: n.maneuvers,
      });
    frontier = next;
    tMs += dtS * 1000;
    // Report the true frontier clock: substepped nodes lag the ring clock by
    // up to 7/8 dtS, so the ring clock alone can overstate progress. Equal to
    // tMs when no substeps occurred; empty frontier falls back to the ring.
    let frontierTMs = tMs;
    for (const n of frontier) if (n.tMs < frontierTMs) frontierTMs = n.tMs;
    p.onProgress?.({ tMs: frontierTMs, frontierSize: frontier.length });
  }

  if (!best) {
    // Heuristic: nodes pruned by visited/byKey count as neither death; adequate in real geometry, may misclassify contrived single-cell pockets,
    // plus a handful of consumed-without-registering paths (a blocked direct-arrival attempt; a zero-effective-speed candidate after a maneuver penalty).
    //
    // #866: 'mask-blocked' here cannot distinguish "genuinely unreachable"
    // from "solver gave up" — both collapse to the same cause. Investigated
    // for Marstal->Rudkoebing at the Salona 44 (salona44-relaxation sweep
    // arm, mask-blocked) vs. the Salona 45 (relaxation-dense, ok+shallow) at
    // the identical 2.3 m gate: cellsConnected (boat-independent) confirms
    // the destination IS mask-connected at that gate, so this was a real
    // "gave up" case, not a real "unreachable" one. MAX_FRONTIER truncation
    // was ruled out (cappedRingCount 0 in every run, peak frontier far below
    // the cap). The two boats' frontiers evolved identically through several
    // rings and then diverged; the only differing input was boat SPEED (S44
    // ~2% faster at every TWA at that TWS), so its longer per-ring step
    // overshot a gap the slower boat's step landed inside — a knife-edge
    // instance of the #20/#21 step-length-vs-real-channel-width mechanism,
    // not independently confirmed by a speed-swap experiment (narrowed, not
    // closed). Accepted as a known limit, not fixed — see #866's
    // investigation comment for the full measurement and the disposition
    // ruling.
    // #885: a motor candidate cannot be calm, so a forced-motor segment's
    // fallback arm is mask-blocked; a forced-sail calm gets its own cause.
    if (blockedDeaths >= calmDeaths && blockedDeaths > 0) {
      return { status: 'no-route', cause: 'mask-blocked' };
    }
    return {
      status: 'no-route',
      cause:
        forcedKind === 'sail'
          ? 'forced-sail-calm'
          : forcedKind === 'motor'
            ? 'mask-blocked'
            : 'calm-without-motor',
    };
  }
  return {
    status: 'ok',
    legs: backtrack(best.last, p.departureMs),
    etaMs: best.etaMs,
    costMs: best.costMs,
  };
}

function backtrack(last: Node, departureMs: number): Leg[] {
  const chain: Node[] = [];
  for (let n: Node | null = last; n && n.kind !== 'start'; n = n.parent) chain.unshift(n);
  const legs: Leg[] = [];
  for (const n of chain) {
    const parent = n.parent!;
    const start = { lat: parent.lat, lon: parent.lon };
    const end = { lat: n.lat, lon: n.lon };
    const distanceNm = haversineNm(start, end);
    const prev = legs[legs.length - 1];
    // Merges the solver's own per-step bookkeeping within already-validated steps;
    // this is NOT the CLAUDE.md-governed collinear merge pass (postprocess.ts), which re-validates.
    const collinear =
      prev &&
      prev.kind === n.kind &&
      prev.board === n.board &&
      n.maneuverAtStart === null &&
      Math.abs(normalizeDeg180(prev.headingDeg - n.headingDeg)) < 0.5;
    if (collinear) {
      prev.end = end;
      prev.endTimeMs = n.tMs;
      prev.distanceNm += distanceNm;
      prev.speedKn =
        prev.distanceNm / Math.max((prev.endTimeMs - prev.startTimeMs) / 3_600_000, 1e-9);
    } else {
      const common = {
        start,
        end,
        startTimeMs: parent.tMs,
        endTimeMs: n.tMs,
        headingDeg: n.headingDeg,
        twsKn: n.twsKn,
        speedKn: distanceNm / Math.max((n.tMs - parent.tMs) / 3_600_000, 1e-9),
        distanceNm,
      };
      if (n.kind === 'sail') {
        if (n.board === null) throw new Error('unreachable: sail node without a board');
        legs.push({
          ...common,
          kind: 'sail',
          board: n.board,
          twaDeg: n.twaSigned,
          maneuverAtStart: n.maneuverAtStart,
        });
      } else {
        // Motor arm sets maneuverAtStart explicitly: n.maneuverAtStart is
        // ManeuverKind | null on Node (shared by both branches), but a motor
        // leg can never actually carry a maneuver — the type now says so too.
        legs.push({ ...common, kind: 'motor', board: null, maneuverAtStart: null });
      }
    }
  }
  if (legs.length > 0) legs[0].startTimeMs = departureMs;
  return legs;
}
