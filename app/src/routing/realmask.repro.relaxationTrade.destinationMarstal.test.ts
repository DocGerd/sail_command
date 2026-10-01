import { describe, expect, it, vi } from 'vitest';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import {
  mask,
  RELAXATION_TRADE_DEPTH_CASES,
  measureRelaxationTrade,
  relaxationTradeSnappedPairs,
  expectRelaxationTradeRadiusInvariant,
  expectRelaxationTradeSubsetConsistency,
  expectRelaxationTradeStranded,
  relaxationTradeFixedReachableAtFloor,
  relaxationTradeCasePartition,
  polars,
  FLENSBURG,
  MARSTAL,
  T0,
} from '../test/realmaskFixtures';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, sailIdsOf } from '../data/boats';
import { DEFAULT_SETTINGS, boatSnapshot } from '../types';
import { solverTimeoutMs } from '../test/timeouts';

// #1261: split out of relaxationTrade.differential.test.ts (~728 s CI total
// there) — the DESTINATION MARSTAL population row of its `describe.each(DEPTH_CASES)`
// / `it.each(POPULATIONS)` block, given its own file so vitest can schedule
// it on a separate worker instead of serializing behind its two population
// siblings. Named with the `realmask.repro.` prefix (not
// `relaxationTrade.differential.*`) so it falls inside the EXISTING
// `realmask.repro*.test.ts` tsconfig glob without adding any tsconfig entry
// — see relaxationTrade.differential.test.ts's own #1261 comment for why.
// The `describe.each`/`it.each` helper functions live in
// `../test/realmaskFixtures.ts` (a plain, non-`.test.ts` module), shared with
// that file and the other two population siblings — moved there from a
// per-file verbatim duplicate (PR #1278 review). Pure relocation of the
// logic and literals otherwise; see relaxationTrade.differential.test.ts for
// the full #930 R3 design note, the "derives one depth case" test and both
// POSITIVE CONTROLs.
vi.setConfig({ testTimeout: solverTimeoutMs(300_000) });

// `reversed` puts the fixed harbour LAST: [X, Marstal] is the mirror of the
// Marstal-origin population, measured because phase 2 walks waypoints in
// order. This file carries only the ONE 'destination marstal' entry from
// relaxationTrade.differential.test.ts's original `POPULATIONS` array — the
// other two ('origin marstal', 'origin flensburg') live in their own
// sibling files.
const POPULATIONS = [{ name: 'destination marstal', fixedId: 'marstal', reversed: true }] as const;

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
  // #1575: both sides of the partition must exist, or the stranded pin (or the
  // measurement it replaces) would be vacuous; and a stranded case surfaces as
  // the typed `error`/`unreachable` result, not a silent success.
  describe('stranded vs relaxable depth cases', () => {
    const { relaxable, stranded } = relaxationTradeCasePartition('marstal');

    it('partitions the catalogue depth cases: at least one relaxes and at least one cannot', () => {
      expect(relaxable.length, 'cases where Marstal can relax').toBeGreaterThan(0);
      expect(stranded.length, 'cases where Marstal is cut off at the floor').toBeGreaterThan(0);
    });

    it.each(stranded)('boats $boatIds: planRoute returns the typed unreachable error', (c) => {
      const boat = boatById(c.boatIds[0] as Parameters<typeof boatById>[0]);
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: { ...DEFAULT_SETTINGS, safetyDepthM: c.requestedM },
          sailIds: [...sailIdsOf(boat)],
          boat: boatSnapshot(boat),
        },
        uniformWindGrid(12, 270),
        { polars, boat, mask },
      );
      expect(res.status).toBe('error');
      expect(res).toMatchObject({ reason: 'unreachable' });
    });
  });

  describe.each(RELAXATION_TRADE_DEPTH_CASES)(
    'boats $boatIds (gate $requestedM m, floor $floorM m)',
    (c) => {
      it.each(POPULATIONS)('$name: shipped radius == global search on every pair', (pop) => {
        const { pairs, snapFailed } = relaxationTradeSnappedPairs(
          pop.fixedId,
          c.requestedM,
          pop.reversed,
        );
        expect(pairs.length + snapFailed.length, 'harbour pairs per fixed origin').toBe(45);

        const rows = measureRelaxationTrade(mask, pairs, c.requestedM, c.floorM, APPROACH_RADIUS_M);
        const label = `[${c.boatIds.join(',')}] ${pop.name}`;

        // #1575: a boat whose relaxation floor is deeper than Marstal's deepest
        // connecting gate cannot reach it at all — nothing CAN relax, which is
        // the accepted outcome, so it is pinned here rather than measured.
        if (!relaxationTradeFixedReachableAtFloor(pop.fixedId, c.requestedM, c.floorM)) {
          expectRelaxationTradeStranded(rows, label);
          return;
        }

        // LICENCE: equality over pairs where nothing relaxes proves nothing, so
        // at least one relevant pair must actually relax.
        const relaxedRelevant = rows.filter((r) => r.relevant && r.globalUsedDepthM !== null);
        expect(
          relaxedRelevant.length,
          `${label}: no relevant pair relaxed — nothing measured.\n${JSON.stringify(rows)}`,
        ).toBeGreaterThan(0);

        expectRelaxationTradeSubsetConsistency(rows, label);
        expectRelaxationTradeRadiusInvariant(rows, label);

        console.log(
          `#930 ${label}: ${rows.length} pairs, ${rows.filter((r) => r.relevant).length} relevant, ` +
            `${relaxedRelevant.length} relevant+relaxed, snap-failed ${JSON.stringify(snapFailed)}:`,
          JSON.stringify(rows),
        );
      });
    },
  );
});
