import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import {
  SALONA_DEPS,
  FLENSBURG,
  MARSTAL,
  T0,
  sailResult,
  exposureNm,
} from '../test/realmaskFixtures';

// #1261: split out of realmask.repro.depthComfort.test.ts (#878's own split
// of the former realmask.repro.test.ts) — this one `planRoute` call (~180 s
// of that file's ~214 s CI total) was the sole reason the file ran long;
// giving it its own worker lets vitest schedule it alongside its former
// siblings instead of after them. Pure relocation: same imports, same
// literals, same timeout as before the split. See
// realmask.repro.depthComfort.test.ts for G.1/G.5 and the Bagenkop/Drejoe
// cases, and the shared #878 history.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('#243 depth comfort preference (real mask)', () => {
  // #243 mechanism-2 assertion (G.4): the relaxed gate no longer licenses
  // sub-requested-depth water along the WHOLE passage — only where the pinch
  // actually forces it. usedDepthM===2.3 proves the relaxation was not
  // removed; the tightened exposure bound proves it was localized.
  // Pre-change literal (measured on develop before #243 existed): 1.33 nm.
  // This PR's own measured value: ~0.23 nm. The 0.6 nm threshold sits
  // strictly between the two.
  it(
    'Flensburg -> Marstal at DEFAULT_SETTINGS: the relaxed gate is localized to the pinch, not the whole passage (G.4, #243 mechanism 2)',
    { timeout: solverTimeoutMs(600_000) },
    () => {
      const res = planRoute(
        {
          origin: FLENSBURG,
          destination: MARSTAL,
          viaPoints: [],
          originHarborId: 'flensburg',
          destinationHarborId: 'marstal',
          departureMs: T0,
          settings: DEFAULT_SETTINGS,
          sailIds: ['genoa', 'fock'],
          boat: defaultBoatSnapshot(),
        },
        uniformWindGrid(12, 270),
        SALONA_DEPS,
      );
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      expect(res.shallow).toBeDefined();
      expect(res.shallow!.usedDepthM).toBeCloseTo(2.3, 6);
      const rig = sailResult(res, res.recommended);
      expect(rig).not.toBeNull();
      expect(exposureNm(rig!.legs, 3.0)).toBeLessThan(0.6);
    },
  );
});
