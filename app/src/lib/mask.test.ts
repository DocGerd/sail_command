import { describe, expect, it } from 'vitest';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { cautiousDepthLowerBoundM, MASK_TOLERANCE_M } from './mask';
import { APPROACH_RADIUS_M, approachGate, uniformGate } from './depthGate';

const CELL_LAT = (TEST_MASK_META.north - TEST_MASK_META.south) / TEST_MASK_META.rows; // 0.005
const CELL_LON = (TEST_MASK_META.east - TEST_MASK_META.west) / TEST_MASK_META.cols; // 0.005

describe('NavMask', () => {
  it('reads depth per cell (row 0 = south, col 0 = west)', () => {
    const m = makeMask((r, c) => (r === 0 && c === 0 ? 31 : 200));
    // center of cell (0,0)
    const p = { lat: 54.3 + CELL_LAT / 2, lon: 9.4 + CELL_LON / 2 };
    expect(m.depthM(p)).toBeCloseTo(3.1, 5);
    expect(m.isNavigable(p, 3.0)).toBe(true);
    expect(m.isNavigable(p, 3.2)).toBe(false);
  });

  it('treats land, out-of-bbox and 255 correctly', () => {
    const m = makeMask((r) => (r < 5 ? 0 : 255));
    expect(m.isNavigable({ lat: 54.301, lon: 10 }, 3)).toBe(false); // land
    expect(m.isNavigable({ lat: 55.2, lon: 10 }, 3)).toBe(true); // 255 → 25.4 m
    expect(m.isNavigable({ lat: 56, lon: 10 }, 3)).toBe(false); // outside bbox
  });

  it('segment test catches a one-cell wall the endpoints straddle', () => {
    // wall at col 160 across all rows
    const m = makeMask((_, c) => (c === 160 ? 0 : 200));
    const a = { lat: 54.75, lon: 10.19 };
    const b = { lat: 54.76, lon: 10.22 };
    expect(m.isNavigable(a, 3)).toBe(true);
    expect(m.isNavigable(b, 3)).toBe(true);
    expect(m.segmentNavigable(a, b, uniformGate(3))).toBe(false);
    expect(m.segmentNavigable(a, { lat: 54.76, lon: 10.19 }, uniformGate(3))).toBe(true);
  });

  it('segment test respects safety depth at query time', () => {
    const m = makeMask((_, c) => (c === 160 ? 25 : 200)); // 2.5 m shoal line
    const a = { lat: 54.75, lon: 10.19 };
    const b = { lat: 54.75, lon: 10.22 };
    expect(m.segmentNavigable(a, b, uniformGate(3.0))).toBe(false);
    expect(m.segmentNavigable(a, b, uniformGate(2.0))).toBe(true);
  });

  it('snaps to the nearest navigable cell within 300 m, else null', () => {
    // Use finer grid (10x resolution) to allow cells within 300m
    const fineGridMeta = {
      west: 9.4,
      south: 54.3,
      east: 11.0,
      north: 55.3,
      cols: 3200,
      rows: 2000,
    };
    const m = makeMask((_, c) => (c < 1600 ? 0 : 200), fineGridMeta);
    const onLand = { lat: 54.75, lon: 10.205 }; // col ~1600 (land), ~32m from col 1600 center
    const snapped = m.snapToNavigable(onLand, 3.0);
    expect(snapped).not.toBeNull();
    expect(m.isNavigable(snapped!, 3.0)).toBe(true);
    const deepInland = { lat: 54.75, lon: 9.5 };
    expect(m.snapToNavigable(deepInland, 3.0)).toBeNull();
  });

  it('snap radius covers narrow longitude cells at high latitude (asymmetry regression)', () => {
    const m = makeMask((_, c) => (c >= 155 ? 200 : 0));
    const p = { lat: 54.7525, lon: 10.1549 };
    const snapped = m.snapToNavigable(p, 3.0, 1500);
    expect(snapped).not.toBeNull();
    expect(m.isNavigable(snapped!, 3.0)).toBe(true);
  });

  it('isNavigable at the exact north/east edge is fail-closed (false) by design', () => {
    // meta.north/meta.east are exclusive bounds: floor((edge - origin) / step)
    // lands exactly on rows/cols, one past the last valid index, so the edge
    // coordinate itself never falls inside any cell. Pinning this as
    // intentional (not a bug) so a future "fix" doesn't silently flip it.
    const m = makeMask(() => 200);
    expect(m.isNavigable({ lat: TEST_MASK_META.north, lon: 10 }, 3)).toBe(false);
    expect(m.isNavigable({ lat: 54.5, lon: TEST_MASK_META.east }, 3)).toBe(false);
  });

  it('snapToNavigable centered far outside the bbox returns null', () => {
    const m = makeMask(() => 200);
    expect(m.snapToNavigable({ lat: 60, lon: 20 }, 3.0)).toBeNull();
  });
});

