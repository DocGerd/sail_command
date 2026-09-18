import { describe, expect, it, vi } from 'vitest';
import { planRoute, planRouteWithRecord } from './planRoute';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, PlanRequest, PlanResult, PolarTable, Settings } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  mask,
  polarGenoa,
  polarFock,
  SALONA_DEPS,
  FLENSBURG,
  BAGENKOP,
  T0,
} from '../test/realmaskFixtures';

// #1136 against the real committed mask and polars: Flensburg -> Bagenkop,
// motor off, 3.0 m, uniform wind from 0°. The outcome is non-monotonic in TWS
// and flips on a 24.7 m origin shift (#1168, spike
// docs/spikes/1136-motor-off-solve-termination.md §3.2), so every pin below is a
// BAND of adjacent inputs, never a single point (spike §11.3). Uniform wind is
// the harness, not the product.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const SETTINGS: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false };
const RIGS: [string, PolarTable][] = [
  ['genoa', polarGenoa],
  ['fock', polarFock],
];

function solveSalvaged(o: {
  origin: LatLon;
  tws: number;
  table: PolarTable;
  performanceFactor: number;
  comfortDepthM?: number;
}) {
  return solve({
    origin: o.origin,
    destination: mask.snapToNavigable(BAGENKOP, 3)!,
    departureMs: T0,
    polar: new Polar(o.table, o.performanceFactor),
    wind: new WindField(uniformWindGrid(o.tws, 0)),
    mask,
    settings: SETTINGS,
    gate: uniformGate(3),
    ...(o.comfortDepthM !== undefined ? { comfortDepthM: o.comfortDepthM } : {}),
    salvage: true,
  });
}

function bagenkopRequest(): PlanRequest {
  return {
    origin: FLENSBURG,
    destination: BAGENKOP,
    viaPoints: [],
    originHarborId: 'flensburg',
    destinationHarborId: 'bagenkop',
    departureMs: T0,
    settings: SETTINGS,
    sailIds: ['genoa', 'fock'],
    boat: defaultBoatSnapshot(),
  };
}

function planBagenkop(tws: number): PlanResult {
  return planRoute(bagenkopRequest(), uniformWindGrid(tws, 0), SALONA_DEPS);
}

describe('#1136 solve-level salvage (real mask)', () => {
  // Spike §11.1 set D: plan fidelity (performanceFactor 0.9, comfort 5 / none).
  // Unsalvaged, 8 of these 12 solves die; salvaged, all route.
  const setD = [2.8, 3, 8].flatMap((tws) =>
    RIGS.flatMap(([rig, table]) =>
      [5, undefined].map((comfortDepthM) => ({ tws, rig, table, comfortDepthM })),
    ),
  );
  it.each(setD)(
    'snapped, plan fidelity, TWS $tws $rig comfort=$comfortDepthM: routes',
    ({ tws, table, comfortDepthM }) => {
      const r = solveSalvaged({
        origin: mask.snapToNavigable(FLENSBURG, 3)!,
        tws,
        table,
        performanceFactor: 0.9,
        ...(comfortDepthM !== undefined ? { comfortDepthM } : {}),
      });
      expect(r.status).toBe('ok');
    },
  );

  // The band pinned in §3.2's convention (unsnapped origin, performanceFactor
  // 1.0). Unsalvaged the genoa dies at 2.4 and 2.8 and routes at 2.6 and 3.0
  // (#1168); salvaged, all four route. Measured at this change's HEAD.
  it.each([2.4, 2.6, 2.8, 3.0])(
    'unsnapped, genoa, TWS %s: routes across the non-monotonic band',
    (tws) => {
      const r = solveSalvaged({ origin: FLENSBURG, tws, table: polarGenoa, performanceFactor: 1 });
      expect(r.status).toBe('ok');
    },
  );

  // What matters here is that a salvaged solve TERMINATES (spike §11.2) rather
  // than re-expanding forever. #1303 re-pin: at BASE (CONFINED_PRUNE_DIV = 1)
  // this input terminated at the horizon with no route; under the
  // confined-water grid it terminates WITH one. Both outcomes discharge §11.2,
  // and the row keeps its teeth because a non-terminating salvage would time
  // the test out rather than return either.
  it('snapped, genoa, TWS 8, performanceFactor 1.0: terminates (now with a route)', () => {
    const r = solveSalvaged({
      origin: mask.snapToNavigable(FLENSBURG, 3)!,
      tws: 8,
      table: polarGenoa,
      performanceFactor: 1,
    });
    expect(r.status).toBe('ok');
  });
});

describe('#1136 planRoute pass 2 (real mask)', () => {
  // Before #1136 all three returned error 'unreachable' (measured at the
  // change's base, 33dbad2).
  // #1303 re-pin of the failed sail's LABEL only. At BASE every pass-1 sail
  // died mask-blocked on all three rows; under the confined-water grid the
  // TWS 2 row's failing sail reaches the horizon instead, so it reports
  // 'beyond-horizon'. The claim the row makes — a failed sail carries PASS
  // ONE's cause, never a pass-2 one — is unchanged; only which pass-1 cause
  // this input produces moved, so the expected label is now per row.
  it.each([
    { tws: 2.0, failedReason: 'beyond-horizon' },
    { tws: 2.4, failedReason: 'unreachable' },
    { tws: 2.8, failedReason: 'unreachable' },
  ])('TWS $tws: a motor-off plan that died now routes', ({ tws, failedReason }) => {
    const res = planBagenkop(tws);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sails.some((s) => s.result !== null)).toBe(true);
    for (const s of res.sails) if (s.result === null) expect(s.reason).toBe(failedReason);
  });

  // Containment: an ok pass 1 is never admitted to pass 2 (ruling 2).
  //
  // #1303 re-pin. At BASE these two rows carried the #1166 shape — pass 1 ok
  // with ONE sail failed — and pinned the routed sail's ETA
  // (1784159977571.5435 / 1784122896754.3152, both reproducing with the rule
  // off). Under the confined-water grid BOTH sails route at both TWS, so that
  // fixture no longer produces the #1166 shape and no real-mask fixture in
  // this file does. `record.cause === null` pins a PRECONDITION of
  // non-admission — that pass 1 did not fail — not non-admission itself:
  // deleting clause 2 from `salvagePassAdmitted` leaves this row green (PR
  // #1322 review). Clause 2 is pinned directly by
  // `planRoute.motorOffSalvage.test.ts`'s truth table.
  it.each([{ tws: 3 }, { tws: 8 }])(
    'TWS $tws: an ok plan is left as it was — pass 2 is not admitted',
    ({ tws }) => {
      const { result: res, record } = planRouteWithRecord(
        bagenkopRequest(),
        uniformWindGrid(tws, 0),
        SALONA_DEPS,
      );
      expect(record.cause).toBeNull();
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.sails.every((s) => s.result !== null)).toBe(true);
    },
  );
});
