import type {
  LatLon,
  Leg,
  NoRouteReason,
  PlanRequest,
  PlanResult,
  PolarTable,
  Rig,
  RigResult,
  Settings,
  ShallowInfo,
  WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { BOAT_DRAFT_M, findRelaxedDepthM, type ProbeProgress } from './relaxedDepth';

export interface PlanDeps {
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  mask: NavMask;
}

export type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;

interface RunOut {
  rigResult: RigResult | null;
  reason: NoRouteReason | null;
}

/**
 * #68 reason propagation: fold the two rigs' failure reasons from the RELAXED
 * re-solve into one plan-level reason. Precedence encodes actionability, so the
 * class the user can act on wins when the rigs disagree:
 *   'beyond-horizon' (change departure / refresh forecast)
 *   > 'calm-motor-off' (enable motor)
 *   > 'unreachable' (mask-level, nothing the user can change).
 * Both rigs share mask/wind/waypoints and differ only in polar table, so a
 * disagreement is rare — but the fold is deterministic so the result is stable.
 */
function combineNoRouteReason(a: NoRouteReason | null, b: NoRouteReason | null): NoRouteReason {
  if (a === 'beyond-horizon' || b === 'beyond-horizon') return 'beyond-horizon';
  if (a === 'calm-motor-off' || b === 'calm-motor-off') return 'calm-motor-off';
  return 'unreachable';
}

/**
 * #243: does this rig-pair result need a full-tier retry with the depth
 * comfort preference turned off? True when EITHER rig individually failed
 * with a reason the preference could plausibly have caused: the §C.1
 * search-capacity effect the two-scalar clock encoding was designed to avoid
 * but cannot PROVE it always avoids ('unreachable'), or a preference-inflated
 * ranking clock tripping the horizon guard ('beyond-horizon'). 'calm-motor-off'
 * is a wind/mask fact the preference cannot cause or cure — mirroring #53's
 * own rule that only mask-unreachability degrades further — and never
 * triggers a retry.
 *
 * Checked per rig, but the retry always re-solves BOTH rigs together (#243
 * §D.1 piece 3, decided at PLAN level): a per-rig-only retry would cost the
 * two rigs under different objectives (one preference-weighted, one not) and
 * skew the recommended-rig comparison, which is why this is a tier rather
 * than a per-rig fallback.
 */
function needsUnpreferencedRetry(out: { genoa: RunOut; fock: RunOut }): boolean {
  const failedRetriably = (r: RunOut): boolean =>
    r.rigResult === null && (r.reason === 'unreachable' || r.reason === 'beyond-horizon');
  return failedRetriably(out.genoa) || failedRetriably(out.fock);
}

/**
 * #53: flag every leg whose geometry crosses cells charted below the REQUESTED
 * safety depth with that leg's minimum charted depth, across both rig results,
 * and derive the plan-level ShallowInfo (minGateDepthM = shallowest such cell
 * actually traversed). Returns null when no leg of either rig crosses
 * sub-requested cells — the relaxed gate merely widened the search without the
 * route using it, so the route is requested-depth-valid and carries no warning.
 */
function flagShallowLegs(
  mask: NavMask,
  rigs: { genoa: RunOut; fock: RunOut },
  requestedDepthM: number,
  usedDepthM: number,
): ShallowInfo | null {
  let minGateDepthM = Infinity;
  const flagLeg = (leg: Leg): Leg => {
    const minDepthM = mask.segmentShallowestBelow(leg.start, leg.end, requestedDepthM);
    if (minDepthM === null) return leg;
    if (minDepthM < minGateDepthM) minGateDepthM = minDepthM;
    // Narrow on kind (never cast) so each variant's spread keeps its own shape.
    return leg.kind === 'sail'
      ? { ...leg, shallow: { minDepthM } }
      : { ...leg, shallow: { minDepthM } };
  };
  for (const out of [rigs.genoa, rigs.fock]) {
    if (out.rigResult) out.rigResult.legs = out.rigResult.legs.map(flagLeg);
  }
  return minGateDepthM === Infinity ? null : { requestedDepthM, usedDepthM, minGateDepthM };
}

export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
  onProbe?: ProbeProgress,
): PlanResult {
  const { mask } = deps;
  const s = req.settings;
  const origin = mask.snapToNavigable(req.origin, s.safetyDepthM);
  if (!origin) return { status: 'error', reason: 'snap-failed-origin' };
  const destination = mask.snapToNavigable(req.destination, s.safetyDepthM);
  if (!destination) return { status: 'error', reason: 'snap-failed-destination' };

  const viaPoints: LatLon[] = [];
  for (const v of req.viaPoints) {
    const snapped = mask.snapToNavigable(v, s.safetyDepthM);
    if (!snapped) return { status: 'error', reason: 'snap-failed-via' };
    viaPoints.push(snapped);
  }
  const waypoints = [origin, ...viaPoints, destination];

  // #243 depth comfort preference: anchored to the REQUESTED settings `s`,
  // computed ONCE and reused unchanged for both the strict and the #53
  // relaxed solve below — this single line is the entire mechanism-2 fix
  // (the relaxed gate only widens what is *possible*; it must never make
  // sub-requested water equally *attractive* along the whole passage).
  // 0 = feature off ⇒ undefined ⇒ every solve/merge call below takes the
  // byte-identical pre-#243 path (SolveParams.comfortDepthM absent).
  const comfortDepthM =
    s.depthComfortMarginM > 0 ? s.safetyDepthM + s.depthComfortMarginM : undefined;

  const wind = new WindField(windGrid);
  const run = (
    rig: Rig,
    table: PolarTable,
    settings: Settings,
    comfort: number | undefined,
  ): RunOut => {
    const polar = new Polar(table, settings.performanceFactor);
    const legs: Leg[] = [];
    // Segments are solved sequentially, each departing at the previous
    // segment's ETA. Maneuver state (board, tack/gybe count) is v1-simplified
    // to reset at each via-point joint: a board change across a via is not
    // charged a maneuver penalty.
    let departureMs = req.departureMs;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const res = solve({
        origin: waypoints[i],
        destination: waypoints[i + 1],
        departureMs,
        polar,
        wind,
        mask,
        settings,
        onProgress: (info) => onProgress?.(rig, info),
        ...(comfort !== undefined ? { comfortDepthM: comfort } : {}),
      });
      if (res.status !== 'ok') return { rigResult: null, reason: res.reason };
      legs.push(...mergeCollinearLegs(res.legs, mask, wind, settings, comfort));
      departureMs = res.etaMs;
    }
    const etaMs = departureMs;
    const rigResult: RigResult = {
      rig,
      legs,
      etaMs,
      durationMs: etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { rigResult, reason: null };
  };
  const runBoth = (settings: Settings, comfort: number | undefined) => ({
    genoa: run('genoa', deps.polarGenoa, settings, comfort),
    fock: run('fock', deps.polarFock, settings, comfort),
  });

  const assemble = (genoa: RunOut, fock: RunOut, shallow: ShallowInfo | null): PlanResult => {
    const recommended: Rig =
      genoa.rigResult && fock.rigResult
        ? genoa.rigResult.etaMs <= fock.rigResult.etaMs
          ? 'genoa'
          : 'fock'
        : genoa.rigResult
          ? 'genoa'
          : 'fock';
    return {
      status: 'ok',
      genoa: genoa.rigResult,
      fock: fock.rigResult,
      genoaReason: genoa.rigResult ? null : genoa.reason,
      fockReason: fock.rigResult ? null : fock.reason,
      recommended,
      snappedOrigin: origin,
      snappedDestination: destination,
      // exactOptionalPropertyTypes: omit the key entirely when there is no
      // warning — never assign undefined explicitly.
      ...(shallow ? { shallow } : {}),
    };
  };

  const connectedAt = (depthM: number): boolean => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!mask.cellsConnected(waypoints[i], waypoints[i + 1], depthM)) return false;
    }
    return true;
  };

  // #53 fast path: any solver route implies a 4-connected navigable cell chain
  // between consecutive snapped waypoints (segmentNavigable's traversal steps
  // one cell at a time in x or y, so every validated leg sweeps such a chain).
  // A mask disconnected at the requested gate therefore makes both full solves
  // a foregone 'unreachable' — classify directly (one cheap BFS) instead of
  // burning two doomed isochrone runs first. This also classifies a
  // disconnected-AND-calm plan as 'unreachable' rather than the solver's
  // death-count heuristic guess, which is the more accurate class.
  let reason: NoRouteReason = 'unreachable';
  if (connectedAt(s.safetyDepthM)) {
    // #243 tier 1: requested gate, preference on — the happy path, nothing
    // extra paid.
    const tier1 = runBoth(s, comfortDepthM);
    if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier1)) {
      // #243 tier 2: requested gate, preference off — bit-identical to the
      // pre-#243 single `runBoth(s)` call this replaces (comfortDepthM
      // undefined ⇒ every solve/merge call takes the untouched path). Only
      // reached when the preference was actually active AND at least one rig
      // failed with a reason it could plausibly have caused (see
      // needsUnpreferencedRetry) — this is what makes "no plan can get worse
      // than pre-#243" true by construction rather than by argument.
      const tier2 = runBoth(s, undefined);
      if (tier2.genoa.rigResult || tier2.fock.rigResult)
        return assemble(tier2.genoa, tier2.fock, null);
      // #243 fix-wave item 5: tier 2 failed on BOTH rigs, but tier 1 may
      // still hold a genuinely successful rig (the retry was triggered by
      // the OTHER rig failing, per needsUnpreferencedRetry's per-rig check —
      // the search is heuristic, so a rig that succeeded WITH the
      // preference is not guaranteed to also succeed once retried without
      // it). Don't discard a working, internally-consistent (both legs from
      // the SAME preference-on tier, so still apples-to-apples) route just
      // because the retry didn't pan out — that would be strictly worse
      // than what tier 1 already had.
      if (tier1.genoa.rigResult || tier1.fock.rigResult) {
        return assemble(tier1.genoa, tier1.fock, null);
      }
      // Arbitrary tie-break: report genoa's reason (checked first); both rigs
      // solve identical mask/wind/waypoints and differ only in polar table,
      // so their failure reasons rarely differ in practice. Matches tier 1's
      // fallback below exactly (the pre-#243 rule).
      reason = tier2.genoa.reason!;
    } else if (tier1.genoa.rigResult || tier1.fock.rigResult) {
      return assemble(tier1.genoa, tier1.fock, null);
    } else {
      // Arbitrary tie-break: report genoa's reason (checked first); both rigs
      // solve identical mask/wind/waypoints and differ only in polar table,
      // so their failure reasons rarely differ in practice.
      reason = tier1.genoa.reason!;
    }
  }

  // #53 graceful degradation below safety depth: ONLY the mask-unreachability
  // class relaxes — calm-motor-off and beyond-horizon keep their errors — and
  // never at or below the boat-draft floor. The relaxed gate is discovered
  // once (cheap mask BFS probes, no solver runs), then BOTH rigs solve at that
  // single gate, so the rig comparison stays apples-to-apples by construction.
  // The user's safetyDepthM setting is NEVER mutated: the relaxed gate lives
  // only in a solver-local Settings copy, per-plan, never sticky. Unaffected
  // by #243: this decision is a pure mask/reason fact, made before either
  // relaxed tier runs.
  if (reason === 'unreachable' && s.safetyDepthM > BOAT_DRAFT_M) {
    const usedDepthM = findRelaxedDepthM(mask, waypoints, s.safetyDepthM, onProbe);
    if (usedDepthM !== null) {
      const relaxedSettings: Settings = { ...s, safetyDepthM: usedDepthM };
      // #243 tier 3: relaxed gate, preference on — the mechanism-2 fix.
      // comfortDepthM stays anchored to the REQUESTED `s` (computed once,
      // above), never to usedDepthM: the relaxed gate only widens what is
      // *possible*, it must not also widen what is *comfortable*.
      const tier3 = runBoth(relaxedSettings, comfortDepthM);
      if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier3)) {
        // #243 tier 4: relaxed gate, preference off — bit-identical to the
        // pre-#243 relaxed `runBoth({ ...s, safetyDepthM: usedDepthM })` call
        // this replaces.
        const tier4 = runBoth(relaxedSettings, undefined);
        if (tier4.genoa.rigResult || tier4.fock.rigResult) {
          const shallow = flagShallowLegs(mask, tier4, s.safetyDepthM, usedDepthM);
          return assemble(tier4.genoa, tier4.fock, shallow);
        }
        // #243 fix-wave item 5 (mirrors the tier 1/2 fallback above): tier 4
        // failed on BOTH rigs, but tier 3 may still hold a genuinely
        // successful rig — fall back to it rather than discarding a working
        // route. Both legs of the fallback still come from the SAME
        // preference-on, SAME relaxed-gate tier, so the rig comparison
        // stays apples-to-apples.
        if (tier3.genoa.rigResult || tier3.fock.rigResult) {
          const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
          return assemble(tier3.genoa, tier3.fock, shallow);
        }
        // #68: relaxation FOUND a connected gate but both rigs still failed to
        // solve there even without the preference, so this is no longer a
        // mask-level failure — propagate the relaxed solve's OWN class
        // (beyond-horizon / calm-motor-off are actionable) rather than
        // leaving the stale 'unreachable'. See combineNoRouteReason for the
        // rig-disagreement precedence. Matches tier 3's fallback below
        // exactly (the pre-#243 rule).
        reason = combineNoRouteReason(tier4.genoa.reason, tier4.fock.reason);
      } else if (tier3.genoa.rigResult || tier3.fock.rigResult) {
        const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
        return assemble(tier3.genoa, tier3.fock, shallow);
      } else {
        // #68: relaxation FOUND a connected gate but both rigs still failed to
        // solve there, so this is no longer a mask-level failure — propagate the
        // relaxed solve's OWN class (beyond-horizon / calm-motor-off are
        // actionable) rather than leaving the stale 'unreachable'. See
        // combineNoRouteReason for the rig-disagreement precedence.
        reason = combineNoRouteReason(tier3.genoa.reason, tier3.fock.reason);
      }
    }
  }
  // The relaxed solve failed (or no gate connected / relaxation not attempted):
  // report `reason` — 'unreachable' when the mask never connected, else the
  // propagated relaxed-solve class.
  return { status: 'error', reason };
}
