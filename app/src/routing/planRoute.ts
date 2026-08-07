import type {
  LatLon,
  Leg,
  NoRouteReason,
  PlanRequest,
  PlanResult,
  PolarTable,
  Rig,
  RigRecommendation,
  RigResult,
  Settings,
  ShallowInfo,
  WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve, type SolveDeadline, type SolveFailureCause } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { BOAT_DRAFT_M, findRelaxedDepthM, type ProbeProgress } from './relaxedDepth';

export interface PlanDeps {
  polarGenoa: PolarTable;
  polarFock: PolarTable;
  mask: NavMask;
}

export type RigProgress = (rig: Rig, info: { tMs: number; frontierSize: number }) => void;

/**
 * #282: the ONE translation from the solver's internal control vocabulary
 * (`SolveFailureCause`, declared next to `solve()` in isochrone.ts — read its
 * doc comment for why the two vocabularies exist) to the label the user sees.
 *
 * Purely presentational: nothing in this file branches on its VALUES, only on
 * the cause. Changing this table — rewording a label, or re-granularising
 * `NoRouteReason` altogether — cannot change any route, because no gate and no
 * solver ever reads a label. That is the whole point of #282, and it is
 * enforced structurally: planRoute.reasonDecoupling.test.ts fails the build if
 * any code in THIS file names a solver-derived label outside this table, or if
 * `isochrone.ts` names one at all.
 *
 * The reverse direction no longer exists. `solve()` used to return a
 * `NoRouteReason` that a second table translated back into a cause, so the
 * gates were one lookup hop from the display string; the solver now emits the
 * cause directly and this is the only table left.
 */
export const NO_ROUTE_LABEL_OF_CAUSE = {
  'mask-blocked': 'unreachable',
  'calm-without-motor': 'calm-motor-off',
  'horizon-exceeded': 'beyond-horizon',
  'budget-exhausted': 'search-budget-exceeded',
} as const satisfies Record<SolveFailureCause, NoRouteReason>;

interface RunOut {
  rigResult: RigResult | null;
  /** Null exactly when `rigResult` is non-null. Never the user-facing label. */
  cause: SolveFailureCause | null;
}

/** The user-facing label for a RunOut, or null when the rig actually solved. */
function noRouteLabel(out: RunOut): NoRouteReason | null {
  return out.cause === null ? null : NO_ROUTE_LABEL_OF_CAUSE[out.cause];
}

/**
 * #68 cause propagation: fold the two rigs' failure causes from the RELAXED
 * re-solve into one plan-level cause. Precedence encodes actionability, so the
 * class the user can act on wins when the rigs disagree:
 *   'horizon-exceeded' (change departure / refresh forecast)
 *   > 'calm-without-motor' (enable motor)
 *   > 'mask-blocked' (mask-level, nothing the user can change).
 * Both rigs share mask/wind/waypoints and differ only in polar table, so a
 * disagreement is rare — but the fold is deterministic so the result is stable.
 * Pre-#282 this folded the LABELS; the precedence and the both-null default are
 * unchanged, only the vocabulary moved.
 */
function combineFailureCause(
  a: SolveFailureCause | null,
  b: SolveFailureCause | null,
): SolveFailureCause {
  // #432 takes TOP precedence, ahead of the actionability order below, and
  // for a different reason than the rest of it: the other three are all
  // claims about a search that finished, so the most actionable one wins.
  // 'budget-exhausted' is a claim that a search did NOT finish, and reporting
  // a finished sibling's verdict alongside it would over-claim — telling the
  // skipper "unreachable" (a statement about the water) when the honest
  // answer is "we ran out of time and do not know". Reachable only in the
  // mixed case where one rig completes and the shared deadline expires
  // during the other.
  if (a === 'budget-exhausted' || b === 'budget-exhausted') return 'budget-exhausted';
  if (a === 'horizon-exceeded' || b === 'horizon-exceeded') return 'horizon-exceeded';
  if (a === 'calm-without-motor' || b === 'calm-without-motor') return 'calm-without-motor';
  return 'mask-blocked';
}

