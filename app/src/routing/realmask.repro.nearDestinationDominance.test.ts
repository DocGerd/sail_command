import { describe, expect, it, vi } from 'vitest';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { mask, polarFock, T0 } from '../test/realmaskFixtures';
import { DEFAULT_SETTINGS } from '../types';
import { SOLVER_TEST_TIMEOUT_MS, solverTimeoutMs } from '../test/timeouts';
import { solve } from './isochrone';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// harbors.json snap coordinates.
const FLENSBURG = { lat: 54.798, lon: 9.4335 };
const SVENDBORG = { lat: 55.0554, lon: 10.6167 };

// #1303: with the frontier cap lifted, early lineages reached Svendborgsund's
// harbour mouth from positions with no navigable direct edge, stamped the
// approach prune cells, and pruned the later, better-placed arrivals. The
// Svendborgsund family (~51 nm, ~8.7 h) died and the search returned the
// ~97 nm route round Langeland (15.35 h). Uncapped on purpose: at the default
// 30 000 cap truncation hides the defect (issue #1303's root-cause comment).
describe('#1303: near-destination visited dominance (real mask)', () => {
  it(
    'Flensburg -> Svendborg, fock, uncapped: keeps the Svendborgsund route',
    () => {
      const s = DEFAULT_SETTINGS;
      const origin = mask.snapToNavigable(FLENSBURG, s.safetyDepthM);
      const destination = mask.snapToNavigable(SVENDBORG, s.safetyDepthM);
      if (!origin || !destination) throw new Error('snap failed');
      const res = solve({
        origin,
        destination,
        departureMs: T0,
        polar: new Polar(polarFock, s.performanceFactor),
        wind: new WindField(uniformWindGrid(12, 225)),
        mask,
        settings: s,
        gate: uniformGate(s.safetyDepthM),
        comfortDepthM: s.safetyDepthM + s.depthComfortMarginM,
        maxFrontier: Number.MAX_SAFE_INTEGER,
      });
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      const hours = (res.etaMs - T0) / 3_600_000;
      const nm = res.legs.reduce((a, l) => a + l.distanceNm, 0);
      expect(hours).toBeLessThanOrEqual(9);
      expect(nm).toBeLessThan(60);
    },
    solverTimeoutMs(900_000),
  );
});
