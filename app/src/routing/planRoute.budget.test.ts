import { describe, expect, it, vi } from 'vitest';
import { solve, type SolveDeadline, type SolveFailureCause } from './isochrone';
import { combineAllCauses, combineFailureCause, planRoute } from './planRoute';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { TEST_MASK_META, TEST_POLAR, testPlanDeps, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type LatLon,
  type PlanRequest,
  type PlanResultOk,
  type PolarTable,
  type SailId,
  type SailResult,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// #432: the plan-level wall-clock budget. Solver-heavy file (every case runs
// a real solve), so it takes the shared coverage-aware budget rather than a
// hardcoded literal — timeoutGuard.test.ts enforces that.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };

function openWaterMask(): NavMask {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  return new NavMask(TEST_MASK_META, data);
}

/**
 * A mask with a solid land wall between origin and destination, so the solve
 * runs to completion and returns a genuine 'mask-blocked' verdict — the state
 * the pre-relaxation deadline check exists for. Depth byte 0 is land.
 */
function walledMask(): NavMask {
  const data = new Uint8Array(TEST_MASK_META.rows * TEST_MASK_META.cols).fill(200);
  const wallCol = Math.floor(TEST_MASK_META.cols / 2);
  for (let r = 0; r < TEST_MASK_META.rows; r++) data[r * TEST_MASK_META.cols + wallCol] = 0;
  return new NavMask(TEST_MASK_META, data);
}

const ORIGIN: LatLon = { lat: 54.7525, lon: 10.0025 };
const DESTINATION: LatLon = { lat: 54.7525, lon: 10.3025 };
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);

/** A deadline that reports "spent" from the Nth `expired()` call onwards. */
function deadlineAfterCalls(n: number): SolveDeadline & { calls: number } {
  const d = {
    calls: 0,
    expired() {
      d.calls++;
      return d.calls > n;
    },
  };
  return d;
}

const NEVER: SolveDeadline = { expired: () => false };

function planWith(
  deadline: SolveDeadline | undefined,
  mask: NavMask,
  onProbe?: (p: { probeDepthM: number; done: number; total: number }) => void,
  sailIds: readonly SailId[] = ['genoa', 'fock'],
) {
  const request: PlanRequest = {
    origin: ORIGIN,
    destination: DESTINATION,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings: DEFAULT_SETTINGS,
    sailIds,
  };
  return planRoute(
    request,
    uniformWindGrid(12, 0),
    testPlanDeps(mask, { genoa: TEST_POLAR, fock: FOCK }),
    undefined,
    onProbe,
    deadline,
  );
}