// #259: an ETA gap smaller than this is measurement noise, not a genuine
// speed difference between rigs — 23.8x the worst knife-edge measured to date
// (2.52 s at the sail-speed floor's 3.8 kn boundary, see the motor-decision-rule
// spec and issue #264) so it comfortably absorbs solver-level noise from a
// user-adjusted floor without swallowing a genuinely different route: 60 s is
// 0.417% of a typical 4 h multi-hour Flensburg Fjord passage, so it cannot
// misclassify two routes that actually differ AT THAT LENGTH.
//
// Known trade-off, assessed and NOT acted on: this is an ABSOLUTE band, so it
// grows proportionally larger as the passage gets shorter — 60 s stops being
// under 1% below a 1 h 40 min passage and reaches 5% at 20 min, and a harbour
// hop inside Flensburg Fjord is routinely an hour or less. No misclassification
// has been MEASURED on this app's real in-domain route (Langballigau ->
// Sønderborg, uniform 12 kn/225°, real mask+polars, #275 review): an 81 min
// passage where 60 s is 1.23% of duration, and the true genoa/fock gap is
// 13.57 s (0.28%) — noise, correctly absorbed as a tie. So this is a bound
// worth recording, not an observed defect, and the value is NOT changed here
// on that basis alone. If a real short-passage misclassification is ever
// measured, the fix shape is a relative term floored at the noise level
// (e.g. `Math.max(NOISE_FLOOR_MS, Math.min(RIG_TIE_BAND_MS, 0.005 *
// durationMs))`), never a bare percentage — a purely relative band would fall
// under the 2.52 s knife-edge on a 20 min hop and start ranking noise again.
export const RIG_TIE_BAND_MS = 60_000;

/** True when every leg of a RigResult is a motor leg (vacuously true for zero legs). */
function isAllMotor(result: RigResult): boolean {
  return result.legs.every((leg) => leg.kind === 'motor');
}

/**
 * #259: the honest rig comparison, distinct from the plain `recommended` pick
 * in `assemble` below. Checked in this order because 'moot' is the STRONGER
 * statement: an all-motor result on both rigs means neither polar drove a
 * single leg, so the comparison is meaningless regardless of the ETA gap —
 * motor legs run at the same settings.motorSpeedKn on both rigs, so this case
 * commonly coincides with an exact tie, but the check does not depend on
 * that. Exported for direct unit testing of the tie-band boundary.
 */
export function compareRigs(genoa: RigResult, fock: RigResult): RigRecommendation {
  if (isAllMotor(genoa) && isAllMotor(fock)) return { kind: 'moot' };
  if (Math.abs(genoa.etaMs - fock.etaMs) < RIG_TIE_BAND_MS) return { kind: 'tie' };
  return { kind: 'decided', rig: genoa.etaMs < fock.etaMs ? 'genoa' : 'fock' };
}

/**
 * #243 gate predicate: could the depth-comfort preference plausibly have
 * CAUSED this failure, so that re-solving with the preference off might
 * succeed? True for the §C.1 search-capacity effect the two-scalar clock
 * encoding was designed to avoid but cannot PROVE it always avoids
 * ('mask-blocked'), and for a preference-inflated ranking clock tripping the
 * horizon guard ('horizon-exceeded'). A calm forecast with the engine off is a
 * wind fact the preference can neither cause nor cure — mirroring #53's own
 * rule that only mask-unreachability degrades further — so it never triggers a
 * retry.
 *
 * #282: takes the internal cause, NOT the user-facing reason. Exported for
 * direct unit testing of the truth table.
 *
 * #432: 'budget-exhausted' is excluded — a retry re-solves BOTH rigs against
 * a deadline that has ALREADY passed, so every retried solve aborts at its
 * first ring and the only effect is to burn further wall-clock past a budget
 * the user is already waiting out. It falls out of the `===` list below
 * rather than being rejected by an extra statement on purpose: a redundant
 * `if (cause === 'budget-exhausted') return false;` would be unfalsifiable
 * (no mutation could red it while the list stays as it is — PR #410's
 * "a mutation the codebase cannot produce proves nothing"). What actually
 * pins the exclusion is the EXHAUSTIVE four-cause truth table in
 * planRoute.test.ts, which reds if this list is ever widened to admit it.
 */
