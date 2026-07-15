import { describe, expect, it } from 'vitest';
import { activeLegIndex, distanceToNextManeuverNm, headingToSteerDeg, projectedEtaMs } from './live';
import { destinationPoint, haversineNm, initialBearingDeg } from './geo';
import type { Leg } from '../types';

// Synthetic route: three 5 nm legs heading due east (090) from ORIGIN, at a
// constant latitude so distances/bearings are easy to reason about by hand.
// Built with geo.ts's own primitives (not hand-typed lat/lon deltas) so the
// fixture's geometry is exactly what alongTrackFraction/haversineNm expect.
const ORIGIN = { lat: 54.7, lon: 9.5 };
const LEG_LEN_NM = 5;
const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 6, 15, 8, 0, 0);

const pt = (distNm: number) => destinationPoint(ORIGIN, 90, distNm);
const P0 = pt(0);
const P1 = pt(LEG_LEN_NM);
const P2 = pt(2 * LEG_LEN_NM);
const P3 = pt(3 * LEG_LEN_NM);

function sailLeg(
  start: typeof P0,
  end: typeof P0,
  startTimeMs: number,
  board: 'port' | 'starboard',
  maneuverAtStart: 'tack' | 'gybe' | null,
): Leg {
  return {
    kind: 'sail',
    start,
    end,
    startTimeMs,
    endTimeMs: startTimeMs + HOUR_MS,
    headingDeg: initialBearingDeg(start, end),
    twsKn: 12,
    speedKn: LEG_LEN_NM, // LEG_LEN_NM nm covered in exactly one hour
    distanceNm: haversineNm(start, end),
    board,
    twaDeg: board === 'starboard' ? 45 : -45,
    maneuverAtStart,
  };
}

function motorLeg(start: typeof P0, end: typeof P0, startTimeMs: number): Leg {
  return {
    kind: 'motor',
    start,
    end,
    startTimeMs,
    endTimeMs: startTimeMs + HOUR_MS,
    headingDeg: initialBearingDeg(start, end),
    twsKn: 2,
    speedKn: LEG_LEN_NM,
    distanceNm: haversineNm(start, end),
    board: null,
    maneuverAtStart: null,
  };
}

// One tack, at the start of leg 1.
const ROUTE: Leg[] = [
  sailLeg(P0, P1, T0, 'starboard', null),
  sailLeg(P1, P2, T0 + HOUR_MS, 'port', 'tack'),
  sailLeg(P2, P3, T0 + 2 * HOUR_MS, 'port', null),
];

describe('activeLegIndex', () => {
  it('picks the leg whose clamped projection is nearest, for a point off-track mid-leg', () => {
    const midLeg1 = destinationPoint(pt(7.5), 0, 0.3); // 0.3 nm north of leg 1's midpoint
    expect(activeLegIndex(ROUTE, midLeg1)).toBe(1);
  });

  it('clamps to leg 0 for a point before the route start', () => {
    const beforeStart = destinationPoint(P0, 270, 3); // 3 nm behind the origin
    expect(activeLegIndex(ROUTE, beforeStart)).toBe(0);
  });

  it('picks the last leg for a point past the route end', () => {
    const pastEnd = destinationPoint(P3, 90, 3); // 3 nm beyond the destination
    expect(activeLegIndex(ROUTE, pastEnd)).toBe(2);
  });

  it('throws on an empty route rather than returning a bogus index', () => {
    expect(() => activeLegIndex([], P0)).toThrow();
  });
});

describe('headingToSteerDeg', () => {
  it('is the bearing from p to legs[i].end', () => {
    const p = destinationPoint(pt(7.5), 0, 0.3); // off-track point near leg 1
    expect(headingToSteerDeg(ROUTE, 1, p)).toBeCloseTo(initialBearingDeg(p, ROUTE[1].end), 6);
  });

  it('is ~090 for a point exactly on the (due-east) track', () => {
    const onTrack = pt(7.5); // exactly on leg 1
    expect(headingToSteerDeg(ROUTE, 1, onTrack)).toBeCloseTo(90, 0);
  });

  it('steers back toward track for a point offset north of it', () => {
    // North of a due-east track, the bearing to a point further east along
    // the track must point south-of-east: strictly between 90 and 180.
    const north = destinationPoint(pt(7.5), 0, 0.3);
    const hts = headingToSteerDeg(ROUTE, 1, north);
    expect(hts).toBeGreaterThan(90);
    expect(hts).toBeLessThan(180);
  });
});

