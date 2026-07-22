import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type Plan, type Rig, type RigResult } from '../types';
import { uniformWindGrid } from '../test/fixtures';
import { formatDateTime } from './format';
import { averageSpeedKn, resultSummary } from './resultSummary';

const DEPARTURE_MS = Date.UTC(2026, 6, 15, 8, 0, 0);

function makePlan(recommended: Rig): Plan {
  return {
    id: 'plan-1',
    name: 'Test',
    createdAtMs: DEPARTURE_MS,
    request: {
      origin: { lat: 54.79, lon: 9.43 },
      destination: { lat: 54.85, lon: 10.52 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs: DEPARTURE_MS,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs: DEPARTURE_MS },
    result: {
      status: 'ok',
      genoa: null,
      fock: null,
      genoaReason: null,
      fockReason: null,
      recommended,
      snappedOrigin: { lat: 54.79, lon: 9.43 },
      snappedDestination: { lat: 54.85, lon: 10.52 },
    },
  };
}

function rigResult(over: Partial<RigResult>): RigResult {
  return {
    rig: 'genoa',
    legs: [],
    etaMs: DEPARTURE_MS + 5 * 3_600_000,
    durationMs: 5 * 3_600_000,
    distanceNm: 21.5,
    maneuverCount: 1,
    motorDistanceNm: 5,
    ...over,
  };
}

describe('averageSpeedKn', () => {
  it('divides distance by duration in hours', () => {
    // 21.5 nm over 5 h = 4.3 kn (hand-derived).
    expect(averageSpeedKn(21.5, 5 * 3_600_000)).toBeCloseTo(4.3, 10);
  });

  it('returns 0 for a zero-duration result (no divide-by-zero)', () => {
    expect(averageSpeedKn(0, 0)).toBe(0);
    expect(averageSpeedKn(10, 0)).toBe(0);
  });
});

describe('resultSummary', () => {
  it('derives avg speed, distance and duration text from a mixed sail/motor result', () => {
    const summary = resultSummary(makePlan('genoa'), rigResult({}), 'en');
    // 21.5 nm / 5 h = 4.3 kn.
    expect(summary.avgSpeedKn).toBeCloseTo(4.3, 10);
    expect(summary.avgSpeedText).toBe('4.3 kn');
    expect(summary.distanceText).toBe('21.5 nm');
    expect(summary.durationText).toBe('5 h 00 min');
  });

  it('delegates arrival formatting to formatDateTime with the active locale', () => {
    const result = rigResult({});
    const summary = resultSummary(makePlan('genoa'), result, 'en');
    // Delegation check (formatDateTime is separately tested); TZ-independent
    // because both sides format the same instant with the same locale.
    expect(summary.arrivalText).toBe(formatDateTime(result.etaMs, 'en'));
  });

  it('splits sail vs motor: sailNm = distance - motor, integer percents summing to 100', () => {
    const summary = resultSummary(makePlan('genoa'), rigResult({}), 'en');
    // 21.5 total, 5 motor -> 16.5 sail. 5/21.5 = 0.23256 -> 23 %, sail 77 %.
    expect(summary.sailNm).toBe(16.5);
    expect(summary.motorNm).toBe(5);
    expect(summary.motorFraction).toBeCloseTo(0.232558, 5);
    expect(summary.sailFraction).toBeCloseTo(0.767442, 5);
    expect(summary.motorPct).toBe(23);
    expect(summary.sailPct).toBe(77);
    expect(summary.sailPct + summary.motorPct).toBe(100);
  });

  it('derives sailPct as the complement of motorPct (not independent rounding)', () => {
    // distance 8, motor 1: motor 1/8 = 12.5 % -> round 13 %; sail = 100 - 13 = 87 %.
    // Independent rounding of the sail fraction (7/8 = 87.5 %) would round to 88,
    // giving a bogus 13 + 88 = 101 %. The complement design pins sail to 87.
    const summary = resultSummary(
      makePlan('genoa'),
      rigResult({ distanceNm: 8, motorDistanceNm: 1 }),
      'en',
    );
    expect(summary.motorPct).toBe(13);
    expect(summary.sailPct).toBe(87);
    expect(summary.sailPct + summary.motorPct).toBe(100);
  });

  it('all-motor result: 100 % motor, 0 % sail', () => {
    const summary = resultSummary(
      makePlan('genoa'),
      rigResult({ distanceNm: 10, motorDistanceNm: 10, durationMs: 2 * 3_600_000 }),
      'en',
    );
    expect(summary.sailNm).toBe(0);
    expect(summary.motorNm).toBe(10);
    expect(summary.motorPct).toBe(100);
    expect(summary.sailPct).toBe(0);
    expect(summary.avgSpeedText).toBe('5.0 kn');
  });

  it('all-sail result: 0 % motor, 100 % sail', () => {
    const summary = resultSummary(
      makePlan('genoa'),
      rigResult({ distanceNm: 12, motorDistanceNm: 0, durationMs: 3 * 3_600_000 }),
      'en',
    );
    expect(summary.sailNm).toBe(12);
    expect(summary.motorNm).toBe(0);
    expect(summary.motorPct).toBe(0);
    expect(summary.sailPct).toBe(100);
    expect(summary.avgSpeedText).toBe('4.0 kn');
  });

  it('zero-distance result: both percents 0, no NaN fractions', () => {
    const summary = resultSummary(
      makePlan('genoa'),
      rigResult({ distanceNm: 0, motorDistanceNm: 0, durationMs: 0 }),
      'en',
    );
    expect(summary.sailPct).toBe(0);
    expect(summary.motorPct).toBe(0);
    expect(summary.sailFraction).toBe(0);
    expect(summary.motorFraction).toBe(0);
    expect(summary.avgSpeedKn).toBe(0);
  });

  it('reports the recommended (faster) rig and its label key, independent of the shown result', () => {
    // The shown result is a genoa RigResult, but the plan recommends fock.
    const summary = resultSummary(makePlan('fock'), rigResult({}), 'en');
    expect(summary.recommendedRig).toBe('fock');
    expect(summary.recommendedRigLabelKey).toBe('route.rig.fock');
  });
});
