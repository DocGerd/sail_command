import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { APPROACH_RADIUS_M } from './depthGate';
import { haversineNm } from './geo';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { roundExposureNm, shallowConfinedWithinM, shallowExposureNm } from './shallowExposure';
import type { NavMask } from './mask';
import type { LatLon, Leg, MaskMeta } from '../types';

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

  it('parity with segmentShallowestBelow byte-255 rule: a deep-capped band never counts as shallow (UNREACHABLE at the 10 m safetyDepthM cap)', () => {
    // NOT coverage of user-visible behaviour (#410, and PR #523 review Minor
    // 2): this row runs at thresholdM 26.0, but shallowExposureNm is only
    // ever called with `shallow.requestedDepthM`, i.e. the safetyDepthM
    // OptionsPanel's SAFETY_DEPTH_FIELD bounds to [2.2, 10]. A capped cell
    // decodes to 25.4 m, so at every threshold a user can reach
    // `depthM < thresholdM` is already false and the `!info.capped` term
    // cannot change the verdict. Kept because it pins PARITY with
    // NavMask.segmentShallowestBelow's own byte-255 rule, so the two cannot
    // drift if either bound ever widens — the same reason mask.ts's
    // segmentClearanceM carries its "revisit if either bound widens past
    // 25.4 m" note.
    //
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

  // #516 design doc §8 item 6, NARROWED (PR #523 review, Major 1): a seeded
  // property that the two implementations agree on the shallow/deep VERDICT
  // — needle (shallowExposureNm's boolean) from THIS module, haystack
  // (segmentShallowestBelow's boolean) from NavMask, independently sourced
  // (per #411's "needle and haystack from the same source is the worse
  // tautology"). It is NOT the drift guard for the duplicated
  // Amanatides-Woo walk and must not be described as one: a boolean
  // equivalence cannot see WHICH cells were visited or in what order, so it
  // stayed 8/8 GREEN under a measured convention divergence (the corner
  // tie-break, `tMaxX < tMaxY` -> `<=`). The visited-cell sequence
  // comparison below is the drift keeper; this row catches a different,
  // cheaper class.
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

// PR #523 review, Major 1 — the DRIFT KEEPER for the Amanatides-Woo walk
// shallowExposure.ts duplicates from NavMask.walkCells. The two walks are
// byte-identical TODAY; the duplication's whole risk is a FUTURE edit to
// either copy diverging silently, producing a wrong safety number with no
// signal. So this compares the VISITED-CELL SEQUENCES, not a verdict — the
// boolean property above cannot see a traversal change and measurably did
// not (8/8 green under a corner tie-break flip).
//
// Needle: shallowExposureNm touches the mask only through
// `mask.depthInfoM(centre)`, so a facade carrying the real `meta` plus a
// recording `depthInfoM` captures the shipped walk's own sequence with NO
// production change.
//
// Haystack: `NavMask.walkCells` is `private` in TYPESCRIPT ONLY — an
// ordinary method at runtime. Reaching it through a cast is deliberate and
// is the only way to compare the two walks at all: nothing public reports a
// visited-cell sequence, and re-deriving one inside this test would make
// needle and haystack share a source, the worse tautology (#411).
interface WalkCellsHost {
  walkCells(a: LatLon, b: LatLon, visit: (row: number, col: number) => boolean): boolean;
}

function shippedWalk(mask: NavMask, a: LatLon, b: LatLon): string[] {
  const meta = mask.meta;
  const latStep = (meta.north - meta.south) / meta.rows;
  const lonStep = (meta.east - meta.west) / meta.cols;
  const seq: string[] = [];
  const recorder = {
    meta,
    depthInfoM(p: LatLon) {
      const row = Math.floor((p.lat - meta.south) / latStep);
      const col = Math.floor((p.lon - meta.west) / lonStep);
      seq.push(`${row},${col}`);
      return mask.depthInfoM(p);
    },
  };
  // The threshold cannot change WHICH cells are visited — every visited cell
  // is probed before its depth is compared — so any value serves here.
  shallowExposureNm([makeLeg(a, b, 1)], recorder as unknown as NavMask, 3.0);
  return seq;
}

function navMaskWalk(mask: NavMask, a: LatLon, b: LatLon): string[] {
  const seq: string[] = [];
  (mask as unknown as WalkCellsHost).walkCells(a, b, (row, col) => {
    seq.push(`${row},${col}`);
    return true;
  });
  return seq;
}

// Exact-tie grid: west/south and both steps are exact binary fractions
// (step = 2^-7 = 0.0078125), so a point offset by the SAME multiple of the
// step in both axes yields x0 === y0 bit-for-bit. A 45-degree segment across
// it therefore has tMaxX === tMaxY at EVERY step — the only regime in which
// the corner tie-break convention is observable at all. On TEST_MASK_META
// neither step is a binary fraction, so an exact tie is not constructible
// there and every named shape below would leave the tie-break untested.
const TIE_META: MaskMeta = { west: 8, south: 54, east: 10, north: 56, cols: 256, rows: 256 };
const TIE_STEP = (TIE_META.east - TIE_META.west) / TIE_META.cols;
const tiePoint = (k: number): LatLon => ({
  lat: TIE_META.south + k * TIE_STEP,
  lon: TIE_META.west + k * TIE_STEP,
});

describe("shallowExposureNm's walk vs NavMask.walkCells (#516)", () => {
  const mask = makeMask((row, col) => ((row * 7 + col * 13) % 5 === 0 ? 20 : 200));
  const tieMask = makeMask(() => 200, TIE_META);
  const cases: Array<[string, NavMask, LatLon, LatLon]> = [
    ['pure longitude (dy = 0)', mask, pointAt(100.5, 50.3), pointAt(100.5, 70.7)],
    ['pure latitude (dx = 0)', mask, pointAt(40.3, 60.5), pointAt(90.7, 60.5)],
    ['a single cell', mask, pointAt(30.2, 30.2), pointAt(30.8, 30.8)],
    ['zero length', mask, pointAt(30.5, 30.5), pointAt(30.5, 30.5)],
    // PR #523 review, Minor 6: pointAt(20, 20) is NOT boundary-exact, and the
    // names say so. Measured on TEST_MASK_META, whose two steps are different
    // doubles (CELL_LAT 0.005, CELL_LON 0.004999999999999999): x0 =
    // 19.999999999999932 floors to 19 while y0 = 20.000000000000284 floors to
    // 20 — the two axes land on OPPOSITE sides of the same nominal boundary.
    // Still worth keeping (a differential comparison of the harder float case);
    // the boundary-EXACT regime is the two TIE_META rows below.
    [
      'start just off a cell boundary (one axis under, one over)',
      mask,
      pointAt(20, 20),
      pointAt(35.4, 48.9),
    ],
    [
      'end just off a cell boundary (one axis under, one over)',
      mask,
      pointAt(35.4, 48.9),
      pointAt(20, 20),
    ],
    ['steep (|dy| >> |dx|)', mask, pointAt(10.3, 100.4), pointAt(180.6, 103.1)],
    ['shallow slope (|dx| >> |dy|)', mask, pointAt(80.3, 10.4), pointAt(83.1, 300.6)],
    ['both axes negative', mask, pointAt(150.6, 250.7), pointAt(20.2, 30.1)],
    ['exact 45 degrees through cell corners, ascending', tieMask, tiePoint(10), tiePoint(60)],
    ['exact 45 degrees through cell corners, descending', tieMask, tiePoint(60), tiePoint(10)],
  ];
  // PR #523 review, Major 2 — the DATUM the two 45-degree rows rest on. They
  // are the only rows that can observe the corner tie-break, and only while
  // TIE_META's steps stay exact binary fractions. Nothing asserted that, so a
  // meta edit with no obvious meaning (cols/rows 256 -> 300) left every row
  // GREEN *and* made the tie-break mutation undetectable — #411's
  // unpinned-guard-data defect, one level out. The equality assertion does
  // NOT stand alone: at cols/rows 255, x0 === y0 still holds
  // (9.999999999999964) and the integer assertion is what reds — measured.
  it('TIE_META really produces exact ties (precondition for the two 45-degree rows)', () => {
    const latStep = (TIE_META.north - TIE_META.south) / TIE_META.rows;
    const a = tiePoint(10);
    const b = tiePoint(60);
    const x0 = (a.lon - TIE_META.west) / TIE_STEP;
    const y0 = (a.lat - TIE_META.south) / latStep;
    // toBe is Object.is, so a -0/+0 split fails here rather than passing.
    expect(x0).toBe(y0);
    // An integer x0 is not what creates the tie — `x0 === y0` with `dx === dy`
    // does that at every step, for any offset (measured: a k + 0.5 fixture still
    // reds the tie-break mutation on both 45-degree rows). This pins the
    // SIMPLEST such fixture, so a future tiePoint edit that keeps the symmetry
    // but moves the origin off the corner reds here and gets re-read rather than
    // silently accepted.
    expect(Number.isInteger(x0)).toBe(true);
    // dx === dy is what keeps them equal at EVERY later step.
    expect((b.lon - TIE_META.west) / TIE_STEP - x0).toBe((b.lat - TIE_META.south) / latStep - y0);
  });

  for (const [name, m, a, b] of cases) {
    it(`visits the same cells in the same order: ${name}`, () => {
      const shipped = shippedWalk(m, a, b);
      // Fails CLOSED: a segment that never walked at all would make the
      // sequence comparison below vacuously true (two empty arrays).
      expect(shipped.length).toBeGreaterThan(0);
      expect(shipped).toEqual(navMaskWalk(m, a, b));
    });
  }

  it('visits the same cells in the same order over seeded random segments', () => {
    const MARGIN = 0.02;
    const arbPoint = fc.record({
      lat: fc.double({
        min: TEST_MASK_META.south + MARGIN,
        max: TEST_MASK_META.north - MARGIN,
        noNaN: true,
      }),
      lon: fc.double({
        min: TEST_MASK_META.west + MARGIN,
        max: TEST_MASK_META.east - MARGIN,
        noNaN: true,
      }),
    });
    fc.assert(
      fc.property(arbPoint, arbPoint, (a, b) => {
        const shipped = shippedWalk(mask, a, b);
        expect(shipped.length).toBeGreaterThan(0);
        expect(shipped).toEqual(navMaskWalk(mask, a, b));
      }),
      { numRuns: 500, seed: 42 }, // deterministic CI
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

// #516 increment 2 (requires #518). Every geometry below is a PURE-LATITUDE
// leg/waypoint pair at the same longitude (col 50) — dLon = 0, so haversineNm
// reduces to a plain great-circle distance along one meridian with no
// cos(lat) factor to reason about, which is what makes the row-offset
// arithmetic in each test's own comment tractable by hand. Every "just
// inside"/"just outside" claim is nonetheless verified by a PRECONDITION
// assertion against the actual haversineNm output (this file's own TIE_META
// precondition pattern), never trusted from the hand arithmetic alone.
describe('shallowConfinedWithinM (#516 increment 2)', () => {
  const WAYPOINT = pointAt(100.5, 50.5);

  function singleShallowRowMask(shallowRow: number): NavMask {
    return makeMask((row, col) => (row === shallowRow && col === 50 ? 20 /* 2.0 m */ : 200));
  }

  // Spans 5 rows either side of shallowRow — comfortably brackets every row
  // used below (98..109) while staying a single, pure-latitude (same-column)
  // segment, so the walk visits every integer row in between including
  // shallowRow itself.
  function legThroughRow(shallowRow: number): Leg {
    return makeLeg(pointAt(shallowRow - 5, 50.5), pointAt(shallowRow + 5, 50.5), 20);
  }

  function shallowCellCenter(shallowRow: number): LatLon {
    return pointAt(shallowRow + 0.5, 50.5);
  }

  it('a shallow cell just OUTSIDE APPROACH_RADIUS_M of the only waypoint suppresses confinement', () => {
    // Row 104's cell centre sits 4.0 grid-rows from WAYPOINT's own row
    // (100.5 -> 104.5) — roughly 4 * 555.6 m =~ 2222 m, comfortably past the
    // 1852 m radius (a ~371 m / 20% margin, not "a few metres").
    const shallowRow = 104;
    const distanceM = haversineNm(WAYPOINT, shallowCellCenter(shallowRow)) * 1852;
    expect(distanceM).toBeGreaterThan(APPROACH_RADIUS_M); // precondition: really outside
    const result = shallowConfinedWithinM(
      [legThroughRow(shallowRow)],
      singleShallowRowMask(shallowRow),
      3.0,
      [WAYPOINT],
      [0],
      APPROACH_RADIUS_M,
    );
    expect(result).toBe(false);
  });

  it('a shallow cell just INSIDE APPROACH_RADIUS_M of the only waypoint confirms confinement', () => {
    // Row 103's cell centre sits 3.0 grid-rows from WAYPOINT (100.5 -> 103.5)
    // — roughly 3 * 555.6 m =~ 1667 m, under the 1852 m radius (a ~185 m /
    // 10% margin).
    const shallowRow = 103;
    const distanceM = haversineNm(WAYPOINT, shallowCellCenter(shallowRow)) * 1852;
    expect(distanceM).toBeLessThan(APPROACH_RADIUS_M); // precondition: really inside
    const result = shallowConfinedWithinM(
      [legThroughRow(shallowRow)],
      singleShallowRowMask(shallowRow),
      3.0,
      [WAYPOINT],
      [0],
      APPROACH_RADIUS_M,
    );
    expect(result).toBe(true);
  });

  it('#516 design doc §8: mutation-check — shrinking/growing radiusM moves BOTH verdicts', () => {
    // Same two geometries as the two rows above, at a radius chosen on the
    // OTHER side of each cell's own measured distance from the two rows
    // above — a mutation that stopped comparing against radiusM at all (e.g.
    // hardcoding the verdict) would leave at least one of these four checks
    // unmoved.
    const insideDistanceM = haversineNm(WAYPOINT, shallowCellCenter(103)) * 1852;
    const outsideDistanceM = haversineNm(WAYPOINT, shallowCellCenter(104)) * 1852;
    const shrunkRadius = insideDistanceM - 1; // now excludes row 103's own cell
    const grownRadius = outsideDistanceM + 1; // now includes row 104's own cell
    expect(
      shallowConfinedWithinM(
        [legThroughRow(103)],
        singleShallowRowMask(103),
        3.0,
        [WAYPOINT],
        [0],
        shrunkRadius,
      ),
    ).toBe(false);
    expect(
      shallowConfinedWithinM(
        [legThroughRow(104)],
        singleShallowRowMask(104),
        3.0,
        [WAYPOINT],
        [0],
        grownRadius,
      ),
    ).toBe(true);
  });

  it('a via allowance can flip a would-be-confined cell to NOT confined, conservatively', () => {
    // shallowConfinedWithinM's own contract: allowanceM[j] is ADDED to the
    // measured distance before the <= radiusM test, so a LARGER allowance can
    // only make confinement HARDER to establish — never easier. `via` is a
    // raw LatLon (not a cell centre), mirroring a real UNSNAPPED via point.
    const shallowRow = 100;
    const via = pointAt(103.5, 50.5);
    const distanceM = haversineNm(via, shallowCellCenter(shallowRow)) * 1852;
    // Precondition: the measured distance alone reads confined (<= radius),
    // but +300 m (snapToNavigable's own maxRadiusM default) pushes it past —
    // exactly the case the allowance exists to catch.
    expect(distanceM).toBeLessThanOrEqual(APPROACH_RADIUS_M);
    expect(distanceM + 300).toBeGreaterThan(APPROACH_RADIUS_M);
    const leg = legThroughRow(shallowRow);
    const mask = singleShallowRowMask(shallowRow);
    expect(shallowConfinedWithinM([leg], mask, 3.0, [via], [0], APPROACH_RADIUS_M)).toBe(true);
    expect(shallowConfinedWithinM([leg], mask, 3.0, [via], [300], APPROACH_RADIUS_M)).toBe(false);
  });

  it('a shallow cell far from one waypoint but close to another is confined via the closer one (OR across waypoints)', () => {
    const shallowRow = 100;
    const near = pointAt(103.5, 50.5); // same point as the allowance test's own `via` — already ~1667 m away, see its precondition
    const far = pointAt(103.5, 250.5); // 200 grid-columns away — clearly outside any radius
    const result = shallowConfinedWithinM(
      [legThroughRow(shallowRow)],
      singleShallowRowMask(shallowRow),
      3.0,
      [far, near],
      [0, 0],
      APPROACH_RADIUS_M,
    );
    expect(result).toBe(true);
  });

  it('a leg with no shallow cell at all is vacuously confined (true, never checked against any waypoint)', () => {
    const leg = legThroughRow(103);
    const deepMask = makeMask(() => 200); // no cell anywhere is below thresholdM
    const result = shallowConfinedWithinM([leg], deepMask, 3.0, [], [], APPROACH_RADIUS_M);
    expect(result).toBe(true);
  });

  it('a shallow cell with NO waypoints at all is never confined (false, not vacuously true)', () => {
    // Contrasts with the row above: an empty ARRAY of shallow cells is
    // vacuously true, but a genuine shallow cell against an EMPTY waypoint
    // list can satisfy "for some j" over an empty set only as false.
    const shallowRow = 103;
    const result = shallowConfinedWithinM(
      [legThroughRow(shallowRow)],
      singleShallowRowMask(shallowRow),
      3.0,
      [],
      [],
      APPROACH_RADIUS_M,
    );
    expect(result).toBe(false);
  });

  it('an out-of-bounds leg endpoint nulls the WHOLE route, never just skips that leg', () => {
    // Mirrors shallowExposureNm's own out-of-bounds test: if this leg were
    // silently SKIPPED instead of nulling the whole route, the result would
    // be the first leg's own true verdict (see the row-103 test above)
    // rather than null.
    const shallowRow = 103;
    const validLeg = legThroughRow(shallowRow);
    const outOfBoundsLeg = makeLeg({ lat: 56.0, lon: 10.0 }, { lat: 56.01, lon: 10.01 }, 5);
    const result = shallowConfinedWithinM(
      [validLeg, outOfBoundsLeg],
      singleShallowRowMask(shallowRow),
      3.0,
      [WAYPOINT],
      [0],
      APPROACH_RADIUS_M,
    );
    expect(result).toBeNull();
  });
});
