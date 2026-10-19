import { describe, expect, it, vi } from 'vitest';
import { planRoute, type PlanDeps } from './planRoute';
import { openWaterMask, TEST_POLAR, testPlanDeps, uniformWindGrid } from '../test/fixtures';
import { boatById, MAX_HEADSAILS, polarKey, type BoatDef, type PolarTier } from '../data/boats';
import {
  DEFAULT_SETTINGS,
  boatSnapshot,
  defaultBoatSnapshot,
  type PlanRequest,
  type PlanResultOk,
  type PolarTable,
  type SailId,
} from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';

// Solver-heavy file: every row below runs a real isochrone solve against the
// open-water fixture mask. Imported from test/timeouts.ts rather than
// hardcoded, per #342 — test/timeoutGuard.test.ts fails the build on a literal.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

/**
 * #553 / spec §N.4 — `RigRecommendation.kind === 'not-compared'`.
 *
 * WHAT THIS FILE GUARDS, stated as the hazard rather than as the fix: before
 * this change `assemble` stamped `{ kind: 'decided' }` on EVERY path that did
 * not call `compareRigs`, so an unmade comparison was reported as a verdict.
 * Two cases reach that path — N = 1 and two-sails-one-solved, which is
 * reachable in production TODAY. A third is a requested sail the boat does
 * not declare (fail closed). N >= 3 throws before `assemble`. Spec §T.2 retired the provenance-tier clause: an
 * estimated sail no longer withholds the comparison, and the rows below pin
 * that for every tier mix.
 *
 * Nothing in the pre-existing suite could see any of this: 354 tests across
 * planRoute / resultSummary / RouteSummary / PlannerPanel / migratePlan /
 * workerClient / protocol passed unchanged with the semantics flipped
 * (measured on this branch before these rows were written). In particular
 * `planRoute.test.ts`'s "a single-rig failure surfaces that rig no-route
 * reason" already constructs the two-sails-one-solved state and asserts only
 * the per-sail `reason`s — it never looks at `rigRecommendation`.
 *
 * The `not-compared` rows red under different mutations, and the DECIDES and
 * CONTROL rows are what stop the whole file from being satisfiable by a
 * `return { kind: 'not-compared' }` that never compares anything.
 */

/** Uniformly 12% slower than TEST_POLAR, so `compareRigs` decides rather than ties. */
const SLOW: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.88)),
};

/** A third table, distinct again, for the N >= 3 row. */
const SLOWER: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.8)),
};

