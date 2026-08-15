import { describe, expect, it, vi, beforeEach } from 'vitest';
import { planRoute } from './planRoute';
import { solve, type SolveFailureCause } from './isochrone';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Leg,
  type PlanRequest,
  type PlanResultOk,
  type PolarTable,
  type SailId,
  type Settings,
} from '../types';

// #54: the pre-#54 shape exposed `res.genoa`/`res.fock`/`res.fockReason`/
// `res.genoaReason` directly.
function sailResult(res: PlanResultOk, sailId: SailId) {
  return res.sails.find((s) => s.sailId === sailId)?.result ?? null;
}
function sailReason(res: PlanResultOk, sailId: SailId) {
  return res.sails.find((s) => s.sailId === sailId)?.reason ?? null;
}

// #243 §G.6: the tier-ladder is the mandatory safety net (§D.4: "the
// reachability argument is not a proof — the fallback ladder is"), so its
// wiring in planRoute.ts must be tested directly rather than left as "dead
// code nobody notices is broken" — see isochrone.test.ts's
// "#243 search-capacity effect" describe block for a REAL (non-mocked)
// solver demonstration that the underlying failure mode this ladder guards
// against is genuine, not hypothetical. That scenario needs a deliberately
// starved solve()-level maxFrontier that planRoute's public API has no
// reason to expose, so this file instead mocks `solve` to exercise the
// exact CONTROL FLOW deterministically: which tier ran, in what order, and
// which tier's result the plan ultimately reports.
vi.mock('./isochrone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./isochrone')>();
  return { ...actual, solve: vi.fn() };
});
const solveMock = vi.mocked(solve);

const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);

// TEST_MASK_META cell centers (0.005° grid): row 80/col 120 and row 81/col
// 121 — CELL CENTERS, not grid-line intersections. snapToNavigable's default
// 300 m search radius does not reach far enough to snap a point sitting
// exactly on a grid corner (the four adjacent cell centers there are all
// ~321 m away on this grid), so origin/destination must be genuine cell
// centers for planRoute's snap step to succeed on openWaterMask().
const ORIGIN = { lat: 54.3 + 80.5 * 0.005, lon: 9.4 + 120.5 * 0.005 };
const DESTINATION = { lat: 54.3 + 81.5 * 0.005, lon: 9.4 + 121.5 * 0.005 };

/** A minimal, single-leg valid RigResult building block — never triggers postprocess.ts's merge (needs >= 2 legs). */
function leg(distanceNm: number): Leg {
  return {
    kind: 'sail',
    board: 'starboard',
    start: ORIGIN,
    end: DESTINATION,
    startTimeMs: T0,
    endTimeMs: T0 + 600_000,
    headingDeg: 45,
    twaDeg: 90,
    twsKn: 12,
    speedKn: 6,
    distanceNm,
    maneuverAtStart: null,
  };
}

const req: PlanRequest = {
  origin: ORIGIN,
  destination: DESTINATION,
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: T0,
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
};
const mask = openWaterMask(); // trivially connected at any gate: the #53 fast path always attempts tier 1
const deps = { polarGenoa: TEST_POLAR, polarFock: TEST_POLAR as PolarTable, mask };
// solve() is mocked in every test below, so the wind data is never actually
// sampled — just structurally valid for WindField's constructor.
const windGrid = uniformWindGrid(12, 0);

// solve() call order within one tier follows req.sailIds (#54: runAll's
// `req.sailIds.map((sailId) => run(sailId, ...))` evaluates in array order —
// genoa-then-fock here because that's this file's sailIds literal above).
const ok = (distanceNm: number, etaMs = T0 + 1000) => ({
  status: 'ok' as const,
  legs: [leg(distanceNm)],
  etaMs,
});
// #282: `solve()` speaks the INTERNAL control vocabulary (SolveFailureCause),
// not the user-facing NoRouteReason label — so these mocked failures are
// written in causes. The plan-level `reason` the assertions below check is the
// LABEL planRoute derives from the cause at its one presentation boundary.
const noRoute = (cause: SolveFailureCause) => ({
  status: 'no-route' as const,
  cause,
});

beforeEach(() => {
  solveMock.mockReset();
});

