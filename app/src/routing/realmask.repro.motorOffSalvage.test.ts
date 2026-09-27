import { describe, expect, it, vi } from 'vitest';
import { planRoute, planRouteWithRecord } from './planRoute';
import * as isochroneModule from './isochrone';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, PlanRequest, PlanResult, PolarTable, Settings } from '../types';
import { SOLVER_TEST_TIMEOUT_MS, solverTimeoutMs } from '../test/timeouts';
import {
  mask,
  polarGenoa,
  polarFock,
  SALONA_DEPS,
  FLENSBURG,
  BAGENKOP,
  DREJOE,
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

// #1502: every input in this block now also routes UNSALVAGED (probed on the
// #1502 PR), so these rows pin that a salvaged solve still routes and
// terminates, not that salvage rescues anything.
describe('#1136 solve-level salvage (real mask)', () => {
  // Spike §11.1 set D: plan fidelity (performanceFactor 0.9, comfort 5 / none).
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
  // 1.0).
  it.each([2.4, 2.6, 2.8, 3.0])('unsnapped, genoa, TWS %s: routes across the §3.2 band', (tws) => {
    const r = solveSalvaged({ origin: FLENSBURG, tws, table: polarGenoa, performanceFactor: 1 });
    expect(r.status).toBe('ok');
  });

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

// Schleimünde's `snap` in harbors.json (id `schleimuende`).
const SCHLEIMUENDE: LatLon = { lat: 54.673, lon: 10.037 };

describe('#1136 planRoute pass 2 (real mask)', () => {
  // #1502: the `motorless-short-horizon` sweep arm's rows for these two
  // destinations (app/sweep/sweepArms.ts) admit pass 2, which replays every
  // tier with salvage on and routes nothing, so `planRoute` returns pass 1
  // verbatim. No real-mask input found yields 'rescued' (#1502 PR).
  it.each([
    { dest: 'flensburg', to: FLENSBURG },
    { dest: 'schleimuende', to: SCHLEIMUENDE },
  ])(
    '#1502 Drejø -> $dest, motor off, 3 h horizon: pass 2 admitted, routes nothing',
    ({ dest, to }) => {
      const solveSpy = vi.spyOn(isochroneModule, 'solve');
      const {
        result: res,
        record,
        pass2,
      } = planRouteWithRecord(
        {
          origin: DREJOE,
          destination: to,
          viaPoints: [],
          originHarborId: 'drejoe',
          destinationHarborId: dest,
          departureMs: T0,
          settings: { ...DEFAULT_SETTINGS, motorEnabled: false },
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(4, 90, { hours: 3 }),
        SALONA_DEPS,
      );
      const salvaged = solveSpy.mock.calls.filter(([o]) => o.salvage === true).length;
      const plain = solveSpy.mock.calls.length - salvaged;
      solveSpy.mockRestore();
      // Preconditions: the input still has the admitted shape.
      expect(record.cause).toBe('mask-blocked');
      expect(record.tiers.length).toBeGreaterThan(0);
      expect(res.status).toBe('error');
      expect(pass2).toBe('admitted-no-route');
      // Pass 2 actually ran: one plain solve per sail per recorded tier, then
      // salvage solves.
      expect(plain).toBe(record.tiers.length * 2);
      expect(salvaged).toBeGreaterThan(0);
    },
  );

  // #1502: these were this file's "a motor-off plan that died now routes"
  // pass-2 rows (every sail died before #1136, measured at 33dbad2). Both
  // rigs now route at tier 1 (#1502 PR), so they pin that instead.
  it.each([{ tws: 2.0 }, { tws: 2.4 }, { tws: 2.8 }])(
    'TWS $tws: both rigs route at tier 1, pass 2 not admitted',
    ({ tws }) => {
      const solveSpy = vi.spyOn(isochroneModule, 'solve');
      const {
        result: res,
        record,
        pass2,
      } = planRouteWithRecord(bagenkopRequest(), uniformWindGrid(tws, 0), SALONA_DEPS);
      const calls = solveSpy.mock.calls.length;
      solveSpy.mockRestore();
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.sails.every((s) => s.result !== null)).toBe(true);
      expect(record.tiers.map((t) => t.tier)).toEqual([1]);
      expect(pass2).toBe('not-admitted');
      expect(calls).toBe(2);
    },
  );

  // Containment: an ok pass 1 is never admitted to pass 2 (ruling 2).
  //
  // #1303 re-pin. At BASE these two rows carried the #1166 shape — pass 1 ok
  // with ONE sail failed — and pinned the routed sail's ETA
  // (1784159977571.5435 / 1784122896754.3152, both reproducing with the rule
  // off). Under the confined-water grid BOTH sails route at both TWS, so THIS
  // fixture no longer produces the #1166 shape, and since #1168 no probed
  // Bagenkop input does (see the #1327 rows below). `record.cause === null`
  // pins a PRECONDITION of non-admission — that pass 1 did not fail — not
  // non-admission itself: deleting clause 2 from `salvagePassAdmitted`
  // leaves this row green (PR
  // #1322 review). Clause 2 is pinned directly by
  // `planRoute.motorOffSalvage.test.ts`'s truth table.
  //
  // #1327: neither of these two ROWS produces the #1166 shape post-#1303.
  // The `solveSpy` call-count check here gives THIS row's non-admission
  // real-mask teeth on `solve()` call count directly — but, since
  // `pass1.status === 'error'` (clause 1) already fails on an `ok` plan
  // regardless of clause 2's value, it exercises clause 1, not clause 2
  // independently; clause 2 stays unit-covered only (PR #1322 review's
  // solve-spy suggestion, folded in here to the extent this fixture can
  // reach it).
  it.each([{ tws: 3 }, { tws: 8 }])(
    'TWS $tws: an ok plan is left as it was — pass 2 is not admitted',
    ({ tws }) => {
      const solveSpy = vi.spyOn(isochroneModule, 'solve');
      const { result: res, record } = planRouteWithRecord(
        bagenkopRequest(),
        uniformWindGrid(tws, 0),
        SALONA_DEPS,
      );
      expect(record.cause).toBeNull();
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.sails.every((s) => s.result !== null)).toBe(true);
      // Pass 1 only: one solve per sail, no salvage replay.
      expect(solveSpy).toHaveBeenCalledTimes(2);
      solveSpy.mockRestore();
    },
  );

  // #1327: TWS 3.5 was this file's real-mask #1166 one-sail-failed fixture
  // (genoa unreachable, fock routed) until #1168's motor-off divisor 3 let
  // genoa route there; no other probed Bagenkop TWS reproduces the shape
  // (#1168's PR). The row now pins that both rigs route, with the same
  // containment precondition as the rows above.
  it('#1327 TWS 3.5: both rigs route since #1168', () => {
    const { result: res, record } = planRouteWithRecord(
      bagenkopRequest(),
      uniformWindGrid(3.5, 0),
      SALONA_DEPS,
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.sails.every((s) => s.result !== null)).toBe(true);
    expect(record.cause).toBeNull();
  });

  // #1327: bounded TWS sweep for a real-mask #1166 shape. One row per TWS
  // point (a stall names its own point rather than reporting a generic
  // timeout on the whole sweep). Fails CLOSED on a find.
  it.each([{ tws: 2.2 }, { tws: 2.6 }, { tws: 5 }, { tws: 7 }, { tws: 10 }])(
    '#1327 TWS $tws: no real-mask one-sail-failed shape',
    { timeout: solverTimeoutMs(300_000) },
    ({ tws }) => {
      const res = planBagenkop(tws);
      const hit =
        res.status === 'ok' && res.sails.filter((s) => s.result === null).length === 1
          ? `TWS ${tws}: ${res.sails.map((s) => `${s.sailId}=${s.result === null ? s.reason : 'ok'}`).join(', ')}`
          : null;
      expect(hit).toBeNull();
    },
  );
});