const BASE_REQ: PlanRequest = {
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

/**
 * A catalogue-shaped `BoatDef` built here rather than taken from BOATS, so the
 * PROVENANCE TIER and the SAIL COUNT are free variables. Everything else —
 * `draftM` above all, which drives the spec §C.4(a) relaxation floor — is held
 * at the Salona 45's values, so a row that differs only in tier differs ONLY
 * in tier and the comparison between two rows is a comparison of one variable.
 */
function boatWith(tier: PolarTier, sailIds: readonly string[]): BoatDef {
  return {
    id: 'probe-45',
    name: 'Probe 45',
    draftM: 2.1,
    // Required on BoatDef since #563. Held at the Salona 45's shape so this
    // fixture differs from the catalogue boat in POLAR provenance only —
    // draft provenance is not what any row here is about.
    draftProvenance: {
      keel: 'standard',
      hullVerified: true,
      note: 'test fixture — not a real hull',
    },
    motorSpeedKn: 6.5,
    maneuverPenaltyS: 45,
    sails: sailIds.map((id) => ({
      id,
      label: `Probe ${id}`,
      polarAsset: `data/polars/probe-45-${id}.json`,
      polarProvenance: { tier, note: `test fixture — ${tier}` },
    })),
  };
}

/** PlanDeps for `boatWith(...)`, keyed the way `polarFor` looks tables up. */
function depsFor(boat: BoatDef, tables: Readonly<Record<string, PolarTable>>): PlanDeps {
  const polars: Record<string, PolarTable> = {};
  for (const [sailId, table] of Object.entries(tables)) {
    polars[polarKey(boat.id, sailId)] = table;
  }
  return { polars, boat, mask: openWaterMask() };
}

function ok(r: ReturnType<typeof planRoute>): PlanResultOk {
  expect(r.status).toBe('ok');
  if (r.status !== 'ok') throw new Error(`expected status ok, got ${r.status}`);
  return r;
}

/** Every `not-compared` row also re-checks this — see the invariant row below. */
function recommendedHasResult(r: PlanResultOk): boolean {
  return r.sails.some((s) => s.sailId === r.recommended && s.result !== null);
}

describe('#553 assemble: not-compared', () => {
  // CONTROL 1. The comparison path still runs and still produces a VERDICT on
  // an ordinary tier-A/B two-sail boat. Load-bearing in a way the four rows
  // below are not: without it, a blanket `{ kind: 'not-compared' }` returned
  // unconditionally from `assemble` would satisfy every other assertion in
  // this file. It is the only row here that can fail on over-suppression.
  it('CONTROL: two sails on a certificate-tier boat still DECIDE', () => {
    const deps = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute(BASE_REQ, uniformWindGrid(12, 0), deps));
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });

  // Reachable in production TODAY, unlike the other three: two sails were
  // requested, both searches FINISHED, and one of them found no route. There
  // is exactly one ETA, so there was nothing to compare it against — but the
  // pre-#553 code answered `{ kind: 'decided', rig: 'genoa' }`, i.e. "genoa is
  // faster", on the strength of fock having failed.
  it('two sails requested, only one solves -> not-compared', () => {
    // Scaled far below MIN_SAIL_KN so fock can never produce a sailing
    // candidate; with the motor disabled that is a finished search returning
    // calm-motor-off, NOT an aborted one (which would be a partial result).
    const calmFock: PolarTable = {
      ...TEST_POLAR,
      rig: 'fock',
      speeds: TEST_POLAR.speeds.map((row) => row.map((v) => v * 0.01)),
    };
    const deps = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: calmFock });
    const r = ok(
      planRoute(
        { ...BASE_REQ, settings: { ...DEFAULT_SETTINGS, motorEnabled: false } },
        uniformWindGrid(12, 0),
        deps,
      ),
    );
    // Guard the row's own premise: if BOTH solved, or NEITHER, this row would
    // be testing something else entirely and its green would be vacuous.
    expect(r.sails.filter((s) => s.result !== null).map((s) => s.sailId)).toEqual(['genoa']);
    expect(r.rigRecommendation).toEqual({ kind: 'not-compared' });
    // The surviving sail is still named, so tab seeding and the PlansList chip
    // keep working — declining to RANK is not declining to pick a default.
    expect(r.recommended).toBe('genoa');
    expect(recommendedHasResult(r)).toBe(true);
  });

  it('one sail requested -> not-compared', () => {
    const deps = testPlanDeps(openWaterMask(), { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute({ ...BASE_REQ, sailIds: ['genoa'] }, uniformWindGrid(12, 0), deps));
    expect(r.sails).toHaveLength(1);
    expect(r.rigRecommendation).toEqual({ kind: 'not-compared' });
    expect(r.recommended).toBe('genoa');
  });

  // The cap is 2 (spec §J OQ-3, §R D11). Beyond it `planRoute` throws rather
  // than invent a verdict: no N-way ranking is defined (§R.4 is design only),
  // and a third solve does not fit `PLAN_BUDGET_MS` (§R.6). The pre-#553 code
  // stamped `decided` on whichever sail came first; the pre-#1661 code solved
  // all three and returned `not-compared`.
  it('more than MAX_HEADSAILS sails requested -> throws, no N-way ranking is invented', () => {
    const boat = boatWith('certificate', ['genoa', 'fock', 'storm']);
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW, storm: SLOWER });
    const req = { ...BASE_REQ, sailIds: ['genoa', 'fock', 'storm'] as readonly SailId[] };
    expect(() => planRoute(req, uniformWindGrid(12, 0), deps)).toThrow(
      `#1661: 3 headsails requested, MAX_HEADSAILS is ${MAX_HEADSAILS}`,
    );
  });

  it('exactly MAX_HEADSAILS sails does not throw', () => {
    const boat = boatWith('certificate', ['genoa', 'fock']);
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute(BASE_REQ, uniformWindGrid(12, 0), deps));
    expect(BASE_REQ.sailIds).toHaveLength(MAX_HEADSAILS);
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });

  // Spec §T.2: the comparison runs for an estimated pair. Paired with the
  // control below it: the two rows differ in EXACTLY ONE input (the tier).
  it('tier-C boat, both sails solve -> DECIDES (spec T.2)', () => {
    const boat = boatWith('estimated', ['genoa', 'fock']);
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute(BASE_REQ, uniformWindGrid(12, 0), deps));
    expect(r.sails.filter((s) => s.result !== null)).toHaveLength(2);
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
    expect(r.recommended).toBe('genoa');
  });

  // CONTROL 2 for the row above — same boat shape, same tables, tier flipped.
  it('CONTROL: the SAME boat at modelled tier decides identically', () => {
    const boat = boatWith('modelled', ['genoa', 'fock']);
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute(BASE_REQ, uniformWindGrid(12, 0), deps));
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });

  // Spec §T.8.1: the three shipped estimate-based boats. SLOW is 12% below
  // TEST_POLAR in every cell, so the faster table's sail wins wherever it
  // sits, and two identical tables are inside the tie band by construction.
  describe.each(['salona-44-speedy-go', 'elan-444-piranja', 'salona-44-easy-go'] as const)(
    '#1716: %s',
    (boatId) => {
      const boat = boatById(boatId);
      const first: SailId = 'genoa';
      const second: SailId = 'fock';
      const req: PlanRequest = {
        ...BASE_REQ,
        boat: boatSnapshot(boat),
        sailIds: [first, second],
      };
      const solve = (a: PolarTable, b: PolarTable) =>
        ok(planRoute(req, uniformWindGrid(12, 0), depsFor(boat, { [first]: a, [second]: b })));

      it('decides the second sail when its table is faster', () => {
        const r = solve(SLOW, TEST_POLAR);
        expect(r.comparisonComplete).toBe(true);
        expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: second });
        expect(r.recommended).toBe(second);
      });

      it('ties on identical tables and recommends the first-solved sail', () => {
        const r = solve(TEST_POLAR, TEST_POLAR);
        expect(r.rigRecommendation).toEqual({ kind: 'tie' });
        expect(r.recommended).toBe(first);
      });
    },
  );

  // A boat declaring a third, uncompared sail still compares the requested
  // two; §E.1 ("the user picks which two to compare") makes this reachable.
  it('three-sail boat: an UNCOMPARED sail does not affect the comparison', () => {
    const boat: BoatDef = {
      ...boatWith('certificate', ['genoa', 'fock', 'storm']),
      sails: [
        boatWith('certificate', ['genoa']).sails[0],
        boatWith('certificate', ['fock']).sails[0],
        boatWith('estimated', ['storm']).sails[0],
      ],
    };
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW, storm: SLOWER });
    const r = ok(
      // Explicit even though it matches BASE_REQ: naming only two of the
      // three sails IS the condition under test.
      planRoute({ ...BASE_REQ, sailIds: ['genoa', 'fock'] }, uniformWindGrid(12, 0), deps),
    );
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });

  // Pins the `sail === undefined` clause, the only one left in
  // `comparisonSuppressed`: a requested sail the boat does not declare has no
  // provenance to qualify a verdict with, so it withholds the comparison.
  it('a requested sail the boat does not declare is not compared (fail closed)', () => {
    const boat = boatWith('certificate', ['genoa']);
    // A polar IS supplied for `ghost`, so the solve succeeds and the plan
    // reaches `assemble` with two results — otherwise `polarFor` would throw
    // and this row would be testing the lookup guard instead of the gate.
    const deps = depsFor(boat, { genoa: TEST_POLAR, ghost: SLOW });
    const r = ok(
      planRoute(
        { ...BASE_REQ, sailIds: ['genoa', 'ghost'] as readonly SailId[] },
        uniformWindGrid(12, 0),
        deps,
      ),
    );
    expect(r.sails.filter((s) => s.result !== null)).toHaveLength(2);
    expect(r.rigRecommendation).toEqual({ kind: 'not-compared' });
  });

  // Mixed tier is compared too (spec §T.1: EASY GO!, jib B / genoa C).
  it('mixed-tier boat (one certificate sail, one estimated) -> DECIDES', () => {
    const boat: BoatDef = {
      ...boatWith('certificate', ['genoa', 'fock']),
      sails: [
        boatWith('certificate', ['genoa']).sails[0],
        boatWith('estimated', ['fock']).sails[0],
      ],
    };
    const deps = depsFor(boat, { genoa: TEST_POLAR, fock: SLOW });
    const r = ok(planRoute(BASE_REQ, uniformWindGrid(12, 0), deps));
    expect(r.rigRecommendation).toEqual({ kind: 'decided', rig: 'genoa' });
  });
});
