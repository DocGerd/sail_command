import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { mask, SALONA_DEPS, FLENSBURG, MARSTAL, T0 } from './realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block; shared setup lives in ./realmaskFixtures.ts. These run
// against the real shipped mask and polars, unlike the synthetic masks used
// everywhere else in the suite.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('issue #265: the mirror case — genuinely mask-limited must stay unreachable', () => {
  // Flensburg -> Marstal at the REQUESTED 3.0 m gate is genuinely
  // mask-disconnected (documented in this file's DEFAULT_SETTINGS test above
  // and in issue #9): the shipped mask only 4-connects Flensburg to Marstal
  // at gates <= 2.3 m. This is the #265 review's Blocker-2 concern in
  // concrete form — a light-air, motor-off plan against a destination that
  // is disconnected for reasons having NOTHING to do with wind. A
  // reclassification that makes masked-but-slow headings read as "calm"
  // (the subFloor idea evaluated and REJECTED in this PR — see the PR
  // description) would make this exact case regress to 'calm-motor-off',
  // telling the user to wait for wind that can never help. Ground truth
  // comes from an independent oracle (mask.cellsConnected), not from
  // solve()/planRoute() itself.
  const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 3, motorEnabled: false };

  it('is mask-disconnected at the requested 3.0 m gate but connected at 2.3 m (independent oracle)', () => {
    const o = mask.snapToNavigable(FLENSBURG, settings.safetyDepthM);
    const d = mask.snapToNavigable(MARSTAL, settings.safetyDepthM);
    expect(o).not.toBeNull();
    expect(d).not.toBeNull();
    expect(mask.cellsConnected(o!, d!, uniformGate(3.0))).toBe(false);
    expect(mask.cellsConnected(o!, d!, uniformGate(2.3))).toBe(true);
  });

  it(
    'a light-air, motor-off plan reports unreachable, not calm-motor-off, even though #53 relaxation is attempted',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      // Measured directly (not derived from this PR's own reasoning): #53's
      // relaxed-gate mechanism DOES fire here (reason defaults to
      // 'unreachable' from the disconnected-at-3.0m fast path, which is the
      // relaxation trigger), finds the same 2.3 m gate as the DEFAULT_SETTINGS
      // test above, and re-solves both rigs there under this scenario's
      // light air + motor-off settings — which still fails (the pinch is
      // narrow enough that the solver can't thread it at this wind/motor
      // combination), so the plan correctly falls through to 'unreachable'
      // rather than being coerced into 'calm-motor-off'.
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(3, 0),
        SALONA_DEPS,
      );
      // Split so a red run names WHICH fact broke: `status` is the
      // solver-capability/mask-connectivity fact (would flip to 'ok' if
      // either the mask reconnects at 3.0 m OR the relaxed 2.3 m re-solve
      // starts succeeding — both "good news", neither a classification
      // regression), while `reason` is the actual classification guard this
      // test exists to protect. A single `toEqual` would report both as one
      // failure and couldn't tell them apart.
      expect(res.status).toBe('error');
      if (res.status === 'error') expect(res.reason).toBe('unreachable');
    },
  );
});

// #54 spec §C.4(a): the #53 relaxation floor is the SELECTED boat's draft,
// not a module constant. Left global, relaxation takes a 2.30 m boat down to
// a 2.1 m gate — 0.2 m shallower than its keel before the mask tolerance is
// even applied — while the shallow banner reports the relaxation as if it
// were the Salona's.
//
// Fixture: Flensburg->54.8652,10.5313 (pocket ~0.45 nm N of the Marstal snap).
// MEASURED 2026-08-16: floor 2.1 -> usedDepthM 2.1, floor 2.3 -> no route.
//
// NOT a harbour pair on purpose. `findRelaxedGate` MAXIMISES the connecting
// gate, so a fixture whose maximum gate is >= 2.3 returns the IDENTICAL value
// at floor 2.1 and floor 2.3 and the obvious `usedDepthM >= 2.3` assertion is
// a theorem. All 528 unordered harbour pairs measure 2.9, 2.3 or null — none
// of them can red a wrongly-wired floor (Flensburg->Marstal is exactly the
// 2.3 boundary case). This pocket's maximum connecting gate is 2.1, verified
// against an independent numpy flood fill using a haversine disc.
