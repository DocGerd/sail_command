import { describe, expect, it } from 'vitest';
import { TEST_MASK_META } from '../test/fixtures';
import { APPROACH_RADIUS_M, approachGate, gateAtCell, gateFloorM, uniformGate } from './depthGate';

// TEST_MASK_META is 320 cols over 9.4..11.0 and 200 rows over 54.3..55.3, so
// both steps are 0.005 deg. At the waypoint latitude used throughout this file
// (row 90's cell centre, 54.3 + 90.5*0.005 = 54.7525):
//
//   metres per ROW = 111_320 * 0.005                    = 556.60
//   metres per COL = 111_320 * 0.005 * cos(54.7525 deg) = 321.18
//
// so at R = APPROACH_RADIUS_M (1852 m) the disc is 1852/556.60 = 3.327 rows
// tall and 1852/321.18 = 5.766 cols wide. Every index below is hand-derived
// from those two numbers, never read off the implementation.
const WP = { lat: 54.7525, lon: 10.1025 }; // row 90, col 140
const ROW = 90;
const COL = 140;

describe('#452 gateAtCell', () => {
  it('returns the requested depth outside every disc and the disc gate inside', () => {
    const gate = approachGate(TEST_MASK_META, [WP], 3.0, [2.3], APPROACH_RADIUS_M);
    // Centre cell: trivially inside.
    expect(gateAtCell(gate, ROW, COL)).toBeCloseTo(2.3, 6);
    // Far away in both axes: outside, and outside the bounding box too.
    expect(gateAtCell(gate, ROW + 40, COL + 40)).toBeCloseTo(3.0, 6);

    // The discriminating cell: INSIDE the union bounding box but OUTSIDE the
    // ellipse. bbox rows floor(90-3.327)=86 .. ceil(90+3.327)=94, cols
    // floor(140-5.766)=134 .. ceil(140+5.766)=146. Take the corner (86, 134):
    // (4/3.327)^2 + (6/5.766)^2 = 1.446 + 1.083 = 2.53 > 1, so it is outside
    // the disc and must read the REQUESTED depth. A gateAtCell that dropped
    // the ellipse test and treated the whole bbox as inside would return 2.3
    // here — this row is what makes the bbox an O(1) REJECT rather than the
    // membership test itself.
    expect(gateAtCell(gate, 86, 134)).toBeCloseTo(3.0, 6);
  });

  it('the disc is measured in METRES, so it is wider in columns than in rows', () => {
    const gate = approachGate(TEST_MASK_META, [WP], 3.0, [2.3], APPROACH_RADIUS_M);
    // Due NORTH: 3 rows = 1669.8 m <= 1852 m, inside; 4 rows = 2226.4 m, outside.
    expect(gateAtCell(gate, ROW + 3, COL)).toBeCloseTo(2.3, 6);
    expect(gateAtCell(gate, ROW + 4, COL)).toBeCloseTo(3.0, 6);
    // Due EAST: 5 cols = 1605.9 m <= 1852 m, inside; 6 cols = 1927.1 m, outside.
    // This pair is what pins the cos(latitude) correction: without it the
    // column radius would also be 3.327 cols and dc = 5 would fall OUTSIDE,
    // an error of ~73% in the disc's east-west extent at this latitude.
    expect(gateAtCell(gate, ROW, COL + 5)).toBeCloseTo(2.3, 6);
    expect(gateAtCell(gate, ROW, COL + 6)).toBeCloseTo(3.0, 6);
  });

  it('a cell inside two overlapping discs takes the DEEPEST gate, not the shallowest', () => {
    // Two waypoints 5 columns apart, so their discs overlap heavily.
    const near = { lat: 54.7525, lon: 10.1275 }; // col 145
    const gate = approachGate(TEST_MASK_META, [WP, near], 3.0, [2.3, 2.7], APPROACH_RADIUS_M);
    // Cell (90, 142): dc = 2 from the first disc and dc = -3 from the second,
    // so it lies inside both. MAX licenses strictly LESS water than MIN would.
    expect(gateAtCell(gate, ROW, 142)).toBeCloseTo(2.7, 6);
    // A cell inside ONLY the shallower disc still gets that disc's gate — so
    // the row above is testing the overlap rule, not just "2.7 wins globally".
    expect(gateAtCell(gate, ROW, COL - 5)).toBeCloseTo(2.3, 6);
  });

  it('minGateM / gateFloorM report the shallowest gate anywhere in the field', () => {
    const near = { lat: 54.7525, lon: 10.1275 };
    const gate = approachGate(TEST_MASK_META, [WP, near], 3.0, [2.3, 2.7], APPROACH_RADIUS_M);
    expect(gateFloorM(gate)).toBeCloseTo(2.3, 6);
    expect(gateFloorM(uniformGate(3.0))).toBeCloseTo(3.0, 6);
  });
});

describe('#452 kill switch (approachRadiusM = Infinity)', () => {
  it('returns a UniformGate, not an ApproachGate with huge radii', () => {
    const gate = approachGate(TEST_MASK_META, [WP], 3.0, [2.3], Infinity);
    expect(gate.kind).toBe('uniform');
    if (gate.kind !== 'uniform') return;
    expect(gate.gateM).toBeCloseTo(2.3, 6);
  });

  it('gates every cell at the relaxed depth, however far from the waypoint', () => {
    const gate = approachGate(TEST_MASK_META, [WP], 3.0, [2.3], Infinity);
    expect(gateAtCell(gate, ROW, COL)).toBeCloseTo(2.3, 6);
    // The same far cell that reads 3.0 under a finite radius.
    expect(gateAtCell(gate, ROW + 40, COL + 40)).toBeCloseTo(2.3, 6);
  });
});
