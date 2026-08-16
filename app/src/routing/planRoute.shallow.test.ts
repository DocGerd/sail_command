import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { makeMask, openWaterMask, TEST_POLAR, uniformWindGrid } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type PlanRequest,
  type PlanResultOk,
  type PolarTable,
  type SailId,
  type Settings,
} from '../types';

// #54: the pre-#54 shape exposed `r.genoa`/`r.fock` directly.
function sailResult(res: PlanResultOk, sailId: SailId) {
  return res.sails.find((s) => s.sailId === sailId)?.result ?? null;
}
import type { ProbeInfo } from './relaxedDepth';
import { uniformGate } from '../lib/depthGate';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines. Fast test files keep vitest's 5s default so hang detection
// stays meaningful there.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

// An E-W corridor (rows 85..105, ~11.5 km wide) walled by land, split by a
// wall at col 160 (lon ≈ 10.2) whose only opening (rows 90..99) is charted
// `gapDm` decimeters. The land frame keeps the doomed-frontier region small so
// the unreachable solves stay cheap.
const corridorGapMask = (gapDm: number) =>
  makeMask((r, c) => {
    if (r < 85 || r > 105) return 0;
    if (c === 160) return r >= 90 && r <= 99 ? gapDm : 0;
    return 200;
  });

// Cell centers (grid step 0.005°): row 90 (lat 54.7525), cols 120 / 200.
//
// #452: with BOTH waypoints 40 columns from the col-160 wall, the gap is
// ~12.8 km from either — far outside a 1852 m approach disc. This request is
// therefore the DISTANT-pinch case, which P3 deliberately no longer relaxes.
const req: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
  sailIds: ['genoa', 'fock'],
};

// #452 APPROACH-pinch variant: destination moved to col 165 (cell centre lon
// 9.4 + 165.5*0.005 = 10.2275), 5 columns east of the wall. At 54.7525°N one
// column spans 111_320 * 0.005 * cos(54.7525°) ≈ 321 m, so the gap sits
// ≈1606 m from the destination — inside the 1852 m disc. This is the shape
// #452 exists to serve (a shallow pinch on a harbour approach), and it is
// what keeps the tier-ladder cases below exercising relaxation at all.
const reqNearApproach: PlanRequest = {
  ...req,
  destination: { lat: 54.7525, lon: 10.2275 },
};

const depsWith = (mask: ReturnType<typeof makeMask>) => ({
  polarGenoa: TEST_POLAR,
  polarFock: SLOW_FOCK,
  mask,
});

