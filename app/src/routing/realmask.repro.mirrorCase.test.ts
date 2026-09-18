import { describe, expect, it, vi } from 'vitest';
import { planRouteWithRecord } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { uniformGate } from '../lib/depthGate';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { mask, SALONA_DEPS, FLENSBURG, MARSTAL, T0 } from '../test/realmaskFixtures';

// #878: split out of the former realmask.repro.test.ts (~1286 lines, five
// top-level describe blocks) so vitest can parallelise the real-mask suite
// across files/cores — one monopolizing file previously set the whole `app`
// job's wall clock while other cores idled. Pure relocation of this
// describe block; shared setup lives in ../test/realmaskFixtures.ts. These run
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
    '#1303: the requested gate still fails mask-blocked, and the relaxed tier now routes',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      // #265's guard is the CLASSIFICATION: a light-air motor-off plan whose
      // requested gate is mask-limited must record 'mask-blocked', never
      // 'calm-without-motor' — that cause is what opens #53 relaxation at all,
      // so a reclassification would silently suppress the relaxed tier.
      //
      // #1303 moved the OUTCOME, not the classification: at BASE
      // (CONFINED_PRUNE_DIV = 1) the relaxed tiers still failed and the plan
      // reported error/'unreachable'; the confined-water grid now threads the
      // pinch at the same 2.3 m gate, so the plan is ok with that gate on its
      // shallow block. The tier-1 cause below is what this row exists for and
      // it is unchanged; the status/usedDepthM assertions pin the new outcome.
      const { result: res, record } = planRouteWithRecord(
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
      // Split so a red run names WHICH fact broke. The CLASSIFICATION guard is
      // the first pair: this input is disconnected at the requested 3.0 m gate
      // on planRoute's fast path, so no tier solves there (every recorded tier
      // is a relaxed one) and the relaxed tiers run ONLY because the cause is
      // mask-level — `depthRelaxationMayHelp` rejects 'calm-without-motor', so
      // the reclassification #265 exists to prevent would leave NO tier 3 and
      // red here. Status and usedDepthM are the solver-capability facts.
      expect(record.tiers.every((t) => t.tier >= 3)).toBe(true);
      const tier3 = record.tiers.find((t) => t.tier === 3);
      expect(tier3?.usedDepthM).toBeCloseTo(2.3, 5);
      expect(res.status).toBe('ok');
      if (res.status === 'ok') expect(res.shallow?.usedDepthM).toBeCloseTo(2.3, 5);
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
