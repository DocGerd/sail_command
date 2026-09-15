import { describe, expect, it } from 'vitest';
import { migratePlan } from './migratePlan';
import { DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION, defaultBoatSnapshot } from '../types';

// #885 §5.1 / §7 persistence. A modern (post-#54) stored record, built as a bare
// record because the rows below damage it in ways today's Plan type forbids.
const LEG = {
  kind: 'motor',
  board: null,
  start: { lat: 54.79, lon: 9.43 },
  end: { lat: 54.8, lon: 9.5 },
  startTimeMs: 1_700_003_600_000,
  endTimeMs: 1_700_007_200_000,
  headingDeg: 90,
  twsKn: 8,
  speedKn: 6.5,
  distanceNm: 4,
  maneuverAtStart: null,
  forced: true,
};

function storedPlan(
  requestExtra: Record<string, unknown>,
  leg: Record<string, unknown> = LEG,
): Record<string, unknown> {
  const result = {
    sailId: 'genoa',
    legs: [{ ...leg }],
    etaMs: 1_700_007_200_000,
    durationMs: 3_600_000,
    distanceNm: 4,
    maneuverCount: 0,
    motorDistanceNm: 4,
  };
  return {
    id: 'p1',
    name: 'Flensburg → Glücksburg',
    createdAtMs: 1_700_000_000_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.84, lon: 9.52 },
      viaPoints: [{ lat: 54.82, lon: 9.45 }],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: 1_700_003_600_000,
      settings: { ...DEFAULT_SETTINGS },
      sailIds: ['genoa'],
      boat: defaultBoatSnapshot(),
      ...requestExtra,
    },
    windGrid: { lats: [], lons: [], timesMs: [], fetchedAtMs: 0, model: 'test' },
    result: {
      status: 'ok',
      sails: [{ sailId: 'genoa', result, reason: null }],
      recommended: 'genoa',
      comparisonComplete: true,
      rigRecommendation: { kind: 'not-compared' },
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.84, lon: 9.52 },
    },
  };
}

describe('#885 migratePlan: segmentModes and forced legs', () => {
  it('round-trips segmentModes and a forced leg', () => {
    const migrated = migratePlan(storedPlan({ segmentModes: ['motor', null] }));
    expect(migrated).not.toBeNull();
    expect(migrated!.request.segmentModes).toEqual(['motor', null]);
    expect(migrated!.result.sails[0]!.result!.legs[0]!.forced).toBe(true);
  });

  it('an absent segmentModes stays absent (no overrides, no migration)', () => {
    const migrated = migratePlan(storedPlan({}));
    expect(migrated).not.toBeNull();
    expect('segmentModes' in migrated!.request).toBe(false);
  });

  it.each([
    ['too short', []],
    ['too long', [null, null, null]],
    ['not an array', 'motor'],
    ['an unknown mode', ['engine', null]],
  ])('refuses a record whose segmentModes is %s', (_n, modes) => {
    expect(migratePlan(storedPlan({ segmentModes: modes }))).toBeNull();
  });

  it.each([false, 'true', 1, null])('refuses a leg whose forced is %s', (forced) => {
    expect(migratePlan(storedPlan({}, { ...LEG, forced }))).toBeNull();
  });

  it('admits a stored calm-sail-only per-sail reason', () => {
    const raw = storedPlan({ sailIds: ['genoa', 'fock'] });
    const result = raw.result as Record<string, unknown>;
    result.sails = [
      ...(result.sails as unknown[]),
      { sailId: 'fock', result: null, reason: 'calm-sail-only' },
    ];
    const migrated = migratePlan(raw);
    expect(migrated!.result.sails[1]!.reason).toBe('calm-sail-only');
  });
});
