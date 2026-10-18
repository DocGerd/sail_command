import { describe, expect, it } from 'vitest';
import { backtrack } from './isochrone';
import { uniformGate } from '../lib/depthGate';
import { initialBearingDeg, normalizeDeg180 } from '../lib/geo';
import { makeMask } from '../test/fixtures';
import type { MaskMeta } from '../types';

// #1705: backtrack's collinear merge must not emit a chord the gate rejects.
const META: MaskMeta = { west: 9.9, south: 54.7, east: 10.1, north: 54.8, cols: 256, rows: 128 };
const CELL = 0.00078125;
const GATE = uniformGate(3);

type Chain = Parameters<typeof backtrack>[0];

/**
 * A -> B -> C eastward, B bent north of the A-C chord so the two headings
 * differ by ~0.45 deg. The chord runs ~1 m south of a row boundary; the cells
 * under its midpoint are land, which both sub-steps clear by rising into the
 * next row first.
 */
function scenario() {
  const row = 64;
  const boundaryLat = META.south + (row + 1) * CELL;
  const lat0 = boundaryLat - 9e-6;
  const midCol = 128;
  const lonAt = (col: number) => META.west + (col + 0.5) * CELL;
  const A = { lat: lat0, lon: lonAt(midCol - 40) };
  const C = { lat: lat0, lon: lonAt(midCol + 40) };
  const B = { lat: lat0 + 7.07e-5, lon: lonAt(midCol) };
  const mask = makeMask((r, c) => (r === row && Math.abs(c - midCol) <= 1 ? 0 : 200), META);

  const node = (p: { lat: number; lon: number }, parent: Chain | null, tMs: number): Chain =>
    ({
      lat: p.lat,
      lon: p.lon,
      tMs,
      costMs: tMs,
      kind: parent === null ? 'start' : 'motor',
      board: null,
      headingDeg: parent === null ? 0 : initialBearingDeg(parent, p),
      twaSigned: NaN,
      stepSpeedKn: 6,
      twsKn: 5,
      maneuverAtStart: null,
      maneuvers: 0,
      distToDestNm: 0,
      parent,
    }) as Chain;
  const start = node(A, null, 0);
  const b = node(B, start, 600_000);
  const c = node(C, b, 1_200_000);
  return { A, B, C, mask, c, b };
}

describe('backtrack collinear merge (#1705)', () => {
  it('scenario preconditions: sub-steps pass, chord fails, headings merge-eligible', () => {
    const { A, B, C, mask, b, c } = scenario();
    expect(mask.segmentNavigable(A, B, GATE)).toBe(true);
    expect(mask.segmentNavigable(B, C, GATE)).toBe(true);
    expect(mask.segmentNavigable(A, C, GATE)).toBe(false);
    const diff = Math.abs(normalizeDeg180(b.headingDeg - c.headingDeg));
    expect(diff).toBeGreaterThan(0.4);
    expect(diff).toBeLessThan(0.5);
  });

  it('keeps the steps separate when the merged chord fails the gate', () => {
    const { A, B, C, mask, c } = scenario();
    const legs = backtrack(c, 0, mask, GATE);
    expect(legs.map((l) => [l.start, l.end])).toEqual([
      [A, B],
      [B, C],
    ]);
  });

  it('still merges collinear steps whose chord passes the gate', () => {
    const { A, C, c } = scenario();
    const open = makeMask(() => 200, META);
    const legs = backtrack(c, 0, open, GATE);
    expect(legs).toHaveLength(1);
    expect(legs[0].start).toEqual(A);
    expect(legs[0].end).toEqual(C);
  });
});
