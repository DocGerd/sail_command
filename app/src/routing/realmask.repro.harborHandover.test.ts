import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { planWithHarborHandover } from './harborHandover';
import {
  mask,
  polars,
  expectLegsNavigable,
  sailResult,
  MARSTAL,
  BAGENKOP,
  T0,
} from '../test/realmaskFixtures';
import { uniformWindGrid } from '../test/fixtures';
import { boatById, sailIdsOf, DEFAULT_BOAT_ID } from '../data/boats';
import { DEFAULT_SETTINGS, boatSnapshot, type LatLon, type PlanResultOk } from '../types';
import { defaultSafetyDepthM } from '../lib/boatDepth';
import { haversineNm } from '../lib/geo';
import type { PlanResultWithHandover } from '../lib/harborHandover';
import { solverTimeoutMs } from '../test/timeouts';

vi.setConfig({ testTimeout: solverTimeoutMs(300_000) });

const ASSENS: LatLon = { lat: 55.2621, lon: 9.8778 };
const AUGUSTENBORG: LatLon = { lat: 54.9412, lon: 9.8502 };
const HOERUPHAV: LatLon = { lat: 54.9037, lon: 9.888 };
const KD = new Set(['arnis', 'dyvig', 'graasten', 'kappeln', 'maasholm']);
const WIND = uniformWindGrid(12, 225);
const metresBetween = (a: LatLon, b: LatLon) => haversineNm(a, b) * 1852;

function plan(
  boatId: Parameters<typeof boatById>[0],
  from: { p: LatLon; id: string },
  to: { p: LatLon; id: string },
) {
  const boat = boatById(boatId);
  const req = {
    origin: from.p,
    destination: to.p,
    viaPoints: [],
    originHarborId: from.id,
    destinationHarborId: to.id,
    departureMs: T0,
    settings: { ...DEFAULT_SETTINGS, safetyDepthM: defaultSafetyDepthM(boat) },
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
  return { req, spy, result };
}

function expectRescued(
  r: ReturnType<typeof plan>,
  end: 'origin' | 'destination',
  handoverM: number,
): PlanResultOk {
  expect(r.result.status).toBe('ok');
  const ok = r.result as PlanResultWithHandover;
  expect(ok.harborHandovers).toEqual({ [end]: true });
  expect(r.spy).toHaveBeenCalledTimes(2);
  const harbour = r.req[end];
  const snapped = end === 'origin' ? ok.snappedOrigin : ok.snappedDestination;
  expect(metresBetween(harbour, snapped)).toBeCloseTo(handoverM, 1);
  const gate = r.req.settings.safetyDepthM;
  for (const s of ok.sails) {
    const rig = sailResult(ok, s.sailId);
    expect(rig, `${s.sailId} routes`).not.toBeNull();
    expectLegsNavigable(rig!.legs, ok.shallow?.usedDepthM ?? gate);
  }
  console.log(
    `#1721 ${end} handover ${metresBetween(harbour, snapped).toFixed(1)} m, usedDepthM ` +
      `${ok.shallow?.usedDepthM ?? gate}, distance ${sailResult(ok, ok.recommended)!.distanceNm.toFixed(1)} nm`,
  );
  return ok;
}

describe('#1721 harbour handover on the real mask (each boat at its default gate)', () => {
  it('Marstal → Assens routes from a handover off Marstal', () => {
    const r = plan('salona-44-easy-go', { p: MARSTAL, id: 'marstal' }, { p: ASSENS, id: 'assens' });
    const ok = expectRescued(r, 'origin', 1423.4);
    expect(ok.shallow).toBeUndefined();
  });

  it('Marstal → Bagenkop routes from a handover off Marstal', () => {
    const r = plan(
      'salona-44-easy-go',
      { p: MARSTAL, id: 'marstal' },
      { p: BAGENKOP, id: 'bagenkop' },
    );
    const ok = expectRescued(r, 'origin', 1423.4);
    expect(ok.shallow).toBeUndefined();
  });

  it('Bagenkop → Marstal routes to a handover off Marstal', () => {
    const r = plan(
      'salona-44-easy-go',
      { p: BAGENKOP, id: 'bagenkop' },
      { p: MARSTAL, id: 'marstal' },
    );
    expectRescued(r, 'destination', 1423.4);
  });

  it('Augustenborg → Høruphav routes from a handover off Augustenborg', () => {
    const r = plan(
      'salona-44-easy-go',
      { p: AUGUSTENBORG, id: 'augustenborg' },
      { p: HOERUPHAV, id: 'hoeruphav' },
    );
    expectRescued(r, 'origin', 988.3);
  });

  it('a plan that routes today is returned as the identical object after one call', () => {
    const r = plan(DEFAULT_BOAT_ID, { p: MARSTAL, id: 'marstal' }, { p: BAGENKOP, id: 'bagenkop' });
    expect(r.result.status).toBe('ok');
    expect(r.spy).toHaveBeenCalledTimes(1);
    expect(r.result).toBe(r.spy.mock.results[0].value);
    expect(Object.hasOwn(r.result, 'harborHandovers')).toBe(false);
  });
});
