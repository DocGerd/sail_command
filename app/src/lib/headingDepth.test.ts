import { describe, expect, it } from 'vitest';
import { NavMask } from './mask';
import { advanceHold, checkHeadingDepth, initialHold } from './headingDepth';
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

describe('advanceHold', () => {
  const CAUTION = { state: 'caution', shallowestM: 2.0 } as const;
  const CLEAR = { state: 'clear' } as const;
  const UNAVAIL = { state: 'unavailable' } as const;

  it('engages a caution on the very first detecting observation', () => {
    const hold = advanceHold(initialHold(), CAUTION, 0);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('keeps showing the caution through a single clear observation', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('clears only once clear has held for the full window', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CLEAR, 5900);
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 6000);
    expect(hold.shown).toEqual(CLEAR);
  });

  it('re-arms the caution when shallow water reappears mid-window', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CAUTION, 2000);
    hold = advanceHold(hold, CLEAR, 3000);
    hold = advanceHold(hold, CLEAR, 7500);
    expect(hold.shown).toEqual(CAUTION);
  });

  it('freezes the timer across an unavailable gap instead of counting it', () => {
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    hold = advanceHold(hold, CLEAR, 3000); // 2000 ms accumulated
    hold = advanceHold(hold, UNAVAIL, 4000);
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 20000); // gap must not count
    expect(hold.shown).toEqual(CAUTION);
    hold = advanceHold(hold, CLEAR, 23100); // +3100 -> 5100 total
    expect(hold.shown).toEqual(CLEAR);
  });

  it('banks nothing across a step longer than the clear window, and still clears afterwards', () => {
    // A backgrounded tab or a sleeping device advances even a monotonic clock
    // while GPS delivers nothing. Banking that gap would let one post-wake
    // clear observation satisfy the whole 5000 ms window — the unsafe
    // direction. Hand-derived: the 59 000 ms step banks 0, then 2000 + 3000
    // observed milliseconds reach the window exactly.
    let hold = advanceHold(initialHold(), CAUTION, 0);
    hold = advanceHold(hold, CLEAR, 1000);
    expect(hold.clearAccumMs).toBe(0);

    hold = advanceHold(hold, CLEAR, 60000);
    expect(hold.shown).toEqual(CAUTION);
    expect(hold.clearAccumMs).toBe(0);

    hold = advanceHold(hold, CLEAR, 62000);
    expect(hold.shown).toEqual(CAUTION);
    expect(hold.clearAccumMs).toBe(2000);

    hold = advanceHold(hold, CLEAR, 65000);
    expect(hold.shown).toEqual(CLEAR);
  });

  it('passes unavailable straight through when no caution is held', () => {
    const hold = advanceHold(initialHold(), UNAVAIL, 0);
    expect(hold.shown).toEqual(UNAVAIL);
  });
});
