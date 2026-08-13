import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { shallowExposureNm, roundExposureNm } from './shallowExposure';
import type { LatLon, Leg } from '../types';

const CELL_LAT = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows; // 0.005
const CELL_LON = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols; // 0.005

// Minimal valid Leg — a motor leg carries no board/twaDeg (the Leg
// discriminated union, CLAUDE.md's own convention: never fake a sail leg's
// extra fields just to get a LegCommon shape). Only start/end/distanceNm
// matter to shallowExposureNm; the rest are structurally required but inert.
function makeLeg(start: LatLon, end: LatLon, distanceNm: number): Leg {
  return {
    kind: 'motor',
    board: null,
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 0,
    headingDeg: 0,
    twsKn: 0,
    speedKn: 0,
    distanceNm,
    maneuverAtStart: null,
  };
}

// Grid-x/y helper: convert a chosen (row, gridX) pair into a LatLon at that
// exact continuous grid coordinate, so a test can place a leg endpoint
// mid-cell (never on a cell boundary, sidestepping floating-point floor()
// ambiguity at a knife-edge) while still reasoning exactly about which
// integer columns it falls in.
function pointAt(rowCenter: number, gridX: number): LatLon {
  return {
    lat: TEST_MASK_META.south + rowCenter * CELL_LAT,
    lon: TEST_MASK_META.west + gridX * CELL_LON,
  };
}

