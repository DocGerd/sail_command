import type { Board, Leg, LegKind, LatLon, ManeuverKind, NoRouteReason, Settings } from '../types';
import type { Polar } from '../lib/polar';
import type { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
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
}

export type SolveResult =
  | { status: 'ok'; legs: Leg[]; etaMs: number }
  | {
      status: 'no-route';
      reason: Extract<NoRouteReason, 'unreachable' | 'beyond-horizon' | 'calm-motor-off'>;
    };

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
  gateM: number,
  comfortDepthM: number | undefined,
): number | null {
  if (comfortDepthM === undefined || comfortDepthM <= gateM) {
    return mask.segmentNavigable(a, b, gateM) ? 1 : null;
  }
  const clearanceM = mask.segmentClearanceM(a, b, gateM);
  if (clearanceM === null) return null; // === segmentNavigable === false
  if (clearanceM >= comfortDepthM) return 1;
  // clearanceM is in [gateM, comfortDepthM) here (segmentClearanceM only
  // returns depths >= gateM), so shortfall lands in (0, 1] and the ramp needs
  // no clamp.
  const shortfall = (comfortDepthM - clearanceM) / (comfortDepthM - gateM);
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
      return { status: 'no-route', reason: 'beyond-horizon' };
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
        if (sailSpeed >= settings.motorThresholdKn) {
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
            settings.safetyDepthM,
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
        const fullFactor = edgeFactor(mask, from, end, settings.safetyDepthM, comfortDepthM);
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
            const subFactor = edgeFactor(mask, from, e, settings.safetyDepthM, comfortDepthM);
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
              settings.safetyDepthM,
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
      reason: blockedDeaths >= calmDeaths && blockedDeaths > 0 ? 'unreachable' : 'calm-motor-off',
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
