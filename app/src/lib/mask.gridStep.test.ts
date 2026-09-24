import { describe, it, expect } from 'vitest';
import type { MaskMeta } from '../types';
import { cellsPerDegree, maskGrid, NavMask, type MaskGrid } from './mask';
import { assertNonVacuousStrip, stripCommentsAndStrings } from '../test/sourceStrip';

// #1259: a bbox change must leave every pre-existing cell's centre and index
// bit-identical. The pre-#1259 step `(north - south) / rows` moved every
// centre by an ulp whenever the far edge moved.

// The pre-#295 and #295 extents of the committed mask.
const BASE: MaskMeta = { west: 9.4, south: 54.3, east: 11.0, north: 55.3, cols: 2200, rows: 2400 };
const EAST_WIDENED: MaskMeta = { ...BASE, east: 11.6, cols: 3025 };
const NORTH_WIDENED: MaskMeta = { ...BASE, north: 55.6, rows: 3120 };

function expectSharedCellsIdentical(a: MaskGrid, b: MaskGrid, rows: number, cols: number) {
  let checked = 0;
  for (let row = 0; row < rows; row++) {
    const la = a.lat.centre(row);
    const lb = b.lat.centre(row);
    expect(Object.is(la, lb), `row ${row} centre ${la} vs ${lb}`).toBe(true);
    expect(a.lat.index(la)).toBe(row);
    expect(b.lat.index(lb)).toBe(row);
    expect(a.lat.coord(la)).toBe(b.lat.coord(lb));
    checked++;
  }
  for (let col = 0; col < cols; col++) {
    const la = a.lon.centre(col);
    const lb = b.lon.centre(col);
    expect(Object.is(la, lb), `col ${col} centre ${la} vs ${lb}`).toBe(true);
    expect(a.lon.index(la)).toBe(col);
    expect(b.lon.index(lb)).toBe(col);
    expect(a.lon.coord(la)).toBe(b.lon.coord(lb));
    checked++;
  }
  expect(checked).toBe(rows + cols);
}

describe('#1259 exact mask grid step', () => {
  it('east-only widening leaves every shared cell bit-identical', () => {
    expectSharedCellsIdentical(maskGrid(BASE), maskGrid(EAST_WIDENED), BASE.rows, BASE.cols);
  });

  it('north-only widening leaves every shared cell bit-identical', () => {
    expectSharedCellsIdentical(maskGrid(BASE), maskGrid(NORTH_WIDENED), BASE.rows, BASE.cols);
  });

  it('NavMask.snapToNavigable returns the exact-step centre under both extents', () => {
    const a = new NavMask(BASE, new Uint8Array(BASE.rows * BASE.cols).fill(200));
    const b = new NavMask(
      NORTH_WIDENED,
      new Uint8Array(NORTH_WIDENED.rows * NORTH_WIDENED.cols).fill(200),
    );
    // Rows 1040/1115 and col 1036 are cells whose centre the pre-#1259
    // quotient step moved by an ulp under both extents.
    for (const [row, col] of [
      [1040, 1036],
      [1115, 1036],
    ] as const) {
      const expected = { lat: 54.3 + (row + 0.5) / 2400, lon: 9.4 + (col + 0.5) / 1375 };
      const p = { lat: expected.lat + 1e-5, lon: expected.lon + 1e-5 };
      expect(a.snapToNavigable(p, 3)).toEqual(expected);
      expect(b.snapToNavigable(p, 3)).toEqual(expected);
    }
  });

  it('derives integer cells-per-degree for the committed mask', () => {
    const [raw] = Object.values(
      import.meta.glob<string>('../../public/data/mask.meta.json', {
        query: '?raw',
        import: 'default',
        eager: true,
      }),
    );
    expect(raw).toBeTypeOf('string');
    const grid = maskGrid(JSON.parse(raw!) as MaskMeta);
    expect(grid.lat.cpd).toBe(2400);
    expect(grid.lon.cpd).toBe(1375);
  });

  it('throws on a non-integer cells-per-degree', () => {
    expect(() => cellsPerDegree(9.4, 11.0, 4)).toThrow(/integer cells-per-degree/);
    expect(() => maskGrid({ ...BASE, cols: 2201 })).toThrow(/integer cells-per-degree/);
    expect(() => new NavMask({ ...BASE, north: 55.35 }, new Uint8Array(BASE.rows * BASE.cols))).toThrow(
      /integer cells-per-degree/,
    );
    expect(() => cellsPerDegree(54, 54, 10)).toThrow(/integer cells-per-degree/);
    expect(cellsPerDegree(BASE.south, BASE.north, BASE.rows)).toBe(2400);
  });

  // Every production step site must go through the helper: six hand-copied
  // derivations is how the drift entered.
  it('no production module re-derives the step as a bbox quotient', () => {
    const QUOTIENT =
      /\(\s*(?:\w+\.)*(?:north|east)\s*-\s*(?:\w+\.)*(?:south|west)\s*\)\s*\)?\s*\/\s*(?:\w+\.)*(?:rows|cols)\b/;
    // Positive controls: both spellings that existed before #1259.
    expect(QUOTIENT.test('const latStep = (meta.north - meta.south) / meta.rows;')).toBe(true);
    expect(QUOTIENT.test('lat: m.south + ((row + 0.5) * (m.north - m.south)) / m.rows,')).toBe(
      true,
    );

    const sources = import.meta.glob<string>(
      ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}', '!/src/test/**'],
      {
        query: '?raw',
        import: 'default',
        eager: true,
      },
    );
    expect(Object.keys(sources)).toContain('/src/lib/mask.ts');
    expect(Object.keys(sources)).toContain('/src/routing/isochrone.ts');
    const code = Object.fromEntries(Object.entries(sources).map(([path, src]) => [path, stripCommentsAndStrings(src)]));
    assertNonVacuousStrip(code['/src/lib/mask.ts']!, 'cells / (hi - lo)', 'mask.ts');
    const offenders = Object.entries(code)
      .filter(([, src]) => QUOTIENT.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
