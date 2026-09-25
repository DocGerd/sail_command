import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { SALONA_DEPS, FLENSBURG, BAGENKOP, T0 } from '../test/realmaskFixtures';

// #1168 against the real committed mask and polars: Flensburg -> Bagenkop,
// motor off, 3.0 m, uniform wind from 0°. A BAND of adjacent inputs, per the
// issue's own rule that a single-input pin cannot guard this. At the divisor-2
// confined grid each row drops one rig as `unreachable` on water the other rig
// crosses, and at 3.1/3.5/3.6 that leaves fock recommended over a faster genoa
// (docs/spikes/1168-motor-off-prune-instability.md §4).
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('#1168 motor-off confined prune grid (real mask)', () => {
  it.each([3.1, 3.3, 3.5, 3.6, 3.7])('TWS %s: both rigs route and genoa is recommended', (tws) => {
    const res = planRoute(
      {
        origin: FLENSBURG,
        destination: BAGENKOP,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: 'bagenkop',
        departureMs: T0,
        settings: { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false },
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
  });
});
