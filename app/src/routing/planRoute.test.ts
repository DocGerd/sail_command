import { describe, expect, it, vi } from 'vitest';
import { compareRigs, planRoute, RIG_TIE_BAND_MS } from './planRoute';
import { openWaterMask, TEST_POLAR, uniformWindGrid, makeMask } from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Leg,
  type PlanRequest,
  type PolarTable,
  type RigResult,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

/** Fock fixture: uniformly 12% slower than TEST_POLAR (genoa must win). */
const SLOW_FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

const req: PlanRequest = {
  origin: { lat: 54.7525, lon: 10.0025 },
  destination: { lat: 54.7525, lon: 10.4025 },
  viaPoints: [],
  originHarborId: null,
  destinationHarborId: null,
  departureMs: Date.UTC(2026, 6, 15, 8, 0, 0),
  settings: DEFAULT_SETTINGS,
};
const deps = { polarGenoa: TEST_POLAR, polarFock: SLOW_FOCK, mask: openWaterMask() };

describe('planRoute', () => {
  it('runs both rigs and recommends the faster one', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa).not.toBeNull();
    expect(r.fock).not.toBeNull();
    expect(r.recommended).toBe('genoa');
    // #259: SLOW_FOCK is 12% slower — a multi-minute gap on an hours-long
    // passage, decisively outside the 60 s tie band.
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
    expect(r.genoa!.etaMs).toBeLessThanOrEqual(r.fock!.etaMs);
    expect(r.genoa!.maneuverCount).toBe(r.genoa!.legs.filter((l) => l.maneuverAtStart).length);
  });

  it('snaps origin off land and reports snapped coordinates', () => {
    // land west of col 162 (lon ≈ 10.21); origin on land near the edge
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute(
      {
        ...req,
        origin: { lat: 54.7525, lon: 10.2095 },
        destination: { lat: 54.7525, lon: 10.6025 },
      },
      uniformWindGrid(12, 0),
      { ...deps, mask },
    );
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.snappedOrigin.lon).toBeGreaterThan(10.2095);
    expect(mask.isNavigable(r.snappedOrigin, DEFAULT_SETTINGS.safetyDepthM)).toBe(true);
  });

  it('fails with snap-failed-origin when origin is deep inland', () => {
    const mask = makeMask((_, c) => (c < 162 ? 0 : 200));
    const r = planRoute({ ...req, origin: { lat: 54.75, lon: 9.6 } }, uniformWindGrid(12, 0), {
      ...deps,
      mask,
    });
    expect(r).toEqual({ status: 'error', reason: 'snap-failed-origin' });
  });

  it('reports progress per rig', () => {
    const seen = new Set<string>();
    planRoute(req, uniformWindGrid(12, 0), deps, (rig) => seen.add(rig));
    expect(seen).toEqual(new Set(['genoa', 'fock']));
  });

  it('recommends genoa on an exact ETA tie between rigs, but reports the comparison as a tie (#259)', () => {
    const tieDeps = { ...deps, polarFock: TEST_POLAR }; // identical polar table → identical solve
    const r = planRoute(req, uniformWindGrid(12, 0), tieDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa!.etaMs).toBe(r.fock!.etaMs);
    // `recommended` keeps resolving to a concrete rig for non-badge consumers
    // (tab-seeding, saved-plan chip) — unchanged pre-#259 behavior.
    expect(r.recommended).toBe('genoa');
    // The honest comparison must NOT badge either rig as recommended: a 0 ms
    // gap is (trivially) inside the 60 s tie band.
    expect(r.rigRecommendation).toEqual({ kind: 'tie' });
  });

  it('reports the comparison as moot when both rigs sail entirely under motor (#259)', () => {
    // Calm wind (TWS 0): Polar.speedKn returns exactly 0 for twsKn <= 0, well
    // below the sail-speed floor at any settings, so every candidate heading
    // motors on BOTH rigs (motorEnabled defaults true) — the polar never
    // drives a single leg, regardless of the two rigs' differing tables.
    const r = planRoute(req, uniformWindGrid(0, 0), deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa!.legs.length).toBeGreaterThan(0);
    expect(r.genoa!.legs.every((l) => l.kind === 'motor')).toBe(true);
    expect(r.fock!.legs.every((l) => l.kind === 'motor')).toBe(true);
    expect(r.rigRecommendation).toEqual({ kind: 'moot' });
  });

  it('a single-rig failure surfaces that rig no-route reason; the surviving rig reason stays null', () => {
    // Fock's polar is scaled far below MIN_SAIL_KN at any realistic TWS, so with
    // the motor disabled it can never produce a sailing candidate — calm-motor-off —
    // while genoa's normal polar still solves fine in the same 12 kn wind.
    const calmFock: PolarTable = {
      ...TEST_POLAR,
      rig: 'fock',
      speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.01)),
    };
    const calmDeps = { ...deps, polarFock: calmFock };
    const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute({ ...req, settings }, uniformWindGrid(12, 0), calmDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.genoa).not.toBeNull();
    expect(r.genoaReason).toBeNull();
    expect(r.fock).toBeNull();
    expect(r.fockReason).toBe('calm-motor-off');
  });
});

