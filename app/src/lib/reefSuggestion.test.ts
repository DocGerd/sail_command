import { describe, expect, it } from 'vitest';
import {
  apparentWindKn,
  reefBandForApparentWindKn,
  reefSuggestionForLeg,
  REEF1_AWS_KN,
  REEF2_AWS_KN,
  REEF3_AWS_KN,
} from './reefSuggestion';
import type { Leg } from '../types';

// Minimal valid Leg fixtures — the Leg discriminated union (CLAUDE.md: never
// fake a sail leg's extra fields, never cast). Only twsKn/twaDeg/speedKn
// (sail) or kind='motor' (no twaDeg at all) matter to this module; the rest
// are structurally required but inert for these tests.
function sailLeg(twsKn: number, twaDeg: number, speedKn: number): Leg {
  return {
    kind: 'sail',
    board: twaDeg >= 0 ? 'starboard' : 'port',
    start: { lat: 0, lon: 0 },
    end: { lat: 0, lon: 0 },
    startTimeMs: 0,
    endTimeMs: 0,
    headingDeg: 0,
    twsKn,
    twaDeg,
    speedKn,
    distanceNm: 1,
    maneuverAtStart: null,
  };
}

function motorLeg(): Leg {
  return {
    kind: 'motor',
    board: null,
    start: { lat: 0, lon: 0 },
    end: { lat: 0, lon: 0 },
    startTimeMs: 0,
    endTimeMs: 0,
    headingDeg: 0,
    twsKn: 5,
    speedKn: 6,
    distanceNm: 1,
    maneuverAtStart: null,
  };
}

describe('apparentWindKn — hand-derived from the sailing-triangle law of cosines', () => {
  it('TWA=0 (head-to-wind): AWS = TWS + BS exactly', () => {
    // awsSq = 8^2 + 4^2 + 2*8*4*cos(0) = 64+16+64 = 144 = 12^2.
    expect(apparentWindKn(8, 0, 4)).toBe(12);
  });

  it('TWA=180 (dead run), TWS > BS: AWS = TWS - BS exactly', () => {
    // awsSq = 20^2 + 4^2 + 2*20*4*cos(180) = 400+16-160 = 256 = 16^2.
    expect(apparentWindKn(20, 180, 4)).toBe(16);
  });

  it('TWA=180 (dead run), BS > TWS: AWS = BS - TWS exactly (symmetric)', () => {
    // awsSq = 4^2 + 20^2 + 2*4*20*cos(180) = 16+400-160 = 256 = 16^2.
    expect(apparentWindKn(4, 180, 20)).toBe(16);
  });

  it('TWA=90 (beam reach): AWS = sqrt(TWS^2 + BS^2), hand-computed', () => {
    // awsSq = 10^2 + 6^2 + 2*10*6*cos(90) ~= 100+36+0 = 136.
    // sqrt(136) = 11.661903789690601... (hand value, ten significant digits).
    expect(apparentWindKn(10, 90, 6)).toBeCloseTo(11.6619037897, 9);
  });

  // Review MINOR 5: a "symmetric in TWA's sign" row here was deleted —
  // cos(x) === cos(-x) is a mathematical theorem given the formula above,
  // not a property any reachable code change could violate (the PR #410
  // vacuity class in CLAUDE.md's Verification-lessons). MEASURED: deleting
  // `Math.abs(leg.twaDeg)` from `reefSuggestionForLeg` left it 124/124
  // green, because dropping the call changes nothing when cos is already
  // even. The claim survives instead as an OBSERVED property of
  // `reefSuggestionForLeg` below ("is unaffected by which board the leg is
  // on"), which is honest about being descriptive rather than a guard.
});

describe('reefBandForApparentWindKn — band boundaries pinned by hand, not derived', () => {
  // Table-driven: each row states the AWS value and the expected band,
  // computed against REEF1_AWS_KN=12 / REEF2_AWS_KN=18 / REEF3_AWS_KN=24 by
  // hand from the issue's own boundary semantics ("< threshold" stays in the
  // lighter band), not by calling the function under test.
  const cases: Array<[number, string]> = [
    [0, 'full'],
    [11.9, 'full'],
    [12, 'reef1'], // exact REEF1 boundary: at/above -> reef1
    [17.9, 'reef1'],
    [18, 'reef2'], // exact REEF2 boundary
    [23.9, 'reef2'],
    [24, 'reef3'], // exact REEF3 boundary
    [40, 'reef3'],
  ];
  it.each(cases)('AWS %d kn -> %s', (awsKn, expected) => {
    expect(reefBandForApparentWindKn(awsKn)).toBe(expected);
  });

  it('the three named thresholds are strictly increasing (sanity, not a mutation pin)', () => {
    expect(REEF1_AWS_KN).toBeLessThan(REEF2_AWS_KN);
    expect(REEF2_AWS_KN).toBeLessThan(REEF3_AWS_KN);
  });
});

describe('reefSuggestionForLeg', () => {
  it('returns null for a motor leg (#325: no suggestion under engine alone)', () => {
    expect(reefSuggestionForLeg(motorLeg())).toBeNull();
  });

  it('returns the exact band + AWS for a sail leg at TWA=0 (hand-computed)', () => {
    // TWS=8, TWA=0, BS=4 -> AWS=12 exactly -> reef1 (pinned above).
    expect(reefSuggestionForLeg(sailLeg(8, 0, 4))).toEqual({ band: 'reef1', awsKn: 12 });
  });

  it('returns full main for a light-air beam-reach leg (hand-computed)', () => {
    // TWS=6, TWA=90, BS=5 -> awsSq = 36+25+0 = 61 -> AWS = 7.810249675906654.
    const s = reefSuggestionForLeg(sailLeg(6, 90, 5));
    expect(s?.band).toBe('full');
    expect(s?.awsKn).toBeCloseTo(7.8102496759, 9);
  });

  it('is unaffected by which board the leg is on (sign of TWA does not change the band)', () => {
    const starboard = reefSuggestionForLeg(sailLeg(15, 60, 5));
    const port = reefSuggestionForLeg(sailLeg(15, -60, 5));
    expect(starboard).toEqual(port);
  });
});
