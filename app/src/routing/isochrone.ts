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
  tMs: number;
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

function pruneKey(lat: number, lon: number, kind: LegKind | 'start', board: Board | null): string {
  const b = kind === 'motor' ? 'M' : board === 'port' ? 'P' : 'S';
  return `${Math.floor(lat / PRUNE_LAT)}:${Math.floor(lon / PRUNE_LON)}:${b}`;
}

/** Componentwise minima of the arrivals a prune cell has seen in completed rings. */
export interface VisitedStamp {
  tMs: number;
  maneuvers: number;
}

/**
 * True when the stamp dominates the candidate on BOTH axes (issue #21 gap 1):
 * a candidate is pruned only when nothing about it — arrival clock or maneuver
 * count — improves on what already reached the cell. Substepped threads carry
 * earlier clocks than full-step threads (see the blocked-candidate retry in
 * solve), so a maneuvers-only rule could let a later-clock arrival prune an
 * earlier-clock one. Componentwise minima can combine two different stampers
 * into a dominator neither of them was alone — a conservative residual, but
 * strictly less pruning than the maneuvers-only rule this replaces.
 */
export function visitedDominates(seen: VisitedStamp, cand: VisitedStamp): boolean {
  return seen.tMs <= cand.tMs && seen.maneuvers <= cand.maneuvers;
}

/**
 * Lower the stored componentwise minima for `key` with one more arrival.
 * The arrival is passed as a single `VisitedStamp` so the two axes can never be
 * swapped at a call site (issue #21 gap 1): `tMs` and `maneuvers` are named
 * fields, not two same-typed positional numbers.
 */
export function stampVisited(
  visited: Map<string, VisitedStamp>,
  key: string,
  stamp: VisitedStamp,
): void {
  const seen = visited.get(key);
  if (seen === undefined) {
    visited.set(key, { tMs: stamp.tMs, maneuvers: stamp.maneuvers });
  } else {
    if (stamp.tMs < seen.tMs) seen.tMs = stamp.tMs;
    if (stamp.maneuvers < seen.maneuvers) seen.maneuvers = stamp.maneuvers;
  }
}

/** Deterministic "is a better than b" for same-cell pruning and frontier capping. */
function better(a: Node, b: Node): boolean {
  // Substepped nodes (see the blocked-candidate retry in solve) carry earlier
  // clocks than full-step nodes; prefer the earlier arrival in a cell. No-op
  // while the frontier is time-synchronized (no substeps taken).
  if (a.tMs !== b.tMs) return a.tMs < b.tMs;
  if (a.maneuvers !== b.maneuvers) return a.maneuvers < b.maneuvers;
  if (a.distToDestNm !== b.distToDestNm) return a.distToDestNm < b.distToDestNm;
  if (a.headingDeg !== b.headingDeg) return a.headingDeg < b.headingDeg;
  return a.lat !== b.lat ? a.lat < b.lat : a.lon < b.lon;
}

export function solve(p: SolveParams): SolveResult {
  const { polar, wind, mask, settings, destination } = p;
  const maxFrontier = p.maxFrontier ?? MAX_FRONTIER;
  const horizonMs = wind.horizonMs();

  const start: Node = {
    lat: p.origin.lat,
    lon: p.origin.lon,
    tMs: p.departureMs,
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
  let best: { etaMs: number; last: Node } | null = null;
  const visited = new Map<string, VisitedStamp>(); // pruneKey → min clock + min maneuvers seen
  let blockedDeaths = 0;
  let calmDeaths = 0;

  while (frontier.length > 0) {
    // Substepped nodes lag the global clock, so the termination guards use the
    // earliest node clock in the frontier (=== tMs when no substeps occurred).
    let minDist = Infinity;
    let minTMs = Infinity;
    for (const n of frontier) {
      if (n.distToDestNm < minDist) minDist = n.distToDestNm;
      if (n.tMs < minTMs) minTMs = n.tMs;
    }
    if (best && minTMs >= best.etaMs) break;
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
          if (mask.segmentNavigable(from, destination, settings.safetyDepthM)) {
            const penaltyS = dtS - effS;
            const etaMs = node.tMs + (penaltyS + (node.distToDestNm / speed) * 3600) * 1000;
            if (etaMs <= horizonMs && (!best || etaMs < best.etaMs)) {
              const last: Node = {
                lat: destination.lat,
                lon: destination.lon,
                tMs: etaMs,
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
              best = { etaMs, last };
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
        if (!mask.segmentNavigable(from, end, settings.safetyDepthM)) {
          // A full step can be far longer than the local channel is straight
          // (issue #20: harbor arms are ~200-400 m wide while steps run
          // 0.5-2 km, so every heading died on the first expansion out of
          // Flensburg). Retry the same heading over dtS/2, dtS/4, dtS/8 and
          // take the largest substep that fits; the child keeps the honest
          // (shorter) clock, which better()/the loop guards account for.
          let fitted = false;
          for (const div of [2, 4, 8]) {
            const subDtS = dtS / div;
            const subEffS = maneuver ? Math.max(subDtS - settings.maneuverPenaltyS, 0) : subDtS;
            const d = (speed * subEffS) / 3600;
            if (d <= 0) break; // maneuver penalty swallows this and every shorter substep
            const e = destinationPoint(from, headingDeg, d);
            if (mask.segmentNavigable(from, e, settings.safetyDepthM)) {
              end = e;
              stepMs = subDtS * 1000;
              fitted = true;
              break;
            }
          }
          if (!fitted) {
            sawBlocked = true;
            continue;
          }
        }
        if (node.tMs + stepMs > horizonMs) continue;

        const child: Node = {
          lat: end.lat,
          lon: end.lon,
          tMs: node.tMs + stepMs,
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
        // All four conjuncts are side-effect-free, so the cheap distance/ETA
        // gates run first and the expensive mask walk runs last, unchanged in
        // result.
        if (child.distToDestNm < CAPTURE_NM) {
          const finalEtaMs =
            child.tMs + (child.distToDestNm / Math.max(speed, MIN_SAIL_KN)) * 3600 * 1000;
          if (
            finalEtaMs <= horizonMs &&
            (!best || finalEtaMs < best.etaMs) &&
            mask.segmentNavigable(end, destination, settings.safetyDepthM)
          ) {
            const last: Node = {
              ...child,
              lat: destination.lat,
              lon: destination.lon,
              tMs: finalEtaMs,
              distToDestNm: 0,
              parent: child,
              maneuverAtStart: null,
              headingDeg: initialBearingDeg(end, destination),
            };
            best = { etaMs: finalEtaMs, last };
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
        tMs: n.tMs,
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
