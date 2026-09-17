import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { Settings } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  SALONA_DEPS,
  FLENSBURG,
  MARSTAL,
  T0,
  sailResult,
  expectLegsNavigable,
} from '../test/realmaskFixtures';

// #1261: split out of realmask.repro.issue20.test.ts (#878's own split of the
// former realmask.repro.test.ts) — this one `planRoute` call (~170-185 s on
// CI) was serializing behind its two Marstal siblings inside one file; each
// now gets its own worker. Pure relocation: same imports, same literals,
// same timeout as before the split. See realmask.repro.issue20.test.ts for
// the lightweight Gluecksburg/open-water cases and the shared #878 history.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('real mask routing (issue #20)', () => {
  // Direct-request case (Flensburg -> Marstal at an explicit 2.3 m),
  // runtime-heavy: ~45 s locally (~40 s before #21's clock-aware visited
  // pruning deliberately widened the search; CI is measurably slower than
  // dev machines, hence the generous timeout — the 600 s base budget below
  // has ample headroom over 45 s regardless of the exact ratio).
  //
  // Runs at safetyDepthM 2.3: in the shipped mask Marstal's snap cell sits in
  // a 119-cell pocket that only 4-connects to open water at gate depths
  // <= 2.3 m (EMODnet can't resolve the dredged approach channel at 46 m
  // cells; see CONNECTIVITY_EXCEPTIONS_M in pipeline/verify_mask.py and PR
  // #8). A user explicitly planning at 2.3 m gets a plain route with no
  // shallow warnings — nothing was relaxed. The former note here ("at 3.0 m
  // 'unreachable' is the CORRECT answer for this data") is superseded by
  // #53's graceful degradation: the DEFAULT_SETTINGS spec acceptance case
  // (realmask.repro.issue20.marstalDefault.test.ts) expects a route WITH
  // shallow warnings instead.
  it(
    'Flensburg -> Marstal (direct request at 2.3 m safety depth)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const settings: Settings = { ...DEFAULT_SETTINGS, safetyDepthM: 2.3 };
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
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      // Explicitly-requested 2.3 m needs no relaxation: no shallow warnings.
      expect('shallow' in res).toBe(false);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      // ~38 nm great-circle; sane plans stay inside these envelopes
      expect(rig!.distanceNm).toBeGreaterThan(30);
      expect(rig!.durationMs).toBeLessThan(12 * 3_600_000);
      expectLegsNavigable(rig!.legs, settings.safetyDepthM);
    },
  );
});
