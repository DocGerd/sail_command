import { describe, expect, it } from 'vitest';
import { makeMask, TEST_MASK_META } from '../test/fixtures';
import { NavMask } from './mask';

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
    const fineGridMeta = { west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 3200, rows: 2000 };
    const fineData = new Uint8Array(fineGridMeta.rows * fineGridMeta.cols);
    // Land at cols < 1600, water at cols >= 1600
    for (let r = 0; r < fineGridMeta.rows; r++) {
      for (let c = 0; c < fineGridMeta.cols; c++) {
        fineData[r * fineGridMeta.cols + c] = c < 1600 ? 0 : 200;
      }
    }
    const m = new NavMask(fineGridMeta, fineData);
    const onLand = { lat: 54.75, lon: 10.205 }; // col ~1600 (land), ~32m from col 1600 center
    const snapped = m.snapToNavigable(onLand, 3.0);
    expect(snapped).not.toBeNull();
    expect(m.isNavigable(snapped!, 3.0)).toBe(true);
    const deepInland = { lat: 54.75, lon: 9.5 };
    expect(m.snapToNavigable(deepInland, 3.0)).toBeNull();
  });
});
