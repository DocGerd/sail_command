import { describe, expect, it, vi } from 'vitest';
import { Polar } from '../lib/polar';
import { WindField } from '../lib/wind';
import { uniformGate } from '../lib/depthGate';
import { uniformWindGrid } from '../test/fixtures';
import { mask, polars, FLENSBURG, T0 } from '../test/realmaskFixtures';
import { polarKey } from '../data/boats';
import { DEFAULT_SETTINGS, type LatLon, type PolarTable, type SailId } from '../types';
import { SOLVER_TEST_TIMEOUT_MS, solverTimeoutMs } from '../test/timeouts';
import { solve } from './isochrone';

vi.setConfig({ testTimeout: SOLVER_TEST_TIMEOUT_MS });

// #1303/#1305 against the real committed mask and polars. Prune-cell
// dominance ignores position WITHIN a cell, so at a passage narrower than a
// ~220x190 m prune cell a cheaper arrival with no navigable onward edge seals
// the cell against better-placed later ones. Both issues are that one defect:
// #1303 at Svendborg's harbour approach (the search returned the ~97 nm route
// round Langeland instead of the ~51 nm one through Svendborgsund), #1305 at
// the SAME cells as a pass-through ~7 nm from Rudkøbing, where the short
// family died under one search regime per rig.
//
// Each row is pinned on cost, not ETA: the search ranks on `costMs` (#243
// §D.5), so only cost can state "this search found the better route" — a
// finer grid can lower cost while ETA rises where depth comfort is active
// (measured on PR #1304). Distance pins the ROUTE FAMILY, which is what both
// issues are about; the two together cannot be satisfied by the long family
// at any speed this fleet can sail.
//
// Capped AND uncapped, because the cap is not a safeguard here: at BASE the
// 30 000-node truncation accidentally kept #1303's short route and
// accidentally killed #1305's on one rig. A fix that only holds in one regime
// would leave the search's answer decided by truncation.

const SVENDBORG: LatLon = { lat: 55.0554, lon: 10.6167 };
const RUDKOEBING: LatLon = { lat: 54.941, lon: 10.706 };
const UNCAPPED = 1e12;

function fromFlensburg(o: {
  destination: LatLon;
  boatId: string;
  sailId: SailId;
  maxFrontier?: number;
}) {
  const s = DEFAULT_SETTINGS;
  const origin = mask.snapToNavigable(FLENSBURG, s.safetyDepthM);
  const destination = mask.snapToNavigable(o.destination, s.safetyDepthM);
  if (!origin || !destination) throw new Error('snap failed');
  const table = polars[polarKey(o.boatId, o.sailId)] as PolarTable;
  const res = solve({
    origin,
    destination,
    departureMs: T0,
    polar: new Polar(table, s.performanceFactor),
    wind: new WindField(uniformWindGrid(12, 225)),
    mask,
    settings: s,
    // Tier 1 of the `breeze` / `salona44-breeze` sweep arms: requested gate,
    // depth-comfort preference on.
    gate: uniformGate(s.safetyDepthM),
    comfortDepthM: s.safetyDepthM + s.depthComfortMarginM,
    ...(o.maxFrontier !== undefined ? { maxFrontier: o.maxFrontier } : {}),
  });
  expect(res.status).toBe('ok');
  if (res.status !== 'ok') throw new Error('unreachable');
  const costHours = (res.costMs - T0) / 3_600_000;
  const nm = res.legs.reduce((a, l) => a + l.distanceNm, 0);
  console.log(
    `${o.boatId}/${o.sailId}/${o.maxFrontier === undefined ? 'capped' : 'uncapped'} ` +
      `cost_h=${costHours.toFixed(4)} eta_h=${((res.etaMs - T0) / 3_600_000).toFixed(4)} ` +
      `nm=${nm.toFixed(2)}`,
  );
  return { costHours, nm };
}

describe('#1303: Flensburg -> Svendborg keeps the Svendborgsund route (real mask)', () => {
  // Measured at BASE (CONFINED_PRUNE_DIV = 1, cost h / nm): capped
  // 8.8246 / 51.24, uncapped 15.4877 / 97.25. Only the UNCAPPED row reds at
  // BASE — that is #1303's defect, the uncapped search returning the Langeland
  // family 6.7 h slower on its own ranking clock. The capped row was already
  // on the short family at BASE and is here as a non-regression control, since
  // the cap kept that route by accident (#1303's root-cause comment) and a
  // fix that traded it away would red here. HEAD: 8.8282 / 52.05 capped,
  // 8.7675 / 51.05 uncapped. The bounds sit between the two families, not on
  // either measurement.
  it.each<[string, number | undefined]>([
    ['capped', undefined],
    ['uncapped', UNCAPPED],
  ])(
    'fock, %s: routes through the sound, not round Langeland',
    (_label, maxFrontier) => {
      const { costHours, nm } = fromFlensburg({
        destination: SVENDBORG,
        boatId: 'salona-45',
        sailId: 'fock',
        ...(maxFrontier !== undefined ? { maxFrontier } : {}),
      });
      expect(costHours).toBeLessThanOrEqual(9.5);
      expect(nm).toBeLessThan(60);
    },
    solverTimeoutMs(900_000),
  );
});

describe('#1305: Salona 44 Flensburg -> Rudkøbing takes the southern family (real mask)', () => {
  // Measured at BASE (cost h / nm): genoa capped 15.2027 / 97.28, genoa
  // uncapped 9.9763 / 60.29, fock capped 10.3562 / 63.41, fock uncapped
  // 15.2000 / 96.24. Each rig loses the short family under a DIFFERENT search
  // regime, which is what made #1305 read as a second defect (#1305's
  // root-cause comment); those two rows red at BASE and the other two are
  // non-regression controls. HEAD: 9.8641 / 60.50, 9.8748 / 59.79,
  // 9.9653 / 60.54, 9.9383 / 60.19 — one family, all four cells.
  it.each<[SailId, string, number | undefined]>([
    ['genoa', 'capped', undefined],
    ['genoa', 'uncapped', UNCAPPED],
    ['fock', 'capped', undefined],
    ['fock', 'uncapped', UNCAPPED],
  ])(
    '%s, %s: routes north of Ærø through Svendborgsund',
    (sailId, _label, maxFrontier) => {
      const { costHours, nm } = fromFlensburg({
        destination: RUDKOEBING,
        boatId: 'salona-44-speedy-go',
        sailId,
        ...(maxFrontier !== undefined ? { maxFrontier } : {}),
      });
      expect(costHours).toBeLessThanOrEqual(10.6);
      expect(nm).toBeLessThan(70);
    },
    solverTimeoutMs(900_000),
  );
});
