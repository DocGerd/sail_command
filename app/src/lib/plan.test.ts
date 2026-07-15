import { describe, it, expect } from 'vitest';
import { isStaleForecast, activeRigResult } from './plan';
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Plan } from '../types';

function makePlan(departureMs: number, fetchedAtMs: number): Plan {
  return {
    id: 'plan-1',
    name: 'Test Plan',
    createdAtMs: fetchedAtMs,
    request: {
      origin: { lat: 54.8, lon: 9.5 },
      destination: { lat: 54.9, lon: 9.7 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs,
      settings: DEFAULT_SETTINGS,
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs },
    result: {
      status: 'ok',
      recommended: 'genoa',
      snappedOrigin: { lat: 54.8, lon: 9.5 },
      snappedDestination: { lat: 54.9, lon: 9.7 },
      genoa: {
        rig: 'genoa',
        legs: [],
        etaMs: departureMs + 3_600_000,
        durationMs: 3_600_000,
        distanceNm: 5,
        maneuverCount: 0,
        motorDistanceNm: 0,
      },
      fock: null,
      genoaReason: null,
      fockReason: 'unreachable',
    },
  };
}

describe('isStaleForecast', () => {
  const fetchedAtMs = Date.UTC(2026, 6, 15, 6, 0, 0);

  it('is false when the fetch-to-departure gap is exactly 12 h (boundary is exclusive)', () => {
    expect(isStaleForecast(makePlan(fetchedAtMs + 12 * 3_600_000, fetchedAtMs))).toBe(false);
  });

  it('is true just 1 ms over the 12 h boundary', () => {
    expect(isStaleForecast(makePlan(fetchedAtMs + 12 * 3_600_000 + 1, fetchedAtMs))).toBe(true);
  });

  it('is false well under the 12 h boundary', () => {
    expect(isStaleForecast(makePlan(fetchedAtMs + 3_600_000, fetchedAtMs))).toBe(false);
  });

  it('is false when departure precedes the fetch (non-positive gap)', () => {
    expect(isStaleForecast(makePlan(fetchedAtMs - 1000, fetchedAtMs))).toBe(false);
  });
});

describe('activeRigResult', () => {
  const plan = makePlan(Date.UTC(2026, 6, 15, 8, 0, 0), Date.UTC(2026, 6, 15, 6, 0, 0));

  it('returns the RigResult for a rig that has one', () => {
    expect(activeRigResult(plan, 'genoa')).toBe(plan.result.genoa);
  });

  it('returns null (not a throw) for a rig with no route', () => {
    expect(activeRigResult(plan, 'fock')).toBeNull();
  });
});
