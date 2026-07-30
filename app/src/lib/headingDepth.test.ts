import { describe, expect, it } from 'vitest';
import { NavMask } from './mask';
import { checkHeadingDepth, maskCellKey } from './headingDepth';
import type { LatLon, Leg, MaskMeta } from '../types';

// 10x10 cells of 0.01 deg over 54.00-54.10 N, 9.00-9.10 E.
// Row 0 is the southernmost row, col 0 the westernmost (types.ts:233).
const META: MaskMeta = { west: 9.0, south: 54.0, east: 9.1, north: 54.1, cols: 10, rows: 10 };
const STEP = 0.01;

// Byte 255 = "deep, >= 25.4 m", which segmentShallowestBelow never counts as
// shallow — so an all-255 grid is unambiguously clear at any threshold.
function maskWith(cells: Array<{ row: number; col: number; byte: number }>): NavMask {
  const data = new Uint8Array(META.rows * META.cols).fill(255);
  for (const c of cells) data[c.row * META.cols + c.col] = c.byte;
  return new NavMask(META, data);
}

function centreOf(row: number, col: number): LatLon {
  return { lat: META.south + (row + 0.5) * STEP, lon: META.west + (col + 0.5) * STEP };
}

function legTo(start: LatLon, end: LatLon): Leg {
  return {
    kind: 'sail',
    start,
    end,
    startTimeMs: 0,
    endTimeMs: 3_600_000,
    headingDeg: 90,
    twsKn: 12,
    speedKn: 5,
    distanceNm: 1,
    board: 'starboard',
    twaDeg: 45,
    maneuverAtStart: null,
  };
}

describe('checkHeadingDepth', () => {
  it('reports clear when every cell along the bearing is deep', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    const result = checkHeadingDepth(maskWith([]), [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'clear' });
  });

  it('reports caution with the shallowest depth on the bearing', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    // byte 20 -> 20/10 = 2.0 m; byte 25 -> 2.5 m. Shallowest is 2.0.
    const mask = maskWith([
      { row: 0, col: 4, byte: 25 },
      { row: 0, col: 6, byte: 20 },
    ]);
    const result = checkHeadingDepth(mask, [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'caution', shallowestM: 2.0 });
  });

  it('ignores shallow cells that the bearing does not cross', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    const mask = maskWith([{ row: 9, col: 4, byte: 20 }]);
    const result = checkHeadingDepth(mask, [legTo(from, to)], 0, from, 3.0);
    expect(result).toEqual({ state: 'clear' });
  });

  it('treats a cell exactly at the safety depth as clear, one decimetre below as caution', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    // segmentShallowestBelow uses strict `depthM < thresholdM`.
    // byte 30 -> 3.0 m, not below 3.0. byte 29 -> 2.9 m, below.
    expect(
      checkHeadingDepth(maskWith([{ row: 0, col: 5, byte: 30 }]), [legTo(from, to)], 0, from, 3.0),
    ).toEqual({ state: 'clear' });
    expect(
      checkHeadingDepth(maskWith([{ row: 0, col: 5, byte: 29 }]), [legTo(from, to)], 0, from, 3.0),
    ).toEqual({ state: 'caution', shallowestM: 2.9 });
  });

  it('reports unavailable when there is no mask', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    expect(checkHeadingDepth(null, [legTo(from, to)], 0, from, 3.0)).toEqual({
      state: 'unavailable',
    });
  });

  it('reports unavailable — never clear — when the fix is outside mask coverage', () => {
    const inside = centreOf(0, 9);
    const outside: LatLon = { lat: 53.5, lon: 8.5 };
    const result = checkHeadingDepth(maskWith([]), [legTo(outside, inside)], 0, outside, 3.0);
    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable when the waypoint is outside mask coverage', () => {
    const from = centreOf(0, 0);
    const outside: LatLon = { lat: 54.05, lon: 9.6 };
    const result = checkHeadingDepth(maskWith([]), [legTo(from, outside)], 0, from, 3.0);
    expect(result).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable when the leg index does not exist', () => {
    const from = centreOf(0, 0);
    const to = centreOf(0, 9);
    expect(checkHeadingDepth(maskWith([]), [legTo(from, to)], 5, from, 3.0)).toEqual({
      state: 'unavailable',
    });
  });
});

describe('maskCellKey', () => {
  it('is stable within a cell and changes between cells', () => {
    const a = { lat: 54.0 + 0.001, lon: 9.0 + 0.001 };
    const b = { lat: 54.0 + 0.009, lon: 9.0 + 0.009 };
    const c = { lat: 54.0 + 0.011, lon: 9.0 + 0.001 };
    expect(maskCellKey(META, a)).toBe(maskCellKey(META, b));
    expect(maskCellKey(META, a)).not.toBe(maskCellKey(META, c));
    expect(maskCellKey(META, a)).toBe('0:0');
    expect(maskCellKey(META, c)).toBe('1:0');
  });

  it('collapses every out-of-coverage point to one key', () => {
    expect(maskCellKey(META, { lat: 53.0, lon: 8.0 })).toBe('out');
    expect(maskCellKey(META, { lat: 55.0, lon: 10.0 })).toBe('out');
  });
});
