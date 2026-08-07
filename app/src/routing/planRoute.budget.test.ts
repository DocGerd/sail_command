import { describe, expect, it, vi } from 'vitest';
import { solve, type SolveDeadline } from './isochrone';
import { planRoute } from './planRoute';
import { NavMask } from '../lib/mask';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { TEST_MASK_META, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type LatLon, type PlanRequest, type PolarTable } from '../types';
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
) {
  const request: PlanRequest = {
    origin: ORIGIN,
    destination: DESTINATION,
    viaPoints: [],
    originHarborId: null,
    destinationHarborId: null,
    departureMs: T0,
    settings: DEFAULT_SETTINGS,
  };
  return planRoute(
    request,
    uniformWindGrid(12, 0),
    { polarGenoa: TEST_POLAR, polarFock: FOCK, mask },
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
    expect(res.status).toBe('budget-exhausted');
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

    // Expire on the LAST ring the successful search needed. `best` is already
    // set by then (the reference proves a route was found within these rings),
    // so a run that returned its incumbent would answer 'ok' here. It must
    // not: exceeding the budget is a failure and says so.
    const res = solve({ ...base, deadline: deadlineAfterCalls(rings) });
    expect(res.status).toBe('budget-exhausted');
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

  it('does not run findRelaxedDepthM probes past a spent budget', () => {
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