describe('NavMask.cellsConnected (#53)', () => {
  // Wall at col 160 (lon ≈ 10.2), except rows 90..99 charted 2.3 m (byte 23).
  const gapMask = () => makeMask((r, c) => (c !== 160 ? 200 : r >= 90 && r <= 99 ? 23 : 0));
  // Cell centers (grid step 0.005°): lat 54.7525 → row 90; lon 10.1025 → col
  // 140, lon 10.3025 → col 180 (west resp. east of the wall).
  const WEST = { lat: 54.7525, lon: 10.1025 };
  const EAST = { lat: 54.7525, lon: 10.3025 };

  it('connects across a 2.3 m gap at gates <= 2.3, not above (query-time navigability)', () => {
    const m = gapMask();
    expect(m.cellsConnected(WEST, EAST, uniformGate(2.3))).toBe(true);
    // 2.3 >= 2.4 is false → the gap cells drop out of the navigable set
    expect(m.cellsConnected(WEST, EAST, uniformGate(2.4))).toBe(false);
  });

  it('is 4-connectivity: a diagonal-only corner touch does not connect', () => {
    // Only two navigable cells, corner-touching at (100,100) and (101,101).
    const m = makeMask((r, c) => ((r === 100 && c === 100) || (r === 101 && c === 101) ? 200 : 0));
    const a = { lat: 54.3 + 100.5 * 0.005, lon: 9.4 + 100.5 * 0.005 };
    const b = { lat: 54.3 + 101.5 * 0.005, lon: 9.4 + 101.5 * 0.005 };
    expect(m.cellsConnected(a, b, uniformGate(3))).toBe(false);
  });

  it('same cell is trivially connected; a non-navigable endpoint is not connected', () => {
    const m = gapMask();
    expect(m.cellsConnected(WEST, WEST, uniformGate(3))).toBe(true);
    const onWall = { lat: 54.3025, lon: 10.2025 }; // row 0, col 160 → land byte 0
    expect(m.cellsConnected(WEST, onWall, uniformGate(2.0))).toBe(false);
    expect(m.cellsConnected(onWall, WEST, uniformGate(2.0))).toBe(false);
  });

  it('out-of-bbox endpoints are never connected', () => {
    const m = makeMask(() => 200);
    expect(m.cellsConnected({ lat: 60, lon: 20 }, { lat: 54.75, lon: 10.2 }, uniformGate(3))).toBe(
      false,
    );
  });
});

describe('NavMask.segmentShallowestBelow (#53)', () => {
  // Shoal lines: col 160 charted 2.5 m, col 162 charted 2.8 m, rest 20 m.
  const m = makeMask((_, c) => (c === 160 ? 25 : c === 162 ? 28 : 200));
  const a = { lat: 54.7525, lon: 10.1925 }; // col 158
  const b = { lat: 54.7525, lon: 10.2225 }; // col 164

  it('reports the shallowest crossed cell below the threshold', () => {
    // Crossed cols 158..164 → below 3.0 m: 2.5 and 2.8 → min 2.5
    expect(m.segmentShallowestBelow(a, b, 3.0)).toBeCloseTo(2.5, 6);
  });

  it('cells at or above the threshold never count (strictly below)', () => {
    expect(m.segmentShallowestBelow(a, b, 2.6)).toBeCloseTo(2.5, 6); // 2.8 >= 2.6 excluded
    expect(m.segmentShallowestBelow(a, b, 2.5)).toBeNull(); // 2.5 is not < 2.5
    expect(m.segmentShallowestBelow(a, b, 2.0)).toBeNull();
  });

  it('deep-capped cells (byte 255) never count as shallow — the cap is "≥ 25.4 m", not a reading', () => {
    const deep = makeMask(() => 255);
    expect(deep.segmentShallowestBelow(a, b, 30)).toBeNull();
  });
});

