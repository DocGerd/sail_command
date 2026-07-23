import { describe, it, expect } from 'vitest';
import { AIS_VECTOR_MINUTES, aisFeatureCollection, aisPopupRows } from './aisGeoJson';
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
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: 'ALBATROS' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.shipType', value: '36' },
      { labelKey: 'ais.popup.sog', value: '6.3 kn' },
      { labelKey: 'ais.popup.cog', value: '091°' },
      { labelKey: 'ais.popup.age', value: '2 min' },
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
    );
    expect(rows).toEqual([
      { labelKey: 'ais.popup.name', value: '211234560' },
      { labelKey: 'ais.popup.mmsi', value: '211234560' },
      { labelKey: 'ais.popup.age', value: '0 min' },
    ]);
  });
});