describe('#432 solve(): the plan-level wall-clock budget', () => {
  it('an ABSENT deadline leaves the solve unbudgeted — the fail-open default', () => {
    const mask = openWaterMask();
    const base = {
      origin: ORIGIN,
      destination: DESTINATION,
      departureMs: T0,
      polar: new Polar(TEST_POLAR, DEFAULT_SETTINGS.performanceFactor),
      wind: new WindField(uniformWindGrid(12, 0)),
      mask,
      settings: DEFAULT_SETTINGS,
    };
    const unbudgeted = solve(base);
    const neverExpires = solve({ ...base, deadline: NEVER });
    expect(unbudgeted.status, 'the reference solve must actually succeed').toBe('ok');
    // Same outcome by both routes: an absent deadline and a deadline that
    // never fires are the same solve. This is the "no currently-succeeding
    // plan starts failing" property at solve() level.
    expect(neverExpires).toEqual(unbudgeted);
  });

  it('an ALREADY-spent deadline aborts before expanding a single ring', () => {
    const onProgress = vi.fn();
    const res = solve({
      origin: ORIGIN,
      destination: DESTINATION,
      departureMs: T0,
      polar: new Polar(TEST_POLAR, DEFAULT_SETTINGS.performanceFactor),
      wind: new WindField(uniformWindGrid(12, 0)),
      mask: openWaterMask(),
      settings: DEFAULT_SETTINGS,
      deadline: { expired: () => true },
      onProgress,
    });
    // Asserted as a CAUSE, not a label — post-#450 `solve()` speaks only the
    // internal vocabulary, and 'budget-exhausted' is a member of it rather
    // than a separate SolveResult arm.
    expect(res).toEqual({ status: 'no-route', cause: 'budget-exhausted' });
    // The check is FIRST in the ring, so a later tier entered with a spent
    // budget costs one predicate, not one ring of expansion.
    expect(onProgress, 'a spent budget must not expand any ring').not.toHaveBeenCalled();
  });

  it('a deadline spent MID-SEARCH aborts, and does not report the route it had found', () => {
    const base = {
      origin: ORIGIN,
      destination: DESTINATION,
      departureMs: T0,
      polar: new Polar(TEST_POLAR, DEFAULT_SETTINGS.performanceFactor),
      wind: new WindField(uniformWindGrid(12, 0)),
      mask: openWaterMask(),
      settings: DEFAULT_SETTINGS,
    };
    // Learn the real ring count of the SAME input first, so the expiry point
    // below is derived from the search rather than guessed.
    let rings = 0;
    const reference = solve({ ...base, onProgress: () => rings++ });
    expect(reference.status, 'the reference solve must succeed').toBe('ok');
    expect(rings, 'the reference solve must take more than one ring').toBeGreaterThan(1);

    // Expire on the LAST ring the successful search needed. That `best` is
    // genuinely already set by then is not assumed — it is MEASURED by the
    // mutation: with the ring check deleted this exact case returns
    // `status: 'ok'`, which it could only do from an incumbent found before
    // the abort point. So the incumbent exists and is being discarded, which
    // is the behaviour #432 requires (exceeding the budget is a failure, not
    // a route of unproven optimality returned silently).
    const res = solve({ ...base, deadline: deadlineAfterCalls(rings) });
    expect(res).toEqual({ status: 'no-route', cause: 'budget-exhausted' });
  });
});

// PR #453 review, Major 1. Deleting `combineFailureCause`'s 'budget-exhausted'
// arm reddened ZERO of the 297 tests in src/routing + src/state — a reachable
// behavioural claim with nothing falsifying it, which is precisely the standard
// planRoute.ts applies to its own retry gates. The whole 5x5 table is pinned
// rather than just the budget arm, because the pre-existing
// `horizon > calm > mask` ordering was equally unpinned.
//
// Expectations are HAND-DERIVED from the documented precedence, never computed
// by re-implementing the fold (that would be #50's equivalence tautology: an
// expectation derived from the function under test always passes). Reading
// order, most actionable first:
//   budget-exhausted   the search did not finish — we do not know, and must
//                      not report a finished sibling's verdict as fact
//   > horizon-exceeded change departure / refresh forecast
//   > calm-without-motor  enable the motor
//   > mask-blocked     nothing the user can change; also the both-null default
const B = 'budget-exhausted';
const H = 'horizon-exceeded';
const C = 'calm-without-motor';
const M = 'mask-blocked';

const PRECEDENCE: ReadonlyArray<[SolveFailureCause | null, SolveFailureCause | null, string]> = [
  // both null -> the mask-level default (pre-#432 behaviour, unchanged)
  [null, null, M],
  // one side null: the non-null cause carries, whatever it is
  [null, M, M],
  [M, null, M],
  [null, C, C],
  [C, null, C],
  [null, H, H],
  [H, null, H],
  [null, B, B],
  [B, null, B],
  // same on both sides
  [M, M, M],
  [C, C, C],
  [H, H, H],
  [B, B, B],
  // mixed pairs among the pre-existing three, both argument orders
  [M, C, C],
  [C, M, C],
  [M, H, H],
  [H, M, H],
  [C, H, H],
  [H, C, H],
  // #432: budget beats every one of them, in BOTH positions
  [B, M, B],
  [M, B, B],
  [B, C, B],
  [C, B, B],
  [B, H, B],
  [H, B, B],
];

