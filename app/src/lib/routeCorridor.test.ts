import { describe, it, expect, vi } from 'vitest';
import type { LatLon } from '../types';
import type { AisBoundingBox } from '../services/aisStream';
import {
  boundingBoxAreaNm2,
  countTargetsInCorridor,
  pointInBox,
  routeCorridorBoxes,
} from './routeCorridor';

// Tiny segment factory: routeCorridorBoxes only reads each segment's endpoints,
// so bare {start,end} literals stand in for full Legs.
const seg = (start: LatLon, end: LatLon) => ({ start, end });

const inAny = (p: LatLon, bs: readonly AisBoundingBox[]): boolean =>
  bs.some((b) => pointInBox(p, b));

describe('routeCorridorBoxes', () => {
  it('pads a single horizontal leg nm-true on all four sides (full route, activeLegIndex null)', () => {
    const [box] = routeCorridorBoxes(
      [seg({ lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 })],
      null,
      5,
    );
    // lat pad = toDeg(5/3440.065) = 0.083277° (meridian arc, exact):
    expect(box[0][0]).toBeCloseTo(54.416723, 5); // 54.5 − 0.083277
    expect(box[1][0]).toBeCloseTo(54.583277, 5); // 54.5 + 0.083277
    // lon pad = 5/(60.0405·cos54.5°) = 0.143407° (nm-true E/W at 54.5°N):
    expect(box[0][1]).toBeCloseTo(9.8566, 3); // 10.0 − 0.143407
    expect(box[1][1]).toBeCloseTo(10.3434, 3); // 10.2 + 0.143407
  });

  it('merges two collinear adjacent legs into one envelope box', () => {
    const boxes = routeCorridorBoxes(
      [
        seg({ lat: 54.5, lon: 10.0 }, { lat: 54.5, lon: 10.2 }),
        seg({ lat: 54.5, lon: 10.2 }, { lat: 54.5, lon: 10.4 }),
      ],
      null,
      5,
    );
    expect(boxes).toHaveLength(1); // box1.lonMax(10.3434) > box2.lonMin(10.0566) ⇒ overlap ⇒ merge
    expect(boxes[0][0][1]).toBeCloseTo(9.8566, 3); // 10.0 − 0.143407
    expect(boxes[0][1][1]).toBeCloseTo(10.5434, 3); // 10.4 + 0.143407
  });

  it('keeps one leg astern of the active leg and drops earlier ones (Math.max(0, i-1))', () => {
    // Four disjoint legs 0.2° (≈12 nm) apart in lat — more than 2·0.083° pad ⇒ no merge.
    const legs = [
      seg({ lat: 54.4, lon: 10.0 }, { lat: 54.4, lon: 10.1 }), // L0
      seg({ lat: 54.6, lon: 10.0 }, { lat: 54.6, lon: 10.1 }), // L1
      seg({ lat: 54.8, lon: 10.0 }, { lat: 54.8, lon: 10.1 }), // L2
      seg({ lat: 55.0, lon: 10.0 }, { lat: 55.0, lon: 10.1 }), // L3
    ];
    // activeLegIndex = 2 ⇒ startIdx = max(0,1) = 1 ⇒ legs L1..L3
    const c2 = routeCorridorBoxes(legs, 2, 5);
    expect(c2).toHaveLength(3);
    expect(inAny({ lat: 54.4, lon: 10.05 }, c2)).toBe(false); // L0 dropped (astern boundary)
    expect(inAny({ lat: 54.6, lon: 10.05 }, c2)).toBe(true); // L1 kept
    // activeLegIndex = 0 ⇒ startIdx = 0 ⇒ all four
    expect(routeCorridorBoxes(legs, 0, 5)).toHaveLength(4);
    // activeLegIndex = null ⇒ full route ⇒ L0 covered
    expect(inAny({ lat: 54.4, lon: 10.05 }, routeCorridorBoxes(legs, null, 5))).toBe(true);
  });

  it('caps the box count at 8 by merging nearest pairs without dropping coverage', () => {
    // Ten point legs 0.2° apart ⇒ 10 disjoint ≈10×10 nm boxes ≈ 1000 nm² total —
    // well under the 2000 nm² area cap, isolating the box-count cap.
    const legs = Array.from({ length: 10 }, (_, k) => {
      const p = { lat: 54.0 + 0.2 * k, lon: 10.0 };
      return seg(p, p);
    });
    const boxes = routeCorridorBoxes(legs, null, 5);
    expect(boxes).toHaveLength(8); // 10 − 2 nearest-pair merges
    for (const l of legs) expect(boxes.some((b) => pointInBox(l.start, b))).toBe(true); // coverage invariant
  });

  it('falls back to [] with one console.warn when the corridor area exceeds the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const boxes = routeCorridorBoxes(
      [seg({ lat: 54.0, lon: 9.5 }, { lat: 55.3, lon: 11.0 })],
      null,
      5,
    );
    // padded ≈ 1.47° lat (≈88 nm) × ≈1.79° lon (≈62 nm) ≈ 5450 nm² > 2000 ⇒ fallback
    expect(boxes).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('returns [] for an empty leg list', () => {
    expect(routeCorridorBoxes([], null, 5)).toEqual([]);
  });
});

describe('boundingBoxAreaNm2', () => {
  it('computes the mid-latitude-corrected area of a 1°×1° box at 54.5°N', () => {
    // height = toRad(1)·3440.065 = 60.0405 nm;
    // width = 60.0405·cos54.5° = 60.0405·0.580703 = 34.8657 nm; area ≈ 2093.35 nm².
    expect(
      boundingBoxAreaNm2([
        [54, 10],
        [55, 11],
      ]),
    ).toBeCloseTo(2093, 0);
  });
});

describe('pointInBox / countTargetsInCorridor', () => {
  it('classifies points against a box and counts corridor targets', () => {
    const box: AisBoundingBox = [
      [54, 10],
      [55, 11],
    ];
    expect(pointInBox({ lat: 54.5, lon: 10.5 }, box)).toBe(true);
    expect(pointInBox({ lat: 56.0, lon: 10.5 }, box)).toBe(false);
    const targets = [
      { position: { lat: 54.5, lon: 10.5 } }, // in
      { position: { lat: 56.0, lon: 10.5 } }, // out
      { position: { lat: 54.2, lon: 10.9 } }, // in
    ];
    expect(countTargetsInCorridor(targets, [box])).toBe(2);
  });
});