describe('NavMask.segmentMinDepthInfoM (#505)', () => {
  // Same shoal-line fixture as segmentShallowestBelow above: col 160 charted
  // 2.5 m, col 162 charted 2.8 m, rest 20 m.
  const m = makeMask((_, c) => (c === 160 ? 25 : c === 162 ? 28 : 200));
  const a = { lat: 54.7525, lon: 10.1925 }; // col 158
  const b = { lat: 54.7525, lon: 10.2225 }; // col 164

  it('reports the true minimum over every touched cell, unconditionally — no threshold', () => {
    // Crossed cols 158..164: min is the 2.5 m cell, same as
    // segmentShallowestBelow(a, b, 3.0) above, but with no threshold to pass.
    expect(m.segmentMinDepthInfoM(a, b)).toEqual({ depthM: 2.5, capped: false });
  });

  it('a cell shallower than any threshold segmentShallowestBelow would be asked for is still found', () => {
    // segmentShallowestBelow(a, b, 2.0) returns null (2.5 is not < 2.0) — the
    // whole point of this method is to have no such blind spot.
    expect(m.segmentMinDepthInfoM(a, b)).toEqual({ depthM: 2.5, capped: false });
    expect(m.segmentShallowestBelow(a, b, 2.0)).toBeNull();
  });

  it("an all-deep-capped segment reports capped: true at the encoding's deepest value", () => {
    const deep = makeMask(() => 255);
    expect(deep.segmentMinDepthInfoM(a, b)).toEqual({ depthM: 25.4, capped: true });
  });

  it('one real reading anywhere on the segment wins over deep-capped cells, uncapped', () => {
    // Deep-capped everywhere except col 160, charted 2.5 m — the finite
    // reading is shallower than 25.4 m, so it is the minimum and capped
    // flips to false (mirrors depthInfoM: capped tracks the WINNING cell).
    const mostlyCapped = makeMask((_, c) => (c === 160 ? 25 : 255));
    expect(mostlyCapped.segmentMinDepthInfoM(a, b)).toEqual({ depthM: 2.5, capped: false });
  });

  it('land (byte 0) is included as a 0 m reading, unlike segmentClearanceM which aborts on land', () => {
    const land = makeMask((_, c) => (c === 160 ? 0 : 200));
    expect(land.segmentMinDepthInfoM(a, b)).toEqual({ depthM: 0, capped: false });
  });

  it('returns null when the walk leaves the grid, like segmentShallowestBelow/segmentClearanceM', () => {
    expect(m.segmentMinDepthInfoM({ lat: 60, lon: 20 }, b)).toBeNull();
  });
});

