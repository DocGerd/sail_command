import { describe, expect, it, vi } from 'vitest';
import { compareRigs, planRoute, RIG_TIE_BAND_MS } from './planRoute';
import {
  openWaterMask,
  TEST_POLAR,
  testPlanDeps,
  uniformWindGrid,
  makeMask,
} from '../test/fixtures';
import {
  DEFAULT_SETTINGS,
  type Leg,
  type PlanRequest,
  type PlanResultOk,
  type PolarTable,
  type RigResult,
  type SailId,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { defaultBoatSnapshot } from '../types';
import { polarKey } from '../data/boats';

// #54: the pre-#54 shape exposed `r.genoa`/`r.fock`/`r.genoaReason`/
// `r.fockReason` directly.
function sailResult(res: PlanResultOk, sailId: SailId) {
  return res.sails.find((s) => s.sailId === sailId)?.result ?? null;
}
function sailReason(res: PlanResultOk, sailId: SailId) {
  return res.sails.find((s) => s.sailId === sailId)?.reason ?? null;
}

// Solver-heavy file: on 2026-07-15 this file ran 32.6-42.8 s in CI across five
// runs (max in run 29411103146); locally it is a small fraction of that. Fast
// test files keep vitest's 5s default so hang detection stays meaningful there.
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
  sailIds: ['genoa', 'fock'],
  boat: defaultBoatSnapshot(),
};
const deps = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: SLOW_FOCK });

