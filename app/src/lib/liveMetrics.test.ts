import { describe, expect, it } from 'vitest';
import type { LatLon, Leg } from '../types';
import { activeLegIndex } from './live';
import { haversineNm } from './geo';
import {
  LEG_SWITCH_MARGIN_NM,
  crossTrack,
  legDistanceNm,
  distanceToGoNm,
  formatTrueHeading,
  legPosition,
  nextActiveLegIndex,
  stepActiveLeg,
} from './liveMetrics';

// Fixtures sit on the equator so 1 degree of arc is 60.0404 nm
// (3440.065 * pi / 180) and every expected value below is hand-derivable.
const ll = (lat: number, lon: number): LatLon => ({ lat, lon });

function motorLeg(start: LatLon, end: LatLon, distanceNm: number): Leg {
  return {
    kind: 'motor',
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 3_600_000,
    headingDeg: 0,
    twsKn: 0,
    speedKn: 6,
    distanceNm,
    board: null,
    maneuverAtStart: null,
  };
}

// Leg 0 runs north along lon 0 to lat 0.1; leg 1 turns east along lat 0.1.
const LEG_N = motorLeg(ll(0, 0), ll(0.1, 0), 6);
const LEG_E = motorLeg(ll(0.1, 0), ll(0.1, 0.1), 4);
const LEG_LAST = motorLeg(ll(0.1, 0.1), ll(0.1, 0.2), 5);

describe('distanceToGoNm', () => {
  const legs = [LEG_N, LEG_E, LEG_LAST];

  it('halfway along leg 0: half its length, plus the full later legs', () => {
    const r = distanceToGoNm(legs, 0, ll(0.05, 0));
    expect(r.legNm).toBeCloseTo(3, 3);
    expect(r.routeNm).toBeCloseTo(12, 3);
  });

  it('on a middle leg only later legs are added', () => {
    const r = distanceToGoNm(legs, 1, ll(0.1, 0.05));
    expect(r.legNm).toBeCloseTo(2, 3);
    expect(r.routeNm).toBeCloseTo(7, 3);
  });

  it('before the leg start counts the whole leg; beyond its end counts zero', () => {
    expect(distanceToGoNm(legs, 0, ll(-0.02, 0)).legNm).toBeCloseTo(6, 3);
    const past = distanceToGoNm(legs, 2, ll(0.1, 0.25));
    expect(past.legNm).toBe(0);
    expect(past.routeNm).toBe(0);
  });

  it('rejects an index outside the legs', () => {
    expect(() => distanceToGoNm(legs, 3, ll(0, 0))).toThrow(RangeError);
    expect(() => distanceToGoNm([], 0, ll(0, 0))).toThrow(RangeError);
  });
});

describe('legPosition', () => {
  const legs = [LEG_N, LEG_E, LEG_LAST];

  it('is 1-based', () => {
    expect(legPosition(legs, 0)).toEqual({ current: 1, total: 3 });
    expect(legPosition(legs, 2)).toEqual({ current: 3, total: 3 });
  });

  it('rejects out-of-range and non-integer indices', () => {
    expect(() => legPosition(legs, -1)).toThrow(RangeError);
    expect(() => legPosition(legs, 3)).toThrow(RangeError);
    expect(() => legPosition(legs, 1.5)).toThrow(RangeError);
  });
});

