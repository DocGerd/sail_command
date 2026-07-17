import { describe, expect, it } from 'vitest';
import { makeMask, TEST_MASK_META } from '../test/fixtures';

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
    expect(m.segmentNavigable(a, b, 3)).toBe(false);
    expect(m.segmentNavigable(a, { lat: 54.76, lon: 10.19 }, 3)).toBe(true);
  });

  it('segment test respects safety depth at query time', () => {
    const m = makeMask((_, c) => (c === 160 ? 25 : 200)); // 2.5 m shoal line
    const a = { lat: 54.75, lon: 10.19 };
    const b = { lat: 54.75, lon: 10.22 };
    expect(m.segmentNavigable(a, b, 3.0)).toBe(false);
    expect(m.segmentNavigable(a, b, 2.0)).toBe(true);
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
    expect(m.cellsConnected(WEST, EAST, 2.3)).toBe(true);
    // 2.3 >= 2.4 is false → the gap cells drop out of the navigable set
    expect(m.cellsConnected(WEST, EAST, 2.4)).toBe(false);
  });

  it('is 4-connectivity: a diagonal-only corner touch does not connect', () => {
    // Only two navigable cells, corner-touching at (100,100) and (101,101).
    const m = makeMask((r, c) => ((r === 100 && c === 100) || (r === 101 && c === 101) ? 200 : 0));
    const a = { lat: 54.3 + 100.5 * 0.005, lon: 9.4 + 100.5 * 0.005 };
    const b = { lat: 54.3 + 101.5 * 0.005, lon: 9.4 + 101.5 * 0.005 };
    expect(m.cellsConnected(a, b, 3)).toBe(false);
  });

  it('same cell is trivially connected; a non-navigable endpoint is not connected', () => {
    const m = gapMask();
    expect(m.cellsConnected(WEST, WEST, 3)).toBe(true);
    const onWall = { lat: 54.3025, lon: 10.2025 }; // row 0, col 160 → land byte 0
    expect(m.cellsConnected(WEST, onWall, 2.0)).toBe(false);
    expect(m.cellsConnected(onWall, WEST, 2.0)).toBe(false);
  });

  it('out-of-bbox endpoints are never connected', () => {
    const m = makeMask(() => 200);
    expect(m.cellsConnected({ lat: 60, lon: 20 }, { lat: 54.75, lon: 10.2 }, 3)).toBe(false);
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
