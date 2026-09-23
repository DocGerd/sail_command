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

/** `secondPass` is present (true) only for #1136 pass-2 solves. */
export type RigProgress = (
  sailId: SailId,
  info: { tMs: number; frontierSize: number; secondPass?: true },
) => void;

/**
 * #1136: the plan deadline, plus an optional clock for pass 2's sub-deadline.
 * `now` defaults to `Date.now`; tests inject a fake.
 */
export interface PlanDeadline extends SolveDeadline {
  now?: () => number;
}

/**
 * #1136 ruling (2026-09-15, comment 5680650879 on #1136): pass 2 may use at
 * most min(60 s, remaining shared budget). Applied only to a budgeted plan: an
 * unbudgeted `planRoute()` stays uncapped, like the plan budget itself.
 */
export const PASS2_BUDGET_MS = 60_000;

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
 */
export const NO_ROUTE_LABEL_OF_CAUSE = {
  'mask-blocked': 'unreachable',
  'calm-without-motor': 'calm-motor-off',
  'horizon-exceeded': 'beyond-horizon',
  'budget-exhausted': 'search-budget-exceeded',
  'forced-sail-calm': 'calm-sail-only',
} as const satisfies Record<SolveFailureCause, NoRouteReason>;

interface RunOut {
  sailId: SailId;
  rigResult: RigResult | null;
  /** Null exactly when `rigResult` is non-null. Never the user-facing label. */
  cause: SolveFailureCause | null;
}

