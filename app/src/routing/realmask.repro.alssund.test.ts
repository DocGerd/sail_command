import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planRoute } from './planRoute';
import { OPENING_BRIDGES } from '../data/openingBridges';
import { bridgesPassed } from '../lib/openingBridges';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, defaultBoatSnapshot, type LatLon } from '../types';
import { solverTimeoutMs } from '../test/timeouts';
import {
  FLENSBURG,
  MARSTAL,
  SALONA_DEPS,
  SOENDERBORG,
  T0,
  sailResult,
} from '../test/realmaskFixtures';

vi.setConfig({ testTimeout: solverTimeoutMs(900_000) });

// #1875: ADR-0003's charted-channel override opens Alssund at Sønderborg.
// Outbound northwards is #1879 and is not pinned here.
const ALS_FJORD: LatLon = { lat: 55.0338, lon: 9.6815 };
const SOUND = { south: 54.9049, north: 54.9145, west: 9.775, east: 9.79 };

function planToSoenderborg(origin: LatLon, windFromDeg: number) {
  return planRoute(
    {
      origin,
      destination: SOENDERBORG,
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: 'soenderborg',
      departureMs: T0,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    uniformWindGrid(12, windFromDeg),
    SALONA_DEPS,
  );
}

describe('#1875 Alssund (real mask)', () => {
  it('Als Fjord -> Sønderborg goes through the sound on both rigs', () => {
    const res = planToSoenderborg(ALS_FJORD, 270);
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
        `#1875 ${sailId}: ${rig.distanceNm.toFixed(1)} nm, ${inSound} vertices in the sound`,
      );
      expect({ sailId, inSound: inSound > 0 }).toEqual({ sailId, inSound: true });
      expect(rig.distanceNm).toBeLessThan(15);
      // #1881: the same legs pass the bridge, and the notice geometry sees it.
      expect(
        { sailId, bridges: bridgesPassed(rig.legs).map((b) => b.id) },
        'route through the sound must pass the Kong Christian X bridge line',
      ).toEqual({ sailId, bridges: ['soenderborg-kong-christian-x'] });
    }
  });
});

// #1881: inbound routes that end at Sønderborg from the south never cross the
// span, so the bridge notice must stay off them (they are the e2e suite's
// starting routes).
describe('#1881 bridge notice geometry on real routes', () => {
  const LANGBALLIGAU = { lat: 54.8237, lon: 9.6524 };
  it.each([
    ['Langballigau', LANGBALLIGAU],
    ['Flensburg', FLENSBURG],
    ['Marstal', MARSTAL],
  ])('%s -> Sønderborg does not pass the bridge on either rig', (_name, origin) => {
    const res = planToSoenderborg(origin, 225);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    for (const sailId of ['genoa', 'fock'] as const) {
      const rig = sailResult(res, sailId);
      expect(rig, sailId).not.toBeNull();
      if (rig === null) continue;
      expect({ sailId, bridges: bridgesPassed(rig.legs).map((b) => b.id) }).toEqual({
        sailId,
        bridges: [],
      });
    }
  });
});

// #1881: OPENING_BRIDGES is typed by hand; its span and URL come from the
// charted channel. Lives here because this is the node-typed file allowed to
// read pipeline/.
describe('#1881 Kong Christian X bridge data matches pipeline/charted-channels.json', () => {
  interface ChannelFile {
    channels: {
      id: string;
      source: { bridge: { title: string; url: string } };
      centreline: { lat: number; lon: number; marks?: { seamarkIndex: number }[] }[];
    }[];
  }
  const file = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../pipeline/charted-channels.json'),
      'utf8',
    ),
  ) as ChannelFile;
  const SPAN_LIGHTS = [2262, 2263, 2264, 2265];

  it('span, name and URL equal the channel’s', () => {
    const channel = file.channels.find((c) => c.id === 'soenderborg-alssund');
    expect(channel, 'channel soenderborg-alssund').toBeDefined();
    const spanPoints = (channel?.centreline ?? []).filter((p) =>
      (p.marks ?? []).some((m) => SPAN_LIGHTS.includes(m.seamarkIndex)),
    );
    expect(spanPoints, 'the centreline point carrying the four span lights').toHaveLength(1);
    const bridge = OPENING_BRIDGES.find((b) => b.id === 'soenderborg-kong-christian-x');
    expect(bridge).toBeDefined();
    expect(bridge?.span).toEqual({ lat: spanPoints[0]!.lat, lon: spanPoints[0]!.lon });
    expect(bridge?.infoUrl).toBe(channel?.source.bridge.url);
    expect(bridge?.name).toBe(channel?.source.bridge.title);
  });
});