describe('NavMask.segmentClearanceM (#243)', () => {
  // Same shoal-line fixture as segmentShallowestBelow above: col 160 charted
  // 2.5 m, col 162 charted 2.8 m, rest 20 m.
  const m = makeMask((_, c) => (c === 160 ? 25 : c === 162 ? 28 : 200));
  const a = { lat: 54.7525, lon: 10.1925 }; // col 158
  const b = { lat: 54.7525, lon: 10.2225 }; // col 164

  it('reports the minimum charted depth over every touched cell (not just below-threshold ones)', () => {
    // segmentShallowestBelow(a, b, 3.0) reports 2.5 (the shallowest sub-3.0
    // cell); segmentClearanceM reports the same minimum for a gate of 2.0 —
    // both are "min depth actually crossed", the difference is the threshold
    // semantics (shallowestBelow filters below a threshold; clearance is
    // gated by navigability and returns the true minimum).
    expect(m.segmentClearanceM(a, b, uniformGate(2.0))).toBeCloseTo(2.5, 6);
  });

  it('returns null exactly when segmentNavigable would (any touched cell below the gate)', () => {
    expect(m.segmentNavigable(a, b, uniformGate(2.6))).toBe(false); // the 2.5 m cell fails a 2.6 m gate
    expect(m.segmentClearanceM(a, b, uniformGate(2.6))).toBeNull();
    expect(m.segmentNavigable(a, b, uniformGate(2.5))).toBe(true); // 2.5 m cell passes an exact 2.5 m gate
    expect(m.segmentClearanceM(a, b, uniformGate(2.5))).toBeCloseTo(2.5, 6);
  });

  it('deep-capped cells (byte 255) contribute 25.4 m, never a lower "reading"', () => {
    const deep = makeMask(() => 255);
    expect(deep.segmentClearanceM(a, b, uniformGate(3.0))).toBeCloseTo(25.4, 6);
  });

  it('is null out of bounds or on land, like segmentNavigable', () => {
    const land = makeMask(() => 0);
    expect(land.segmentClearanceM(a, b, uniformGate(1.0))).toBeNull();
    expect(m.segmentClearanceM({ lat: 60, lon: 20 }, b, uniformGate(2.0))).toBeNull();
  });
});

describe('NavMask.depthInfoM', () => {
  const inBounds = { lat: 54.75, lon: 10.2 };

  it('byte 255 (deep cap) reports capped, depth 25.4', () => {
    const m = makeMask(() => 255);
    expect(m.depthInfoM(inBounds)).toEqual({ depthM: 25.4, capped: true });
  });

  it('byte 254 (measured 25.4 m) reports NOT capped, same depth — the honest discriminator', () => {
    const m = makeMask(() => 254);
    expect(m.depthInfoM(inBounds)).toEqual({ depthM: 25.4, capped: false });
  });

  it('byte 0 (land/unknown) is depth 0, not capped', () => {
    const m = makeMask(() => 0);
    expect(m.depthInfoM(inBounds)).toEqual({ depthM: 0, capped: false });
  });

  it('a mid-range depth byte decodes to decimetres, not capped', () => {
    const m = makeMask(() => 31); // 3.1 m
    expect(m.depthInfoM(inBounds)).toEqual({ depthM: 3.1, capped: false });
  });

  it('out-of-bounds is depth 0, not capped', () => {
    const m = makeMask(() => 255);
    expect(m.depthInfoM({ lat: 60, lon: 20 })).toEqual({ depthM: 0, capped: false });
  });

  it('depthM() is unchanged by the new accessor (255 -> 25.4, 254 -> 25.4)', () => {
    expect(makeMask(() => 255).depthM(inBounds)).toBeCloseTo(25.4, 5);
    expect(makeMask(() => 254).depthM(inBounds)).toBeCloseTo(25.4, 5);
  });
});