describe('#432/#453 combineFailureCause precedence', () => {
  it.each(PRECEDENCE)('combineFailureCause(%s, %s) === %s', (a, b, expected) => {
    expect(combineFailureCause(a, b)).toBe(expected);
  });

  it('is symmetric in its two arguments', () => {
    const all: (SolveFailureCause | null)[] = [null, M, C, H, B];
    for (const a of all) {
      for (const b of all) {
        expect(
          combineFailureCause(a, b),
          `combineFailureCause is order-dependent at (${a}, ${b})`,
        ).toBe(combineFailureCause(b, a));
      }
    }
  });

  it('the table covers every ordered pair over the four causes plus null', () => {
    // Fails closed: a shrunken PRECEDENCE table would silently stop testing
    // the arm this describe exists for, the SOLVER_LABELS failure mode one
    // level up (PR #411).
    expect(PRECEDENCE.length, 'PRECEDENCE must cover all 5x5 ordered pairs').toBe(25);
    const seen = new Set(PRECEDENCE.map(([a, b]) => `${a}|${b}`));
    expect(seen.size, 'PRECEDENCE contains a duplicate pair').toBe(25);
  });
});

// #54 review round 2. `combineAllCauses` folds N sails' causes into one
// plan-level cause with a `null`-seeded reduce. Expectations come from the
// SAME hand-derived PRECEDENCE table the binary function is pinned against,
// never from calling `combineFailureCause` here — deriving needle and
// haystack from one source is the tautology PR #411 records.
const runOut = (cause: SolveFailureCause | null) => ({
  sailId: 'genoa' as const,
  rigResult: null,
  cause,
});

describe('#54 combineAllCauses', () => {
  it.each(PRECEDENCE)('combineAllCauses([%s, %s]) === %s', (a, b, expected) => {
    expect(combineAllCauses([runOut(a), runOut(b)])).toBe(expected);
  });

  it.each<SolveFailureCause>([M, C, H, B])(
    'N=1 returns the single sail’s own cause (%s)',
    (cause) => {
      expect(combineAllCauses([runOut(cause)])).toBe(cause);
    },
  );

  it('N=1 with a null cause falls back to the order’s bottom', () => {
    expect(combineAllCauses([runOut(null)])).toBe(M);
  });

  it('N=0 falls back to the order’s bottom', () => {
    expect(combineAllCauses([])).toBe(M);
  });
});

describe('#432 planRoute(): one budget for the whole plan', () => {
  it('surfaces a spent budget as the search-budget-exceeded label, never as unreachable', () => {
    const res = planWith({ expired: () => true }, openWaterMask());
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    // The label is derived from the internal 'budget-exhausted' cause at
    // planRoute's single presentation boundary (#282). Asserting the LABEL
    // here — the value a user actually sees — rather than the cause, which
    // planRoute deliberately does not export in its result.
    expect(res.reason).toBe('search-budget-exceeded');
  });

  it('an unbudgeted plan is unchanged — proves the budget adds no new failure', () => {
    const mask = openWaterMask();
    const unbudgeted = planWith(undefined, mask);
    const neverExpires = planWith(NEVER, mask);
    expect(unbudgeted.status, 'the reference plan must actually succeed').toBe('ok');
    expect(neverExpires).toEqual(unbudgeted);
  });

  it('does not run findRelaxedGate probes past a spent budget', () => {
    // The gap `depthRelaxationMayHelp` alone does NOT close: the solve
    // completes with an honest 'mask-blocked' verdict (so the relaxation gate
    // opens) while the budget is already spent. The BFS probes are the only
    // work in planRoute that does not run inside solve()'s ring loop, so the
    // per-ring check cannot stop them — the explicit check before the
    // relaxation block is what does.
    const onProbe = vi.fn();
    const spent = planWith({ expired: () => true }, walledMask(), onProbe);
    // The probe assertion runs FIRST, deliberately. With the reason check
    // ahead of it, removing the pre-relaxation check reddened this row on the
    // REASON and the probe claim in the row's own name was never exercised
    // (MEASURED — the mutation reported `Received: "unreachable"` and stopped
    // there). Ordered this way, the same mutation reds on the probe count, so
    // the row fails for the thing it is named after.
    expect(onProbe, 'relaxation probes must not run past a spent budget').not.toHaveBeenCalled();
    expect(spent.status).toBe('error');
    if (spent.status !== 'error') return;
    expect(spent.reason).toBe('search-budget-exceeded');

    // Non-vacuity: the SAME mask and request DO reach the probes when the
    // budget is not spent. Without this the assertion above would pass even
    // if this geometry never probed at all.
    const probed = vi.fn();
    const unbudgeted = planWith(undefined, walledMask(), probed);
    expect(unbudgeted.status).toBe('error');
    expect(probed, 'control: this geometry must reach the relaxation probes').toHaveBeenCalled();
  });
});

