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

  // The same TWS 8 input routes at plan fidelity (above) and terminates at the
  // horizon at performanceFactor 1.0 — a #1168-style flip on one parameter, so
  // both are pinned. What matters here is that it terminates (spike §11.2).
  it('snapped, genoa, TWS 8, performanceFactor 1.0: ends horizon-exceeded, not a hang', () => {
    const r = solveSalvaged({
      origin: mask.snapToNavigable(FLENSBURG, 3)!,
      tws: 8,
      table: polarGenoa,
      performanceFactor: 1,
    });
    expect(r).toEqual({ status: 'no-route', cause: 'horizon-exceeded' });
  });
});

describe('#1136 planRoute pass 2 (real mask)', () => {
  // Before #1136 all three returned error 'unreachable' (measured at the
  // change's base, 33dbad2).
  it.each([2.0, 2.4, 2.8])('TWS %s: a motor-off plan that died now routes', (tws) => {
    const res = planBagenkop(tws);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sails.some((s) => s.result !== null)).toBe(true);
    // A failed sail carries pass 1's cause (every pass-1 sail died mask-blocked
    // here), never a pass-2 one.
    for (const s of res.sails) if (s.result === null) expect(s.reason).toBe('unreachable');
  });

  // Containment: pass 1 already returns ok with one sail failed (#1166 shape),
  // so pass 2 is not admitted. An ok pass 1 records no cause, and admission
  // requires 'mask-blocked', so `record.cause === null` pins non-admission
  // structurally. It replaced base-pinned ETAs that #1303's approach grid
  // moved (PR #1304, comment 5716085827).
  it.each([
    { tws: 3, failed: 'genoa', routed: 'fock' },
    { tws: 8, failed: 'fock', routed: 'genoa' },
  ])('TWS $tws: an ok plan with $failed failed is left as it was', ({ tws, failed, routed }) => {
    const { result: res, record } = planRouteWithRecord(
      bagenkopRequest(),
      uniformWindGrid(tws, 0),
      SALONA_DEPS,
    );
    expect(record.cause).toBeNull();
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    const byId = (id: string) => res.sails.find((s) => s.sailId === id);
    expect(byId(failed)?.result).toBeNull();
    expect(byId(failed)?.reason).toBe('unreachable');
    expect(byId(routed)?.result).not.toBeNull();
  });
});
