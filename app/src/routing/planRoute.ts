import type {
  LatLon,
  Leg,
  NoRouteReason,
  PlanRequest,
  PlanResult,
  PolarTable,
  RigRecommendation,
  RigResult,
  SailId,
  SailResult,
  Settings,
  ShallowInfo,
  WindGrid,
} from '../types';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import type { NavMask } from '../lib/mask';
import { solve, type SolveDeadline, type SolveFailureCause } from './isochrone';
import { mergeCollinearLegs } from './postprocess';
import { APPROACH_RADIUS_M, uniformGate, type DepthGate } from '../lib/depthGate';
import { findRelaxedGate, type ProbeProgress } from './relaxedDepth';
import { polarKey, type BoatDef } from '../data/boats';
import { relaxationFloorM } from '../lib/boatDepth';

export interface PlanDeps {
  /**
   * #54 spec F.3: polars keyed `${boatId}/${sailId}` by polarKey(). Only the
   * keys for `boat` × the request's `sailIds` are read; a caller may pass a
   * wider map.
   */
  polars: Readonly<Record<string, PolarTable>>;
  /**
   * #54: the boat this plan is for. SAFETY-CRITICAL — spec C.4(a) derives the
   * #53 relaxation floor from its draft. Left as the old module constant,
   * relaxation would take a 2.30 m boat down to a 2.1 m gate while the
   * shallow banner reported the relaxation as if it were the Salona's.
   */
  boat: BoatDef;
  mask: NavMask;
}

export type RigProgress = (sailId: SailId, info: { tMs: number; frontierSize: number }) => void;

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
  sailId: SailId;
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
 *
 * Exported for direct unit testing of the truth table, exactly as
 * `comfortRetryMayHelp`/`depthRelaxationMayHelp` below are — and for the same
 * reason. PR #453 review MEASURED that deleting the `'budget-exhausted'` arm
 * below reds ZERO tests across all 25 `src/routing` + `src/state` files: a
 * reachable behavioural claim with nothing falsifying it, which is the exact
 * standard this file applies to the retry gates. `combineFailureCause` is
 * called only where BOTH rigs failed with non-null causes, and a shared
 * deadline expiring during the SECOND rig's solve after the first finished
 * with 'mask-blocked'/'horizon-exceeded' produces precisely that mixed pair.
 * planRoute.budget.test.ts now pins the whole 5x5 table (the four causes plus
 * null in both argument positions), so the older `horizon > calm > mask`
 * ordering — equally unpinned until now — is covered too.
 */
