import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTOUR_LEVELS_M, type ContourAsset, type ContourFeature } from '../lib/contours';
import { MASK_TOLERANCE_M, cautiousDepthLowerBoundM, maskGrid } from '../lib/mask';
import type { MaskMeta } from '../types';

// #629 §5/§6: pipeline/build_contours.py's output is a generated asset with
// no compiler spanning its Python producer and this TypeScript consumer.
// This file is the fail-closed pin: a rebuilt mask with a stale
// contours.json, a drifted MASK_TOLERANCE_M/CONTOUR_LEVELS_M, or a pipeline
// classification bug all red here.

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');

const maskMeta = JSON.parse(readFileSync(resolve(dataDir, 'mask.meta.json'), 'utf8')) as MaskMeta;
const maskBytes = readFileSync(resolve(dataDir, 'mask.bin'));
const contours = JSON.parse(
  readFileSync(resolve(dataDir, 'contours.json'), 'utf8'),
) as ContourAsset;

const GRID = maskGrid(maskMeta); // replaces LAT_CPD / LON_CPD

function byteAt(row: number, col: number): number {
  return maskBytes[row * maskMeta.cols + col];
}

function shippedDepthM(b: number): number {
  return b === 0 ? 0 : b === 255 ? 25.4 : b / 10;
}

function atOrAboveLevel(b: number, levelM: number): boolean {
  return cautiousDepthLowerBoundM(shippedDepthM(b)) >= levelM;
}

type Point = readonly [number, number];
interface Segment {
  readonly p0: Point;
  readonly p1: Point;
}

function segmentsOf(feature: ContourFeature): Segment[] {
  const segs: Segment[] = [];
  for (const line of feature.geometry.coordinates) {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      segs.push({ p0: [a[0]!, a[1]!], p1: [b[0]!, b[1]!] });
    }
  }
  return segs;
}

/** Deterministic stride sample — never random, so a red is reproducible. */
const MAX_SAMPLES_PER_FEATURE = 200;
function sampleStride<T>(items: readonly T[], maxSamples: number): T[] {
  if (items.length <= maxSamples) return [...items];
  const stride = Math.ceil(items.length / maxSamples);
  const out: T[] = [];
  for (let i = 0; i < items.length; i += stride) out.push(items[i]!);
  return out;
}

/**
 * Vertex-grid indices a segment endpoint lands on, rounded to the nearest
 * integer — sound because contours.json's coordinates are exact multiples of
 * the grid step before their 1e-5 rounding (CLAUDE.md's `#1259` note: an
 * on-boundary coordinate can round by float noise, which is exactly why this
 * function is used only to recover the vertex index, never to sample a point
 * ON the boundary for a cell-classification read).
 */
function vertexIndex(p: Point): { row: number; col: number } {
  return {
    row: Math.round(GRID.lat.coord(p[1])),
    col: Math.round(GRID.lon.coord(p[0])),
  };
}

interface CellPair {
  /** `null` when this side falls outside the grid (an outer-boundary edge). */
  readonly a: { row: number; col: number } | null;
  readonly b: { row: number; col: number } | null;
}

/**
 * The (up to) two cells a segment separates, from the segment's endpoints
 * alone — never from a sampled point offset into either cell, so this
 * reaches exactly the same interior/boundary classification the pipeline's
 * tracer used, with no risk of drifting into a THIRD cell along a merged
 * multi-step run.
 */
function cellsAcross(seg: Segment): CellPair {
  const v0 = vertexIndex(seg.p0);
  const v1 = vertexIndex(seg.p1);
  if (v0.row === v1.row) {
    // Horizontal: fixed vertex row R separates array row R-1 (south) from R (north).
    const r = v0.row;
    const col = Math.min(v0.col, v1.col);
    return {
      a: r - 1 >= 0 ? { row: r - 1, col } : null,
      b: r < maskMeta.rows ? { row: r, col } : null,
    };
  }
  // Vertical: fixed vertex col C separates array col C-1 (west) from C (east).
  const c = v0.col;
  const row = Math.min(v0.row, v1.row);
  return {
    a: c - 1 >= 0 ? { row, col: c - 1 } : null,
    b: c < maskMeta.cols ? { row, col: c } : null,
  };
}

describe('#629 contours.json is tied to the shipped mask', () => {
  it('maskSha256 equals sha256 of the committed mask.bin', () => {
    const hash = createHash('sha256').update(maskBytes).digest('hex');
    expect(contours.maskSha256).toBe(hash);
  });

  it('toleranceM and levelsM match the app-side constants', () => {
    expect(contours.toleranceM).toBe(MASK_TOLERANCE_M);
    expect(contours.levelsM).toEqual(CONTOUR_LEVELS_M);
    expect(contours.basis).toBe('cautious');
  });
});