/** #1136: a pass-2 run — salvage on, under pass 2's sub-deadline. */
interface Pass2 {
  deadline: SolveDeadline | undefined;
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
 *   > 'forced-sail-calm' (#885: change departure, or unmark the segment)
 *   > 'calm-without-motor' (enable motor)
 *   > 'mask-blocked' (mask-level, nothing the user can change).
 * Both rigs share mask/wind/waypoints and differ only in polar table, so a
 * disagreement is rare — but the fold is deterministic so the result is stable.
 * Pre-#282 this folded the LABELS; the precedence and the both-null default are
 * unchanged, only the vocabulary moved.
 *
 * Exported for direct unit testing of the truth table, exactly as
 * `comfortRetryMayHelp`/`depthRelaxationMayHelp` below are — and for the same
 * reason. `combineFailureCause` is
 * called only where BOTH rigs failed with non-null causes, and a shared
 * deadline expiring during the SECOND rig's solve after the first finished
 * with 'mask-blocked'/'horizon-exceeded' produces precisely that mixed pair.
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
  // #885: an actionable constraint the captain set, so it ranks above the
  // motor-off calm (whose remedy it would otherwise hide).
  if (a === 'forced-sail-calm' || b === 'forced-sail-calm') return 'forced-sail-calm';
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

/**
 * #1258: the plan-level cause after a relaxed tier failed, folded with the
 * requested-gate cause. `combineFailureCause('mask-blocked', x) === x`, so
 * every pre-#1258 path is unchanged. One cell differs from that fold
 * (maintainer ruling M3 on PR #1299): a requested-gate horizon failure whose
 * speculative relaxed tier ran out of budget keeps 'horizon-exceeded', the
 * verdict the requested gate actually proved.
 */
function relaxedPlanCause(
  requested: SolveFailureCause,
  relaxed: SolveFailureCause,
): SolveFailureCause {
  if (requested === 'horizon-exceeded' && relaxed === 'budget-exhausted') return requested;
  return combineFailureCause(requested, relaxed);
}

// #259: an ETA gap smaller than this is measurement noise, not a genuine
// speed difference between rigs (see the motor-decision-rule spec and issue
// #264).
//
// Known trade-off, assessed and NOT acted on: this is an ABSOLUTE band, so it
// grows proportionally larger as the passage gets shorter, and a harbour hop
// inside Flensburg Fjord is routinely an hour or less. No misclassification
// has been measured on this app's real in-domain route (#275 review). So
// this is a bound worth recording, not an observed defect, and the value is
// NOT changed here on that basis alone. If a real short-passage
// misclassification is ever measured, the fix shape is a relative term
// floored at the noise level (e.g. `Math.max(NOISE_FLOOR_MS,
// Math.min(RIG_TIE_BAND_MS, 0.005 * durationMs))`), never a bare percentage.
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
 * wind fact the preference can neither cause nor cure, so it never triggers a
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
 * #53 gate predicate: might a SHALLOWER safety gate help? True for a
 * mask-level block, and since #1258 for 'horizon-exceeded': a requested-gate
 * search still running at the horizon can finish in time on the wider relaxed
 * field. A calm forecast is unchanged by the gate, so it keeps its error.
 *
 * #282: takes the internal cause, NOT the user-facing reason. Exported for
 * direct unit testing of the truth table.
 *
 * #432: 'budget-exhausted' is excluded for the same reason as
 * `comfortRetryMayHelp` above, and pinned the same way (the exhaustive
 * four-cause table in planRoute.test.ts, not a redundant statement here).
 * Note this exclusion alone does NOT cover the case where tiers 1-2 spend
 * the whole budget and still finish with a genuine 'mask-blocked' or
 * 'horizon-exceeded' verdict —
 * the cause is then honestly that cause, this gate opens, and
 * `findRelaxedGate`'s BFS probes would run past the deadline. That gap is
 * closed by an explicit deadline check immediately before the relaxation
 * block, not here.
 */
export function depthRelaxationMayHelp(cause: SolveFailureCause): boolean {
  return cause === 'mask-blocked' || cause === 'horizon-exceeded';
}

/** #1136: one tier as pass 1 ran it. */
export interface TierRecord {
  tier: 1 | 2 | 3 | 4;
  gate: DepthGate;
  comfortDepthM: number | undefined;
  /** Pass 1's relaxed depth on tiers 3–4; null on the requested gate. */
  usedDepthM: number | null;
  /** Per sail in `req.sailIds` order: the solver cause, null where it routed. Never a label. */
  causes: (SolveFailureCause | null)[];
}

/** #1136: what pass 1 ran, for pass 2 to admit and replay. */
export interface Pass1Record {
  /** In run order. Empty when no solving tier ran. */
  tiers: TierRecord[];
  /**
   * The plan-level cause at pass 1's final error return: `tier1[0]?.cause` /
   * `tier2[0]?.cause` when tiers 3–4 did not run, else `relaxedPlanCause` of
   * that requested cause and `combineAllCauses` of tier 4 or 3 (#1258). Null
   * on every other return (`ok`, snap failures, the pre-relaxation deadline
   * exit).
   */
  cause: SolveFailureCause | null;
}

function recordTier(
  record: Pass1Record,
  tier: TierRecord['tier'],
  gate: DepthGate,
  comfortDepthM: number | undefined,
  usedDepthM: number | null,
  sails: readonly RunOut[],
): void {
  record.tiers.push({ tier, gate, comfortDepthM, usedDepthM, causes: sails.map((r) => r.cause) });
}

/**
 * #1136 pass-2 admission (spike docs/spikes/1136-motor-off-solve-termination.md
 * §11.1; maintainer rulings on #1136, 2026-09-14). Every clause must hold:
 *  1. pass 1 returned an error — an `ok` plan, incl. the #1166 one-sail-failed
 *     shape, is never admitted (ruling 2);
 *  2. pass 1 recorded the plan-level cause 'mask-blocked';
 *  3. pass 1 ran a solving tier, so every pass-2 solve is on an
 *     oracle-connected pair (§11.1 hole 5);
 *  4. motor off (ruling 1);
 *  5. the shared deadline is not spent (ruling 3). Read last, so a plan another
 *     clause rejects never consumes an `expired()` call.
 * Clause 1 is redundant with clause 2 for records `planRouteWithRecord` builds
 * (an `ok` return records no cause); it is kept so the predicate does not rely
 * on that.
 */
export function salvagePassAdmitted(
  pass1: PlanResult,
  record: Pass1Record,
  settings: Settings,
  deadline: SolveDeadline | undefined,
): boolean {
  return (
    pass1.status === 'error' &&
    record.cause === 'mask-blocked' &&
    record.tiers.length > 0 &&
    !settings.motorEnabled &&
    !(deadline?.expired() ?? false)
  );
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

/** #885 R5: marks a leg solved inside a captain-forced segment. */
function markForced(leg: Leg): Leg {
  // Narrow on kind (never cast) so each variant's spread keeps its own shape.
  return leg.kind === 'sail' ? { ...leg, forced: true } : { ...leg, forced: true };
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
 * runner (see `app/src/test/timeouts.ts`) and must not decide a test outcome.
 */
export function planRoute(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
  onProbe?: ProbeProgress,
  deadline?: PlanDeadline,
): PlanResult {
  return planRouteWithRecord(req, windGrid, deps, onProgress, onProbe, deadline).result;
}

/** #1136: `planRoute`'s result (after any pass 2) plus pass 1's record. */
export function planRouteWithRecord(
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress?: RigProgress,
  onProbe?: ProbeProgress,
  deadline?: PlanDeadline,
): { result: PlanResult; record: Pass1Record } {
  const record: Pass1Record = { tiers: [], cause: null };
  const result = runLadder(record, req, windGrid, deps, onProgress, onProbe, deadline);
  return { result, record };
}

function runLadder(
  record: Pass1Record,
  req: PlanRequest,
  windGrid: WindGrid,
  deps: PlanDeps,
  onProgress: RigProgress | undefined,
  onProbe: ProbeProgress | undefined,
  deadline: PlanDeadline | undefined,
): PlanResult {
  const { mask } = deps;
  const s = req.settings;
  // #885 §3.3: validated before any snap or solve. The R4 guarantee is this
  // refusal, not the UI's disabled option.
  const segmentModes = req.segmentModes;
  if (segmentModes !== undefined) {
    if (
      segmentModes.length !== req.viaPoints.length + 1 ||
      segmentModes.some((m) => m !== null && m !== 'motor' && m !== 'sail')
    ) {
      return { status: 'error', reason: 'segment-modes-invalid' };
    }
    if (!s.motorEnabled && segmentModes.includes('motor')) {
      return { status: 'error', reason: 'segment-mode-conflict' };
    }
  }
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

  // #1178: pass the real mask bounds so the constructor can assert the
  // fetched wind lattice actually covers the mask's domain — this is the
  // ONE place real forecast data enters the routing pipeline, so it's the
  // one place that matters for catching a lattice/mask mismatch at runtime.
  const wind = new WindField(windGrid, mask.meta);
  // #54: a key the caller never supplied is absent from `deps.polars`
  // (rejected below via Object.hasOwn, #601). This throw pins the
  // DIAGNOSTIC, not the existence of a failure — `new Polar(undefined)`
  // throws on `table.rig` either way (lib/polar.ts) — so what it buys is
  // naming WHICH key is missing, at the lookup instead of at the
  // `new Polar` construction below. One check for every path:
  // protocol.ts hands over only the keys `init` carried, and the sweep
  // harness and tests construct PlanDeps directly.
  //
  // #601: protocol.ts's worker (production) path builds its per-plan
  // `polars` object via Object.create(null); every OTHER PlanDeps
  // constructor in this codebase — test fixtures and the sweep harness —
  // builds an ordinary `{}` object literal instead, so `deps.polars` is NOT
  // always null-prototype. Object.hasOwn below is what makes the guard
  // correct regardless of which shape a given caller passed.
  const polarFor = (sailId: SailId): PolarTable => {
    const key = polarKey(deps.boat.id, sailId);
    // #601: Object.hasOwn, not a `!== undefined` chain lookup. `in` and a
    // bare property read both walk the PROTOTYPE CHAIN, so a key that
    // happened to collide with an Object.prototype member name (toString,
    // constructor, hasOwnProperty, ...) would silently resolve to an
    // INHERITED function instead of tripping this fail-closed throw — every
    // `Object.getOwnPropertyNames(Object.prototype)` member passes a bare
    // `!== undefined` check. Unreachable today (every real key is
    // `${boatId}/${sailId}` via polarKey() above, so it always contains a
    // literal "/", which none of those 12 names do), but the guard is
    // written to test what it means to test rather than lean on that shape
    // holding forever.
    if (!Object.hasOwn(deps.polars, key)) throw new Error(`#54: no polar table for ${key}`);
    return deps.polars[key];
  };
  const run = (
    sailId: SailId,
    table: PolarTable,
    settings: Settings,
    gate: DepthGate,
    comfort: number | undefined,
    pass2: Pass2 | null,
  ): RunOut => {
    const polar = new Polar(table, settings.performanceFactor);
    const solveDeadline = pass2 === null ? deadline : pass2.deadline;
    const legs: Leg[] = [];
    // Segments are solved sequentially, each departing at the previous
    // segment's ETA. Maneuver state (board, tack/gybe count) is v1-simplified
    // to reset at each via-point joint: a board change across a via is not
    // charged a maneuver penalty.
    let departureMs = req.departureMs;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const forcedKind = segmentModes?.[i] ?? null;
      const res = solve({
        origin: waypoints[i],
        destination: waypoints[i + 1],
        departureMs,
        polar,
        wind,
        mask,
        settings,
        gate,
        onProgress: (info) =>
          onProgress?.(sailId, pass2 === null ? info : { ...info, secondPass: true }),
        ...(comfort !== undefined ? { comfortDepthM: comfort } : {}),
        // exactOptionalPropertyTypes: omit the key entirely when unbudgeted,
        // never pass `{ deadline: undefined }`. The SAME object goes to every
        // pass-1 solve of this plan — see the `deadline` parameter's doc
        // comment — and pass 2's sub-deadline to every pass-2 solve.
        ...(solveDeadline !== undefined ? { deadline: solveDeadline } : {}),
        // #1136: key omitted in pass 1, so its SolveParams are unchanged.
        ...(pass2 !== null ? { salvage: true } : {}),
        // #885: absent key when the solver decides — the byte-identical path.
        ...(forcedKind !== null ? { forcedKind } : {}),
      });
      // #282: the solver's own cause, taken verbatim — no label ever exists on
      // this path. #432's 'budget-exhausted' needs no branch of its own here:
      // folding it into SolveFailureCause (rather than giving it a separate
      // SolveResult arm, as this change's pre-#450 draft did) means it arrives
      // through exactly this line like any other cause.
      if (res.status !== 'ok') return { sailId, rigResult: null, cause: res.cause };
      // #452 graft 5: the merge pass re-validates against the SAME gate this
      // segment solved at — never a route-wide scalar.
      const merged = mergeCollinearLegs(res.legs, mask, wind, gate, comfort);
      // #885 R5: marked after the merge, which never crosses a via joint.
      legs.push(...(forcedKind !== null ? merged.map(markForced) : merged));
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
  const runAll = (
    settings: Settings,
    gate: DepthGate,
    comfort: number | undefined,
    pass2: Pass2 | null = null,
  ): RunOut[] =>
    req.sailIds.map((sailId) => run(sailId, polarFor(sailId), settings, gate, comfort, pass2));

  /**
   * #553 / spec §N.4: a comparison involving a tier-C ('estimated') sail is
   * WITHHELD, not computed and then hidden. Per §N.3/§N.6-E6, the estimator
   * derives a tier-C boat's SECOND table as its own base table times the
   * Salona 45's documented overlay ramp, so the difference between its two
   * tables is a function of THE RAMP, not of the hull — deterministic,
   * repeatable, and carrying zero information about that boat. In the spec's
   * words: "it is not a noisy finding; it is not a finding." (No tier-C boat
   * is in the catalogue yet — this is the estimator's contract that the first
   * one must satisfy, not an observed property of shipped data.)
   *
   * Computed once per plan HERE and consumed by `assemble` below, so the
   * suppression is decided in the ROUTING layer and reaches every consumer
   * through the `PlanResult` type — never in the view. A view-level check
   * would be a data accident: `PlanResult` is persisted and re-rendered (and
   * exported), so a verdict suppressed at one render site is a verdict that
   * still exists in the record and resurfaces at the next one.
   *
   * Scoped to `req.sailIds` — the COMPARED set, not the boat's whole sail
   * set. §N.4's justification is that the difference between the two COMPARED
   * tables is a function of the overlay ramp rather than of the hull, and
   * that argument says nothing about a third, uncompared sail: a boat with
   * two certificate sails and an estimated storm jib has a perfectly sound
   * certificate-vs-certificate comparison, and withholding it would lose the
   * feature's headline capability for no epistemic reason. §E.1 anticipates
   * the divergence explicitly ("The boat may carry any number of foresails;
   * the user picks which two to compare"), so it goes live with the first
   * three-sail boat rather than being permanently dead. A MIXED-tier
   * comparison — one certificate sail against one estimated one — still
   * suppresses, because both sails are in the compared set.
   *
   * `some` rather than `!every`: `[].every(...)` is VACUOUSLY TRUE, so the
   * negated form would report an EMPTY request as suppressed. `[].some(...)`
   * is false.
   */
  const comparisonSuppressed = req.sailIds.some((id) => {
    const sail = deps.boat.sails.find((s) => s.id === id);
    // Fail CLOSED on a sail the boat does not declare: an unresolvable
    // provenance is not a certificate.
    return sail === undefined || sail.polarProvenance.tier === 'estimated';
  });

  const assemble = (
    sails: readonly RunOut[],
    shallow: ShallowInfo | null,
    budgetCut = sails.some((out) => out.cause === 'budget-exhausted'),
  ): PlanResult => {
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
    //
    // #553 / spec §N.4: the ELSE branch now reports `not-compared` instead of
    // stamping `decided`. Before this change every path that did NOT call
    // compareRigs still returned `{ kind: 'decided' }`, so three latent cases
    // presented an unmade comparison as a verdict — N = 1 (one requested
    // sail), N >= 3 (the `sails.length === 2` gate is false, so the cap
    // silently degraded into a claim), and the reachable-today case where two
    // sails were requested and only one solved. All three are answered by
    // declining to rank, which is why this is NOT the N-way generalisation
    // §L rejects: the cap stays at 2 and no N-way tie semantics are defined
    // (spec §N.9 states this explicitly).
    //
    // `recommended` is unchanged on every path — it still names a sail with a
    // non-null result, because the tab seeding and PlansList chip need *a*
    // sail whether or not a comparison happened.
    let rigRecommendation: RigRecommendation;
    let recommended: SailId;
    const a = sails[0];
    const b = sails[1];
    if (!comparisonSuppressed && sails.length === 2 && a.rigResult && b.rigResult) {
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
      rigRecommendation = { kind: 'not-compared' };
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
      // #54 spec §E.3: a sail whose search was cut short by the plan's
      // wall-clock budget was never compared, so a result carrying one is a
      // PARTIAL comparison and says so. 'budget-exhausted' is the only cause
      // that qualifies: the other three are verdicts from a search that
      // FINISHED (see combineFailureCause's precedence comment).
      //
      // Reads the internal cause, never `SailResult.reason` — #282: no code
      // in this file may branch on a user-facing label. #1136 pass 2 passes
      // `budgetCut` from its unmasked causes.
      comparisonComplete: !budgetCut,
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

  // #1136 pass 2 (spike §11.1; rulings on #1136, 2026-09-14 and comments
  // 5679435574 / 5679649933 / 5680650879): replay pass 1's recorded tiers with
  // salvage on, at pass 1's gates.
  const routed = (r: RunOut): boolean => r.rigResult !== null;
  // A failed pass-2 sail carries the cause pass 1 recorded for that sail and
  // tier, so no pass-2 cause reaches `noRouteLabel`. `comparisonComplete` is
  // the exception (ruling, comment 5680650879): false when a pass-2 solve of
  // the returned tier was cut by the budget. Every sail of an admitted plan
  // failed in every recorded tier, so the `record.cause` fallback is defensive.
  const withPass1Causes = (sails: RunOut[], tier: TierRecord): RunOut[] =>
    sails.map((r, i) =>
      routed(r) ? r : { ...r, cause: tier.causes[i] ?? record.cause ?? 'mask-blocked' },
    );
  // Started when pass 2 starts; expires with the shared deadline or after
  // PASS2_BUDGET_MS, whichever is first.
  const pass2Deadline = (): SolveDeadline | undefined => {
    if (deadline === undefined) return undefined;
    const now = deadline.now ?? (() => Date.now());
    const startMs = now();
    return { expired: () => deadline.expired() || now() - startMs >= PASS2_BUDGET_MS };
  };
  const replayWithSalvage = (): PlanResult | null => {
    const pass2: Pass2 = { deadline: pass2Deadline() };
    const tiers = record.tiers;
    for (let i = 0; i < tiers.length; i++) {
      const first = tiers[i];
      // Tier 2 pairs with tier 1, tier 4 with tier 3; the pair shares a gate.
      const retryTier = tiers[i + 1]?.tier === first.tier + 1 ? tiers[i + 1] : undefined;
      if (retryTier !== undefined) i++;
      const done = (sails: RunOut[], tier: TierRecord): PlanResult => {
        const masked = withPass1Causes(sails, tier);
        const shallow =
          tier.usedDepthM === null
            ? null
            : flagShallowLegs(mask, masked, s.safetyDepthM, tier.usedDepthM);
        const budgetCut = sails.some((r) => r.cause === 'budget-exhausted');
        return assemble(masked, shallow, budgetCut);
      };
      const firstRun = runAll(s, first.gate, first.comfortDepthM, pass2);
      // Retry entry: pass 1 ran the retry tier and a sail still has no result.
      const retryRun =
        retryTier !== undefined && !firstRun.every(routed)
          ? runAll(s, retryTier.gate, retryTier.comfortDepthM, pass2)
          : null;
      // As in pass 1: the retry wins if it routed any sail, else the first tier
      // if it did. A budget-exhausted retry routes nothing, so the first tier
      // stands.
      if (retryTier !== undefined && retryRun?.some(routed)) return done(retryRun, retryTier);
      if (firstRun.some(routed)) return done(firstRun, first);
      // Nothing routed at this gate: only then move on to the relaxed gate.
    }
    return null;
  };
  // Every pass-1 return after the ladder starts goes through here. Pass 2
  // routing nothing, for any cause, returns pass 1 verbatim (ruling 4).
  const finish = (pass1: PlanResult): PlanResult =>
    salvagePassAdmitted(pass1, record, s, deadline) ? (replayWithSalvage() ?? pass1) : pass1;
  if (connectedAt(requestedGate)) {
    // #243 tier 1: requested gate, preference on — the happy path, nothing
    // extra paid.
    const tier1 = runAll(s, requestedGate, comfortDepthM);
    recordTier(record, 1, requestedGate, comfortDepthM, null, tier1);
    if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier1)) {
      // #243 tier 2: requested gate, preference off — bit-identical to the
      // pre-#243 single `runAll(s, …)` call this replaces (comfortDepthM
      // undefined ⇒ every solve/merge call takes the untouched path). Only
      // reached when the preference was actually active AND at least one
      // sail failed with a reason it could plausibly have caused (see
      // needsUnpreferencedRetry) — this is what makes "no plan can get worse
      // than pre-#243" true by construction rather than by argument.
      const tier2 = runAll(s, requestedGate, undefined);
      recordTier(record, 2, requestedGate, undefined, null, tier2);
      if (tier2.some((r) => r.rigResult)) return finish(assemble(tier2, null));
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
        return finish(assemble(tier1, null));
      }
      // Arbitrary tie-break: take the first requested sail's cause (checked
      // first, per req.sailIds order); every sail solves identical
      // mask/wind/waypoints and differs only in polar table, so their
      // failure causes rarely differ in practice. Matches tier 1's fallback
      // below exactly (the pre-#243 rule).
      //
      // `?.`/`??` for the same reason as tier 1's fallback below, applied
      // DEFENSIVELY here and MEASURED as unreachable by that input: reaching
      // this branch needs `needsUnpreferencedRetry(tier1)`, a `.some()` that
      // is false for an empty array, so an empty sail list always takes the
      // `else` below instead. Nothing can red this line, and no test claims
      // to.
      cause = tier2[0]?.cause ?? 'mask-blocked';
    } else if (tier1.some((r) => r.rigResult)) {
      return finish(assemble(tier1, null));
    } else {
      // Arbitrary tie-break: take the first requested sail's cause (checked
      // first); every sail solves identical mask/wind/waypoints and differs
      // only in polar table, so their failure causes rarely differ in
      // practice.
      //
      // `?.`/`??` rather than `!`: `runAll` maps over `req.sailIds`, so an
      // EMPTY sail list makes every tier `[]` and this assertion died as an
      // unnamed TypeError, forwarded as `worker-fatal` and shown as the
      // generic 'error.routingFailed'. `[]` is neither nullish nor falsy, so
      // none of the `?? DEFAULT_SAIL_IDS` backfills on the way in catches it.
      // services/migratePlan.ts now rebuilds an empty stored list from the
      // sails the result actually lists; this degrades to a typed no-route if
      // one is ever built another way. `cause` is non-null on every element
      // here (this branch is only taken when no sail produced a rigResult),
      // so the fallback changes nothing for a non-empty list.
      cause = tier1[0]?.cause ?? 'mask-blocked';
    }
  }

  // #53 graceful degradation below safety depth: only the causes
  // `depthRelaxationMayHelp` admits relax (a calm forecast keeps its error),
  // and never at or below the boat-draft floor. The relaxed gate is
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
  // ENTIRE budget and still finish with a genuine 'mask-blocked' (or, since
  // #1258, 'horizon-exceeded') verdict, so the gate opens, and
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
      deadline,
    );
    // #1280 part B: `findRelaxedGate` abandons its probe ladder on a spent
    // budget and returns null, which is also its "nothing connects" answer.
    // Re-reading the deadline HERE is what keeps the typed budget failure
    // winning: without it an abandoned search would be reported as a
    // mask-level verdict the probes never actually reached.
    if (deadline?.expired()) {
      return { status: 'error', reason: NO_ROUTE_LABEL_OF_CAUSE['budget-exhausted'] };
    }
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
      recordTier(record, 3, relaxedGate, comfortDepthM, usedDepthM, tier3);
      if (comfortDepthM !== undefined && needsUnpreferencedRetry(tier3)) {
        // #243 tier 4: relaxed gate, preference off.
        const tier4 = runAll(s, relaxedGate, undefined);
        recordTier(record, 4, relaxedGate, undefined, usedDepthM, tier4);
        if (tier4.some((r) => r.rigResult)) {
          const shallow = flagShallowLegs(mask, tier4, s.safetyDepthM, usedDepthM);
          return finish(assemble(tier4, shallow));
        }
        // #243 fix-wave item 5 (mirrors the tier 1/2 fallback above): tier 4
        // failed on EVERY sail, but tier 3 may still hold a genuinely
        // successful one — fall back to it rather than discarding a working
        // route. Every leg of the fallback still comes from the SAME
        // preference-on, SAME relaxed-gate tier, so the rig comparison
        // stays apples-to-apples.
        if (tier3.some((r) => r.rigResult)) {
          const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
          return finish(assemble(tier3, shallow));
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
        // #1258: folded with the requested-gate cause; see relaxedPlanCause.
        cause = relaxedPlanCause(cause, combineAllCauses(tier4));
      } else if (tier3.some((r) => r.rigResult)) {
        const shallow = flagShallowLegs(mask, tier3, s.safetyDepthM, usedDepthM);
        return finish(assemble(tier3, shallow));
      } else {
        // #68: relaxation FOUND a connected gate but every sail still failed
        // to solve there, so this is no longer a mask-level failure —
        // propagate the relaxed solve's OWN class (the horizon and calm
        // classes are actionable) rather than leaving the stale mask-blocked
        // one. See combineFailureCause for the rig-disagreement precedence.
        // #54 fix round 1: folds over every requested sail via
        // combineAllCauses (see the tier-4 call site's comment above).
        // #1258: folded with the requested-gate cause; see relaxedPlanCause.
        cause = relaxedPlanCause(cause, combineAllCauses(tier3));
      }
    }
  }
  // The relaxed solve failed (or no gate connected / relaxation not attempted):
  // report the cause — mask-blocked when the mask never connected, else the
  // propagated relaxed-solve class.
  //
  // #282: the ONE place a plan-level failure becomes a user-facing label.
  // #1136: the only return that records a plan-level cause. The pre-relaxation
  // deadline exit above leaves it null although the local `cause` still reads
  // 'mask-blocked' there.
  record.cause = cause;
  return finish({ status: 'error', reason: NO_ROUTE_LABEL_OF_CAUSE[cause] });
}
