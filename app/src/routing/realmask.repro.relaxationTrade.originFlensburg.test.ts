import { describe, expect, it, vi } from 'vitest';
import { APPROACH_RADIUS_M } from '../lib/depthGate';
import {
  mask,
  RELAXATION_TRADE_DEPTH_CASES,
  measureRelaxationTrade,
  relaxationTradeSnappedPairs,
  expectRelaxationTradeRadiusInvariant,
  expectRelaxationTradeSubsetConsistency,
} from '../test/realmaskFixtures';
import { solverTimeoutMs } from '../test/timeouts';

// #1261: split out of relaxationTrade.differential.test.ts (~728 s CI total
// there) — the ORIGIN FLENSBURG population row of its `describe.each(DEPTH_CASES)`
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
// order. This file carries only the ONE 'origin flensburg' entry from
// relaxationTrade.differential.test.ts's original `POPULATIONS` array — the
// other two ('origin marstal', 'destination marstal') live in their own
// sibling files.
const POPULATIONS = [{ name: 'origin flensburg', fixedId: 'flensburg', reversed: false }] as const;

describe('#930 R3: P3 disc-vs-global relaxation trade (shipped findRelaxedGate, real mask)', () => {
  describe.each(RELAXATION_TRADE_DEPTH_CASES)(
    'boats $boatIds (gate $requestedM m, floor $floorM m)',
    (c) => {
      it.each(POPULATIONS)('$name: shipped radius == global search on every pair', (pop) => {
        const { pairs, snapFailed } = relaxationTradeSnappedPairs(
          pop.fixedId,
          c.requestedM,
          pop.reversed,
        );
        expect(pairs.length + snapFailed.length, 'harbour pairs per fixed origin').toBe(39);

        const rows = measureRelaxationTrade(mask, pairs, c.requestedM, c.floorM, APPROACH_RADIUS_M);
        const label = `[${c.boatIds.join(',')}] ${pop.name}`;

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
