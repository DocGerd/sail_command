import { describe, expect, it } from 'vitest';
import { OPENING_BRIDGES, type OpeningBridge } from '../data/openingBridges';
import type { LatLon, Leg } from '../types';
import { BRIDGE_PASS_M, bridgesPassed, segmentDistanceM } from './openingBridges';

const KC = OPENING_BRIDGES[0]!;
const LINE_LAT = 54.9110026;
// One degree of latitude is 111195 m on the 6371008.8 m sphere geo.ts uses,
// so 0.00044 deg = 48.93 m and 0.00046 deg = 51.15 m: the two sides of
// BRIDGE_PASS_M = 50.
const LAT_48_9M = 0.00044;
const LAT_51_2M = 0.00046;

function leg(start: LatLon, end: LatLon, kind: 'sail' | 'motor' = 'sail'): Leg {
  const common = {
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 600_000,
    headingDeg: 0,
    twsKn: 8,
    speedKn: 5,
    distanceNm: 1,
    maneuverAtStart: null,
  };
  return kind === 'sail'
    ? { ...common, kind: 'sail', board: 'starboard', twaDeg: 90 }
    : { ...common, kind: 'motor', board: null };
}

const NORTH_OF_SPAN: LatLon = { lat: 54.9210026, lon: 9.7830141 };
const SOUTH_OF_SPAN: LatLon = { lat: 54.9010026, lon: 9.7830141 };
const crossing = (kind: 'sail' | 'motor' = 'sail') => leg(NORTH_OF_SPAN, SOUTH_OF_SPAN, kind);
const eastWestAt = (lat: number) => leg({ lat, lon: 9.78 }, { lat, lon: 9.786 });

describe('#1881 segmentDistanceM', () => {
  const O: LatLon = { lat: 0, lon: 0 };
  const E: LatLon = { lat: 0, lon: 0.001 };

  it('is 0 for crossing, T-touching and collinear-overlapping segments', () => {
    expect(segmentDistanceM({ lat: -0.001, lon: 0.0005 }, { lat: 0.001, lon: 0.0005 }, O, E)).toBe(
      0,
    );
    expect(segmentDistanceM({ lat: -0.001, lon: 0.0005 }, { lat: 0, lon: 0.0005 }, O, E)).toBe(0);
    expect(segmentDistanceM({ lat: 0, lon: 0.0005 }, { lat: 0, lon: 0.002 }, O, E)).toBe(0);
  });

  it('measures a parallel offset as the cross-track distance', () => {
    // 0.0005 deg of latitude at the equator = 55.6 m
    const d = segmentDistanceM({ lat: 0.0005, lon: 0.0002 }, { lat: 0.0005, lon: 0.0008 }, O, E);
    expect(d).toBeCloseTo(55.6, 1);
  });

  it('measures end-clamped separation to the nearest endpoint', () => {
    // 0.001 deg of longitude at the equator = 111.2 m past E
    const d = segmentDistanceM({ lat: 0, lon: 0.002 }, { lat: 0, lon: 0.003 }, O, E);
    expect(d).toBeCloseTo(111.2, 1);
  });

  it('is symmetric in its arguments', () => {
    const a1 = { lat: 0.0003, lon: 0.002 };
    const a2 = { lat: 0.0004, lon: 0.003 };
    expect(segmentDistanceM(a1, a2, O, E)).toBeCloseTo(segmentDistanceM(O, E, a1, a2), 6);
  });
});

describe('#1881 bridgesPassed', () => {
  it('returns the bridge for a leg crossing the passage line, sail or motor', () => {
    expect(bridgesPassed([crossing('sail')])).toEqual([KC]);
    expect(bridgesPassed([crossing('motor')])).toEqual([KC]);
  });

  it('pins both sides of BRIDGE_PASS_M with parallel legs', () => {
    expect(BRIDGE_PASS_M).toBe(50);
    expect(bridgesPassed([eastWestAt(LINE_LAT + LAT_48_9M)])).toEqual([KC]);
    expect(bridgesPassed([eastWestAt(LINE_LAT - LAT_48_9M)])).toEqual([KC]);
    expect(bridgesPassed([eastWestAt(LINE_LAT + LAT_51_2M)])).toEqual([]);
    expect(bridgesPassed([eastWestAt(LINE_LAT - LAT_51_2M)])).toEqual([]);
  });

  it('counts a leg ending exactly on the line and a vertex touching it', () => {
    const onLine: LatLon = { lat: LINE_LAT, lon: 9.7830141 };
    expect(bridgesPassed([leg(SOUTH_OF_SPAN, onLine)])).toEqual([KC]);
    expect(bridgesPassed([leg(onLine, NORTH_OF_SPAN)])).toEqual([KC]);
  });

  it('counts a leg that runs along the line itself', () => {
    expect(bridgesPassed([leg(KC.passageLine.a, KC.passageLine.b)])).toEqual([KC]);
  });

  it('lists a bridge once however many legs reach it', () => {
    expect(
      bridgesPassed([crossing(), leg(SOUTH_OF_SPAN, NORTH_OF_SPAN), crossing('motor')]),
    ).toEqual([KC]);
  });

  it('orders bridges by the first leg that reaches them', () => {
    const far: OpeningBridge = {
      ...KC,
      id: 'far',
      passageLine: {
        a: { lat: 54.95, lon: KC.passageLine.a.lon },
        b: { lat: 54.95, lon: KC.passageLine.b.lon },
      },
    };
    const toFar = leg({ lat: 54.96, lon: 9.7830141 }, { lat: 54.94, lon: 9.7830141 });
    expect(bridgesPassed([crossing(), toFar], [far, KC]).map((b) => b.id)).toEqual([KC.id, 'far']);
    expect(bridgesPassed([toFar, crossing()], [KC, far]).map((b) => b.id)).toEqual(['far', KC.id]);
  });

  it('is empty for no legs', () => {
    expect(bridgesPassed(null)).toEqual([]);
    expect(bridgesPassed(undefined)).toEqual([]);
    expect(bridgesPassed([])).toEqual([]);
  });

  it('is empty for a route 2 km away and for one that never reaches the line', () => {
    expect(bridgesPassed([eastWestAt(LINE_LAT + 0.018)])).toEqual([]);
    expect(bridgesPassed([leg({ lat: 54.9046, lon: 9.7833 }, SOUTH_OF_SPAN)])).toEqual([]);
  });

  it('ignores a non-finite coordinate without throwing', () => {
    const bad = leg({ lat: Number.NaN, lon: 9.7830141 }, SOUTH_OF_SPAN);
    expect(bridgesPassed([bad])).toEqual([]);
    expect(bridgesPassed([bad, crossing()])).toEqual([KC]);
  });
});