describe('#243 planRoute tier ladder (requested gate: tier 1 -> tier 2)', () => {
  it("retries BOTH rigs without the preference when only ONE rig fails mask-blocked, discarding the OTHER rig's successful tier-1 result", () => {
    // Tier 1 (preference on): genoa fails, fock SUCCEEDS.
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 genoa
    solveMock.mockReturnValueOnce(ok(999)); // tier1 fock (a distinctive distance that must NOT survive)
    // Tier 2 (preference off): both succeed.
    solveMock.mockReturnValueOnce(ok(11)); // tier2 genoa
    solveMock.mockReturnValueOnce(ok(12)); // tier2 fock

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0 };
    const res = planRoute({ ...req, settings }, windGrid, deps);

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // #243 §D.1 piece 3: decided at PLAN level — fock's tier-1 success
    // (distanceNm 999) must be discarded, not reused, once genoa forced a
    // retry. Both rigs come from tier 2.
    expect(sailResult(res, 'genoa')?.distanceNm).toBe(11);
    expect(sailResult(res, 'fock')?.distanceNm).toBe(12);
    expect(res.shallow).toBeUndefined();
    // Every SolveParams passed comfortDepthM on the first two calls, and
    // omitted it (exactOptionalPropertyTypes: absent, not undefined) on the
    // last two.
    expect(solveMock.mock.calls[0]![0]).toHaveProperty('comfortDepthM', 5.0);
    expect(solveMock.mock.calls[1]![0]).toHaveProperty('comfortDepthM', 5.0);
    expect(solveMock.mock.calls[2]![0]).not.toHaveProperty('comfortDepthM');
    expect(solveMock.mock.calls[3]![0]).not.toHaveProperty('comfortDepthM');
  });

  it('also retries on horizon-exceeded (not just mask-blocked)', () => {
    solveMock.mockReturnValueOnce(noRoute('horizon-exceeded')); // tier1 genoa
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 fock
    solveMock.mockReturnValueOnce(ok(21)); // tier2 genoa
    solveMock.mockReturnValueOnce(ok(22)); // tier2 fock

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0 };
    const res = planRoute({ ...req, settings }, windGrid, deps);

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(sailResult(res, 'genoa')?.distanceNm).toBe(21);
    expect(sailResult(res, 'fock')?.distanceNm).toBe(22);
  });

  it('never retries on calm-without-motor — that class is a wind/mask fact the preference cannot cause or cure', () => {
    solveMock.mockReturnValueOnce(noRoute('calm-without-motor')); // tier1 genoa
    solveMock.mockReturnValueOnce(noRoute('calm-without-motor')); // tier1 fock

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0 };
    const res = planRoute({ ...req, settings }, windGrid, deps);

    expect(solveMock).toHaveBeenCalledTimes(2); // no tier-2 attempt at all
    expect(res).toEqual({ status: 'error', reason: 'calm-motor-off' });
  });

  it('feature off (margin 0): never attempts a retry even on a mask-blocked tier-1 failure', () => {
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 genoa
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 fock

    // safetyDepthM pinned to BOAT_DRAFT_M (2.1): keeps this test isolated to
    // the requested-gate stage — above the floor, a real 'mask-blocked' on
    // openWaterMask() (uniformly navigable at any depth, connected at any
    // gate) would otherwise fall through into #53's relaxed-gate mechanism
    // and call solve() twice more for tier 3, which is a different concern
    // (exercised, and mocked, in the next test below).
    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 0, safetyDepthM: 2.1 };
    const res = planRoute({ ...req, settings }, windGrid, deps);

    // comfortDepthM undefined ⇒ tier 1 IS the pre-#243 solve already; a
    // "retry" would just re-run the identical thing, so it must not happen.
    expect(solveMock).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ status: 'error', reason: 'unreachable' });
    expect(solveMock.mock.calls[0]![0]).not.toHaveProperty('comfortDepthM');
  });

  it("when tier 2 ALSO fails entirely, the plan-level reason is tier 2's own genoa tie-break (matching the pre-#243 rule at the requested gate)", () => {
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 genoa
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 fock
    solveMock.mockReturnValueOnce(noRoute('calm-without-motor')); // tier2 genoa
    solveMock.mockReturnValueOnce(noRoute('calm-without-motor')); // tier2 fock

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0, safetyDepthM: 2.1 }; // at BOAT_DRAFT_M: relaxation never fires, isolates this stage
    const res = planRoute({ ...req, settings }, windGrid, deps);

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res).toEqual({ status: 'error', reason: 'calm-motor-off' });
  });

  // #243 fix-wave item 5: the retry is triggered by ONE rig failing, but
  // that doesn't guarantee the retry succeeds — the search is heuristic, so
  // a rig that succeeded WITH the preference can fail once retried without
  // it. The plan must not discard tier 1's genuinely successful rig just
  // because the retry it triggered came up empty on BOTH rigs.
  it("falls back to tier 1's successful rig when tier 2 fails on BOTH rigs (does not discard a working route)", () => {
    solveMock.mockReturnValueOnce(ok(41)); // tier1 genoa: succeeds
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier1 fock: fails, triggers retry
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier2 genoa: retry fails too
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier2 fock: retry fails too

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0, safetyDepthM: 2.1 }; // at BOAT_DRAFT_M: relaxation never fires, isolates this stage
    const res = planRoute({ ...req, settings }, windGrid, deps);

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    // Tier 1's genoa (preference on), not an error — genoa/fock both come
    // from the SAME tier, so the rig comparison stays apples-to-apples.
    expect(sailResult(res, 'genoa')?.distanceNm).toBe(41);
    expect(sailResult(res, 'fock')).toBeNull();
    expect(sailReason(res, 'fock')).toBe('unreachable');
  });
});