describe('planRoute graceful shallow degradation (#53)', () => {
  it('relaxes an unreachable 3.0 m plan to the highest connecting gate and flags shallow legs', () => {
    const mask = corridorGapMask(25); // gap charted 2.5 m
    const probes: ProbeInfo[] = [];
    const settings = { ...DEFAULT_SETTINGS };
    const r = planRoute(
      { ...reqNearApproach, settings },
      uniformWindGrid(12, 0),
      depsWith(mask),
      undefined,
      (p) => probes.push(p),
    );

    // Hand-derived over candidates dm 21..29, in the two phases #452 added.
    //
    // Disc membership first, since the whole sequence depends on it. The
    // destination disc is centred on cell (row 90, col 165) with radii
    // 1852/(111_320*0.005) = 3.33 rows and 1852/321 = 5.77 cols. For a gap
    // cell (row r, col 160): dc = 5, so (5/5.77)^2 = 0.752, leaving room for
    // (dr/3.33)^2 <= 0.248, i.e. |dr| <= 1.65 → gap rows 90 and 91 are
    // INSIDE, rows 92..99 are not. The origin disc (col 120) is 40 columns
    // away and contains no gap cell at all. So the wall is passable only
    // through rows 90-91, and only via the DESTINATION disc's gate.
    //
    // PHASE 1 (shared gate, unchanged in shape from pre-#452): mid 25 → the
    // 2.5 m gap passes a 2.5 m gate → connects, lo=26; mid 27 → fails,
    // hi=26; mid 26 → fails, hi=25 → best 2.5.
    //
    // PHASE 2 (#452 graft 1, per-disc ascent). Origin disc first: its own
    // cells are all 20 m, so raising its gate removes nothing and every
    // probe connects — 2.7 (lo=28), 2.8 (lo=29), 2.9 → origin ends at 2.9.
    // Destination disc second: raising it above 2.5 closes the gap outright
    // — 2.7 fails (hi=26), 2.6 fails (hi=25) → it stays at 2.5.
    //
    // That split is the point of graft 1: the disc that needed nothing gives
    // its licence back, and only the pinch disc keeps the relaxed gate.
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.7, 2.6, 2.7, 2.8, 2.9, 2.7, 2.6]);
    // Upper bound = phase-1 bound ceil(log2(9+1)) = 4, times (1 + 2 waypoints).
    for (const p of probes) expect(p.total).toBe(12);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.shallow).toEqual({ requestedDepthM: 3.0, usedDepthM: 2.5, minGateDepthM: 2.5 });

    // Both rigs relax to the SAME gate (apples-to-apples rig comparison).
    for (const rig of [sailResult(r, 'genoa'), sailResult(r, 'fock')]) {
      expect(rig).not.toBeNull();
      const flagged = rig!.legs.filter((l) => l.shallow);
      expect(flagged.length).toBeGreaterThan(0);
      // The only sub-3.0 cells in this mask are the 2.5 m gap cells.
      for (const leg of flagged) expect(leg.shallow!.minDepthM).toBeCloseTo(2.5, 6);
      // Independent depth-along-geometry oracle for the flag state, NOT a
      // re-call of segmentShallowestBelow (which SETS the flag — asserting the
      // flag against its own source can never fail). This mask's ONLY sub-3.0
      // water is the 2.5 m gap in the wall at col 160, whose lon span is
      // [10.200, 10.205] (west edge 9.4 + 160*0.005, east edge 9.4 + 161*0.005);
      // every other corridor cell is 20 m. Since each emitted leg is
      // navigable-validated at 2.5 m, it can only cross the wall column THROUGH
      // that gap — so a leg is shallow-flagged iff its lon span straddles the
      // gap column. Endpoints are solver-computed positions, never exactly on a
      // cell boundary, so the strict inequalities are safe.
      const GAP_W = 9.4 + 160 * 0.005; // 10.200
      const GAP_E = 9.4 + 161 * 0.005; // 10.205
      for (const leg of rig!.legs) {
        expect(mask.segmentNavigable(leg.start, leg.end, uniformGate(2.5))).toBe(true);
        const straddlesGap =
          Math.min(leg.start.lon, leg.end.lon) < GAP_E &&
          Math.max(leg.start.lon, leg.end.lon) > GAP_W;
        expect(Boolean(leg.shallow)).toBe(straddlesGap);
      }
      // The route genuinely uses the relaxed gate (some leg fails at 3.0 m).
      expect(rig!.legs.some((l) => !mask.segmentNavigable(l.start, l.end, uniformGate(3.0)))).toBe(
        true,
      );
    }

    // The user's settings object is NEVER mutated by relaxation.
    expect(settings.safetyDepthM).toBe(3.0);
    expect(req.settings.safetyDepthM).toBe(3.0);
  });

  // #452 graft 5, at PLAN level: proves planRoute hands mergeCollinearLegs
  // the GATE FIELD and not some other correctly-typed gate.
  //
  // Why this needs its own fixture. The obvious mutation — planRoute passing
  // uniformGate(s.safetyDepthM) to the merge pass while solve() still gets
  // the field — is UNREACHABLE on the reqNearApproach fixture above, because
  // genoa's result there is a single leg and the merge pass is a no-op on it.
  // A green battery on that fixture would be zero evidence, not weak
  // evidence. Origin col 5 makes the route ~27.7 nm, long enough that the
  // solver emits several collinear legs and merging is genuinely load-bearing.
  //
  // What the assertion pins: the whole route merges into ONE span, and that
  // span crosses the 2.5 m gap. The merged span is navigable ONLY because the
  // destination's approach disc licenses that cell — so a merge pass handed a
  // uniform REQUESTED-depth gate must reject it and the route stays split.
  //
  // This test and postprocess.test.ts's graft-5 pair cover opposite errors and
  // neither is sufficient alone: this one reds when the merge pass is handed a
  // gate that is too STRICT (uniform requested), that one reds when it is
  // handed one that is too PERMISSIVE (uniform at the relaxed floor, the
  // pre-#452 hazard).
  it('#452 graft 5: the merge pass re-validates against the field, not a uniform gate', () => {
    const mask = corridorGapMask(25);
    const r = planRoute(
      { ...reqNearApproach, origin: { lat: 54.7525, lon: 9.4275 } }, // col 5
      uniformWindGrid(12, 0),
      depsWith(mask),
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const legs = sailResult(r, 'genoa')!.legs;
    // One span for the whole passage: every collinear leg merged, across the
    // gap included. Handed a uniform 3.0 m gate the merge across the gap is
    // rejected and this splits.
    expect(legs.length).toBe(1);
    // ...and that single span really does cross the sub-requested water, so
    // the merge above was gate-relevant rather than merely unobstructed.
    const GAP_W = 9.4 + 160 * 0.005;
    const GAP_E = 9.4 + 161 * 0.005;
    const leg = legs[0];
    expect(Math.min(leg.start.lon, leg.end.lon)).toBeLessThan(GAP_W);
    expect(Math.max(leg.start.lon, leg.end.lon)).toBeGreaterThan(GAP_E);
    expect(leg.shallow?.minDepthM).toBeCloseTo(2.5, 6);
    // The merged span is NOT navigable at the requested depth — the disc is
    // the only thing licensing it.
    expect(mask.segmentNavigable(leg.start, leg.end, uniformGate(3.0))).toBe(false);
  });

  it('a plan that never relaxed carries no shallow fields at all (omitted, not undefined)', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), depsWith(openWaterMask()));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect('shallow' in r).toBe(false);
    for (const leg of sailResult(r, 'genoa')!.legs) expect('shallow' in leg).toBe(false);
  });

  it('calm + motor off keeps its own error class — relaxation never fires', () => {
    const probes: ProbeInfo[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute(
      { ...req, settings },
      uniformWindGrid(0, 0),
      depsWith(openWaterMask()),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'calm-motor-off' });
    expect(probes).toEqual([]);
  });

  it('beyond-horizon keeps its own error class — relaxation never fires', () => {
    const probes: ProbeInfo[] = [];
    // Grid hours 06..08 UTC; departure 08:00 → the very first step would
    // already overrun the horizon.
    const r = planRoute(
      req,
      uniformWindGrid(12, 0, { hours: 3 }),
      depsWith(openWaterMask()),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'beyond-horizon' });
    expect(probes).toEqual([]);
  });

  it('propagates the relaxed solve reason: disconnected at requested, but beyond-horizon at the relaxed gate (#68)', () => {
    const probes: ProbeInfo[] = [];
    // Gap charted 2.5 m: DISCONNECTED at the requested 3.0 m gate, so the
    // connected-mask fast path is skipped and classification starts
    // 'unreachable'; CONNECTED at 2.5 m, so relaxation runs the solver once per
    // rig at that gate. The 3-hour grid (06..08 UTC) with an 08:00 departure
    // overruns the forecast horizon on the very first step, so BOTH relaxed
    // solves fail 'beyond-horizon'. Because relaxation DID find a connected
    // gate, the failure is no longer mask-level: the plan-level reason must
    // propagate the actionable 'beyond-horizon', not the stale 'unreachable'.
    // (Before #68 this returned 'unreachable' — the relaxed class was dropped.)
    const r = planRoute(
      reqNearApproach,
      uniformWindGrid(12, 0, { hours: 3 }),
      depsWith(corridorGapMask(25)),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'beyond-horizon' });
    // Relaxation actually ran: the same hand-derived two-phase sequence as
    // the successful case above (it depends only on the mask and the
    // waypoints, never on the wind, so the short forecast cannot move it).
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.7, 2.6, 2.7, 2.8, 2.9, 2.7, 2.6]);
  });

  // #54 review round 2: the same relaxed-solve propagation with ONE requested
  // sail. These are the only cases that reach the fold's CALL SITES at a
  // length the pre-#54-fix positional read (`combineFailureCause(tier[0].cause,
  // tier[1].cause)`) cannot survive — `tier[1]` is undefined there, so the
  // fold throws before any reason can be returned.
  //
  // There are TWO such folds and they sit on different branches, so one row
  // cannot cover both: the depth-comfort preference decides which. At the
  // DEFAULT margin the preference is active and both relaxed tiers run, so
  // the tier-4 fold reports; with the margin at 0 the preference is off
  // (planRoute.ts's `comfortDepthM` is then undefined), tier 4 never runs
  // and the tier-3 fold reports instead.
  it.each([
    ['tier 4 (comfort preference on)', DEFAULT_SETTINGS.depthComfortMarginM],
    ['tier 3 (comfort preference off)', 0],
  ])(
    '#54: propagates the relaxed solve reason with a single requested sail — %s',
    (_name, depthComfortMarginM) => {
      const settings: Settings = { ...DEFAULT_SETTINGS, depthComfortMarginM };
      const r = planRoute(
        { ...reqNearApproach, settings, sailIds: ['genoa'] },
        uniformWindGrid(12, 0, { hours: 3 }),
        depsWith(corridorGapMask(25)),
      );
      expect(r).toEqual({ status: 'error', reason: 'beyond-horizon' });
    },
  );

  // #452's headline claim, asserted at planRoute level: a pinch far from
  // every waypoint is NOT relaxed, so a plan that used to degrade gracefully
  // through it now honestly reports unreachable.
  //
  // This is the SAME mask and the SAME 2.5 m gap as the first case in this
  // file — only the destination differs (col 200, ~12.8 km from the wall,
  // versus col 165 at ~1.6 km). Before #452 this input returned status 'ok'
  // with shallow { usedDepthM: 2.5 }; the pair is therefore a direct
  // before/after on the one behaviour P3 changes.
  it('#452: a pinch outside every approach disc is NOT relaxed — the plan reports unreachable', () => {
    const probes: ProbeInfo[] = [];
    const r = planRoute(
      req,
      uniformWindGrid(12, 0),
      depsWith(corridorGapMask(25)),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'unreachable' });
    // Hand-derived: every gap cell sits outside both discs, so every cell in
    // the wall is gated at the requested 3.0 m and no candidate connects.
    // The descent is the same one a genuinely blocked mask produces — mid 25
    // fails (hi=24), mid 22 fails (hi=21), mid 21 fails (hi=20) → null.
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.2, 2.1]);
  });

  it('a genuinely unreachable destination still errors unreachable after the probe descent', () => {
    const probes: ProbeInfo[] = [];
    // Gap charted 1.5 m — below every candidate gate, nothing connects.
    const r = planRoute(
      req,
      uniformWindGrid(12, 0),
      depsWith(corridorGapMask(15)),
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'unreachable' });
    // Hand-derived failing descent: 2.5, 2.2, 2.1 → null.
    expect(probes.map((p) => p.probeDepthM)).toEqual([2.5, 2.2, 2.1]);
  });

  it('requested depth at the boat draft floor never relaxes', () => {
    const probes: ProbeInfo[] = [];
    const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 2.1 };
    const r = planRoute(
      { ...req, settings },
      uniformWindGrid(12, 0),
      depsWith(corridorGapMask(19)), // 1.9 m gap: blocked even at 2.1
      undefined,
      (p) => probes.push(p),
    );
    expect(r).toEqual({ status: 'error', reason: 'unreachable' });
    expect(probes).toEqual([]);
  });
});
