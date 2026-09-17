import { describe, expect, it, vi } from 'vitest';
import { planRouteWithRecord } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { SALONA_DEPS, FLENSBURG, T0 } from '../test/realmaskFixtures';

// #1258 against the real committed mask and polars: the `light-motorless` sweep
// arm's Flensburg->Troense plan. At #1258's base the requested 3.0 m genoa
// search hit the 48 h horizon and only the relaxed 2.9 m gate routed. Since
// #1303's confined-water prune refinement the genoa routes at the REQUESTED
// gate here, so this input no longer reaches horizon -> relaxed -> ok, and no
// real-mask input found so far does (probe list in PR #1304 comment
// 5717102784, re-checked under the general rule — see the PR body). That
// success path is covered only by synthetic tests today. The outcome flips on
// small input changes (#1168), so a neighbouring origin is pinned too.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// harbors.json `troense` snap, as the sweep plans it.
const TROENSE: LatLon = { lat: 55.0371, lon: 10.6444 };
const MOTOR_OFF = { ...DEFAULT_SETTINGS, motorEnabled: false };

function plan(origin: LatLon, tws: number, hours = 48) {
  return planRouteWithRecord(
    {
      origin,
      destination: TROENSE,
      viaPoints: [],
      originHarborId: 'flensburg',
      destinationHarborId: 'troense',
      departureMs: T0,
      settings: MOTOR_OFF,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    uniformWindGrid(tws, 0, { hours }),
    SALONA_DEPS,
  );
}

describe('#1258: a requested-gate horizon failure opens #53 relaxation (real mask)', () => {
  // #1303: this row pinned #1258's relaxed-tier route until the confined-water
  // grid let the genoa reach Troense inside the 48 h horizon at the requested
  // gate. It is now a drift sentinel for that change: with the rule off
  // (CONFINED_PRUNE_DIV = 1) it reds on `expected 'horizon-exceeded' to be
  // null`, which is the BASE behaviour this row used to assert.
  it(
    '#1303: Flensburg harbour snap, TWS 3: genoa routes at the requested gate without relaxing',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const { result, record } = plan(FLENSBURG, 3);
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.sails.find((s) => s.sailId === 'genoa')?.result).not.toBeNull();
      expect(record.tiers[0]?.causes[0]).toBeNull();
      expect(record.tiers.some((t) => t.tier === 3)).toBe(false);
    },
  );

  // Neighbour (#1168): 25 m west snaps to the adjacent cell, where the fock
  // routes at the requested gate and relaxation is never needed. Measured on
  // base f229f96 plus this change; a knife-edge drift sentinel, not a pin of
  // #1258 (it does not reach the widened predicate).
  it(
    'origin 25 m W, TWS 3: routes at the requested gate without relaxing',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const origin = { lat: FLENSBURG.lat, lon: FLENSBURG.lon - 25 / (111_320 * 0.575) };
      const { result, record } = plan(origin, 3);
      expect(result.status).toBe('ok');
      expect(record.tiers.some((t) => t.tier === 3)).toBe(false);
    },
  );

  // Control: a 24 h grid is unroutable at every gate, and the widened #1258
  // gate still runs tiers 3-4 on it.
  // #1303 re-pin: the reported label moved from 'beyond-horizon' to
  // 'unreachable'. Under the finer grid the relaxed tiers exhaust the mask
  // rather than the horizon, so `relaxedPlanCause` folds a mask-level verdict
  // — a LABEL change on an already-failing plan, not a routing one. With the
  // rule off this row reds with `Received: "beyond-horizon"`. What the row
  // still pins is that relaxation RAN and the plan stayed an error.
  it(
    'a 24 h forecast still fails after trying the relaxed gate',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const { result, record } = plan(FLENSBURG, 3, 24);
      expect(result).toEqual({ status: 'error', reason: 'unreachable' });
      expect(record.tiers.some((t) => t.tier === 3)).toBe(true);
      // #1258's WIDENED arm is what opens relaxation here: the tier-1 causes
      // measured ['mask-blocked', 'horizon-exceeded'] fold to horizon-exceeded
      // (`combineFailureCause`), so this row is the last real-mask exercise of
      // that predicate and nothing else asserts it (PR #1322 review).
      expect(record.tiers[0]?.causes).toContain('horizon-exceeded');
    },
  );

  // Control: a calm with the engine off is not a depth problem, so relaxation
  // must not run.
  it('a calm motor-off plan keeps calm-motor-off and never relaxes', () => {
    const { result, record } = plan(FLENSBURG, 0.15);
    expect(result).toEqual({ status: 'error', reason: 'calm-motor-off' });
    expect(record.tiers.some((t) => t.tier === 3)).toBe(false);
  });
});
