import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { planWithHarborHandover } from './harborHandover';
import { mask, polars, sailResult, MARSTAL, BAGENKOP, T0 } from '../test/realmaskFixtures';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, sailIdsOf } from '../data/boats';
import {
  DEFAULT_SETTINGS,
  boatSnapshot,
  type LatLon,
  type PlanRequest,
  type PlanResult,
  type PlanResultOk,
} from '../types';
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
const AABENRAA: LatLon = { lat: 55.0345, lon: 9.427 };
const AUGUSTENBORG: LatLon = { lat: 54.9412, lon: 9.8502 };
// Shallower than the gate itself; planRoute snaps it into the flood east of Marstal.
const NEAR_SHORE_EAST: LatLon = { lat: 54.84892, lon: 10.62162 };
// Inland Langeland, south-east of Marstal: no navigable cell within the snap radius.
const LANGELAND_INLAND: LatLon = { lat: 54.78, lon: 10.72 };

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

/** The ends `planWithHarborHandover` substitutes, read off a stub planner (no solve). */
function substitutedEnds(
  gateM: number,
  from: { p: LatLon; id: string },
  to: { p: LatLon; id: string },
  viaPoints: LatLon[],
) {
  const requests: PlanRequest[] = [];
  const stub = (req: PlanRequest): PlanResult => {
    requests.push(req);
    return { status: 'error', reason: 'unreachable' };
  };
  planWithHarborHandover(
    {
      origin: from.p,
      destination: to.p,
      viaPoints,
      originHarborId: from.id,
      destinationHarborId: to.id,
      departureMs: T0,
      settings: { ...DEFAULT_SETTINGS, safetyDepthM: gateM },
      sailIds: [...sailIdsOf(boat)],
      boat: boatSnapshot(boat),
    },
    WIND,
    { polars, boat, mask },
    undefined,
    undefined,
    undefined,
    KD,
    stub,
  );
  expect(requests).toHaveLength(2);
  return { origin: requests[1].origin, destination: requests[1].destination };
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
    expect(
      findHarborHandover(mask, MARSTAL, NORTH_BASIN_GATE, undefined, AABENRAA)!.lat,
    ).toBeLessThan(MARSTAL.lat);
  });

  it('falls back to straight-line ranking when the adjacent point snaps to nothing', () => {
    expect(mask.snapToNavigable(LANGELAND_INLAND, NORTH_BASIN_GATE)).toBeNull();
    expect(
      findHarborHandover(mask, MARSTAL, NORTH_BASIN_GATE, undefined, LANGELAND_INLAND)!.lat,
    ).toBeLessThan(MARSTAL.lat);
  });

  it('faces the first via point at the origin and the last via point at the destination', () => {
    const marstal = { p: MARSTAL, id: 'marstal' };
    const flensburg = { p: FLENSBURG, id: 'flensburg' };
    const g = NORTH_BASIN_GATE;
    expect(substitutedEnds(g, marstal, flensburg, [EAST]).origin.lat).toBeGreaterThan(MARSTAL.lat);
    expect(substitutedEnds(g, flensburg, marstal, [EAST]).destination.lat).toBeGreaterThan(
      MARSTAL.lat,
    );
    expect(substitutedEnds(g, flensburg, marstal, []).destination.lat).toBeLessThan(MARSTAL.lat);
  });

  it('with both ends pocketed, each end faces the other end handover', () => {
    const marstal = { p: MARSTAL, id: 'marstal' };
    const augustenborg = { p: AUGUSTENBORG, id: 'augustenborg' };
    const g = NORTH_BASIN_GATE;
    expect(substitutedEnds(g, marstal, augustenborg, []).origin.lat).toBeLessThan(MARSTAL.lat);
    expect(substitutedEnds(g, augustenborg, marstal, []).destination.lat).toBeLessThan(MARSTAL.lat);
  });

  it(`Marstal → Aabenraa exits south (gate ${NORTH_BASIN_GATE})`, () => {
    const r = planFromMarstal(NORTH_BASIN_GATE, { p: AABENRAA, id: 'aabenraa' }, []);
    expect(r.handover.lat).toBeLessThan(MARSTAL.lat);
    for (const rig of r.rigs) expect(rig.distanceNm).toBeLessThan(55);
  });

  it(`Marstal → a near-shore point east keeps the northern exit (gate ${NORTH_BASIN_GATE})`, () => {
    const r = planFromMarstal(NORTH_BASIN_GATE, { p: NEAR_SHORE_EAST, id: null }, []);
    expect(r.handover.lat).toBeGreaterThan(MARSTAL.lat);
    for (const rig of r.rigs) expect(rig.distanceNm).toBeLessThan(6);
  });
});