describe('#629 differential: pipeline cell classification vs cautiousDepthLowerBoundM', () => {
  it('no-data edge: sampled segments separate byte-0 from non-zero, or sit on the outer boundary of a non-zero cell', () => {
    const feature = contours.features.find((f) => f.properties.kind === 'no-data');
    expect(feature, 'no no-data feature').toBeDefined();
    const samples = sampleStride(segmentsOf(feature!), MAX_SAMPLES_PER_FEATURE);
    expect(samples.length, 'zero sampled no-data segments').toBeGreaterThan(0);
    for (const seg of samples) {
      const { a, b } = cellsAcross(seg);
      if (a === null || b === null) {
        const inside = a ?? b;
        expect(
          inside,
          'a boundary no-data edge must have exactly one adjacent cell',
        ).not.toBeNull();
        expect(
          byteAt(inside!.row, inside!.col),
          'outer-boundary no-data edge must border a non-zero cell',
        ).not.toBe(0);
      } else {
        const byteA = byteAt(a.row, a.col);
        const byteB = byteAt(b.row, b.col);
        const zeroCount = (byteA === 0 ? 1 : 0) + (byteB === 0 ? 1 : 0);
        expect(
          zeroCount,
          'an interior no-data edge must separate exactly one byte-0 cell from one non-zero cell',
        ).toBe(1);
      }
    }
  });
});

/** Unit cell edges a polyline set covers, keyed `H:<vertexRow>:<col>` / `V:<vertexCol>:<row>`. */
function unitEdgeKeys(feature: ContourFeature): string[] {
  const keys: string[] = [];
  for (const seg of segmentsOf(feature)) {
    const v0 = vertexIndex(seg.p0);
    const v1 = vertexIndex(seg.p1);
    if (v0.row === v1.row) {
      for (let c = Math.min(v0.col, v1.col); c < Math.max(v0.col, v1.col); c++)
        keys.push(`H:${v0.row}:${c}`);
    } else {
      for (let r = Math.min(v0.row, v1.row); r < Math.max(v0.row, v1.row); r++)
        keys.push(`V:${v0.col}:${r}`);
    }
  }
  return keys;
}

/** Every edge §2 says a feature must carry, derived from mask.bin alone. */
function expectedEdgeKeys(
  isEdge: (b0: number, b1: number) => boolean,
  boundary: boolean,
): Set<string> {
  const { rows, cols } = maskMeta;
  const out = new Set<string>();
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const b = byteAt(r, c);
      if (r + 1 < rows && isEdge(b, byteAt(r + 1, c))) out.add(`H:${r + 1}:${c}`);
      if (c + 1 < cols && isEdge(b, byteAt(r, c + 1))) out.add(`V:${c + 1}:${r}`);
      if (boundary && b !== 0) {
        if (r === 0) out.add(`H:0:${c}`);
        if (r === rows - 1) out.add(`H:${rows}:${c}`);
        if (c === 0) out.add(`V:0:${r}`);
        if (c === cols - 1) out.add(`V:${cols}:${r}`);
      }
    }
  return out;
}

function expectExactEdgeSet(feature: ContourFeature, expected: Set<string>): void {
  const got = unitEdgeKeys(feature);
  const gotSet = new Set(got);
  expect(got.length, 'an edge was emitted twice').toBe(gotSet.size);
  expect(expected.size, 'expected edge set is empty').toBeGreaterThan(0);
  const missing = [...expected].filter((k) => !gotSet.has(k));
  const extra = [...gotSet].filter((k) => !expected.has(k));
  expect(missing.slice(0, 5), `${missing.length} qualifying edges missing`).toEqual([]);
  expect(extra.slice(0, 5), `${extra.length} unexpected edges`).toEqual([]);
}

describe('#629 completeness: every qualifying no-data edge is emitted exactly once', () => {
  it('no-data edge', () => {
    const feature = contours.features.find((f) => f.properties.kind === 'no-data')!;
    expectExactEdgeSet(
      feature,
      expectedEdgeKeys((b0, b1) => (b0 === 0) !== (b1 === 0), true),
    );
  });
});

type Cell = readonly [row: number, col: number];

/** Floor/ceil of a / b for integers a >= 0, b > 0 — exact, no float division. */
function floorDiv(a: number, b: number): number {
  return (a - (a % b)) / b;
}
function ceilDiv(a: number, b: number): number {
  return floorDiv(a + b - 1, b);
}

/**
 * Mirrors pipeline/build_contours.py's chord_cells: for an axis-aligned
 * segment, the cell pair beside each unit edge it lies on; otherwise every
 * cell whose open interior the open segment crosses. Exact in integers,
 * which is sound because smoothed vertices stay on the vertex lattice
 * (vertexIndex's own caveat).
 */
function chordCells(seg: Segment): { axis: boolean; cells: Cell[] } {
  const v0 = vertexIndex(seg.p0);
  const v1 = vertexIndex(seg.p1);
  const cells: Cell[] = [];
  if (v0.row === v1.row) {
    for (let c = Math.min(v0.col, v1.col); c < Math.max(v0.col, v1.col); c++)
      cells.push([v0.row - 1, c], [v0.row, c]);
    return { axis: true, cells };
  }
  if (v0.col === v1.col) {
    for (let r = Math.min(v0.row, v1.row); r < Math.max(v0.row, v1.row); r++)
      cells.push([r, v0.col - 1], [r, v0.col]);
    return { axis: true, cells };
  }
  const [a, b] = v0.col < v1.col ? [v0, v1] : [v1, v0];
  const dc = b.col - a.col;
  const dr = b.row - a.row;
  for (let c = a.col; c < b.col; c++) {
    const ya = a.row * dc + dr * (c - a.col);
    const yb = a.row * dc + dr * (c + 1 - a.col);
    for (let r = floorDiv(Math.min(ya, yb), dc); r < ceilDiv(Math.max(ya, yb), dc); r++)
      cells.push([r, c]);
  }
  return { axis: false, cells };
}

