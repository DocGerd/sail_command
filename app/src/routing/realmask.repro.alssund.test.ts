import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type LatLon } from '../types';
import { solverTimeoutMs } from '../test/timeouts';
import { SALONA_DEPS, SOENDERBORG, T0, sailResult } from '../test/realmaskFixtures';

vi.setConfig({ testTimeout: solverTimeoutMs(900_000) });

// #1875: ADR-0003's charted-channel override opens Alssund at Sønderborg.
const ALS_FJORD: LatLon = { lat: 55.0338, lon: 9.6815 };
const NORTH_OF_SOUND: LatLon = { lat: 54.989, lon: 9.75 };
const SOUND = { south: 54.9049, north: 54.9145, west: 9.775, east: 9.79 };

function expectThroughSound(
  label: string,
  origin: LatLon,
  destination: LatLon,
  originHarborId: string | null,
  destinationHarborId: string | null,
  maxNm: number,
): void {
  const res = planRoute(
    {
      origin,
      destination,
      viaPoints: [],
      originHarborId,
      destinationHarborId,
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
  for (const sailId of ['genoa', 'fock'] as const) {
    const rig = sailResult(res, sailId);
    expect(rig, sailId).not.toBeNull();
    if (rig === null) continue;
    const inSound = rig.legs
      .flatMap((l) => [l.start, l.end])
      .filter(
        (p) =>
          p.lat >= SOUND.south &&
          p.lat <= SOUND.north &&
          p.lon >= SOUND.west &&
          p.lon <= SOUND.east,
      ).length;
    console.log(
      `${label} ${sailId}: ${rig.distanceNm.toFixed(1)} nm, ${inSound} vertices in the sound`,
    );
    expect({ sailId, inSound: inSound > 0 }).toEqual({ sailId, inSound: true });
    expect(rig.distanceNm).toBeLessThan(maxNm);
  }
}

describe('#1875 Alssund (real mask)', () => {
  it('Als Fjord -> Sønderborg goes through the sound on both rigs', () => {
    expectThroughSound('#1875', ALS_FJORD, SOENDERBORG, null, 'soenderborg', 15);
  });

  it('#1879: Sønderborg -> Als Fjord goes through the sound on both rigs', () => {
    expectThroughSound('#1879', SOENDERBORG, ALS_FJORD, 'soenderborg', null, 15);
  });

  it('#1879: Sønderborg -> 54.989 N 9.75 E goes through the sound on both rigs', () => {
    expectThroughSound('#1879', SOENDERBORG, NORTH_OF_SOUND, 'soenderborg', null, 8);
  });
});