describe('shallowExposureNm (#516)', () => {
  it('hand-derived value: a pure-longitude segment crossing an EXACTLY 3-cell shallow band', () => {
    // Row 100 (cell centre = row + 0.5, so dy=0 the whole way — the segment
    // never changes row, which is what makes every full column's Δt exactly
    // 1/Dx regardless of where it sits along the path). Start/end sit at
    // grid-x 50.3 / 70.7 — deliberately NOT on cell boundaries, so the FIRST
    // (col 50) and LAST (col 70) columns are partial; columns 55/56/57 are
    // safely interior (51..69 are all full columns) and are the only ones
    // charted shallow.
    const ROW = 100;
    const a = pointAt(ROW + 0.5, 50.3);
    const b = pointAt(ROW + 0.5, 70.7);
    const SHALLOW_COLS = new Set([55, 56, 57]);
    const mask = makeMask(
      (row, col) => (row === ROW && SHALLOW_COLS.has(col) ? 20 /* 2.0 m */ : 200) /* 20 m */,
    );
    // HAND DERIVATION (independent of shallowExposureNm): a straight line at
    // constant grid-velocity dx/dt spends exactly 1/Dx of its parametric
    // range t crossing any one full grid cell, wherever that cell sits along
    // the path — so 3 fully-covered shallow columns contribute exactly
    // 3/Dx of t. Dx = x1 - x0 recomputed the SAME way the implementation
    // does (from the lon values above, via CELL_LON) — not assumed to be
    // exactly 20.4, since IEEE754 division leaves a residue.
    const x0 = (a.lon - TEST_MASK_META.west) / CELL_LON;
    const x1 = (b.lon - TEST_MASK_META.west) / CELL_LON;
    const dx = x1 - x0;
    // distanceNm is chosen to equal Dx numerically (units differ — Dx is a
    // dimensionless grid-coordinate span, distanceNm is nautical miles — but
    // picking the SAME number makes fraction * distanceNm = (3/Dx) * Dx = 3
    // exactly, an expected value simple enough to state and verify by eye).
    const leg = makeLeg(a, b, dx);
    const expected = (3 / dx) * dx; // == 3, modulo the same float residue Dx carries
    const result = shallowExposureNm([leg], mask, 3.0);
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(expected, 9);
    expect(result!).toBeCloseTo(3, 6);
  });

  it('the discriminating row: ONE shallow cell on a long leg returns ~one cell width, never the whole leg', () => {
    // #516 design doc's own "without this row the whole suite is vacuous"
    // row: a rejected whole-leg ("charge the leg if ANY cell is shallow")
    // metric would return the full ~100 nm leg length here; cell-exact
    // must return ~1 nm (one cell's worth), not the leg's own distanceNm.
    const ROW = 120;
    const a = pointAt(ROW + 0.5, 10.3);
    const b = pointAt(ROW + 0.5, 110.3);
    const mask = makeMask((row, col) => (row === ROW && col === 60 ? 20 : 200));
    const x0 = (a.lon - TEST_MASK_META.west) / CELL_LON;
    const x1 = (b.lon - TEST_MASK_META.west) / CELL_LON;
    const dx = x1 - x0; // ~100
    const leg = makeLeg(a, b, dx);
    const result = shallowExposureNm([leg], mask, 3.0);
    expect(result).not.toBeNull();
    // Hand-derived: exactly one full column out of ~100 grid-units, times a
    // distanceNm chosen to equal that same span, so expected ~= 1.
    expect(result!).toBeCloseTo(1, 6);
    // The whole-leg-metric signature this row exists to reject:
    expect(result!).toBeLessThan(leg.distanceNm / 10);
  });

  it('a deep-capped (byte 255) band never counts as shallow, even above the threshold', () => {
    // Threshold set HIGHER than the deep-cap's 25.4 m reading — a naive
    // `depthM < thresholdM` check with no capped exemption would wrongly
    // flag every cell here as shallow.
    const ROW = 50;
    const a = pointAt(ROW + 0.5, 5.3);
    const b = pointAt(ROW + 0.5, 55.7);
    const mask = makeMask((row) => (row === ROW ? 255 : 200));
    const leg = makeLeg(a, b, 42);
    const result = shallowExposureNm([leg], mask, 26.0);
    expect(result).toBe(0);
  });

  it('an out-of-bounds leg endpoint nulls the WHOLE route, never just skips that leg', () => {
    const ROW = 120;
    const shallowA = pointAt(ROW + 0.5, 10.3);
    const shallowB = pointAt(ROW + 0.5, 110.3);
    const mask = makeMask((row, col) => (row === ROW && col === 60 ? 20 : 200));
    const validShallowLeg = makeLeg(shallowA, shallowB, 100);
    // Latitude 56.0 is north of TEST_MASK_META.north (55.3) — outside
    // coverage. If this leg were silently SKIPPED instead of nulling the
    // whole route, the result would be the first leg's own nonzero exposure
    // (~1 nm) rather than null — the mutation this row exists to catch.
    const outOfBoundsLeg = makeLeg({ lat: 56.0, lon: 10.0 }, { lat: 56.01, lon: 10.01 }, 5);
    const result = shallowExposureNm([validShallowLeg, outOfBoundsLeg], mask, 3.0);
    expect(result).toBeNull();
  });

  // #516 design doc §8 item 6: a seeded property test guarding the
  // duplicated Amanatides-Woo walk against drift from NavMask's own private
  // walkCells — needle (shallowExposureNm's boolean) from THIS module,
  // haystack (segmentShallowestBelow's boolean) from NavMask, independently
  // sourced (per #411's "needle and haystack from the same source is the
  // worse tautology").
  it('property: shallowExposureNm finds shallow water iff NavMask.segmentShallowestBelow does (seeded)', () => {
    // Scattered shallow cells amid deep water — an arbitrary deterministic
    // pattern, not a simple band, so the property exercises many different
    // cell-visitation sequences rather than one shape repeated.
    const mask = makeMask((row, col) => ((row * 7 + col * 13) % 5 === 0 ? 20 : 200));
    const THRESHOLD_M = 3.0;
    // Margins keep both endpoints strictly inside the (exclusive-upper-bound)
    // rectangle regardless of fast-check's chosen doubles.
    const MARGIN = 0.02;
    const arbLat = fc.double({
      min: TEST_MASK_META.south + MARGIN,
      max: TEST_MASK_META.north - MARGIN,
      noNaN: true,
    });
    const arbLon = fc.double({
      min: TEST_MASK_META.west + MARGIN,
      max: TEST_MASK_META.east - MARGIN,
      noNaN: true,
    });
    const arbPoint = fc.record({ lat: arbLat, lon: arbLon });
    fc.assert(
      fc.property(arbPoint, arbPoint, (a, b) => {
        fc.pre(a.lat !== b.lat || a.lon !== b.lon); // exclude degenerate zero-length segments
        const leg = makeLeg(a, b, 5);
        const exposure = shallowExposureNm([leg], mask, THRESHOLD_M);
        const shallowestBelow = mask.segmentShallowestBelow(a, b, THRESHOLD_M);
        expect(exposure).not.toBeNull();
        expect((exposure as number) > 0).toBe(shallowestBelow !== null);
      }),
      { numRuns: 200, seed: 42 }, // deterministic CI
    );
  });
});

describe('roundExposureNm (#516)', () => {
  it('rounds UP to 0.1 nm — a genuine 0.02 nm never renders 0.0 nm', () => {
    expect(roundExposureNm(0.02)).toBeCloseTo(0.1, 9);
  });

  it('does not bump a value already exactly on the 0.1 nm grid', () => {
    expect(roundExposureNm(0.3)).toBeCloseTo(0.3, 9);
  });

  it('normalizes a zero-length exposure to +0, never -0 (Object.is(-0, 0) is false)', () => {
    expect(Object.is(roundExposureNm(0), 0)).toBe(true);
  });
});
