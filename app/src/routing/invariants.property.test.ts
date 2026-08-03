import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { planRoute } from './planRoute';
import { makeMask, makeWindGrid, TEST_POLAR } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';
import { haversineNm } from '../lib/geo';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
//
// #319 fix-wave (PR #335): v8 coverage instrumentation adds a further ~4x on
// top of that for solver-heavy work — measured directly on this branch,
// `npm run test:coverage` ran 983.5s-1029.5s for the full suite vs `npm run
// test`'s 249.8s, and CI run 30810112565 hit `Test timed out in 900000ms` on
// this file's property test at the plain budget below. `SC_COVERAGE` is set
// only by the `test:coverage` npm script (see package.json), so the plain
// `npm run test` path an actual hang runs against keeps its tight budget —
// only the coverage-instrumented CI run gets the wider one.
// @ts-expect-error process is not typed in browser context (same pattern as
// PlannerPanel.dst.test.tsx) — this file isn't in tsconfig.test.json's node-
// types allowlist (unlike realmask.repro.test.ts, which is), and adding it
// there for one env-var read would be a wider change than this needs.
const COVERAGE_TIMEOUT_MULTIPLIER = process.env.SC_COVERAGE ? 4 : 1;
vi.setConfig({ testTimeout: 120_000 * COVERAGE_TIMEOUT_MULTIPLIER });

const FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((r) => r.map((v) => v * 0.9)),
};

/** Random blob mask: a few circular islands in otherwise open water. */
function blobMask(seedBlobs: { r: number; c: number; rad: number }[]) {
  return makeMask((row, col) =>
    seedBlobs.some((b) => (row - b.r) ** 2 + (col - b.c) ** 2 < b.rad ** 2) ? 0 : 200,
  );
}

const arbScenario = fc.record({
  blobs: fc.array(
    fc.record({
      r: fc.integer({ min: 40, max: 160 }),
      c: fc.integer({ min: 60, max: 260 }),
      rad: fc.integer({ min: 3, max: 12 }),
    }),
    { minLength: 0, maxLength: 4 },
  ),
  windDir: fc.integer({ min: 0, max: 359 }),
  windKn: fc.integer({ min: 4, max: 22 }),
  oLat: fc.double({ min: 54.45, max: 55.15, noNaN: true }),
  oLon: fc.double({ min: 9.55, max: 10.85, noNaN: true }),
  dLat: fc.double({ min: 54.45, max: 55.15, noNaN: true }),
  dLon: fc.double({ min: 9.55, max: 10.85, noNaN: true }),
});

describe('router invariants', () => {
  // 25 runs x 2 rigs x full isochrone solves is a multi-minute suite on CI;
  // the per-file 120s is still insufficient for slow CI runners (observed 374s),
  // so this test has an explicit ceiling well above that.
  it(
    'holds core invariants on random scenarios',
    () => {
      let okScenarios = 0;
      fc.assert(
        fc.property(arbScenario, (sc) => {
          const mask = blobMask(sc.blobs);
          const origin = { lat: sc.oLat, lon: sc.oLon };
          const destination = { lat: sc.dLat, lon: sc.dLon };
          fc.pre(haversineNm(origin, destination) > 3);
          const r = planRoute(
            {
              origin,
              destination,
              viaPoints: [],
              originHarborId: null,
              destinationHarborId: null,
              departureMs: Date.UTC(2026, 6, 15, 6, 0, 0),
              settings: DEFAULT_SETTINGS,
            },
            makeWindGrid(() => ({ speedKn: sc.windKn, dirFromDeg: sc.windDir }), { hours: 72 }),
            { polarGenoa: TEST_POLAR, polarFock: FOCK, mask },
          );
          if (r.status !== 'ok') return true; // unreachable scenarios are legitimate
          okScenarios++;
          for (const rig of [r.genoa, r.fock]) {
            if (!rig) continue;
            for (let i = 0; i < rig.legs.length; i++) {
              const leg = rig.legs[i];
              // 1. no leg crosses land/shallow
              expect(mask.segmentNavigable(leg.start, leg.end, DEFAULT_SETTINGS.safetyDepthM)).toBe(
                true,
              );
              // 2. times strictly increasing
              expect(leg.endTimeMs).toBeGreaterThan(leg.startTimeMs);
              if (i > 0) {
                // 3. geometric + temporal continuity
                expect(haversineNm(rig.legs[i - 1].end, leg.start)).toBeLessThan(0.01);
                expect(leg.startTimeMs).toBe(rig.legs[i - 1].endTimeMs);
                // 5b. a board change between consecutive sail legs must be a charged maneuver
                const prev = rig.legs[i - 1];
                if (prev.kind === 'sail' && leg.kind === 'sail' && prev.board !== leg.board)
                  expect(leg.maneuverAtStart).not.toBeNull();
              }
              // 4. motor legs flagged consistently
              if (leg.kind === 'motor') expect(leg.board).toBeNull();
            }
            // 5. maneuver count consistency
            expect(rig.maneuverCount).toBe(
              rig.legs.filter((l) => l.maneuverAtStart !== null).length,
            );
          }
          // 6. recommendation is the faster rig
          if (r.genoa && r.fock)
            expect(r.recommended).toBe(r.genoa.etaMs <= r.fock.etaMs ? 'genoa' : 'fock');
          return true;
        }),
        { numRuns: 25, seed: 42 }, // deterministic CI; bump numRuns locally when touching the router
      );
      // Guard against a vacuous pass: with numRuns/seed fixed this is deterministic.
      expect(okScenarios).toBeGreaterThan(0);
    },
    900_000 * COVERAGE_TIMEOUT_MULTIPLIER,
  );
});