export function combineFailureCause(
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

/**
 * #54 fix (review round 1): folds every requested sail's cause into one
 * plan-level cause. `combineFailureCause` above STAYS binary (cap N at 2
 * per spec §J OQ-3 governs `RigRecommendation`/`compareRigs`, not this
 * fold) — this generalises only the FOLD over however many sails were
 * actually requested, replacing a positional `combineFailureCause(a[0],
 * a[1])` that threw at `sailIds.length === 1` (`a[1]` undefined).
 *
 * `null` is NOT an identity for `combineFailureCause`, whose return type
 * excludes null: `combineFailureCause(null, null)` returns 'mask-blocked'.
 * What makes the `null` seed exact anyway is that 'mask-blocked' is
 * simultaneously the BOTTOM of the precedence order above (so any later
 * cause overrides it) and the value of this fold's own `?? 'mask-blocked'`
 * fallback — the seed is therefore ABSORBED, not neutral.
 *
 * Pinned by planRoute.budget.test.ts's '#54 combineAllCauses' block — the
 * N=2 fold against the same hand-derived precedence table the binary
 * function is pinned against, plus N=0 and N=1.
 */
export function combineAllCauses(sails: readonly RunOut[]): SolveFailureCause {
  return (
    sails.reduce<SolveFailureCause | null>((acc, r) => combineFailureCause(acc, r.cause), null) ??
    'mask-blocked'
  );
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
 * statement: an all-motor result on both sails means neither polar drove a
 * single leg, so the comparison is meaningless regardless of the ETA gap —
 * motor legs run at the same settings.motorSpeedKn on both sails, so this
 * case commonly coincides with an exact tie, but the check does not depend on
 * that. Exported for direct unit testing of the tie-band boundary.
 *
 * #54: still BINARY (spec §J OQ-3 — RigRecommendation is not generalised to
 * N-way) and now identity-DERIVED rather than position-hardcoded: the
 * pre-#54 version returned a sail-id literal matching argument POSITION
 * regardless of what each RigResult's own identity was. Now that
 * `RigResult` carries a real `sailId`, deriving the winner's label from
 * `a.sailId`/`b.sailId` is both more honest and removes the last bare
 * sail-id literal from this function — byte-identical for every real caller
 * (planRoute's own `a`/`b` are always the sail actually solved).
 */
export function compareRigs(a: RigResult, b: RigResult): RigRecommendation {
  if (isAllMotor(a) && isAllMotor(b)) return { kind: 'moot' };
  if (Math.abs(a.etaMs - b.etaMs) < RIG_TIE_BAND_MS) return { kind: 'tie' };
  return { kind: 'decided', rig: a.etaMs < b.etaMs ? a.sailId : b.sailId };
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
 * `findRelaxedGate`'s BFS probes would run past the deadline. That gap is
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
function needsUnpreferencedRetry(sails: readonly RunOut[]): boolean {
  const failedRetriably = (r: RunOut): boolean =>
    r.rigResult === null && r.cause !== null && comfortRetryMayHelp(r.cause);
  return sails.some(failedRetriably);
}

/**
 * #53: flag every leg whose geometry crosses cells charted below the REQUESTED
 * safety depth with that leg's minimum charted depth, across every sail's
 * result, and derive the plan-level ShallowInfo (minGateDepthM = shallowest
 * such cell actually traversed). Returns null when no leg of any sail crosses
 * sub-requested cells — the relaxed gate merely widened the search without the
 * route using it, so the route is requested-depth-valid and carries no warning.
 */
function flagShallowLegs(
  mask: NavMask,
  sails: readonly RunOut[],
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
  for (const out of sails) {
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

  // #452: the gate every tier that solves at the REQUESTED depth uses. Built
  // once — `solve()` and `mergeCollinearLegs` take it by reference.
  const requestedGate = uniformGate(s.safetyDepthM);

  const wind = new WindField(windGrid);
  // #54: `deps.polars` is a plain Record, so a key the caller never supplied
  // reads as `undefined`. This throw pins the DIAGNOSTIC, not the existence
  // of a failure — `new Polar(undefined)` throws on `table.rig` either way
  // (lib/polar.ts) — so what it buys is naming WHICH key is missing, at the
  // lookup instead of at the `new Polar` construction below. One check for
  // every path:
  // protocol.ts hands over only the keys `init` carried, and the sweep
  // harness and tests construct PlanDeps directly.
  const polarFor = (sailId: SailId): PolarTable => {
    const key = polarKey(deps.boat.id, sailId);
    const table: PolarTable | undefined = deps.polars[key];
    if (table === undefined) throw new Error(`#54: no polar table for ${key}`);
    return table;
  };
  const run = (
    sailId: SailId,
    table: PolarTable,
    settings: Settings,
    gate: DepthGate,
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
        gate,
        onProgress: (info) => onProgress?.(sailId, info),
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
      if (res.status !== 'ok') return { sailId, rigResult: null, cause: res.cause };
      // #452 graft 5: the merge pass re-validates against the SAME gate this
      // segment solved at — never a route-wide scalar.
      legs.push(...mergeCollinearLegs(res.legs, mask, wind, gate, comfort));
      departureMs = res.etaMs;
    }
    const etaMs = departureMs;
    const rigResult: RigResult = {
      sailId,
      legs,
      etaMs,
      durationMs: etaMs - req.departureMs,
      distanceNm: legs.reduce((d, l) => d + l.distanceNm, 0),
      maneuverCount: legs.filter((l) => l.maneuverAtStart !== null).length,
      motorDistanceNm: legs.filter((l) => l.kind === 'motor').reduce((d, l) => d + l.distanceNm, 0),
    };
    return { sailId, rigResult, cause: null };
  };
  // #340/#54 NAMED COUPLING: `.map()` over `req.sailIds` calls `run()` once
  // per element, SYNCHRONOUSLY and in array order — no interleaving, sail
  // i's solve (and every progress message it reports) fully completes before
  // sail i+1's starts. That real order is asserted equal to
  // `request.sailIds` by planRoute.test.ts's "#340/#54: solve order matches
  // request.sailIds" guard test, observed from a real (small) solve. §E.3
  // deleted the old `RIG_ORDER` module constant for exactly this reason: the
  // REQUEST's own ordered list is now the one source of truth, not a
  // separately-maintained constant that could drift from it. Reordering
  // `req.sailIds` changes the real solve order and the guard test observes
  // exactly that.
  const runAll = (settings: Settings, gate: DepthGate, comfort: number | undefined): RunOut[] =>
    req.sailIds.map((sailId) => run(sailId, polarFor(sailId), settings, gate, comfort));

  const assemble = (sails: readonly RunOut[], shallow: ShallowInfo | null): PlanResult => {
    // #259: `recommended` stays a plain SailId for consumers that only ever
    // need a single pick (tab-seeding in AppState, the saved-plan chip in
    // PlansList, recommendedResult()'s invariant) — it always names a sail
    // with a non-null result. It names the same sail as a 'decided'
    // rigRecommendation; for 'tie'/'moot' it falls back to the pre-#259 `<=`
    // tie-break, since those consumers need *a* sail, not a qualified answer.
    //
    // #54: cap N at 2 (spec §J OQ-3) — RigRecommendation stays binary and is
    // NOT generalised to N-way. The two-sail comparison path (compareRigs)
    // only fires when exactly both of the first two requested sails solved;
    // otherwise this falls back to naming whichever sail solved.
    let rigRecommendation: RigRecommendation;
    let recommended: SailId;
    const a = sails[0];
    const b = sails[1];
    if (sails.length === 2 && a.rigResult && b.rigResult) {
      rigRecommendation = compareRigs(a.rigResult, b.rigResult);
      recommended =
        rigRecommendation.kind === 'decided'
          ? rigRecommendation.rig
          : a.rigResult.etaMs <= b.rigResult.etaMs
            ? a.sailId
            : b.sailId;
    } else {
      // Branched from the two-sail path above (rather than folding both into
      // one general N-way reduction) so the single-sail fallback is written
      // exactly once and stays reachable only when compareRigs was NOT
      // called — mirrors the pre-#54 rationale for keeping this a distinct
      // branch (#275 review).
      const found = sails.find((r) => r.rigResult);
      // `assemble` is only ever called once at least one sail solved (every
      // call site checks `.some((r) => r.rigResult)` first) — the invariant
      // callers rely on, not re-verified here.
      recommended = found!.sailId;
      rigRecommendation = { kind: 'decided', rig: recommended };
    }
    return {
      status: 'ok',
      sails: sails.map((out): SailResult => ({
        sailId: out.sailId,
        result: out.rigResult,
        // #282: the ONE place a per-sail failure becomes a user-facing label.
        reason: out.rigResult ? null : noRouteLabel(out),
      })),
      recommended,
      // #54/Task 10b: always true here — no code path in THIS task produces
      // a partial (budget-exhausted-mid-comparison) result yet.
      comparisonComplete: true,
      rigRecommendation,
      snappedOrigin: origin,
      snappedDestination: destination,
      // exactOptionalPropertyTypes: omit the key entirely when there is no
      // warning — never assign undefined explicitly.
      ...(shallow ? { shallow } : {}),
    };
  };

  // #452 DELIBERATE DIVERGENCE — do not re-unify this with `findRelaxedGate`'s
  // own connectivity probe. Before #452 the two were textually identical and
  // had to be changed together. They are now different by design: this one is
  // the fast-path classifier and asks a question about the REQUESTED gate
  // route-wide, while the search's probe asks about a per-cell FIELD. Merging
  // them back into one helper would hand this classifier a relaxed field and
  // silently re-globalise the relaxation — the exact defect #452 closes.
  const connectedAt = (gate: DepthGate): boolean => {
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (!mask.cellsConnected(waypoints[i], waypoints[i + 1], gate)) return false;
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
  if (connectedAt(requestedGate)) {
    // #243 tier 1: requested gate, preference on — the happy path, nothing
    // extra paid.
    const tier1 = runAll(s, requestedGate, comfortDepthM);
    if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier1)) {
      // #243 tier 2: requested gate, preference off — bit-identical to the
      // pre-#243 single `runAll(s, …)` call this replaces (comfortDepthM
      // undefined ⇒ every solve/merge call takes the untouched path). Only
      // reached when the preference was actually active AND at least one
      // sail failed with a reason it could plausibly have caused (see
      // needsUnpreferencedRetry) — this is what makes "no plan can get worse
      // than pre-#243" true by construction rather than by argument.
      const tier2 = runAll(s, requestedGate, undefined);
      if (tier2.some((r) => r.rigResult)) return assemble(tier2, null);
      // #243 fix-wave item 5: tier 2 failed on EVERY sail, but tier 1 may
      // still hold a genuinely successful one (the retry was triggered by
      // ANOTHER sail failing, per needsUnpreferencedRetry's per-sail check —
      // the search is heuristic, so a sail that succeeded WITH the
      // preference is not guaranteed to also succeed once retried without
      // it). Don't discard a working, internally-consistent (every leg from
      // the SAME preference-on tier, so still apples-to-apples) route just
      // because the retry didn't pan out — that would be strictly worse
      // than what tier 1 already had.
      if (tier1.some((r) => r.rigResult)) {
        return assemble(tier1, null);
      }
      // Arbitrary tie-break: take the first requested sail's cause (checked
      // first, per req.sailIds order); every sail solves identical
      // mask/wind/waypoints and differs only in polar table, so their
      // failure causes rarely differ in practice. Matches tier 1's fallback
      // below exactly (the pre-#243 rule).
      cause = tier2[0].cause!;
    } else if (tier1.some((r) => r.rigResult)) {
      return assemble(tier1, null);
    } else {
      // Arbitrary tie-break: take the first requested sail's cause (checked
      // first); every sail solves identical mask/wind/waypoints and differs
      // only in polar table, so their failure causes rarely differ in
      // practice.
      cause = tier1[0].cause!;
    }
  }

  // #53 graceful degradation below safety depth: ONLY the mask-unreachability
  // class relaxes — a calm forecast and an exhausted horizon keep their errors
  // — and never at or below the boat-draft floor. The relaxed gate is
  // discovered once (cheap mask BFS probes, no solver runs), then BOTH rigs
  // solve against that single gate FIELD, so the rig comparison stays
  // apples-to-apples by construction. The user's safetyDepthM setting is
  // NEVER mutated — and since #452 it is never even COPIED-AND-OVERWRITTEN:
  // the relaxed depth lives in a per-plan DepthGate passed alongside the
  // unchanged Settings, so no object anywhere carries a relaxed
  // `safetyDepthM` that a later reader could mistake for the user's own.
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
  // `findRelaxedGate`'s BFS probes — the only work in this function that
  // does not run inside solve()'s ring loop, and therefore the only work the
  // per-ring check cannot stop — would run past a deadline that has already
  // passed. Checked before the probes rather than after, so a spent budget
  // costs one predicate instead of a full probe sweep.
  if (deadline?.expired()) {
    return { status: 'error', reason: NO_ROUTE_LABEL_OF_CAUSE['budget-exhausted'] };
  }
  // #54 spec C.4(a), SAFETY-CRITICAL: the floor is THIS boat's draft, not a
  // module constant. Both uses below take the same value — the entry gate
  // ("is there anything below the requested depth left to relax into?") and
  // the search's own lower bound — so they cannot drift apart.
  const relaxationFloor = relaxationFloorM(deps.boat);
  if (depthRelaxationMayHelp(cause) && s.safetyDepthM > relaxationFloor) {
    const relaxed = findRelaxedGate(
      mask,
      waypoints,
      s.safetyDepthM,
      APPROACH_RADIUS_M,
      relaxationFloor,
      onProbe,
    );
    if (relaxed !== null) {
      const { gate: relaxedGate, usedDepthM } = relaxed;
      // #243 tier 3: relaxed gate, preference on — the mechanism-2 fix.
      // comfortDepthM stays anchored to the REQUESTED `s` (computed once,
      // above), never to usedDepthM: the relaxed gate only widens what is
      // *possible*, it must not also widen what is *comfortable*.
      //
      // #452: `s` is passed UNCHANGED — the relaxed depth now travels in the
      // gate field, so `Settings.safetyDepthM` is never overwritten with a
      // relaxed value anywhere. The pre-#452 `{ ...s, safetyDepthM:
      // usedDepthM }` copy is deleted, which spike §7 records as a
      // correctness improvement independent of locality.
      const tier3 = runAll(s, relaxedGate, comfortDepthM);
      if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier3)) {
        // #243 tier 4: relaxed gate, preference off.
        const tier4 = runAll(s, relaxedGate, undefined);
        if (tier4.some((r) => r.rigResult)) {
          const shallow = flagShallowLegs(mask, tier4, s.safetyDepthM, usedDepthM);
          return assemble(tier4, shallow);
        }
        // #243 fix-wave item 5 (mirrors the tier 1/2 fallback above): tier 4
        // failed on EVERY sail, but tier 3 may still hold a genuinely
        // successful one — fall back to it rather than discarding a working
        // route. Every leg of the fallback still comes from the SAME
        // preference-on, SAME relaxed-gate tier, so the rig comparison
        // stays apples-to-apples.
        if (tier3.some((r) => r.rigResult)) {
          const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
          return assemble(tier3, shallow);
        }
        // #68: relaxation FOUND a connected gate but every sail still failed
        // to solve there even without the preference, so this is no longer a
        // mask-level failure — propagate the relaxed solve's OWN class (the
        // horizon and calm classes are actionable) rather than leaving the
        // stale mask-blocked one. See combineFailureCause for the
        // rig-disagreement precedence. Matches tier 3's fallback below
        // exactly (the pre-#243 rule). #54 fix round 1: folds over every
        // requested sail via combineAllCauses — a positional
        // combineFailureCause(tier4[0], tier4[1]) crashed at
        // sailIds.length === 1 (tier4[1] undefined).
        cause = combineAllCauses(tier4);
      } else if (tier3.some((r) => r.rigResult)) {
        const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
        return assemble(tier3, shallow);
      } else {
        // #68: relaxation FOUND a connected gate but every sail still failed
        // to solve there, so this is no longer a mask-level failure —
        // propagate the relaxed solve's OWN class (the horizon and calm
        // classes are actionable) rather than leaving the stale mask-blocked
        // one. See combineFailureCause for the rig-disagreement precedence.
        // #54 fix round 1: folds over every requested sail via
        // combineAllCauses (see the tier-4 call site's comment above).
        cause = combineAllCauses(tier3);
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
