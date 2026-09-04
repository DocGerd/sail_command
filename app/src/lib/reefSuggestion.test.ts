import { describe, expect, it } from 'vitest';
import {
  apparentWindKn,
  reefBandForApparentWindKn,
  reefSuggestionForLeg,
  reefSuggestionsForLegs,
  REEF1_AWS_KN,
  REEF2_AWS_KN,
  REEF3_AWS_KN,
  REEF_HYSTERESIS_MARGIN_KN,
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

  // F4 (PR #910 re-review): descriptive, not a guard — same cos-evenness
  // theorem as the deleted "symmetric in TWA's sign" row above (see that
  // row's own comment), so no reachable code change can red this either.
  // Kept because it documents the observed behaviour at the leg level, not
  // because it discriminates anything.
  it('is unaffected by which board the leg is on (sign of TWA does not change the band)', () => {
    const starboard = reefSuggestionForLeg(sailLeg(15, 60, 5));
    const port = reefSuggestionForLeg(sailLeg(15, -60, 5));
    expect(starboard).toEqual(port);
  });
});

// #946: band-change hysteresis. Every fixture below uses TWA=0, BS=0 so
// `apparentWindKn` reduces to AWS = TWS exactly (awsSq = twsKn^2 + 0 + 0),
// giving exact control over the AWS fed to the banding logic without a
// second hand-derivation of the sailing triangle.
function awsLeg(awsKn: number): Leg {
  return sailLeg(awsKn, 0, 0);
}

describe('reefSuggestionForLeg — hysteresis (previousBand argument, #946)', () => {
  it('sanity: the margin is well inside the 6 kn gap between adjacent thresholds', () => {
    expect(REEF_HYSTERESIS_MARGIN_KN).toBeLessThan((REEF2_AWS_KN - REEF1_AWS_KN) / 2);
    expect(REEF_HYSTERESIS_MARGIN_KN).toBeLessThan((REEF3_AWS_KN - REEF2_AWS_KN) / 2);
  });

  it('omitting previousBand reproduces pre-#946 straight banding exactly (backward compat)', () => {
    // AWS=18.5 sits inside what would be the reef1->reef2 dead zone if
    // hysteresis applied — straight banding must NOT apply a dead zone.
    expect(reefSuggestionForLeg(awsLeg(18.5))).toEqual({ band: 'reef2', awsKn: 18.5 });
  });

  it('a marginal crossing (within the margin) does NOT move the band up', () => {
    // REEF2_AWS_KN=18, margin=0.9 -> needs >=18.9 to move reef1 -> reef2.
    // 18.5 is a real crossing of the bare threshold but inside the dead zone.
    expect(reefSuggestionForLeg(awsLeg(18.5), 'reef1')).toEqual({ band: 'reef1', awsKn: 18.5 });
  });

  it('a marginal drop (within the margin) does NOT move the band down', () => {
    // Needs <17.1 (18-0.9) to drop reef2 -> reef1; 17.2 is inside the dead zone.
    expect(reefSuggestionForLeg(awsLeg(17.2), 'reef2')).toEqual({ band: 'reef2', awsKn: 17.2 });
  });

  it('clearing the margin DOES move the band up', () => {
    expect(reefSuggestionForLeg(awsLeg(18.9), 'reef1')).toEqual({ band: 'reef2', awsKn: 18.9 });
  });

  it('clearing the margin DOES move the band down', () => {
    // Needs strictly <17.1 (18-0.9); 17.0 clears it.
    expect(reefSuggestionForLeg(awsLeg(17.0), 'reef2')).toEqual({ band: 'reef1', awsKn: 17.0 });
  });

  it('a genuine, sustained jump moves the band across MULTIPLE boundaries in one step', () => {
    // From 'full', a squall taking AWS to 25 kn clears both the reef1->reef2
    // and reef2->reef3 widened thresholds in a single leg — hysteresis must
    // never refuse a real change (#946 DoD: freezing the band is worse than
    // the churn it replaces).
    expect(reefSuggestionForLeg(awsLeg(25), 'full')).toEqual({ band: 'reef3', awsKn: 25 });
  });
});

describe('reefSuggestionsForLegs — route-level hysteresis (#946)', () => {
  it('MUTATION CHECK: suppresses the exact oscillation that flips under plain per-leg banding', () => {
    // "Before": each leg banded independently (today's production shape,
    // reefBandForApparentWindKn) genuinely flips back and forth on this
    // sequence — this is the churn #946 reports.
    const awsSequence = [17.5, 18.5, 17.4, 18.6];
    const before = awsSequence.map((aws) => reefBandForApparentWindKn(aws));
    expect(before).toEqual(['reef1', 'reef2', 'reef1', 'reef2']); // BEFORE: flips 3 times

    // "After": the same sequence through the route-level hysteresis stays on
    // the band the first leg picked — none of these values ever clears the
    // 0.9 kn margin around the 18 kn boundary.
    const legs = awsSequence.map(awsLeg);
    const after = reefSuggestionsForLegs(legs).map((s) => s?.band);
    expect(after).toEqual(['reef1', 'reef1', 'reef1', 'reef1']); // AFTER: stable
  });

  it('a genuine sustained change still propagates through the route (does not freeze)', () => {
    // A real trend — AWS climbing well past the dead zone on the SECOND leg —
    // must still be shown, proving the fix damps noise without disabling
    // real reef changes. First leg AWS=17 has no previousBand (start of
    // route) so it bands raw: 12<=17<18 -> 'reef1' (REEF1_AWS_KN pinned
    // above); the second leg's 25 kn then clears the dead zone twice over.
    const legs = [17, 25].map(awsLeg);
    const bands = reefSuggestionsForLegs(legs).map((s) => s?.band);
    expect(bands).toEqual(['reef1', 'reef3']);
  });

  it('motor legs render null and do NOT reset the carried hysteresis state', () => {
    const legs = [awsLeg(17), motorLeg(), awsLeg(18.5)];
    const suggestions = reefSuggestionsForLegs(legs);
    expect(suggestions[0]?.band).toBe('reef1');
    expect(suggestions[1]).toBeNull();
    // POSITIVE CONTROL: if a motor leg incorrectly reset the carried band to
    // null, this same 18.5 kn leg would be banded RAW (18.5 >= REEF2_AWS_KN)
    // and read 'reef2' instead — confirming this assertion actually
    // discriminates carry-through from reset, not just restating the input.
    expect(reefBandForApparentWindKn(18.5)).toBe('reef2');
    expect(suggestions[2]?.band).toBe('reef1');
  });
});