describe('compareRigs (#259 tie band)', () => {
  const sailLeg = (etaMs: number): Leg => ({
    kind: 'sail',
    board: 'starboard',
    start: { lat: 54.75, lon: 10.0 },
    end: { lat: 54.75, lon: 10.2 },
    startTimeMs: 0,
    endTimeMs: etaMs,
    headingDeg: 90,
    twaDeg: 90,
    twsKn: 10,
    speedKn: 5,
    distanceNm: 10,
    maneuverAtStart: null,
  });

  const motorLeg = (etaMs: number): Leg => ({
    kind: 'motor',
    board: null,
    start: { lat: 54.75, lon: 10.0 },
    end: { lat: 54.75, lon: 10.2 },
    startTimeMs: 0,
    endTimeMs: etaMs,
    headingDeg: 90,
    twsKn: 0,
    speedKn: 6.5,
    distanceNm: 10,
    maneuverAtStart: null,
  });

  // Minimal single-leg all-sail RigResults so isAllMotor is false for both —
  // these pins are about the ETA-gap boundary, not the moot path (covered
  // below via a real solve and via makeMotorResult).
  const makeResult = (etaMs: number): RigResult => ({
    rig: 'genoa',
    etaMs,
    durationMs: etaMs,
    distanceNm: 10,
    maneuverCount: 0,
    motorDistanceNm: 0,
    legs: [sailLeg(etaMs)],
  });

  const makeMotorResult = (etaMs: number): RigResult => ({
    rig: 'genoa',
    etaMs,
    durationMs: etaMs,
    distanceNm: 10,
    maneuverCount: 0,
    motorDistanceNm: 10,
    legs: [motorLeg(etaMs)],
  });

  // Mixed: one sail leg + one motor leg, so isAllMotor is false — distinct
  // from both makeResult (all-sail) and makeMotorResult (all-motor).
  const makeMixedResult = (etaMs: number): RigResult => ({
    rig: 'genoa',
    etaMs,
    durationMs: etaMs,
    distanceNm: 20,
    maneuverCount: 0,
    motorDistanceNm: 10,
    legs: [sailLeg(etaMs / 2), motorLeg(etaMs)],
  });

  it('exposes the tie band as a 60 s named constant', () => {
    expect(RIG_TIE_BAND_MS).toBe(60_000);
  });

  it('classifies a 59 s gap as a tie (hand-picked: 1 s inside the 60 s band)', () => {
    expect(compareRigs(makeResult(0), makeResult(59_000))).toEqual({ kind: 'tie' });
  });

  it('classifies a 61 s gap as decided (hand-picked: 1 s outside the 60 s band)', () => {
    expect(compareRigs(makeResult(0), makeResult(61_000))).toEqual({
      kind: 'decided',
      rig: 'genoa',
    });
  });

  // #275 review, Minor 4: the boundary suite above brackets the edge (59 s /
  // 61 s) but never lands on it. The band is exclusive (`<`, not `<=`), so a
  // gap of exactly RIG_TIE_BAND_MS must be decided, not a tie. Deriving the
  // argument from the exported constant is not the function-under-test
  // tautology the repo rejects: the constant's own VALUE is pinned
  // independently above (`toBe(60_000)`); this test pins the BOUNDARY
  // BEHAVIOUR (< vs <=), a different fact that mutating `<` to `<=` flips.
  it('a gap of exactly RIG_TIE_BAND_MS is decided (the band is exclusive)', () => {
    expect(compareRigs(makeResult(0), makeResult(RIG_TIE_BAND_MS))).toEqual({
      kind: 'decided',
      rig: 'genoa',
    });
  });

  it('picks fock when fock is the faster (lower etaMs) rig outside the band', () => {
    expect(compareRigs(makeResult(61_000), makeResult(0))).toEqual({
      kind: 'decided',
      rig: 'fock',
    });
  });

  // #275 review, Minor 3: this test pins that an all-motor pair 10 minutes
  // apart still classifies as moot, not decided — a real property (moot
  // outranks a large ETA gap). It does NOT, on its own, prove moot is
  // checked BEFORE tie: with the two checks swapped, a 600 000 ms gap still
  // fails the (now-first) tie check and falls through to the (now-second)
  // moot check, which still returns moot — so this test stays green under
  // that mutation. The TWS-0 full-solve moot test above is what actually
  // pins the check ORDER: its 0 ms gap makes both checks fire, so swapping
  // them turns its result into `{ kind: 'tie' }` and reds the suite.
  it('classifies an all-motor comparison as moot even with a large ETA gap (moot outranks a decided gap)', () => {
    expect(compareRigs(makeMotorResult(0), makeMotorResult(10 * 60_000))).toEqual({
      kind: 'moot',
    });
  });

  // #275 review, MAJOR: a MIXED sail+motor result must not be classified
  // moot just because the OTHER rig happens to be all-motor — isAllMotor
  // must be checked (via `.every`, not `.some`) on BOTH rigs (the `&&`, not
  // just the first operand). Both assertions are load-bearing: the first
  // kills `legs.every(...)` mutated to `legs.some(...)` (a mixed result would
  // then read as "some leg is motor" -> true -> falsely all-motor); the
  // second kills dropping the `isAllMotor(fock)` conjunct (checking only
  // genoa would let an all-motor fock alone force `moot`). Without this, a
  // route that motors out of harbour and then sails the rest would render
  // "rig does not matter" — confidently wrong, not merely unqualified.
  it('a MIXED sail+motor result is not moot, even paired against an all-motor rig', () => {
    const mixed = makeMixedResult(0);
    const motoring = makeMotorResult(10 * 60_000);
    expect(compareRigs(mixed, motoring)).toEqual({ kind: 'decided', rig: 'genoa' });
    expect(compareRigs(motoring, mixed)).toEqual({ kind: 'decided', rig: 'fock' });
  });
});