// #493: cautiousDepthLowerBoundM is a SOUND LOWER BOUND on the mask's more
// cautious (Resampling.max) reading for a cell whose SHIPPED (blended) depth
// is `shippedDepthM` — derived directly from pipeline/build_mask.py's blend
// rule (depth_blend <= depth_max + MASK_TOLERANCE_M, so depth_max >=
// depth_blend - MASK_TOLERANCE_M). Never the true cautious value itself, only
// a floor it cannot be below. See app/src/test/maskTolerance.test.ts for the
// cross-artifact guard pinning MASK_TOLERANCE_M against the Python constant
// it mirrors.
describe('#493: cautiousDepthLowerBoundM', () => {
  it('floors to 0.1 m even where IEEE754 residue would otherwise cost an extra decimetre', () => {
    // 1.4 - MASK_TOLERANCE_M(0.9) is mathematically exactly 0.5, but in
    // double precision evaluates to 0.4999999999999999 (verified via a
    // scratch node -e). A naive Math.floor(x*10)/10 on that residue floors
    // to 0.4 — an EXTRA decimetre of pessimism the pipeline's blend rule
    // never actually proves. Hand-derived expected value (0.5), not
    // computed from the function under test — the #50 equivalence-test
    // tautology this repo has been bitten by before.
    expect(cautiousDepthLowerBoundM(1.4)).toBe(0.5);
  });

  it('pins an ordinary shipped reading (2.3 -> 1.4, exact in double precision)', () => {
    expect(cautiousDepthLowerBoundM(2.3)).toBe(1.4);
  });

  it('floors a genuine fractional remainder down, never rounds it', () => {
    // 2.15 - 0.9 = 1.25 exactly; flooring gives 1.2, rounding would give 1.3
    // (Math.round(12.5) rounds up in JS) and would overstate the floor.
    expect(cautiousDepthLowerBoundM(2.15)).toBe(1.2);
  });

  it('clamps at 0 rather than emitting a negative depth', () => {
    expect(cautiousDepthLowerBoundM(0.5)).toBe(0);
    expect(cautiousDepthLowerBoundM(0)).toBe(0);
    expect(cautiousDepthLowerBoundM(MASK_TOLERANCE_M)).toBe(0);
  });
});

// #452: the three NavMask predicates the solver uses now take a per-cell gate.
// Every case here is built as a PAIR — the same mask and the same relaxed
// depth, with the disc ON the shallow cell and then OFF it. Only a gate that
// is genuinely consulted per cell can separate the two, and both halves are
// load-bearing: a cellNavigable that ignored gateAtCell and used
// requestedDepthM would pass the reject half while failing the accept half,
// and one using minGateM would do exactly the reverse.
describe('NavMask under a #452 ApproachGate', () => {
  // Row 90 is 20 m everywhere except col 150, charted 2.5 m — below the 3.0 m
  // requested gate, above a 2.3 m relaxed one.
  const shoal = makeMask((r, c) => (r === 90 && c === 150 ? 25 : 200));
  // Cell centres on row 90 (lat 54.3 + 90.5*0.005 = 54.7525).
  const lonOfCol = (col: number) => 9.4 + (col + 0.5) * 0.005;
  const A = { lat: 54.7525, lon: lonOfCol(145) };
  const B = { lat: 54.7525, lon: lonOfCol(155) };
  const ON = { lat: 54.7525, lon: lonOfCol(150) }; // disc centred on the shoal
  // 30 columns east (~9.6 km at this latitude) — far outside a 1852 m disc.
  const OFF = { lat: 54.7525, lon: lonOfCol(180) };
  const covering = approachGate(TEST_MASK_META, [ON], 3.0, [2.3], APPROACH_RADIUS_M);
  const elsewhere = approachGate(TEST_MASK_META, [OFF], 3.0, [2.3], APPROACH_RADIUS_M);

  it('segmentNavigable accepts a sub-requested cell inside a disc and rejects it outside', () => {
    expect(shoal.segmentNavigable(A, B, covering)).toBe(true);
    expect(shoal.segmentNavigable(A, B, elsewhere)).toBe(false);
    // Control: the same segment at a plain requested-depth gate is blocked,
    // so the accept above is the disc doing the work, not the mask being deep.
    expect(shoal.segmentNavigable(A, B, uniformGate(3.0))).toBe(false);
  });

  it('segmentClearanceM reports a minimum BELOW the requested depth inside a disc', () => {
    expect(shoal.segmentClearanceM(A, B, covering)).toBeCloseTo(2.5, 6);
    expect(shoal.segmentClearanceM(A, B, elsewhere)).toBeNull();
  });

  it('cellsConnected routes through an in-disc sub-requested cell, not an out-of-disc one', () => {
    // A wall on row 90 would not isolate anything on its own, so this fixture
    // makes col 150 the ONLY water in an otherwise-land column.
    const pinch = makeMask((r, c) => (c === 150 ? (r === 90 ? 25 : 0) : 200));
    expect(pinch.cellsConnected(A, B, covering)).toBe(true);
    expect(pinch.cellsConnected(A, B, elsewhere)).toBe(false);
  });
});