export function comfortRetryMayHelp(cause: SolveFailureCause): boolean {
  return cause === 'mask-blocked' || cause === 'horizon-exceeded';
}

/**
 * #53 gate predicate: might a SHALLOWER safety gate connect a mask the
 * requested gate does not? Only a mask-level block can be answered by moving
 * the depth gate — a calm forecast or an exhausted forecast horizon is
 * unchanged by it, which is why those two keep their errors instead of
 * degrading further.
 *
 * #282: takes the internal cause, NOT the user-facing reason. Exported for
 * direct unit testing of the truth table.
 *
 * #432: 'budget-exhausted' is excluded for the same reason as
 * `comfortRetryMayHelp` above, and pinned the same way (the exhaustive
 * four-cause table in planRoute.test.ts, not a redundant statement here).
 * Note this exclusion alone does NOT cover the case where tiers 1-2 spend
 * the whole budget and still finish with a genuine 'mask-blocked' verdict —
 * the cause is then honestly mask-blocked, this gate opens, and
 * `findRelaxedDepthM`'s BFS probes would run past the deadline. That gap is
 * closed by an explicit deadline check immediately before the relaxation
 * block, not here.
 */
export function depthRelaxationMayHelp(cause: SolveFailureCause): boolean {
  return cause === 'mask-blocked';
}

/**
 * #243: does this rig-pair result need a full-tier retry with the depth
 * comfort preference turned off? True when EITHER rig individually failed with
 * a cause `comfortRetryMayHelp` admits.
 *
 * Checked per rig, but the retry always re-solves BOTH rigs together (#243
 * §D.1 piece 3, decided at PLAN level): a per-rig-only retry would cost the
 * two rigs under different objectives (one preference-weighted, one not) and
 * skew the recommended-rig comparison, which is why this is a tier rather
 * than a per-rig fallback.
 */