describe('distanceToNextManeuverNm', () => {
  it('sums the remainder of the current leg when the very next leg is flagged', () => {
    const p = pt(2); // 2 nm into leg 0 (5 nm long) -> 3 nm remaining
    const result = distanceToNextManeuverNm(ROUTE, 0, p);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('tack');
    expect(result?.distNm).toBeCloseTo(3, 1);
  });

  it('sums across a full intervening leg to reach a later tack/gybe', () => {
    const gapRoute: Leg[] = [
      sailLeg(P0, P1, T0, 'starboard', null),
      sailLeg(P1, P2, T0 + HOUR_MS, 'starboard', null), // no maneuver, same board
      sailLeg(P2, P3, T0 + 2 * HOUR_MS, 'port', 'gybe'), // gybe at leg 2's start
      sailLeg(P3, pt(20), T0 + 3 * HOUR_MS, 'port', null),
    ];
    const p = pt(2); // 2 nm into leg 0 -> 3 nm remaining + all of leg 1 (5 nm)
    const result = distanceToNextManeuverNm(gapRoute, 0, p);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('gybe');
    expect(result?.distNm).toBeCloseTo(8, 1);
  });

  it("flags a sail->motor transition as 'motor-start' even though motor legs never set maneuverAtStart", () => {
    const motorRoute: Leg[] = [
      sailLeg(P0, P1, T0, 'starboard', null),
      sailLeg(P1, P2, T0 + HOUR_MS, 'starboard', null),
      motorLeg(P2, P3, T0 + 2 * HOUR_MS),
    ];
    const p = pt(2); // 3 nm remaining on leg 0 + all of leg 1 (5 nm)
    const result = distanceToNextManeuverNm(motorRoute, 0, p);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('motor-start');
    expect(result?.distNm).toBeCloseTo(8, 1);
  });

  it('does not flag a motor->sail transition (only sail->motor is a flagged event)', () => {
    const motorThenSail: Leg[] = [
      motorLeg(P0, P1, T0),
      sailLeg(P1, P2, T0 + HOUR_MS, 'starboard', null),
    ];
    expect(distanceToNextManeuverNm(motorThenSail, 0, pt(2))).toBeNull();
  });

  it('returns null when there is no flagged event ahead on the rest of the route', () => {
    const p = pt(7); // on leg 1, already past its own (already-happened) tack
    expect(distanceToNextManeuverNm(ROUTE, 1, p)).toBeNull();
  });
});

describe('projectedEtaMs', () => {
  const planEtaMs = ROUTE[ROUTE.length - 1].endTimeMs; // T0 + 3h

  it('equals the plan ETA when exactly on schedule', () => {
    const p = pt(2); // 0.4 fraction into leg 0 -> expected time T0 + 0.4h
    const expectedTimeAtP = T0 + 0.4 * HOUR_MS;
    expect(projectedEtaMs(ROUTE, 0, p, expectedTimeAtP)).toBe(planEtaMs);
  });

  it('projects a later ETA (positive drift) when behind schedule', () => {
    const p = pt(2);
    const expectedTimeAtP = T0 + 0.4 * HOUR_MS;
    const lateMs = 12 * 60_000;
    expect(projectedEtaMs(ROUTE, 0, p, expectedTimeAtP + lateMs)).toBe(planEtaMs + lateMs);
  });

  it('projects an earlier ETA (negative drift) when ahead of schedule', () => {
    const p = pt(2);
    const expectedTimeAtP = T0 + 0.4 * HOUR_MS;
    const earlyMs = 10 * 60_000;
    expect(projectedEtaMs(ROUTE, 0, p, expectedTimeAtP - earlyMs)).toBe(planEtaMs - earlyMs);
  });

  it('clamps the projection past the end of the route to the last leg, so drift is measured against the final ETA directly', () => {
    const pastEnd = destinationPoint(P3, 90, 3);
    const lateMs = 20 * 60_000;
    expect(projectedEtaMs(ROUTE, 2, pastEnd, planEtaMs + lateMs)).toBe(planEtaMs + lateMs);
  });
});