describe('crossTrack', () => {
  it('east of a north-going leg is starboard, west is port', () => {
    // 0.01 deg of longitude on the equator = 0.600404 nm.
    const e = crossTrack(LEG_N, ll(0.05, 0.01));
    expect(e.side).toBe('starboard');
    expect(e.distanceNm).toBeCloseTo(0.6004, 3);
    expect(e.clamped).toBeNull();
    const w = crossTrack(LEG_N, ll(0.05, -0.01));
    expect(w.side).toBe('port');
    expect(w.distanceNm).toBeCloseTo(0.6004, 3);
  });

  it('is relative to the direction of travel: north of a west-going leg is starboard', () => {
    const west = motorLeg(ll(0, 0.1), ll(0, 0), 6);
    expect(crossTrack(west, ll(0.01, 0.05)).side).toBe('starboard');
    expect(crossTrack(west, ll(-0.01, 0.05)).side).toBe('port');
  });

  it('handles a leg bearing across 360/000 (359.43 deg)', () => {
    // Track from (0,0) to (0.1,-0.001); at lat 0.05 it sits at lon -0.0005, so the
    // boat at lon 0.01 is 0.0105 deg east: 0.0105 * 60.0404 * cos(0.573 deg) = 0.6304 nm.
    const nw = motorLeg(ll(0, 0), ll(0.1, -0.001), 6);
    const r = crossTrack(nw, ll(0.05, 0.01));
    expect(r.side).toBe('starboard');
    expect(r.distanceNm).toBeCloseTo(0.6304, 3);
    // Mirror leg bearing 000.57: a boat west of it is port.
    const ne = motorLeg(ll(0, 0), ll(0.1, 0.001), 6);
    const m = crossTrack(ne, ll(0.05, -0.01));
    expect(m.side).toBe('port');
    expect(m.distanceNm).toBeCloseTo(0.6304, 3);
  });

  it('beyond the end: distance to the end point, flagged, side from the extended line', () => {
    // End (0.1,0); boat 0.02 deg beyond it and 0.01 deg east: hypot(0.02, 0.01) deg = 1.3425 nm.
    const r = crossTrack(LEG_N, ll(0.12, 0.01));
    expect(r.clamped).toBe('beyond-end');
    expect(r.side).toBe('starboard');
    expect(r.distanceNm).toBeCloseTo(1.3425, 3);
  });

  it('before the start: distance to the start point, flagged', () => {
    const r = crossTrack(LEG_N, ll(-0.02, -0.01));
    expect(r.clamped).toBe('before-start');
    expect(r.side).toBe('port');
    expect(r.distanceNm).toBeCloseTo(1.3425, 3);
  });

  it('exactly on the leg start: zero distance, no side, not clamped', () => {
    expect(crossTrack(LEG_N, ll(0, 0))).toEqual({ distanceNm: 0, side: null, clamped: null });
  });

  it('a zero-length leg reports distance to its point and no side', () => {
    const dot = motorLeg(ll(0, 0), ll(0, 0), 0);
    const r = crossTrack(dot, ll(0.01, 0));
    expect(r.side).toBeNull();
    expect(r.distanceNm).toBeCloseTo(0.6004, 3);
  });
});

describe('formatTrueHeading', () => {
  it.each([
    [45, '045°T'],
    [5, '005°T'],
    [0, '000°T'],
    [360, '000°T'],
    [-10, '350°T'],
    [87.6, '088°T'],
    [359.6, '000°T'],
  ])('%s -> %s', (deg, expected) => {
    expect(formatTrueHeading(deg)).toBe(expected);
  });
});

describe('nextActiveLegIndex', () => {
  const M = LEG_SWITCH_MARGIN_NM;

  it('takes the candidate on the first fix', () => {
    expect(
      nextActiveLegIndex({
        prevIndex: null,
        candidateIndex: 4,
        prevDistNm: 0,
        candidateDistNm: 0,
        prevEndPassed: false,
      }),
    ).toBe(4);
  });

  it('keeps the current leg when it is also the candidate', () => {
    expect(
      nextActiveLegIndex({
        prevIndex: 2,
        candidateIndex: 2,
        prevDistNm: 1,
        candidateDistNm: 1,
        prevEndPassed: true,
      }),
    ).toBe(2);
  });

  it('a rival only wins by more than the margin', () => {
    const base = { prevIndex: 1, candidateIndex: 2, prevEndPassed: false };
    expect(nextActiveLegIndex({ ...base, prevDistNm: 0.2, candidateDistNm: 0.2 - 0.9 * M })).toBe(
      1,
    );
    expect(nextActiveLegIndex({ ...base, prevDistNm: 0.2, candidateDistNm: 0.2 - 1.1 * M })).toBe(
      2,
    );
  });

  it('the margin applies backwards too', () => {
    const base = { prevIndex: 2, candidateIndex: 1, prevEndPassed: true };
    expect(nextActiveLegIndex({ ...base, prevDistNm: 0.2, candidateDistNm: 0.2 - 0.9 * M })).toBe(
      2,
    );
    expect(nextActiveLegIndex({ ...base, prevDistNm: 0.2, candidateDistNm: 0.2 - 1.1 * M })).toBe(
      1,
    );
  });

  it('passing the current leg end advances at once, even inside the margin', () => {
    expect(
      nextActiveLegIndex({
        prevIndex: 1,
        candidateIndex: 2,
        prevDistNm: 0.1,
        candidateDistNm: 0.1,
        prevEndPassed: true,
      }),
    ).toBe(2);
  });
});

