import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { planRoute } from './planRoute';
import { makeMask, makeWindGrid, TEST_MASK_META, TEST_POLAR, testPlanDeps } from '../test/fixtures';
import { DEFAULT_SETTINGS, type PolarTable } from '../types';
import { haversineNm } from '../lib/geo';
import { uniformGate } from '../lib/depthGate';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';
import { relaxationFloorM } from '../lib/boatDepth';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { defaultBoatSnapshot } from '../types';

// Solver-heavy file: CI runners execute the isochrone solver ~6-10x slower than
// dev machines (2026-07-15 CI run: tests at ~1s locally took 30-44s). Fast test
// files keep vitest's 5s default so hang detection stays meaningful there.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const FOCK: PolarTable = {
  ...TEST_POLAR,
  rig: 'fock',
  speeds: TEST_POLAR.speeds.map((r) => r.map((v) => v * 0.9)),
};

/**
 * #494: the mask byte for the approach shoal below. Mask bytes are decimetres,
 * so 25 is 2.5 m — STRICTLY between land (0) and `DEFAULT_SETTINGS
 * .safetyDepthM` (3.0 m), which is the whole point: before #494 this generator
 * emitted only 0 and 200, so no cell could ever be below the requested gate
 * and yet above the relaxation floor, and `flagShallowLegs` could not produce a
 * `shallow` field on ANY of the seed-42 scenarios (issue #494 §(b) measured
 * `shallowCount=0`). 2.5 m also sits above `relaxationFloorM` for the Salona 45
 * (2.1 m), so the shoal is something relaxation may legitimately cross rather
 * than something it must refuse.
 */
const SHOAL_DEPTH_BYTE = 25;
/**
 * Chebyshev radius, in cells, of the shoal ring. A ring at a CONSTANT Chebyshev
 * distance is a closed square annulus one cell thick, which no 4-connected path
 * can cross — and `NavMask.cellsConnected` is 4-connected — so at the requested
 * 3.0 m gate the origin's own cell is sealed off and the plan fails
 * `mask-blocked`, the one cause `depthRelaxationMayHelp` admits. Radius 2 keeps
 * the whole ring inside the origin's #452 approach disc (`APPROACH_RADIUS_M`
 * 1852 m against ~557 m row / ~321 m column cells here), which is what lets the
 * localized relaxation actually open it.
 */
const SHOAL_RING_CELLS = 2;

const LAT_STEP = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows;
const LON_STEP = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols;

/**
 * Random blob mask: a few circular islands in otherwise open water, optionally
 * with a #494 shoal ring around `shoal`'s cell — a shallow bar across the
 * origin's approach, the real-world shape #53 relaxation exists for (the
 * shipped mask's Marstal pocket is the production instance).
 *
 * LAND WINS over the shoal deliberately: a blob that clips the ring simply
 * leaves that scenario unrelaxed rather than silently turning a shoal cell into
 * water.
 */
function blobMask(
  seedBlobs: { r: number; c: number; rad: number }[],
  shoal: { row: number; col: number } | null,
) {
  return makeMask((row, col) => {
    if (seedBlobs.some((b) => (row - b.r) ** 2 + (col - b.c) ** 2 < b.rad ** 2)) return 0;
    if (
      shoal &&
      Math.max(Math.abs(row - shoal.row), Math.abs(col - shoal.col)) === SHOAL_RING_CELLS
    )
      return SHOAL_DEPTH_BYTE;
    return 200;
  });
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
  // #494: appended LAST so the pre-existing fields keep their generation order.
  // That does NOT preserve the seed-42 value stream (each run draws one more
  // value than before, shifting every later run), so `okScenarios` was
  // re-measured rather than assumed — see the counter assertions below.
  shoaled: fc.boolean(),
});

