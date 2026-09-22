import { describe, it, expect } from 'vitest';
import {
  activeRigResult,
  forecastAgeNowHours,
  isForecastStaleNow,
  isStaleForecast,
  NO_ROUTE_MESSAGE_KEY,
  noRouteMessageKey,
  rigComparisonSuppressedByTier,
  staleForecastGapHours,
} from './plan';

describe('#885 noRouteMessageKey', () => {
  const motorOn = { settings: DEFAULT_SETTINGS };
  const motorOff = { settings: { ...DEFAULT_SETTINGS, motorEnabled: false } };

  it('calm-sail-only names "unmark it" only while the motor is on', () => {
    expect(noRouteMessageKey('calm-sail-only', motorOn)).toBe('error.noRoute.calmSailOnly');
    expect(noRouteMessageKey('calm-sail-only', motorOff)).toBe(
      'error.noRoute.calmSailOnlyMotorOff',
    );
  });

  it('beyond-horizon adds the unmark remedy only when a segment is sail-only', () => {
    expect(noRouteMessageKey('beyond-horizon', motorOn)).toBe('error.noRoute.beyondHorizon');
    expect(noRouteMessageKey('beyond-horizon', { ...motorOn, segmentModes: [null, 'motor'] })).toBe(
      'error.noRoute.beyondHorizon',
    );
    expect(noRouteMessageKey('beyond-horizon', { ...motorOn, segmentModes: [null, 'sail'] })).toBe(
      'error.noRoute.beyondHorizonSailOnly',
    );
  });

  it('every other reason reads the table', () => {
    expect(noRouteMessageKey('unreachable', { ...motorOn, segmentModes: ['sail'] })).toBe(
      NO_ROUTE_MESSAGE_KEY.unreachable,
    );
  });
});
import { uniformWindGrid } from '../test/fixtures';
import { DEFAULT_SETTINGS, type Plan, type RigResult } from '../types';
import { boatSnapshot, defaultBoatSnapshot } from '../types';
import { boatById } from '../data/boats';
import { PLAN_SCHEMA_VERSION } from '../types';

