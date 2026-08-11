import type { Board, Leg, LegKind, LatLon, ManeuverKind, Settings } from '../types';
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
   * Perf-cap on the per-ring frontier size. Defaults to {@link MAX_FRONTIER}.
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
  | 'budget-exhausted';

export type SolveResult =
  { status: 'ok'; legs: Leg[]; etaMs: number } | { status: 'no-route'; cause: SolveFailureCause };

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
// Perf safeguard, not a correctness bound: when the frontier exceeds this,
// non-dominated candidates are discarded by count (see `better()` below for
// the ordering) rather than by geometry. A no-route in that regime may
// reflect search capacity rather than actual unreachability; surfacing that
// distinction to the caller is deferred (plan-amendment pending).
const MAX_FRONTIER = 30_000;
const EXTRA_TWAS = [45, 55, 65, 75, 85, 95, 105, 115, 125, 135, 145, 155, 165, 175];
const MOTOR_TWAS = [0, 20, 35];
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
// — see realmask.repro.test.ts's pinned threshold test and CHANGELOG.md.
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
  // ApproachGate it is `minGateM`, the same value the pre-#452 relaxed tiers
  // put in `settings.safetyDepthM`. Anchoring it anywhere else would be the
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
  const maxFrontier = p.maxFrontier ?? MAX_FRONTIER;
  const horizonMs = wind.horizonMs();
  const comfortDepthM = p.comfortDepthM;
  // #452: resolved ONCE per solve and passed down by reference. `edgeFactor`
  // runs per candidate edge — millions of times per plan — so a gate object
  // must never be constructed inside it or any loop body.
  const gate = p.gate ?? uniformGate(settings.safetyDepthM);
  // #254: the sail-speed floor. A heading motors when sailing it would be more
  // than settings.sailPreferenceKn slower than motoring. motorThresholdKn is the
  // seaworthiness floor underneath, so a small engine can never be handed legs
  // slower than sailing. When motoring is disabled the floor is the bare
  // threshold and the branch below falls through to the MIN_SAIL_KN path.
  const sailFloorKn = settings.motorEnabled
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

  while (frontier.length > 0) {
    // #432 plan-level wall-clock budget. Checked FIRST in the ring, before
    // any expansion work, so a solve entered with an already-spent budget
    // (a later tier, or a later waypoint segment) costs one predicate rather
    // than one ring.
    //
    // ABORT GRANULARITY is one ring, so the real abort overshoots the
    // deadline by up to one ring's duration. Measured on this app's most
    // expensive real input (Flensburg -> Marstal, DEFAULT_SETTINGS, real
    // committed mask+polars, 2026-08-07, one dev machine): 132 rings,
    // 41.4 s total, slowest ring 1045 ms, frontier peaking at MAX_FRONTIER.
    // The client-side backstop is sized to absorb that overshoot with room
    // for a much slower device — see PLAN_TIMEOUT_GRACE_MS in workerClient.ts.
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
    for (const node of frontier) {
      const from = { lat: node.lat, lon: node.lon };
      const w = wind.sample(from, node.tMs);
      const bearingToDest = initialBearingDeg(from, destination);

      // Candidate signed TWAs (deduped within 1°), plus the direct candidate.
      const mags = [
        polar.beatAngleDeg(w.speedKn),
        polar.gybeAngleDeg(w.speedKn),
        ...EXTRA_TWAS,
        ...(settings.motorEnabled ? MOTOR_TWAS : []),
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

      let produced = 0;
      let sawBlocked = false;
      let sawCalm = false;

      for (const twa of twas) {
        const headingDeg = (((w.dirFromDeg - twa) % 360) + 360) % 360;
        const sailSpeed = polar.speedKn(twa, w.speedKn);
        let kind: LegKind;
        let speed: number;
        if (sailSpeed >= sailFloorKn) {
          kind = 'sail';
          speed = sailSpeed;
        } else if (settings.motorEnabled) {
          kind = 'motor';
          speed = settings.motorSpeedKn;
        } else if (sailSpeed >= MIN_SAIL_KN) {
          kind = 'sail';
          speed = sailSpeed;
        } else {
          sawCalm = true;
          continue;
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
          const directFactor = edgeFactor(
            mask,
            from,
            destination,
            gate,
            comfortDepthM,
          );
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
            const captureFactor = edgeFactor(
              mask,
              end,
              destination,
              gate,
              comfortDepthM,
            );
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

        const key = pruneKey(child.lat, child.lon, child.kind, child.board);
        const seen = visited.get(key);
        if (seen !== undefined && visitedDominates(seen, child)) continue;
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
    // route whose frontier peaks below MAX_FRONTIER) is unchanged.
    for (const n of next)
      stampVisited(visited, pruneKey(n.lat, n.lon, n.kind, n.board), {
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
    return {
      status: 'no-route',
      cause:
        blockedDeaths >= calmDeaths && blockedDeaths > 0 ? 'mask-blocked' : 'calm-without-motor',
    };
  }
  return { status: 'ok', legs: backtrack(best.last, p.departureMs), etaMs: best.etaMs };
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