// #54 spec §E.3: "Budget exhaustion partway through is a PARTIAL result, not a
// failure." One sail finishing and another aborting must still return
// `status: 'ok'` carrying the finished sail's route, with the aborted sail's
// 'search-budget-exceeded' and the comparison marked incomplete — never a
// one-sail result presented as if both had been compared.
//
// The all-sails-exhausted case §E.3 pairs with this is NOT re-asserted here:
// '#432 planRoute(): one budget for the whole plan' above already pins it
// (`expect(res.status).toBe('error')` / `expect(res.reason).toBe(
// 'search-budget-exceeded')` with a deadline spent before the first ring).
describe('#54 §E.3: budget exhaustion mid-comparison', () => {
  /**
   * Look a sail up by id, failing with a message that NAMES the missing sail
   * rather than the bare `Cannot read properties of undefined` a `!` would
   * throw one line later.
   */
  function sailOf(res: PlanResultOk, sailId: SailId): SailResult {
    const found = res.sails.find((s) => s.sailId === sailId);
    expect(found, `PlanResult.sails carries no entry for '${sailId}'`).toBeDefined();
    return found as SailResult;
  }

  /**
   * The abort point is DERIVED from the search, never guessed. `solve()` calls
   * `deadline.expired()` exactly once per ring, as the first statement of the
   * ring loop (isochrone.ts). For a plan that succeeds in TIER 1 without
   * reaching the pre-relaxation check — the only shape this helper is used on
   * — that is the plan's only `expired()` call site, so a single-sail plan's
   * call count is that sail's ring count. `planRoute.ts`'s own pre-relaxation
   * check is a second call site, so the count is NOT a sail's ring count for a
   * plan that reaches a #243 retry or a #53 relaxed tier. A deadline expiring
   * after that many calls lets the plan's first sail finish exactly as it
   * would unbudgeted, and aborts the second at its own first ring.
   *
   * That target is a WINDOW, not a knife-edge. Three points were run, which
   * BRACKET the window rather than locate both its edges: `calls - 1` aborts
   * the FIRST sail too and reds these rows on `status` (expected 'error' to be
   * 'ok'), so the lower edge is located at `calls`; `calls + 1` stays GREEN
   * (`deadlineAfterCalls` fires on `calls > n`, so a small over-count only
   * moves the second sail's abort a ring later) while `calls * 2` lets the
   * second sail finish too and reds on the aborted sail's `result` — which
   * places the upper boundary somewhere in [calls + 2, calls * 2] without
   * locating it. Do not read an untested value in that range as known-good.
   */
  function ringsOfFirstSail(mask: NavMask, firstSail: SailId): number {
    const counter = deadlineAfterCalls(Infinity);
    const reference = planWith(counter, mask, undefined, [firstSail]);
    expect(reference.status, 'the single-sail reference plan must succeed').toBe('ok');
    expect(counter.calls, 'the reference solve must take more than one ring').toBeGreaterThan(1);
    return counter.calls;
  }

  it.each<[SailId, SailId]>([
    ['genoa', 'fock'],
    ['fock', 'genoa'],
  ])(
    'sailIds [%s, %s]: the first finishes, the second aborts, the plan is a partial ok',
    (first, second) => {
      const mask = openWaterMask();
      const res = planWith(deadlineAfterCalls(ringsOfFirstSail(mask, first)), mask, undefined, [
        first,
        second,
      ]);

      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      const finished = sailOf(res, first);
      const aborted = sailOf(res, second);
      expect(finished.result, 'the sail that finished keeps its route').not.toBeNull();
      expect(finished.reason, 'a finished sail carries no no-route reason').toBeNull();
      expect(aborted.result, 'the aborted sail has no route to carry').toBeNull();
      expect(aborted.reason).toBe('search-budget-exceeded');
      // Both orderings are asserted so this cannot pass on a hardcoded sail
      // id: the recommendation must name whichever sail actually finished.
      // It cannot distinguish "the completed set" from "sails[0]", though —
      // a monotonic deadline always aborts the LATER sails, so on this path
      // the finished sail is always the first one. Stated rather than
      // papered over: nothing here pins `assemble`'s `find` against a
      // positional pick.
      expect(res.recommended).toBe(first);
      expect(res.comparisonComplete).toBe(false);
    },
  );

  it('a sail that FINISHED and lost still leaves the comparison COMPLETE', () => {
    // THE row that separates the narrow reading from the broad one. Every
    // other row in this block has its failing sail carrying a non-null cause
    // AND a null `rigResult` at the same time, so on those rows
    // `cause !== 'budget-exhausted'` and `rigResult !== null` agree and
    // neither can falsify the other. Here a sail fails for a reason that is
    // NOT the budget: genoa cannot move at all (every polar speed 0) with the
    // motor off, so its search runs to completion and returns
    // 'calm-without-motor' (isochrone.ts's terminal classifier picks the calm
    // arm because an open-water mask produces no blocked deaths), while fock
    // solves normally. Without this row, "simplifying" the flag to
    // `rigResult !== null` keeps the whole suite green and every genuinely
    // unreachable sail starts reporting the comparison as incomplete.
    const becalmed: PolarTable = {
      ...TEST_POLAR,
      speeds: TEST_POLAR.speeds.map((row) => row.map(() => 0)),
    };
    const request: PlanRequest = {
      origin: ORIGIN,
      destination: DESTINATION,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: T0,
      settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
      sailIds: ['genoa', 'fock'],
    };
    const res = planRoute(
      request,
      uniformWindGrid(12, 0),
      testPlanDeps(openWaterMask(), { genoa: becalmed, fock: FOCK }),
    );

    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // Controls first: without these the keeper below could pass on a plan
    // where nothing failed at all, which is just the CONTROL row again.
    const genoa = sailOf(res, 'genoa');
    const fock = sailOf(res, 'fock');
    expect(genoa.result, 'control: genoa must FAIL on this fixture').toBeNull();
    expect(genoa.reason, 'control: genoa must fail for a NON-budget reason').toBe('calm-motor-off');
    expect(fock.result, 'control: fock must SOLVE on this fixture').not.toBeNull();

    expect(res.comparisonComplete).toBe(true);
    // Same row pins the completed-set pick against a positional `sails[0]`:
    // the sail that solved is the SECOND one here.
    expect(res.recommended).toBe('fock');
  });

  it('CONTROL: every requested sail finishing leaves the comparison complete', () => {
    // Without this row a hardcoded `comparisonComplete: false` would satisfy
    // both rows above — the flag would report every plan as partial and no
    // test would notice.
    const res = planWith(NEVER, openWaterMask());
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(
      res.sails.map((s) => s.result === null),
      'control: this plan must have every sail finish',
    ).toEqual([false, false]);
    expect(res.comparisonComplete).toBe(true);
  });
});
