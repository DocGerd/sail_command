import { describe, expect, it } from 'vitest';
import { MAX_HEADSAILS } from '../data/boats';
import { DEFAULT_SETTINGS, PLAN_SCHEMA_VERSION } from '../types';
import { migratePlan } from './migratePlan';

const HEALTHY_LEG = {
  kind: 'motor',
  board: null,
  start: { lat: 54.79, lon: 9.43 },
  end: { lat: 54.85, lon: 10.51 },
  startTimeMs: 1_700_003_600_000,
  endTimeMs: 1_700_007_200_000,
  headingDeg: 90,
  twsKn: 8,
  speedKn: 6.5,
  distanceNm: 12.5,
  maneuverAtStart: null,
};

function rig(sailId: string, etaMs: number): Record<string, unknown> {
  return {
    sailId,
    reason: null,
    result: {
      sailId,
      legs: [{ ...HEALTHY_LEG }],
      etaMs,
      durationMs: 3_600_000,
      distanceNm: 12.5,
      maneuverCount: 2,
      motorDistanceNm: 1.5,
    },
  };
}

function snapshot(sailIds: readonly string[]): Record<string, unknown> {
  return {
    id: 'gone-45',
    name: 'Gone 45',
    draftM: 2.4,
    sails: sailIds.map((id) => ({
      id,
      label: id,
      polarProvenance: { tier: 'estimated', note: 'n' },
    })),
  };
}

// Off-catalogue boat: `sailIsSafe` passes every id, so only the cap can refuse a stored list.
function modernPlan(sailIds: readonly string[], resultSails: readonly string[]) {
  return {
    id: 'p1',
    name: 'p1',
    createdAtMs: 1_700_000_000_000,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.51 },
      viaPoints: [],
      departureMs: 1_700_003_600_000,
      settings: { ...DEFAULT_SETTINGS },
      boat: snapshot(resultSails),
      sailIds,
    },
    windGrid: { lats: [54], lons: [9], timesMs: [1000] },
    result: {
      status: 'ok',
      recommended: resultSails[0],
      comparisonComplete: true,
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.51 },
      sails: resultSails.map((id, i) => rig(id, 2_000_000 + i)),
    },
  };
}

describe('#1661 migratePlan: aboard inventory, pre-trip scope', () => {
  it('a stored sailIds longer than MAX_HEADSAILS takes the fallback reconstruction', () => {
    const over = Array.from({ length: MAX_HEADSAILS + 1 }, (_, i) => `s${i}`);
    const resultSails = ['s0', 's1'];
    const migrated = migratePlan(modernPlan(over, resultSails));
    expect(migrated).not.toBeNull();
    expect(migrated!.request.sailIds).toEqual(resultSails);
  });

  it('CONTROL: a stored sailIds at exactly MAX_HEADSAILS is kept as stored', () => {
    const at = ['s1', 's0'].slice(0, MAX_HEADSAILS);
    const migrated = migratePlan(modernPlan(at, ['s0', 's1']));
    expect(migrated!.request.sailIds).toEqual(at);
  });

  it('a record without the new fields reads exactly as the pre-R10 function read it', () => {
    // Literal captured by running migratePlan at e3ca6c86 (before this change) on this fixture.
    const BASE_OUTPUT = {
      id: 'p1',
      name: 'p1',
      createdAtMs: 1700000000000,
      schemaVersion: 1,
      request: {
        origin: { lat: 54.79, lon: 9.43 },
        destination: { lat: 54.85, lon: 10.51 },
        viaPoints: [],
        departureMs: 1700003600000,
        settings: {
          safetyDepthM: 3,
          depthComfortMarginM: 2,
          motorSpeedKn: 6.5,
          motorThresholdKn: 2.5,
          sailPreferenceKn: 2.8,
          maneuverPenaltyS: 45,
          performanceFactor: 0.9,
          motorEnabled: true,
          showOwnship: false,
        },
        boat: {
          id: 'gone-45',
          name: 'Gone 45',
          draftM: 2.4,
          sails: [
            { id: 's0', label: 's0', polarProvenance: { tier: 'estimated', note: 'n' } },
            { id: 's1', label: 's1', polarProvenance: { tier: 'estimated', note: 'n' } },
          ],
        },
        sailIds: ['s0', 's1'],
      },
      windGrid: { lats: [54], lons: [9], timesMs: [1000] },
      result: {
        status: 'ok',
        sails: [
          {
            sailId: 's0',
            result: {
              legs: [
                {
                  kind: 'motor',
                  board: null,
                  start: { lat: 54.79, lon: 9.43 },
                  end: { lat: 54.85, lon: 10.51 },
                  startTimeMs: 1700003600000,
                  endTimeMs: 1700007200000,
                  headingDeg: 90,
                  twsKn: 8,
                  speedKn: 6.5,
                  distanceNm: 12.5,
                  maneuverAtStart: null,
                },
              ],
              etaMs: 2000000,
              durationMs: 3600000,
              distanceNm: 12.5,
              maneuverCount: 2,
              motorDistanceNm: 1.5,
              sailId: 's0',
            },
            reason: null,
          },
          {
            sailId: 's1',
            result: {
              legs: [
                {
                  kind: 'motor',
                  board: null,
                  start: { lat: 54.79, lon: 9.43 },
                  end: { lat: 54.85, lon: 10.51 },
                  startTimeMs: 1700003600000,
                  endTimeMs: 1700007200000,
                  headingDeg: 90,
                  twsKn: 8,
                  speedKn: 6.5,
                  distanceNm: 12.5,
                  maneuverAtStart: null,
                },
              ],
              etaMs: 2000001,
              durationMs: 3600000,
              distanceNm: 12.5,
              maneuverCount: 2,
              motorDistanceNm: 1.5,
              sailId: 's1',
            },
            reason: null,
          },
        ],
        recommended: 's0',
        comparisonComplete: true,
        snappedOrigin: { lat: 54.79, lon: 9.43 },
        snappedDestination: { lat: 54.85, lon: 10.51 },
      },
    };
    const raw = modernPlan(['s0', 's1'], ['s0', 's1']);
    const before = JSON.stringify(raw);
    const migrated = migratePlan(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(JSON.parse(JSON.stringify(migrated))).toEqual(BASE_OUTPUT);
  });

  it('a one-sail plan round-trips', () => {
    const migrated = migratePlan(modernPlan(['s0'], ['s0']))!;
    expect(migrated.request.sailIds).toEqual(['s0']);
    expect(migrated.request.boat.sails).toHaveLength(1);
    expect(migrated.result.sails.map((s) => s.sailId)).toEqual(['s0']);
    expect(migratePlan(migrated)).toEqual(migrated);
  });

  it('smoke: an unreadable record makes migratePlan return null rather than throw (listing: db.test.ts:452)', () => {
    const noRecommended = modernPlan(['s0'], ['s0']);
    noRecommended.result.recommended = 's9';
    expect(migratePlan(noRecommended)).toBeNull();
    expect(
      migratePlan({ ...modernPlan(['s0'], ['s0']), schemaVersion: PLAN_SCHEMA_VERSION + 1 }),
    ).toBeNull();
  });
});
