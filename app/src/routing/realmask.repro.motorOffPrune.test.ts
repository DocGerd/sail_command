import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { solve } from './isochrone';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { SOLVER_TEST_TIMEOUT_MS, solverTimeoutMs } from '../test/timeouts';
import { mask, polarGenoa, SALONA_DEPS, FLENSBURG, BAGENKOP, T0 } from '../test/realmaskFixtures';

// #1168 against the real committed mask and polars: Flensburg -> Bagenkop,
// motor off, 3.0 m, uniform wind from 0°. A BAND of adjacent inputs, per the
// issue's own rule that a single-input pin cannot guard this. At the divisor-2
// confined grid each row drops one rig as `unreachable` on water the other rig
// crosses, and at 3.1/3.5/3.6 that leaves fock recommended over a faster genoa
// (docs/spikes/1168-motor-off-prune-instability.md §4).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

const SETTINGS = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false };

describe('#1168 motor-off confined prune grid (real mask)', () => {
  it.each([3.1, 3.3, 3.5, 3.6, 3.7])(
    'TWS %s: both rigs route and genoa is recommended',
    { timeout: solverTimeoutMs(300_000) },
    (tws) => {
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: BAGENKOP,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'bagenkop',
          departureMs: T0,
          settings: SETTINGS,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(tws, 0),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.sails.map((s) => [s.sailId, s.result === null ? s.reason : 'ok'])).toEqual([
        ['genoa', 'ok'],
        ['fock', 'ok'],
      ]);
      expect(res.recommended).toBe('genoa');
    },
  );

  // The issue's origin-shift arm is a bare-solve() property (planRoute snaps
  // the origin itself). The spike's §1 pair: the raw and the snapped
  // Flensburg origin, each at the TWS where it died at divisor 2.
  it.each([
    { origin: 'raw', tws: 3.0 },
    { origin: 'raw', tws: 2.8 },
    { origin: 'snapped', tws: 2.8 },
    { origin: 'snapped', tws: 3.0 },
  ])(
    'bare solve, $origin origin, genoa, TWS $tws: routes',
    { timeout: solverTimeoutMs(300_000) },
    ({ origin, tws }) => {
      const r = solve({
        origin: origin === 'raw' ? FLENSBURG : mask.snapToNavigable(FLENSBURG, 3)!,
        destination: mask.snapToNavigable(BAGENKOP, 3)!,
        departureMs: T0,
        polar: new Polar(polarGenoa, 1),
        wind: new WindField(uniformWindGrid(tws, 0)),
        mask,
        settings: SETTINGS,
        gate: uniformGate(3),
      });
      expect(r.status).toBe('ok');
    },
  );
});