describe('planRoute', () => {
  // #54: `deps.polars` is a plain Record, so a key the caller never supplied
  // reads as `undefined`. Deleting the guard does NOT make this pass — `new
  // Polar(undefined)` throws a TypeError on `table.rig` — so what this row
  // pins is the DIAGNOSTIC, not the existence of a failure: which key was
  // missing, reported at the lookup instead of inside the solver.
  it('throws NAMING the missing key when deps.polars has no table for a requested sail', () => {
    const partial = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: SLOW_FOCK });
    delete (partial.polars as Record<string, PolarTable>)['salona-45/fock'];
    expect(() => planRoute({ ...req, sailIds: ['fock'] }, uniformWindGrid(12, 0), partial)).toThrow(
      '#54: no polar table for salona-45/fock',
    );
  });

  // #601: `Object.hasOwn`, not a bare `!== undefined` chain lookup, is what
  // makes `polarFor`'s guard (planRoute.ts, ~:379) correct against a polars
  // map that is an ordinary object literal (the shape `app/sweep/sweepArms.ts`
  // and `app/src/test/fixtures.ts`'s `testPlanDeps` both build, per the
  // corrected comment above `polarFor`) — `in` and a bare property read both
  // walk the PROTOTYPE CHAIN, and every `Object.getOwnPropertyNames
  // (Object.prototype)` member passes a bare `!== undefined` check (#614's
  // precedent bug in this exact shape). Derived from
  // `Object.getOwnPropertyNames`, never a hand-written list — a hand-written
  // 8 previously missed `__defineGetter__`/`__defineSetter__`/
  // `__lookupGetter__`/`__lookupSetter__` — and asserted non-empty so a
  // stubbed-to-`[]` table cannot make this pass vacuously.
  it('#601: every Object.prototype own-property name reads as ABSENT from an ordinary polars map under Object.hasOwn, though NOT under a bare `!== undefined` check', () => {
    const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);
    expect(PROTOTYPE_NAMES.length).toBeGreaterThan(0);
    const polars: Record<string, PolarTable> = {};
    for (const name of PROTOTYPE_NAMES) {
      // The vulnerability class #601 hardens against: a bare `!== undefined`
      // lookup resolves the INHERITED Object.prototype member and reads it
      // as "present" even though `name` was never set as an own key.
      expect((polars as Record<string, unknown>)[name]).not.toBeUndefined();
      // `Object.hasOwn` — what `polarFor`'s guard actually uses — correctly
      // reports it absent.
      expect(Object.hasOwn(polars, name)).toBe(false);
    }
  });

  // #601, mutation-checkable against the REAL `planRoute.ts` guard (not a
  // copy of its logic): every real lookup key is `polarKey(boatId, sailId)`
  // = `${boatId}/${sailId}`, which always contains a literal "/" and so can
  // never equal a bare Object.prototype member name (none of those 12 names
  // contain "/") — the reachability argument that avoided a #282 sweep for
  // this change. This test instead poisons the polars map's PROTOTYPE (not
  // its own keys) with an entry at the REAL computed key, which a plain
  // object literal built by ANY caller (protocol.ts uses Object.create(null)
  // and is immune; the sweep harness and test fixtures do not) can carry.
  // Reverting `polarFor`'s `Object.hasOwn` check back to a bare
  // `!== undefined` makes this test go RED: the guard would then silently
  // accept the inherited, wrong table instead of throwing.
  it('#601: a polars map whose PROTOTYPE carries the requested key is still rejected — Object.hasOwn, not a chain lookup', () => {
    const key = polarKey(deps.boat.id, 'fock');
    const poisonedPolars = Object.create({ [key]: SLOW_FOCK }) as Record<string, PolarTable>;
    // Sanity: the malicious table IS reachable via a bare `!== undefined`
    // chain lookup — that is the vulnerability class this guards against.
    expect(poisonedPolars[key]).toBe(SLOW_FOCK);
    expect(Object.hasOwn(poisonedPolars, key)).toBe(false);
    const poisoned = { ...deps, polars: poisonedPolars };
    expect(() =>
      planRoute({ ...req, sailIds: ['fock'] }, uniformWindGrid(12, 0), poisoned),
    ).toThrow(`#54: no polar table for ${key}`);
  });

  // #54 review: an EMPTY sailIds makes `runAll` return [], and the plan-level
  // cause used to be read off `tier1[0].cause!` — a bare TypeError inside the
  // worker, forwarded as `worker-fatal` and shown as the generic
  // 'error.routingFailed' banner with nothing naming the stored record.
  // `[]` is neither nullish nor falsy, so none of the `?? DEFAULT_SAIL_IDS`
  // backfills on the way in catches it; services/migratePlan.ts now rebuilds
  // an empty stored list, and this pins the solver's own degradation.
  //
  // The mask is OPEN WATER, so this cannot be passing because the route is
  // genuinely blocked — with a non-empty sailIds the same request plans
  // successfully (the row below).
  it('#54: an empty sailIds degrades to a typed no-route instead of throwing', () => {
    const r = planRoute({ ...req, sailIds: [] }, uniformWindGrid(12, 0), deps);
    expect(r.status).toBe('error');
  });

  it('runs both rigs and recommends the faster one', () => {
    const r = planRoute(req, uniformWindGrid(12, 0), deps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const genoa = sailResult(r, 'genoa');
    const fock = sailResult(r, 'fock');
    expect(genoa).not.toBeNull();
    expect(fock).not.toBeNull();
    expect(r.recommended).toBe('genoa');
    // #259: SLOW_FOCK is 12% slower — a multi-minute gap on an hours-long
    // passage, decisively outside the 60 s tie band.
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
    expect(genoa!.etaMs).toBeLessThanOrEqual(fock!.etaMs);
    expect(genoa!.maneuverCount).toBe(genoa!.legs.filter((l) => l.maneuverAtStart).length);
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

  // #340/#54 NAMED COUPLING guard: PlannerPanel.tsx's "sail N of 2" phase
  // readout numbers sails using `request.sailIds` itself (types.ts;
  // §E.3 deleted the old RIG_ORDER module constant), which only carries the
  // router's REAL solve order if `runAll` (planRoute.ts) genuinely evaluates
  // the request's sails in the order given. Unlike the count-only 'reports
  // progress per rig' test above (a Set, order-blind by construction), this
  // records the ORDER sails are FIRST seen in — from a real (small) solve,
  // not from reading the source — and pins it against `request.sailIds`,
  // reversed so the test is non-vacuous (under the old module constant this
  // would still report `['genoa', 'fock']` regardless of the request).
  it('#340/#54: solve order matches request.sailIds', () => {
    const seen: SailId[] = [];
    // NOTE the argument order — planRoute takes (request, windGrid, deps, onProgress).
    planRoute({ ...req, sailIds: ['fock', 'genoa'] }, uniformWindGrid(12, 0), deps, (sailId) => {
      if (!seen.includes(sailId)) seen.push(sailId);
    });
    expect(seen).toEqual(['fock', 'genoa']); // reversed order must be honoured
  });

  it('recommends genoa on an exact ETA tie between rigs, but reports the comparison as a tie (#259)', () => {
    // identical polar table → identical solve
    const tieDeps = testPlanDeps(deps.mask, { genoa: TEST_POLAR, fock: TEST_POLAR });
    const r = planRoute(req, uniformWindGrid(12, 0), tieDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(sailResult(r, 'genoa')!.etaMs).toBe(sailResult(r, 'fock')!.etaMs);
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
    const genoa = sailResult(r, 'genoa')!;
    const fock = sailResult(r, 'fock')!;
    expect(genoa.legs.length).toBeGreaterThan(0);
    expect(genoa.legs.every((l) => l.kind === 'motor')).toBe(true);
    expect(fock.legs.every((l) => l.kind === 'motor')).toBe(true);
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
    const calmDeps = testPlanDeps(deps.mask, { genoa: TEST_POLAR, fock: calmFock });
    const settings = { ...DEFAULT_SETTINGS, motorEnabled: false };
    const r = planRoute({ ...req, settings }, uniformWindGrid(12, 0), calmDeps);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(sailResult(r, 'genoa')).not.toBeNull();
    expect(sailReason(r, 'genoa')).toBeNull();
    expect(sailResult(r, 'fock')).toBeNull();
    expect(sailReason(r, 'fock')).toBe('calm-motor-off');
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
  //
  // #54: `sailId` is now a real parameter (default 'genoa') rather than a
  // hardcoded literal — compareRigs derives its `decided` winner's identity
  // from the RigResult's OWN sailId (byte-identical for every real caller,
  // since planRoute always hands it the sail actually solved), no longer
  // from argument POSITION. Callers that need a specific identity for the
  // returned winner pass it explicitly.
  const makeResult = (etaMs: number, sailId: SailId = 'genoa'): RigResult => ({
    sailId,
    etaMs,
    durationMs: etaMs,
    distanceNm: 10,
    maneuverCount: 0,
    motorDistanceNm: 0,
    legs: [sailLeg(etaMs)],
  });

  const makeMotorResult = (etaMs: number, sailId: SailId = 'genoa'): RigResult => ({
    sailId,
    etaMs,
    durationMs: etaMs,
    distanceNm: 10,
    maneuverCount: 0,
    motorDistanceNm: 10,
    legs: [motorLeg(etaMs)],
  });

  // Mixed: one sail leg + one motor leg, so isAllMotor is false — distinct
  // from both makeResult (all-sail) and makeMotorResult (all-motor).
  const makeMixedResult = (etaMs: number, sailId: SailId = 'genoa'): RigResult => ({
    sailId,
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
    expect(compareRigs(makeResult(61_000), makeResult(0, 'fock'))).toEqual({
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
    const mixed = makeMixedResult(0); // sailId 'genoa' (default)
    const motoring = makeMotorResult(10 * 60_000, 'fock');
    expect(compareRigs(mixed, motoring)).toEqual({ kind: 'decided', rig: 'genoa' });
    // #54: compareRigs now derives the winner's identity from the RigResult
    // itself, not argument position — `mixed` (sailId 'genoa') is still the
    // genuinely faster result in this call too (600_000 ms vs 0 ms), so it
    // wins again under its OWN identity regardless of which position it's
    // passed in. This is the same real property the pre-#54 positional
    // version could not express: swapping the two arguments here still
    // reds under both mutations the comment above names (`.some` instead of
    // `.every`; dropping the `isAllMotor(fock)` conjunct) — only the
    // expected identity label changed, not what the assertion catches.
    expect(compareRigs(motoring, mixed)).toEqual({ kind: 'decided', rig: 'genoa' });
  });
});
