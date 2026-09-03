import { describe, it, expect } from 'vitest';
import {
  AIS_VECTOR_MINUTES,
  aisFeatureCollection,
  aisPopupRows,
  aisTargetsInView,
  type AisViewportBounds,
} from './aisGeoJson';
import { destinationPoint } from './geo';
import type { AisTargetSnapshot } from './aisTargets';

function target(overrides: Partial<AisTargetSnapshot>): AisTargetSnapshot {
  return {
    mmsi: '211234560',
    position: { lat: 54.79, lon: 9.43 },
    lastUpdateMs: 1000,
    tier: 'fresh',
    ...overrides,
  };
}

describe('aisFeatureCollection', () => {
  it('emits a vessel Point rotated to true heading, with course available', () => {
    const fc = aisFeatureCollection([target({ headingDeg: 90, cogDeg: 80, sogKn: 0 })]);
    const vessel = fc.features.find((f) => f.geometry.type === 'Point');
    expect(vessel?.properties).toMatchObject({
      mmsi: '211234560',
      kind: 'vessel',
      tier: 'fresh',
      hasCourse: true,
      rotation: 90,
    });
  });

  it('falls back to COG for rotation when true heading is absent', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 80, sogKn: 0 })]);
    const vessel = fc.features.find((f) => f.geometry.type === 'Point');
    expect(vessel?.properties).toMatchObject({ hasCourse: true, rotation: 80 });
  });

  it('marks a target with neither heading nor COG as course-less (rotation 0, no vector)', () => {
    const fc = aisFeatureCollection([target({ sogKn: 5 })]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].properties).toMatchObject({ hasCourse: false, rotation: 0 });
  });

  it('adds a COG vector LineString of 6 minutes at SOG when moving with a course', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 90, sogKn: 6 })]);
    const vector = fc.features.find((f) => f.geometry.type === 'LineString');
    expect(vector?.properties).toMatchObject({ mmsi: '211234560', kind: 'vector', tier: 'fresh' });
    // 6 kn for 6 min = 0.6 nm along COG 90 from the vessel position.
    const end = destinationPoint({ lat: 54.79, lon: 9.43 }, 90, (6 * AIS_VECTOR_MINUTES) / 60);
    const coords = (vector?.geometry as GeoJSON.LineString).coordinates;
    expect(coords[0]).toEqual([9.43, 54.79]);
    expect(coords[1][0]).toBeCloseTo(end.lon, 6);
    expect(coords[1][1]).toBeCloseTo(end.lat, 6);
  });

  it('suppresses the vector when SOG is zero', () => {
    const fc = aisFeatureCollection([target({ cogDeg: 90, sogKn: 0 })]);
    expect(fc.features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(0);
  });

  it('labels with the name, falling back to the MMSI when unnamed', () => {
    const named = aisFeatureCollection([target({ name: 'ALBATROS' })]);
    const unnamed = aisFeatureCollection([target({})]);
    expect(named.features[0].properties?.label).toBe('ALBATROS');
    expect(unnamed.features[0].properties?.label).toBe('211234560');
  });

  it('propagates the stale tier to both the vessel and its vector', () => {
    const fc = aisFeatureCollection([target({ tier: 'stale', cogDeg: 90, sogKn: 6 })]);
    expect(fc.features.every((f) => f.properties?.tier === 'stale')).toBe(true);
  });
});

describe('aisPopupRows', () => {
  it('builds localized rows from a moving, named target', () => {
    const rows = aisPopupRows(
      {
        mmsi: '211234560',
        name: 'ALBATROS',
        shipType: 36,
        sog: 6.3,
        cog: 91.4,
        heading: 90,
        lastUpdateMs: 0,
      },
      120_000, // 2 minutes later
      'en',
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: 'ALBATROS' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.shipType', value: '36' },
      { labelKey: 'ais.popup.sog', value: '6.3 kn' },
      { labelKey: 'ais.popup.cog', value: '091°' },
      { labelKey: 'ais.popup.age', value: '2 min ago' },
    ]);
  });

  it('omits absent fields and uses the MMSI as the name fallback', () => {
    const rows = aisPopupRows(
      {
        mmsi: '211234560',
        name: '',
        shipType: null,
        sog: null,
        cog: null,
        heading: null,
        lastUpdateMs: 0,
      },
      30_000,
      'en',
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: '211234560' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.age', value: '0 min ago' },
    ]);
  });

  // #709: the German age value must carry 'vor' on the VALUE side of the
  // popup's `${label}: ${value}` composition (AisLayer.tsx) — the DE label
  // is bare 'Letztes Signal' precisely so this doesn't strand 'vor' on the
  // wrong side of the colon, unlike the pre-#709 'Letztes Signal vor: 2 min'.
  it('builds the German age value with "vor" prefixed, matching the label composition', () => {
    const rows = aisPopupRows(
      {
        mmsi: '211234560',
        name: 'ALBATROS',
        shipType: null,
        sog: null,
        cog: null,
        heading: null,
        lastUpdateMs: 0,
      },
      120_000, // 2 minutes later
      'de',
    );
    const ageRow = rows.find((r) => r.labelKey === 'ais.popup.age');
    expect(ageRow?.value).toBe('vor 2 min');
  });
});

