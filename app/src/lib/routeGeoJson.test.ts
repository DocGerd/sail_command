import { describe, it, expect } from 'vitest';
import { legsToFeatureCollection, maneuverFeatures, barbFeatures } from './routeGeoJson';
import { makeWindGrid } from '../test/fixtures';
import type { Leg } from '../types';

const SAIL_LEG: Leg = {
  kind: 'sail',
  board: 'starboard',
  start: { lat: 54.8, lon: 9.5 },
  end: { lat: 54.85, lon: 9.6 },
  startTimeMs: 0,
  endTimeMs: 3_600_000,
  headingDeg: 90,
  twaDeg: 80,
  twsKn: 12,
  speedKn: 6.5,
  distanceNm: 5,
  maneuverAtStart: null,
};

const TACK_LEG: Leg = {
  kind: 'sail',
  board: 'port',
  start: { lat: 54.85, lon: 9.6 },
  end: { lat: 54.9, lon: 9.65 },
  startTimeMs: 3_600_000,
  endTimeMs: 7_200_000,
  headingDeg: 340,
  twaDeg: -60,
  twsKn: 12,
  speedKn: 6.0,
  distanceNm: 4,
  maneuverAtStart: 'tack',
};

const MOTOR_LEG: Leg = {
  kind: 'motor',
  board: null,
  start: { lat: 54.9, lon: 9.65 },
  end: { lat: 54.92, lon: 9.7 },
  startTimeMs: 7_200_000,
  endTimeMs: 9_000_000,
  headingDeg: 45,
  twsKn: 1,
  speedKn: 6.5,
  distanceNm: 2,
  maneuverAtStart: null,
};

describe('legsToFeatureCollection', () => {
  it('emits one LineString feature per leg, coordinates in [lon, lat] order', () => {
    const fc = legsToFeatureCollection([SAIL_LEG]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [9.5, 54.8],
        [9.6, 54.85],
      ],
    });
  });

  it('tags a sail leg with its kind, board and maneuver', () => {
    const fc = legsToFeatureCollection([TACK_LEG]);
    expect(fc.features[0].properties).toEqual({ kind: 'sail', board: 'port', maneuver: 'tack' });
  });

  it('tags a motor leg with board null and maneuver null', () => {
    const fc = legsToFeatureCollection([MOTOR_LEG]);
    expect(fc.features[0].properties).toEqual({ kind: 'motor', board: null, maneuver: null });
  });

  it('returns an empty feature collection for no legs', () => {
    expect(legsToFeatureCollection([])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

describe('maneuverFeatures', () => {
  it('emits a Point at the start of each maneuvering leg, tagged with the maneuver kind', () => {
    const fc = maneuverFeatures([SAIL_LEG, TACK_LEG, MOTOR_LEG]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [9.6, 54.85] });
    expect(fc.features[0].properties).toEqual({ kind: 'tack' });
  });

  it('is empty when no leg carries a maneuver', () => {
    expect(maneuverFeatures([SAIL_LEG, MOTOR_LEG]).features).toHaveLength(0);
  });
});

describe('barbFeatures', () => {
  // 5x5 grid (lat 54.0..54.4, lon 9.0..9.4, step 0.1), 3 hourly steps.
  // speedKn == hourIdx + 1 at every node so the "nearest hour" tests can
  // read the selected hour straight off the returned value.
  const grid = makeWindGrid((lat, lon, hourIdx) => ({ speedKn: hourIdx + 1, dirFromDeg: (lat + lon) % 360 }), {
    south: 54.0,
    north: 54.4,
    west: 9.0,
    east: 9.4,
    latStep: 0.1,
    lonStep: 0.1,
    hours: 3,
    t0Ms: 0,
  });

  it('samples every stride-th grid node (stride 2 over 5x5 -> 3x3)', () => {
    expect(barbFeatures(grid, 0, 2).features).toHaveLength(9);
  });

  it('defaults stride to 2 when omitted', () => {
    expect(barbFeatures(grid, 0).features).toHaveLength(9);
  });

  it('stride 1 samples every node', () => {
    expect(barbFeatures(grid, 0, 1).features).toHaveLength(25);
  });

  it('stride 5 over a 5-wide axis samples only the first node per axis', () => {
    const fc = barbFeatures(grid, 0, 5);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry.coordinates).toEqual([9.0, 54.0]);
  });

  it('selects the nearest forecast hour to tMs (just before/after hour 1)', () => {
    const before = barbFeatures(grid, 3_600_000 - 1000, 1);
    const after = barbFeatures(grid, 3_600_000 + 1000, 1);
    expect(before.features[0].properties.speedKn).toBe(2); // hour index 1
    expect(after.features[0].properties.speedKn).toBe(2);
  });

  it('picks the earlier hour on an exact tie at the midpoint', () => {
    const midpoint = 1_800_000; // exactly between hour 0 (t=0) and hour 1 (t=3_600_000)
    expect(barbFeatures(grid, midpoint, 1).features[0].properties.speedKn).toBe(1); // hour index 0
  });

  it('carries speedKn and dirFromDeg from the grid at the selected node', () => {
    const fc = barbFeatures(grid, 0, 5);
    expect(fc.features[0].properties).toEqual({ speedKn: 1, dirFromDeg: 63 });
  });
});
