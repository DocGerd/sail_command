import { describe, expect, it } from 'vitest';
import { AIS_VECTOR_MINUTES } from './aisGeoJson';
import { PROJECTION_VECTOR_MINUTES } from './projectionVector';
import { OWNSHIP_VECTOR_MIN_SOG_KN, ownshipVectorGeoJson } from './ownshipVector';

// Expected endpoints below are hand-derived (movable-type spherical destination
// formula, R = 3440.065 nm, computed independently in Python — NOT read off the
// implementation) and cross-checked against flat-earth approximations:
// e.g. case A: 0.6 nm at 45° → Δlat = 0.6·cos45°/60 ≈ 0.00707°,
// Δlon = 0.6·sin45°/(60·cos54.8°) ≈ 0.01227°.

function lineFeatures(fc: GeoJSON.FeatureCollection): GeoJSON.Feature[] {
  return fc.features;
}

describe('ownshipVectorGeoJson (#141)', () => {
  it('projects a single 6-min LineString from the fix along COG (6 kn @ 45° = 0.6 nm)', () => {
    const fc = ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, 45, 6);
    const features = lineFeatures(fc);
    expect(features).toHaveLength(1);
    const geom = features[0].geometry as GeoJSON.LineString;
    expect(geom.type).toBe('LineString');
    // Start = the fix position, exactly.
    expect(geom.coordinates[0]).toEqual([9.5, 54.8]);
    // End pinned from the independent hand computation.
    expect(geom.coordinates[1][0]).toBeCloseTo(9.512261, 6);
    expect(geom.coordinates[1][1]).toBeCloseTo(54.807066, 6);
  });

  it('length scales with SOG (5 kn due east = 0.5 nm)', () => {
    const fc = ownshipVectorGeoJson({ lat: 54.79, lon: 9.43 }, 90, 5);
    const geom = lineFeatures(fc)[0].geometry as GeoJSON.LineString;
    expect(geom.coordinates[1][0]).toBeCloseTo(9.444443, 6);
    // Great-circle due-east track: latitude essentially unchanged.
    expect(geom.coordinates[1][1]).toBeCloseTo(54.789999, 6);
  });

  it('renders at exactly the threshold SOG (0.5 kn @ 180° = 0.05 nm south)', () => {
    const fc = ownshipVectorGeoJson({ lat: 54.5, lon: 10.0 }, 180, OWNSHIP_VECTOR_MIN_SOG_KN);
    const features = lineFeatures(fc);
    expect(features).toHaveLength(1);
    const geom = features[0].geometry as GeoJSON.LineString;
    expect(geom.coordinates[1][0]).toBeCloseTo(10.0, 6);
    expect(geom.coordinates[1][1]).toBeCloseTo(54.499167, 6);
  });

  it('suppresses when the device reports no COG (cogDeg null)', () => {
    expect(lineFeatures(ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, null, 6))).toHaveLength(0);
  });

  it('suppresses when the device reports no SOG (sogKn null)', () => {
    expect(lineFeatures(ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, 45, null))).toHaveLength(0);
  });

  it('suppresses below the noise floor (0.4 kn and 0 kn — GPS course is noise at rest)', () => {
    expect(lineFeatures(ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, 45, 0.4))).toHaveLength(0);
    expect(lineFeatures(ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, 45, 0))).toHaveLength(0);
  });

  it('suppresses when both COG and SOG are missing', () => {
    expect(lineFeatures(ownshipVectorGeoJson({ lat: 54.8, lon: 9.5 }, null, null))).toHaveLength(0);
  });

  it('pins the shared 6-minute convention and the ownship noise floor', () => {
    // One constant, structurally shared with the AIS vectors — parity by
    // construction, not by two literals that could drift.
    expect(PROJECTION_VECTOR_MINUTES).toBe(6);
    expect(AIS_VECTOR_MINUTES).toBe(PROJECTION_VECTOR_MINUTES);
    // Device-GPS noise floor (#141): AIS uses sog > 0 (quantized shipborne
    // data); raw device GPS jitters at rest, so ownship needs a real floor.
    expect(OWNSHIP_VECTOR_MIN_SOG_KN).toBe(0.5);
  });
});
