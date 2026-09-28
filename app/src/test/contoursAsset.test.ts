import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTOUR_LEVELS_M, type ContourAsset, type ContourFeature } from '../lib/contours';
import { MASK_TOLERANCE_M, cautiousDepthLowerBoundM, cellsPerDegree } from '../lib/mask';
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

const LAT_CPD = cellsPerDegree(maskMeta.south, maskMeta.north, maskMeta.rows);
const LON_CPD = cellsPerDegree(maskMeta.west, maskMeta.east, maskMeta.cols);

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
    row: Math.round((p[1] - maskMeta.south) * LAT_CPD),
    col: Math.round((p[0] - maskMeta.west) * LON_CPD),
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
  for (const levelM of CONTOUR_LEVELS_M) {
    it(`level ${levelM} m: sampled segments separate above/below cells`, () => {
      const feature = contours.features.find(
        (f) => f.properties.kind === 'contour' && f.properties.levelM === levelM,
      );
      expect(feature, `no contour feature for level ${levelM} m`).toBeDefined();
      const samples = sampleStride(segmentsOf(feature!), MAX_SAMPLES_PER_FEATURE);
      expect(samples.length, `zero sampled segments for level ${levelM} m`).toBeGreaterThan(0);
      for (const seg of samples) {
        const { a, b } = cellsAcross(seg);
        expect(a, 'level-line edge must be strictly interior').not.toBeNull();
        expect(b, 'level-line edge must be strictly interior').not.toBeNull();
        const byteA = byteAt(a!.row, a!.col);
        const byteB = byteAt(b!.row, b!.col);
        expect(byteA, 'level line must separate two non-zero (water) cells').not.toBe(0);
        expect(byteB, 'level line must separate two non-zero (water) cells').not.toBe(0);
        const aboveA = atOrAboveLevel(byteA, levelM);
        const aboveB = atOrAboveLevel(byteB, levelM);
        expect(aboveA, 'segment must separate above/below, not two same-side cells').not.toBe(
          aboveB,
        );
      }
    });
  }

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