describe('router invariants', () => {
  // 25 runs x 2 rigs x full isochrone solves is a multi-minute suite on CI;
  // the per-file 120s is still insufficient for slow CI runners (observed 374s),
  // so this test has an explicit ceiling well above that.
  it(
    'holds core invariants on random scenarios',
    () => {
      let okScenarios = 0;
      let shallowScenarios = 0;
      fc.assert(
        fc.property(arbScenario, (sc) => {
          const origin = { lat: sc.oLat, lon: sc.oLon };
          const destination = { lat: sc.dLat, lon: sc.dLon };
          const mask = blobMask(
            sc.blobs,
            sc.shoaled
              ? {
                  row: Math.floor((origin.lat - TEST_MASK_META.south) / LAT_STEP),
                  col: Math.floor((origin.lon - TEST_MASK_META.west) / LON_STEP),
                }
              : null,
          );
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
              sailIds: ['genoa', 'fock'],
              boat: defaultBoatSnapshot(),
            },
            makeWindGrid(() => ({ speedKn: sc.windKn, dirFromDeg: sc.windDir }), { hours: 72 }),
            testPlanDeps(mask, { genoa: TEST_POLAR, fock: FOCK }),
          );
          if (r.status !== 'ok') return true; // unreachable scenarios are legitimate
          okScenarios++;
          const genoa = r.sails.find((s) => s.sailId === 'genoa')?.result ?? null;
          const fock = r.sails.find((s) => s.sailId === 'fock')?.result ?? null;
          // #494: the gate this plan was actually solved at. Without a #53
          // relaxation that IS the requested depth, so every pre-#494 scenario
          // keeps exactly its old invariant-1 threshold; a relaxed plan is
          // licensed to cross shoal cells down to `usedDepthM`, and asserting
          // the requested depth there would red on correct behaviour. The
          // relaxed-path block below is what stops the DEPTH half of that from
          // being a blanket weakening — it pins where `usedDepthM` may sit and
          // what the legs that used it must report.
          //
          // RESIDUAL: `uniformGate` licenses sub-requested water ANYWHERE on the
          // route, while the shipped `ApproachGate` licenses it only inside a
          // waypoint disc. This battery does not check that locality — the
          // shoal ring is drawn inside the origin's own disc by construction,
          // so an assertion here would be a theorem of the fixture, not a test
          // of the gate. `realmask.repro.test.ts`'s margin-0 case is what
          // covers it. So the block below restores the DEPTH half of what
          // invariant 1 gives up, not the space half.
          const solvedGateM = r.shallow ? r.shallow.usedDepthM : DEFAULT_SETTINGS.safetyDepthM;
          for (const rig of [genoa, fock]) {
            if (!rig) continue;
            for (let i = 0; i < rig.legs.length; i++) {
              const leg = rig.legs[i];
              // 1. no leg crosses land/shallow
              expect(mask.segmentNavigable(leg.start, leg.end, uniformGate(solvedGateM))).toBe(
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
          if (genoa && fock)
            expect(r.recommended).toBe(genoa.etaMs <= fock.etaMs ? 'genoa' : 'fock');

          // 7. #494 RELAXED-PATH INVARIANTS — only reachable at all because of
          // the shoal ring above. These are what invariant 1 gives up when it
          // drops to `usedDepthM`, asserted back explicitly.
          //
          // The safety story these pin is the two-branch one: a relaxed route's
          // sub-requested water is DISCLOSED (a `shallow` block exists, legs
          // carry `leg.shallow.minDepthM`), and the gate it was granted never
          // goes below the selected boat's own relaxation floor.
          if (r.shallow) {
            shallowScenarios++;
            const sh = r.shallow;
            expect(sh.requestedDepthM).toBe(DEFAULT_SETTINGS.safetyDepthM);
            // The floor is the SELECTED boat's (spec C.4a). `testPlanDeps`
            // builds its deps from the catalogue default, so that is the boat
            // whose floor governs here — read from `boats.ts` rather than
            // restated as a literal, so a catalogue draft change cannot leave
            // this silently checking the wrong hull.
            expect(sh.usedDepthM).toBeGreaterThanOrEqual(
              relaxationFloorM(boatById(DEFAULT_BOAT_ID)),
            );
            // Strictly below the request, or nothing was relaxed and the
            // `shallow` block should not exist at all.
            expect(sh.usedDepthM).toBeLessThan(sh.requestedDepthM);
            // The shallowest cell actually traversed sits in the band the
            // relaxation opened: at or above the granted gate, below the
            // request.
            expect(sh.minGateDepthM).toBeGreaterThanOrEqual(sh.usedDepthM);
            expect(sh.minGateDepthM).toBeLessThan(sh.requestedDepthM);
            // A plan-level `shallow` block with no flagged leg would be an
            // undisclosed warning — `flagShallowLegs` derives the block FROM
            // the legs, so an empty set here means the two have drifted apart.
            const flagged = [genoa, fock]
              .flatMap((rig) => rig?.legs ?? [])
              .filter((l) => l.shallow);
            expect(flagged.length).toBeGreaterThan(0);
            for (const leg of flagged) {
              expect(leg.shallow!.minDepthM).toBeGreaterThanOrEqual(sh.minGateDepthM);
              expect(leg.shallow!.minDepthM).toBeLessThan(sh.requestedDepthM);
            }
          }
          return true;
        }),
        { numRuns: 25, seed: 42 }, // deterministic CI; bump numRuns locally when touching the router
      );
      // Guard against a vacuous pass: with numRuns/seed fixed this is deterministic.
      expect(okScenarios).toBeGreaterThan(0);
      // #494 §(b): the same guard for the relaxed path, which this battery had
      // NEVER exercised — issue #494 measured `shallowCount=0` here, because
      // the pre-#494 generator emitted only land (0) and 20 m water (200).
      //
      // MEASURED on this tree at seed 42 / numRuns 25: `shallowScenarios` 4,
      // `okScenarios` 15. The control that isolates the shoal ring is forcing
      // `sc.shoaled` to `false`, which keeps the value stream identical and
      // changes only the mask: that gives 0 and 15, i.e. the ring buys 4
      // relaxed scenarios and costs no routable one (issue #494 also reports
      // 15 on the pre-#494 tree, but that is a DIFFERENT value stream —
      // appending an arbitrary shifts every later run — so the same-stream
      // control above is the comparison that actually isolates the change).
      //
      // Deliberately `> 0` rather than `toBe(4)`: the exact count is a
      // property of fast-check's stream, so pinning it would turn any future
      // generator tweak into a test edit, while what must not silently
      // regress is that the relaxed path is exercised AT ALL.
      expect(
        shallowScenarios,
        `no seed-42 scenario reached the #53 relaxed path (okScenarios=${okScenarios})`,
      ).toBeGreaterThan(0);
    },
    solverTimeoutMs(900_000),
  );
});