describe('#243 planRoute tier ladder (relaxed gate: tier 3 -> tier 4)', () => {
  // An E-W corridor (rows 85..105) walled by land, split by a wall at col
  // 160 whose only opening (rows 90..99) is charted `gapDm` decimeters —
  // same shape as planRoute.shallow.test.ts's corridorGapMask. At the
  // requested 3.0 m gate a 2.5 m-charted gap is DISCONNECTED, so
  // connectedAt(3.0) is false and the #53 fast path skips tier 1/2 entirely
  // (real mask BFS, unaffected by mocking `solve`) — isolating this test to
  // the relaxed-gate stage.
  const corridorGapMask = (gapDm: number) =>
    makeMask((r, c) => {
      if (r < 85 || r > 105) return 0;
      if (c === 160) return r >= 90 && r <= 99 ? gapDm : 0;
      return 200;
    });
  // #452: the destination sits at col 165, five columns (~1606 m at
  // 54.7525°N) east of the col-160 wall, so the gap falls INSIDE its 1852 m
  // approach disc and relaxation still fires. At the pre-#452 col 200 the
  // gap would be ~12.8 km from either waypoint, outside every disc, and
  // these tier-3/tier-4 cases would never run — see
  // planRoute.shallow.test.ts, which pins both sides of that distinction.
  const relaxedReq: PlanRequest = {
    ...req,
    origin: { lat: 54.7525, lon: 10.0025 },
    destination: { lat: 54.7525, lon: 10.2275 },
  };

  it('retries BOTH rigs without the preference when the relaxed-gate solve fails mask-blocked, discarding a successful tier-3 rig', () => {
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier3 genoa
    solveMock.mockReturnValueOnce(ok(999)); // tier3 fock (must NOT survive)
    solveMock.mockReturnValueOnce(ok(31)); // tier4 genoa
    solveMock.mockReturnValueOnce(ok(32)); // tier4 fock

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0 };
    const res = planRoute(
      { ...relaxedReq, settings },
      windGrid,
      { ...deps, mask: corridorGapMask(25) }, // gap charted 2.5 m
    );

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(sailResult(res, 'genoa')?.distanceNm).toBe(31);
    expect(sailResult(res, 'fock')?.distanceNm).toBe(32);
    // #53's contract: the relaxed gate is still reported, even though the
    // legs themselves came from the un-preferenced retry. minGateDepthM is
    // NOT pinned here — flagShallowLegs derives it from these mocked legs'
    // fixed (unrelated-to-this-mask) coordinates, so it carries no meaning
    // in this control-flow test; the real-mask G.4 test pins it precisely.
    expect(res.shallow?.requestedDepthM).toBe(3.0);
    expect(res.shallow?.usedDepthM).toBe(2.5);
  });

  // #243 fix-wave item 5, mirrored at the relaxed gate: tier 4 failing on
  // both rigs must not discard tier 3's genuinely successful rig.
  it("falls back to tier 3's successful rig when tier 4 fails on BOTH rigs (does not discard a working relaxed-gate route)", () => {
    solveMock.mockReturnValueOnce(ok(51)); // tier3 genoa: succeeds
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier3 fock: fails, triggers retry
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier4 genoa: retry fails too
    solveMock.mockReturnValueOnce(noRoute('mask-blocked')); // tier4 fock: retry fails too

    const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM: 2.0 };
    const res = planRoute(
      { ...relaxedReq, settings },
      windGrid,
      { ...deps, mask: corridorGapMask(25) }, // gap charted 2.5 m
    );

    expect(solveMock).toHaveBeenCalledTimes(4);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(sailResult(res, 'genoa')?.distanceNm).toBe(51);
    expect(sailResult(res, 'fock')).toBeNull();
    expect(sailReason(res, 'fock')).toBe('unreachable');
    // Tier 3's shallow flag still applies to the fallback result.
    expect(res.shallow?.requestedDepthM).toBe(3.0);
    expect(res.shallow?.usedDepthM).toBe(2.5);
  });
});