function makePlan(departureMs: number, fetchedAtMs: number): Plan {
  const genoaResult = {
    sailId: 'genoa' as const,
    legs: [],
    etaMs: departureMs + 3_600_000,
    durationMs: 3_600_000,
    distanceNm: 5,
    maneuverCount: 0,
    motorDistanceNm: 0,
  };
  return {
    id: 'plan-1',
    name: 'Test Plan',
    createdAtMs: fetchedAtMs,
    schemaVersion: PLAN_SCHEMA_VERSION,
    request: {
      origin: { lat: 54.8, lon: 9.5 },
      destination: { lat: 54.9, lon: 9.7 },
      viaPoints: [],
      originHarborId: null,
      destinationHarborId: null,
      departureMs,
      settings: DEFAULT_SETTINGS,
      sailIds: ['genoa', 'fock'],
      boat: defaultBoatSnapshot(),
    },
    windGrid: { ...uniformWindGrid(10, 270), fetchedAtMs },
    result: {
      status: 'ok',
      recommended: 'genoa',
      comparisonComplete: true,
      snappedOrigin: { lat: 54.8, lon: 9.5 },
      snappedDestination: { lat: 54.9, lon: 9.7 },
      sails: [
        { sailId: 'genoa', result: genoaResult, reason: null },
        { sailId: 'fock', result: null, reason: 'unreachable' },
      ],
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

describe('staleForecastGapHours', () => {
  const fetchedAtMs = Date.UTC(2026, 6, 15, 6, 0, 0);

  it('rounds an exact 20 h gap to 20', () => {
    expect(staleForecastGapHours(makePlan(fetchedAtMs + 20 * 3_600_000, fetchedAtMs))).toBe(20);
  });

  it('rounds an exact 26 h gap to 26', () => {
    expect(staleForecastGapHours(makePlan(fetchedAtMs + 26 * 3_600_000, fetchedAtMs))).toBe(26);
  });

  // Two cases, not one: round always agrees with EITHER floor OR ceil for
  // any non-tie value (it can never differ from both at once), so a single
  // partial-hour case cannot discriminate round from both alternatives —
  // it takes one case on each side of the 30-minute tie.
  it('rounds down a gap under the half-hour mark (discriminates round from ceil)', () => {
    // 20 h 20 min: round -> 20 (agrees with floor), ceil would give 21.
    expect(
      staleForecastGapHours(makePlan(fetchedAtMs + 20 * 3_600_000 + 20 * 60_000, fetchedAtMs)),
    ).toBe(20);
  });

  it('rounds up a gap at/over the half-hour mark (discriminates round from floor)', () => {
    // 20 h 40 min: round -> 21 (agrees with ceil), floor would give 20.
    expect(
      staleForecastGapHours(makePlan(fetchedAtMs + 20 * 3_600_000 + 40 * 60_000, fetchedAtMs)),
    ).toBe(21);
  });
});

describe('activeRigResult', () => {
  const plan = makePlan(Date.UTC(2026, 6, 15, 8, 0, 0), Date.UTC(2026, 6, 15, 6, 0, 0));

  it('returns the RigResult for a rig that has one', () => {
    expect(activeRigResult(plan, 'genoa')).toBe(plan.result.sails[0].result);
  });

  it('returns null (not a throw) for a rig with no route', () => {
    expect(activeRigResult(plan, 'fock')).toBeNull();
  });
});

// #1399c: forecast age against NOW — same boundary shape as isStaleForecast/
// staleForecastGapHours above, off `windGrid.fetchedAtMs` vs. an EXPLICIT
// `nowMs` rather than `plan.request.departureMs`.
describe('isForecastStaleNow', () => {
  const fetchedAtMs = Date.UTC(2026, 6, 15, 6, 0, 0);

  it('is false when the fetch-to-now gap is exactly 12 h (boundary is exclusive)', () => {
    const plan = makePlan(fetchedAtMs + 3_600_000, fetchedAtMs);
    expect(isForecastStaleNow(plan, fetchedAtMs + 12 * 3_600_000)).toBe(false);
  });

  it('is true just 1 ms over the 12 h boundary', () => {
    const plan = makePlan(fetchedAtMs + 3_600_000, fetchedAtMs);
    expect(isForecastStaleNow(plan, fetchedAtMs + 12 * 3_600_000 + 1)).toBe(true);
  });

  it('is false well under the 12 h boundary', () => {
    const plan = makePlan(fetchedAtMs + 3_600_000, fetchedAtMs);
    expect(isForecastStaleNow(plan, fetchedAtMs + 3_600_000)).toBe(false);
  });

  it('does not confuse a stale-at-save plan with stale-now: departure far in the future, now close to fetch', () => {
    // The plan's OWN isStaleForecast reads TRUE here (huge departure gap),
    // but isForecastStaleNow must read FALSE — the two compare different
    // things and must not collapse into one.
    const plan = makePlan(fetchedAtMs + 100 * 3_600_000, fetchedAtMs);
    expect(isStaleForecast(plan)).toBe(true);
    expect(isForecastStaleNow(plan, fetchedAtMs + 3_600_000)).toBe(false);
  });
});

describe('forecastAgeNowHours', () => {
  const fetchedAtMs = Date.UTC(2026, 6, 15, 6, 0, 0);

  it('rounds an exact 20 h gap to 20', () => {
    const plan = makePlan(fetchedAtMs, fetchedAtMs);
    expect(forecastAgeNowHours(plan, fetchedAtMs + 20 * 3_600_000)).toBe(20);
  });

  it('rounds down a gap under the half-hour mark (discriminates round from ceil)', () => {
    const plan = makePlan(fetchedAtMs, fetchedAtMs);
    expect(forecastAgeNowHours(plan, fetchedAtMs + 20 * 3_600_000 + 20 * 60_000)).toBe(20);
  });

  it('rounds up a gap at/over the half-hour mark (discriminates round from floor)', () => {
    const plan = makePlan(fetchedAtMs, fetchedAtMs);
    expect(forecastAgeNowHours(plan, fetchedAtMs + 20 * 3_600_000 + 40 * 60_000)).toBe(21);
  });
});

// #1398b: the tier-C chip-text predicate — each row isolates ONE of the
// four guard clauses as the deciding factor, per CLAUDE.md's "ask per TERM"
// rule, rather than one row per scenario.
describe('rigComparisonSuppressedByTier', () => {
  const genoaResult: RigResult = {
    sailId: 'genoa',
    legs: [],
    etaMs: 0,
    durationMs: 0,
    distanceNm: 5,
    maneuverCount: 0,
    motorDistanceNm: 0,
  };
  const fockResult: RigResult = { ...genoaResult, sailId: 'fock' };
  const tierCBoat = boatSnapshot(boatById('salona-44-speedy-go'));

  function makeVerdictPlan(overrides: {
    // 'decided' excluded — no row here needs it, and it alone would need a
    // `rig` field RigRecommendation requires for that variant.
    kind?: 'tie' | 'moot' | 'not-compared';
    comparisonComplete?: boolean;
    sails?: [
      { sailId: 'genoa' | 'fock'; result: RigResult | null; reason: null | 'unreachable' },
      { sailId: 'genoa' | 'fock'; result: RigResult | null; reason: null | 'unreachable' },
    ];
    boat?: ReturnType<typeof boatSnapshot>;
  }): Plan {
    const base = makePlan(Date.UTC(2026, 6, 15, 8, 0, 0), Date.UTC(2026, 6, 15, 6, 0, 0));
    return {
      ...base,
      request: { ...base.request, boat: overrides.boat ?? tierCBoat },
      result: {
        ...base.result,
        comparisonComplete: overrides.comparisonComplete ?? true,
        sails: overrides.sails ?? [
          { sailId: 'genoa', result: genoaResult, reason: null },
          { sailId: 'fock', result: fockResult, reason: null },
        ],
        ...(overrides.kind ? { rigRecommendation: { kind: overrides.kind } } : {}),
      },
    };
  }

  it('is true for a tier-C boat, both sails solved, kind not-compared, comparison complete', () => {
    expect(rigComparisonSuppressedByTier(makeVerdictPlan({ kind: 'not-compared' }))).toBe(true);
  });

  it('is false for a hullVerified boat under the identical shape (the TIER clause alone)', () => {
    expect(
      rigComparisonSuppressedByTier(
        makeVerdictPlan({ kind: 'not-compared', boat: defaultBoatSnapshot() }),
      ),
    ).toBe(false);
  });

  it('is false when kind is not not-compared, even for a tier-C boat', () => {
    expect(rigComparisonSuppressedByTier(makeVerdictPlan({ kind: 'tie' }))).toBe(false);
    expect(rigComparisonSuppressedByTier(makeVerdictPlan({}))).toBe(false); // no kind at all
  });

  it('is false when the comparison did not finish — comparisonIncomplete must win, not this', () => {
    expect(
      rigComparisonSuppressedByTier(
        makeVerdictPlan({ kind: 'not-compared', comparisonComplete: false }),
      ),
    ).toBe(false);
  });

  it('is false when exactly one sail failed — rigOneFailed must win, not this', () => {
    expect(
      rigComparisonSuppressedByTier(
        makeVerdictPlan({
          kind: 'not-compared',
          sails: [
            { sailId: 'genoa', result: genoaResult, reason: null },
            { sailId: 'fock', result: null, reason: 'unreachable' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('is false when only one sail was requested (N != 2, structurally unreachable via comparisonSuppressed but still guarded)', () => {
    expect(
      rigComparisonSuppressedByTier(
        makeVerdictPlan({
          kind: 'not-compared',
          sails: [{ sailId: 'genoa', result: genoaResult, reason: null }] as unknown as [
            { sailId: 'genoa' | 'fock'; result: RigResult | null; reason: null | 'unreachable' },
            { sailId: 'genoa' | 'fock'; result: RigResult | null; reason: null | 'unreachable' },
          ],
        }),
      ),
    ).toBe(false);
  });
});
