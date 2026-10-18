import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { planWithHarborHandover } from './harborHandover';
import { mask, polars, sailResult, MARSTAL, BAGENKOP, T0 } from '../test/realmaskFixtures';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, sailIdsOf } from '../data/boats';
import { DEFAULT_SETTINGS, boatSnapshot, type LatLon, type PlanResultOk } from '../types';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import type { PlanResultWithHandover } from '../lib/harborHandover';
import { findHarborHandover } from '../lib/harborReachability';
import { solverTimeoutMs } from '../test/timeouts';

vi.setConfig({ testTimeout: solverTimeoutMs(900_000) });

// #1734. Open water just outside Marstal's south channel, in the seed flood at
// every gate where Marstal has a handover.
const SOUTH_EXIT: LatLon = { lat: 54.8445, lon: 10.544 };
// At this gate the northern basin joins the seed flood only via Svendborgsund,
// and its cells are nearer Marstal than the south exit.
const NORTH_BASIN_GATE = 3.3;
// East of Marstal, reached from the northern basin without the Svendborgsund detour.
const EAST: LatLon = { lat: 54.8579, lon: 10.6147 };
const FLENSBURG: LatLon = { lat: 54.798, lon: 9.4335 };

const KD = new Set(['arnis', 'dyvig', 'graasten', 'kappeln', 'maasholm']);
const WIND = uniformWindGrid(12, 225);
const boat = boatById('salona-44-easy-go');

function planFromMarstal(gateM: number, to: { p: LatLon; id: string | null }, viaPoints: LatLon[]) {
  const req = {
    origin: MARSTAL,
    destination: to.p,
    viaPoints,
    originHarborId: 'marstal',
    destinationHarborId: to.id,
    departureMs: T0,
    settings: { ...DEFAULT_SETTINGS, safetyDepthM: gateM },
    sailIds: [...sailIdsOf(boat)],
    boat: boatSnapshot(boat),
  };
  const spy = vi.fn(planRoute);
  const result = planWithHarborHandover(
    req,
    WIND,
    { polars, boat, mask },
    undefined,
    undefined,
    undefined,
    KD,
    spy,
  );
  expect(spy).toHaveBeenCalledTimes(2);
  expect(result.status).toBe('ok');
  const ok = result as PlanResultOk & PlanResultWithHandover;
  expect(ok.harborHandovers).toEqual({ origin: true });
  const rigs = ok.sails.map((s) => sailResult(ok, s.sailId)).filter((r) => r !== null);
  expect(rigs.length).toBeGreaterThan(0);
  const maxLat = Math.max(...rigs.flatMap((r) => r.legs.flatMap((l) => [l.start.lat, l.end.lat])));
  console.log(
    `#1734 gate ${gateM} via ${viaPoints.length}: handover ${JSON.stringify(ok.snappedOrigin)}, ` +
      `distance ${rigs.map((r) => r.distanceNm.toFixed(2)).join('/')} nm, maxLat ${maxLat.toFixed(4)}`,
  );
  return { handover: ok.snappedOrigin, maxLat, rigs };
}

function expectSouthExit(r: ReturnType<typeof planFromMarstal>, maxNm: number) {
  expect(r.handover.lat).toBeLessThan(MARSTAL.lat);
  expect(r.maxLat).toBeLessThan(MARSTAL.lat);
  for (const rig of r.rigs) {
    expect(rig.distanceNm).toBeGreaterThan(0);
    expect(rig.distanceNm).toBeLessThan(maxNm);
  }
}

describe('#1734 Marstal handover exits toward the adjacent route point (EASY GO!)', () => {
  for (const gateM of [defaultSafetyDepthM(boat), NORTH_BASIN_GATE]) {
    it(`Marstal → point just south, no via (gate ${gateM})`, () => {
      expectSouthExit(planFromMarstal(gateM, { p: SOUTH_EXIT, id: null }, []), 1);
    });

    it(`Marstal → Bagenkop via a point just south (gate ${gateM})`, () => {
      expectSouthExit(planFromMarstal(gateM, { p: BAGENKOP, id: 'bagenkop' }, [SOUTH_EXIT]), 10);
    });
  }

  it('Marstal → Bagenkop via a point just south (gate 3.0)', () => {
    expectSouthExit(planFromMarstal(3.0, { p: BAGENKOP, id: 'bagenkop' }, [SOUTH_EXIT]), 10);
  });

  it(`Marstal → a point east keeps the northern exit (gate ${NORTH_BASIN_GATE})`, () => {
    const r = planFromMarstal(NORTH_BASIN_GATE, { p: EAST, id: null }, []);
    expect(r.handover.lat).toBeGreaterThan(MARSTAL.lat);
    for (const rig of r.rigs) expect(rig.distanceNm).toBeLessThan(6);
  });

  it(`Marstal → Flensburg exits south (gate ${NORTH_BASIN_GATE})`, () => {
    const r = planFromMarstal(NORTH_BASIN_GATE, { p: FLENSBURG, id: 'flensburg' }, []);
    expect(r.handover.lat).toBeLessThan(MARSTAL.lat);
    for (const rig of r.rigs) expect(rig.distanceNm).toBeLessThan(55);
  });

  it('the handover search follows the adjacent point by water, not by bearing', () => {
    const north = findHarborHandover(mask, MARSTAL, 2.7)!;
    expect(north.lat).toBeGreaterThan(MARSTAL.lat);
    expect(findHarborHandover(mask, MARSTAL, 2.7, undefined, EAST)).toEqual(north);
    expect(findHarborHandover(mask, MARSTAL, 2.7, undefined, SOUTH_EXIT)!.lat).toBeLessThan(
      MARSTAL.lat,
    );
    expect(findHarborHandover(mask, MARSTAL, 2.7, undefined, FLENSBURG)!.lat).toBeLessThan(
      MARSTAL.lat,
    );
  });
});