function inGrid([r, c]: Cell): boolean {
  return r >= 0 && r < maskMeta.rows && c >= 0 && c < maskMeta.cols;
}

function cellKey([r, c]: Cell): number {
  return (r + 1) * (maskMeta.cols + 2) + (c + 1);
}

function levelFeature(levelM: number): ContourFeature {
  const feature = contours.features.find(
    (f) => f.properties.kind === 'contour' && f.properties.levelM === levelM,
  );
  expect(feature, `no contour feature for level ${levelM} m`).toBeDefined();
  return feature!;
}

function qualifyingLevelEdges(levelM: number): Set<string> {
  return expectedEdgeKeys(
    (b0, b1) => b0 !== 0 && b1 !== 0 && atOrAboveLevel(b0, levelM) !== atOrAboveLevel(b1, levelM),
    false,
  );
}

/** The two cells an `H:`/`V:` unit-edge key separates. */
function edgeKeyCells(key: string): [Cell, Cell] {
  const [kind, fixed, along] = key.split(':') as [string, string, string];
  const f = Number(fixed);
  const a = Number(along);
  return kind === 'H'
    ? [
        [f - 1, a],
        [f, a],
      ]
    : [
        [a, f - 1],
        [a, f],
      ];
}

// #1540: level lines are smoothed by shortcutting the staircase. The cautious
// guarantee is that no point of a smoothed level-L line lies on the shallow
// side of the edges it was traced from — every point stays in the closure of
// the cells at or above L, classified here by cautiousDepthLowerBoundM, never
// by the pipeline.
describe('#1540 smoothed level lines stay on the deep side of their staircase', () => {
  for (const levelM of CONTOUR_LEVELS_M) {
    it(`level ${levelM} m: every segment lies in the closure of the at-or-above-level cells`, () => {
      const deep = (cell: Cell): boolean =>
        inGrid(cell) && atOrAboveLevel(byteAt(cell[0], cell[1]), levelM);
      const segs = segmentsOf(levelFeature(levelM));
      const violations: string[] = [];
      let diagonal = 0;
      for (const seg of segs) {
        const { axis, cells } = chordCells(seg);
        if (axis) {
          for (let k = 0; k < cells.length; k += 2)
            if (!deep(cells[k]!) && !deep(cells[k + 1]!))
              violations.push(`${JSON.stringify(seg)} lies on an edge with no deep cell beside it`);
        } else {
          diagonal++;
          const shallow = cells.filter((cell) => !deep(cell));
          if (shallow.length > 0)
            violations.push(
              `${JSON.stringify(seg)} crosses shallow cells ${JSON.stringify(shallow)}`,
            );
        }
      }
      expect(
        diagonal,
        'no smoothed (non-axis) segment — the guard would be vacuous',
      ).toBeGreaterThan(0);
      expect(violations.slice(0, 5), `${violations.length} segments on the shallow side`).toEqual(
        [],
      );
    });

    it(`level ${levelM} m: every vertex is a vertex of its own staircase`, () => {
      const vertices = new Set<string>();
      for (const key of qualifyingLevelEdges(levelM)) {
        const [kind, fixed, along] = key.split(':') as [string, string, string];
        const f = Number(fixed);
        const a = Number(along);
        const ends = kind === 'H' ? [`${f}:${a}`, `${f}:${a + 1}`] : [`${a}:${f}`, `${a + 1}:${f}`];
        ends.forEach((v) => vertices.add(v));
      }
      const stray: string[] = [];
      for (const line of levelFeature(levelM).geometry.coordinates)
        for (const p of line) {
          const { row, col } = vertexIndex([p[0]!, p[1]!]);
          if (!vertices.has(`${row}:${col}`)) stray.push(`${row}:${col}`);
        }
      expect(stray.slice(0, 5), `${stray.length} vertices off the staircase`).toEqual([]);
    });

    it(`level ${levelM} m: every qualifying edge borders a cell a smoothed segment touches`, () => {
      const touched = new Set<number>();
      for (const seg of segmentsOf(levelFeature(levelM)))
        for (const cell of chordCells(seg).cells) touched.add(cellKey(cell));
      const expected = qualifyingLevelEdges(levelM);
      expect(expected.size, 'expected edge set is empty').toBeGreaterThan(0);
      const missing = [...expected].filter((key) =>
        edgeKeyCells(key).every((cell) => !touched.has(cellKey(cell))),
      );
      expect(missing.slice(0, 5), `${missing.length} qualifying edges not covered`).toEqual([]);
    });
  }
});