// distanceNm equal to the chord, so stepActiveLeg projects exactly as the geometry says.
const chordLeg = (a: LatLon, b: LatLon): Leg => motorLeg(a, b, haversineNm(a, b));

describe('stepActiveLeg (two legs meeting at a corner)', () => {
  const legs = [chordLeg(LEG_N.start, LEG_N.end), chordLeg(LEG_E.start, LEG_E.end)];

  it('GPS noise near the joint does not flip to the next leg before the end is passed', () => {
    // Leg 0 is 0.0005 deg (0.030 nm) off, leg 1 is 0.0001 deg (0.006 nm) off: nearer, but inside the margin.
    const p = ll(0.0999, 0.0005);
    expect(activeLegIndex(legs, p)).toBe(1);
    expect(stepActiveLeg(legs, p, 0)).toBe(0);
  });

  it('a sequence of jittery fixes before the corner stays on leg 0', () => {
    const fixes = [ll(0.0999, 0.0005), ll(0.0999, 0.0003), ll(0.09995, 0.0004), ll(0.0998, 0.0005)];
    let idx: number | null = 0;
    for (const f of fixes) idx = stepActiveLeg(legs, f, idx);
    expect(idx).toBe(0);
  });

  it('clear progress onto the next leg switches before the end is passed', () => {
    // Leg 0 is 0.18 nm off, leg 1 is 0.03 nm off.
    expect(stepActiveLeg(legs, ll(0.0995, 0.003), 0)).toBe(1);
  });

  it('passing the corner switches promptly although the gap is inside the margin', () => {
    // Leg 0 end is 0.0425 nm away, leg 1 is 0.030 nm off: a 0.0125 nm gap.
    const p = ll(0.1005, 0.0005);
    expect(stepActiveLeg(legs, p, 0)).toBe(1);
  });

  it('once on leg 1, noise back across the corner does not return to leg 0', () => {
    // Leg 0 is 0.006 nm off, leg 1 is 0.030 nm off: leg 0 is nearer by 0.024 nm only.
    const p = ll(0.0995, 0.0001);
    expect(activeLegIndex(legs, p)).toBe(0);
    expect(stepActiveLeg(legs, p, 1)).toBe(1);
  });

  it('a clear move back (0.6 nm from leg 1, on leg 0) returns to leg 0', () => {
    expect(stepActiveLeg(legs, ll(0.09, 0), 1)).toBe(0);
  });

  it('after a reroute, a stale in-range prevIndex is released by the margin', () => {
    // New route: leg 0 lies under the boat, leg 1 starts about 4.8 nm away.
    const rerouted = [chordLeg(ll(0.5, 0.5), ll(0.5, 0.6)), chordLeg(ll(0.5, 0.6), ll(0.6, 0.6))];
    expect(stepActiveLeg(rerouted, ll(0.5, 0.52), 1)).toBe(0);
  });

  it('without a usable previous index it equals activeLegIndex', () => {
    const p = ll(0.0999, 0.0005);
    expect(stepActiveLeg(legs, p, null)).toBe(1);
    expect(stepActiveLeg(legs, p, 7)).toBe(1);
    expect(stepActiveLeg(legs, p, -1)).toBe(1);
  });
});

describe('legDistanceNm vs activeLegIndex (differential)', () => {
  it('the nearest leg by legDistanceNm is activeLegIndex, over seeded random fixes', () => {
    const legs = [LEG_N, LEG_E, LEG_LAST];
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let n = 0; n < 500; n++) {
      const p = ll(-0.03 + rnd() * 0.16, -0.03 + rnd() * 0.26);
      const d = legs.map((l) => legDistanceNm(p, l));
      expect(activeLegIndex(legs, p)).toBe(d.indexOf(Math.min(...d)));
    }
  });
});
