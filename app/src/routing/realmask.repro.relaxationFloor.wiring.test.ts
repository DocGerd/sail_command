import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, DEFAULT_BOAT_ID, type BoatDef } from '../data/boats';
import { DEFAULT_SETTINGS, defaultBoatSnapshot } from '../types';
import type { LatLon, SailId } from '../types';
import { solverTimeoutMs, SOLVER_TEST_TIMEOUT_MS } from '../test/timeouts';
import { mask, polars, FLENSBURG, T0 } from '../test/realmaskFixtures';

// #1261: split out of realmask.repro.relaxationFloor.test.ts (#878's own
// split of the former realmask.repro.test.ts) — this one `planRoute` call
// (two calls, ~531 s CI) was the file's own heaviest test; giving it its
// own worker lets vitest schedule it alongside its former (a)/(a2) siblings
// instead of after them. Pure relocation: same imports, same literals, same
// timeout as before the split. See realmask.repro.relaxationFloor.test.ts
// for (a)/(a2) and the shared #878 history.
vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

describe('#54 spec C.4(a): the relaxation floor comes from the selected boat', () => {
  const POCKET: LatLon = { lat: 54.8652, lon: 10.5313 };

  it(
    '(b) WIRING: planRoute relaxes to the floor of deps.boat, not to a shared constant',
    // #295: 210 s on CI before the widening, 552 s and 604 s after it (runs
    // 34967193450, 34991379729, 34997849572); ~1.5x the slowest.
    { timeout: solverTimeoutMs(900_000) },
    () => {
      const salona = boatById(DEFAULT_BOAT_ID);
      // Deliberately NOT a catalogue entry: the catalogue has one boat, whose
      // draft coincides with the old module constant, so no real boat can
      // discriminate the wiring.
      const deepBoat: BoatDef = { ...salona, id: 'deep-test', draftM: 2.3 };
      const request = {
        origin: FLENSBURG,
        destination: POCKET,
        viaPoints: [],
        originHarborId: 'flensburg',
        destinationHarborId: null,
        departureMs: T0,
        settings: DEFAULT_SETTINGS,
        sailIds: ['genoa', 'fock'] as SailId[],
        boat: defaultBoatSnapshot(),
      };
      const wind = uniformWindGrid(12, 270);

      const deepRes = planRoute(request, wind, { polars, boat: deepBoat, mask });
      expect(deepRes.status, 'a 2.30 m boat must not be routed through a 2.1 m relaxed gate').toBe(
        'error',
      );
      if (deepRes.status === 'error') expect(deepRes.reason).toBe('unreachable');

      // MANDATORY companion, not optional: without it the row above is
      // indistinguishable from "this fixture is simply unroutable", which is
      // the vacuity mode the whole fixture measurement exists to avoid.
      const salonaRes = planRoute(request, wind, { polars, boat: salona, mask });
      expect(salonaRes.status, 'the 2.10 m Salona 45 must still reach the pocket').toBe('ok');
      if (salonaRes.status === 'ok') expect(salonaRes.shallow?.usedDepthM).toBeCloseTo(2.1, 6);
    },
  );
});