// #831: the keyboard-reachable "AIS vessels in view" list's population
// filter — RED at BASE (aisTargetsInView does not exist there), GREEN at
// HEAD.
describe('aisTargetsInView', () => {
  const VIEWPORT: AisViewportBounds = {
    west: 9.4,
    south: 54.3,
    east: 10.0,
    north: 54.9,
    centerLon: 9.7,
    centerLat: 54.6,
  };

  it('excludes a target outside the viewport bounds on all four sides', () => {
    // All four bounds are checked independently — a mutant dropping any one
    // (e.g. south) would pass a "north + west only" version of this test,
    // which is exactly the #518-shaped multi-assertion-pin trap CLAUDE.md
    // documents (delete each assertion one at a time to prove it's load-
    // bearing). Verified: deleting the `>= viewport.south` clause alone
    // makes ONLY the south row below fail; every other row stays green.
    const inside = target({ mmsi: 'inside', position: { lat: 54.6, lon: 9.7 } });
    const tooFarNorth = target({ mmsi: 'north', position: { lat: 55.5, lon: 9.7 } });
    const tooFarSouth = target({ mmsi: 'south', position: { lat: 53.0, lon: 9.7 } });
    const tooFarWest = target({ mmsi: 'west', position: { lat: 54.6, lon: 9.0 } });
    const tooFarEast = target({ mmsi: 'east', position: { lat: 54.6, lon: 10.5 } });
    const result = aisTargetsInView(
      [inside, tooFarNorth, tooFarSouth, tooFarWest, tooFarEast],
      VIEWPORT,
    );
    expect(result.targets.map((t) => t.mmsi)).toEqual(['inside']);
    expect(result.total).toBe(1);
  });

  it('orders targets nearest-to-centre first', () => {
    const far = target({ mmsi: 'far', position: { lat: 54.35, lon: 9.45 } });
    const near = target({ mmsi: 'near', position: { lat: 54.61, lon: 9.71 } });
    const mid = target({ mmsi: 'mid', position: { lat: 54.7, lon: 9.8 } });
    const result = aisTargetsInView([far, near, mid], VIEWPORT);
    expect(result.targets.map((t) => t.mmsi)).toEqual(['near', 'mid', 'far']);
  });

  it('caps the returned list at max while total counts the whole in-view set', () => {
    const targets = Array.from({ length: 5 }, (_, i) =>
      target({ mmsi: `t${i}`, position: { lat: 54.6, lon: 9.5 + i * 0.01 } }),
    );
    const result = aisTargetsInView(targets, VIEWPORT, 2);
    expect(result.targets).toHaveLength(2);
    expect(result.total).toBe(5);
  });

  it('handles an antimeridian-wrapped viewport (west > east)', () => {
    const wrapped: AisViewportBounds = { ...VIEWPORT, west: 179.5, east: -179.5 };
    const insideWrap = target({ mmsi: 'wrap-in', position: { lat: 54.6, lon: 179.9 } });
    const outsideWrap = target({ mmsi: 'wrap-out', position: { lat: 54.6, lon: 0 } });
    const result = aisTargetsInView([insideWrap, outsideWrap], wrapped);
    expect(result.targets.map((t) => t.mmsi)).toEqual(['wrap-in']);
  });

  it('returns an empty result for an empty target list', () => {
    const result = aisTargetsInView([], VIEWPORT);
    expect(result).toEqual({ targets: [], total: 0 });
  });
});