function needsUnpreferencedRetry(out: { genoa: RunOut; fock: RunOut }): boolean {
  const failedRetriably = (r: RunOut): boolean =>
    r.rigResult === null && r.cause !== null && comfortRetryMayHelp(r.cause);
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

/**
 * #432: the plan-level wall-clock budget, shared by every `solve()` this
 * plan runs (up to 4 tiers x 2 rigs x N waypoint segments). ONE deadline
 * object for the whole plan is the entire point — a per-`solve()` budget
 * would bound each piece while leaving the user's actual wait unbounded and
 * settings-dependent, since how many tiers fire is invisible to them.
 *
 * Absent ⇒ unbudgeted ⇒ byte-identical to a pre-#432 plan. That default is
 * FAIL-OPEN by design, which is the correct asymmetry here: this is a
 * diagnostic/UX bound, not a safety control, and the client-side deadline in
 * workerClient.ts is the backstop that always exists — so degrading to
 * "unbudgeted" degrades exactly to today's shipped behaviour, never to
 * something unbounded that today bounds. It also keeps `planRoute()` a pure
 * function for every vitest call site, whose wall-clock cost swings with the
 * runner (CLAUDE.md: ~2.1x CI, and a separate 8x coverage multiplier for
 * solver-heavy work) and must not decide a test outcome.
 */
export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
  onProbe?: ProbeProgress,
  deadline?: SolveDeadline,
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
        // exactOptionalPropertyTypes: omit the key entirely when unbudgeted,
        // never pass `{ deadline: undefined }`. The SAME object goes to every
        // solve of this plan — see the `deadline` parameter's doc comment.
        ...(deadline !== undefined ? { deadline } : {}),
      });
      // #282: the solver's own cause, taken verbatim — no label ever exists on
      // this path. #432's 'budget-exhausted' needs no branch of its own here:
      // folding it into SolveFailureCause (rather than giving it a separate
      // SolveResult arm, as this change's pre-#450 draft did) means it arrives
      // through exactly this line like any other cause.
      if (res.status !== 'ok') return { rigResult: null, cause: res.cause };
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
    return { rigResult, cause: null };
  };
  // #340 NAMED COUPLING: this evaluates `run('genoa', …)` then
  // `run('fock', …)` as plain, synchronous object-literal properties — no
  // interleaving, genoa's solve (and every progress message it reports)
  // fully completes before fock's starts. That real order is asserted equal
  // to `RIG_ORDER` (../types.ts, next to the `Rig` type) by
  // planRoute.test.ts's "#340: solve order matches RIG_ORDER" guard test,
  // which PlannerPanel.tsx's "sail N of 2" phase-readout numbering relies
  // on. Reordering these two properties changes the real solve order and
  // must fail that guard test — if it doesn't, the guard is broken, not this
  // code.
  const runBoth = (settings: Settings, comfort: number | undefined) => ({
    genoa: run('genoa', deps.polarGenoa, settings, comfort),
    fock: run('fock', deps.polarFock, settings, comfort),
  });

  const assemble = (genoa: RunOut, fock: RunOut, shallow: ShallowInfo | null): PlanResult => {
    // #259: `recommended` stays a plain Rig for consumers that only ever need
    // a single pick (tab-seeding in AppState, the saved-plan chip in
    // PlansList, recommendedResult()'s invariant) — it always names a rig
    // with a non-null result. It names the same rig as a 'decided'
    // rigRecommendation; for 'tie'/'moot' it falls back to the pre-#259 `<=`
    // tie-break, since those consumers need *a* rig, not a qualified answer.
    //
    // Branched on `genoa.rigResult && fock.rigResult` directly (rather than
    // switching on rigRecommendation.kind with a same-shaped single-rig tail
    // repeated below it) so the single-rig fallback is written exactly once:
    // when rigRecommendation.kind is 'tie'/'moot', compareRigs was called,
    // which only happens in this branch, so both rigResults are already
    // narrowed non-null here — an equivalent tail in the other branch would
    // be unreachable dead code (#275 review).
    let rigRecommendation: RigRecommendation;
    let recommended: Rig;
    if (genoa.rigResult && fock.rigResult) {
      rigRecommendation = compareRigs(genoa.rigResult, fock.rigResult);
      recommended =
        rigRecommendation.kind === 'decided'
          ? rigRecommendation.rig
          : genoa.rigResult.etaMs <= fock.rigResult.etaMs
            ? 'genoa'
            : 'fock';
    } else {
      recommended = genoa.rigResult ? 'genoa' : 'fock';
      rigRecommendation = { kind: 'decided', rig: recommended };
    }
    return {
      status: 'ok',
      genoa: genoa.rigResult,
      fock: fock.rigResult,
      // #282: the ONE place a per-rig failure becomes a user-facing label.
      genoaReason: genoa.rigResult ? null : noRouteLabel(genoa),
      fockReason: fock.rigResult ? null : noRouteLabel(fock),
      recommended,
      rigRecommendation,
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
  // a foregone mask-level failure — classify directly (one cheap BFS) instead
  // of burning two doomed isochrone runs first. This also classifies a
  // disconnected-AND-calm plan as mask-blocked rather than the solver's
  // death-count heuristic guess, which is the more accurate class.
  //
  // #282: this is the plan-level CAUSE, the control input for the relaxation
  // gate below — never the label. The label is derived from it exactly once,
  // at the `return` at the end of this function.
  let cause: SolveFailureCause = 'mask-blocked';
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
      // Arbitrary tie-break: take genoa's cause (checked first); both rigs
      // solve identical mask/wind/waypoints and differ only in polar table,
      // so their failure causes rarely differ in practice. Matches tier 1's
      // fallback below exactly (the pre-#243 rule).
      cause = tier2.genoa.cause!;
    } else if (tier1.genoa.rigResult || tier1.fock.rigResult) {
      return assemble(tier1.genoa, tier1.fock, null);
    } else {
      // Arbitrary tie-break: take genoa's cause (checked first); both rigs
      // solve identical mask/wind/waypoints and differ only in polar table,
      // so their failure causes rarely differ in practice.
      cause = tier1.genoa.cause!;
    }
  }

  // #53 graceful degradation below safety depth: ONLY the mask-unreachability
  // class relaxes — a calm forecast and an exhausted horizon keep their errors
  // — and never at or below the boat-draft floor. The relaxed gate is
  // discovered once (cheap mask BFS probes, no solver runs), then BOTH rigs
  // solve at that single gate, so the rig comparison stays apples-to-apples by
  // construction. The user's safetyDepthM setting is NEVER mutated: the relaxed
  // gate lives only in a solver-local Settings copy, per-plan, never sticky.
  // Unaffected by #243: this decision is a pure mask/cause fact, made before
  // either relaxed tier runs.
  //
  // #282: gated on the internal cause via `depthRelaxationMayHelp`, never on
  // the user-facing label — and this gate must stay HERE in the control flow:
  // the `combineFailureCause` assignments inside the block below are downstream
  // of it and presentational only.
  //
  // #432: the ONE place the budget needs an explicit check outside solve().
  // `depthRelaxationMayHelp` already rejects 'budget-exhausted', but that
  // does not cover the case this check exists for: tiers 1-2 can spend the
  // ENTIRE budget and still finish with a genuine 'mask-blocked' verdict, so
  // the cause is honestly mask-blocked, the gate opens, and
  // `findRelaxedDepthM`'s BFS probes — the only work in this function that
  // does not run inside solve()'s ring loop, and therefore the only work the
  // per-ring check cannot stop — would run past a deadline that has already
  // passed. Checked before the probes rather than after, so a spent budget
  // costs one predicate instead of a full probe sweep.
  if (deadline?.expired()) {
    return { status: 'error', reason: NO_ROUTE_LABEL_OF_CAUSE['budget-exhausted'] };
  }
  if (depthRelaxationMayHelp(cause) && s.safetyDepthM > BOAT_DRAFT_M) {
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
        // mask-level failure — propagate the relaxed solve's OWN class (the
        // horizon and calm classes are actionable) rather than leaving the
        // stale mask-blocked one. See combineFailureCause for the
        // rig-disagreement precedence. Matches tier 3's fallback below
        // exactly (the pre-#243 rule).
        cause = combineFailureCause(tier4.genoa.cause, tier4.fock.cause);
      } else if (tier3.genoa.rigResult || tier3.fock.rigResult) {
        const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
        return assemble(tier3.genoa, tier3.fock, shallow);
      } else {
        // #68: relaxation FOUND a connected gate but both rigs still failed to
        // solve there, so this is no longer a mask-level failure — propagate
        // the relaxed solve's OWN class (the horizon and calm classes are
        // actionable) rather than leaving the stale mask-blocked one. See
        // combineFailureCause for the rig-disagreement precedence.
        cause = combineFailureCause(tier3.genoa.cause, tier3.fock.cause);
      }
    }
  }
  // The relaxed solve failed (or no gate connected / relaxation not attempted):
  // report the cause — mask-blocked when the mask never connected, else the
  // propagated relaxed-solve class.
  //
  // #282: the ONE place a plan-level failure becomes a user-facing label.
  return { status: 'error', reason: NO_ROUTE_LABEL_OF_CAUSE[cause] };
}
