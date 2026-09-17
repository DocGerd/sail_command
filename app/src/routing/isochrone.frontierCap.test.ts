import { describe, expect, it } from 'vitest';
import { defaultMaxFrontier } from './isochrone';
import type { MaskMeta } from '../types';

// #1257: the frontier cap scales with mask cell count, anchored so the
// pre-#295 mask (2400 rows x 2200 cols, parent of 4a4be94) keeps the
// historical 30_000.
describe('#1257 defaultMaxFrontier', () => {
  it('pre-#295 mask (2400x2200) yields exactly 30_000', () => {
    expect(defaultMaxFrontier({ rows: 2400, cols: 2200 })).toBe(30_000);
  });

  it('post-#295 mask dims (3120x3025) yield 53_625', () => {
    // 30_000 * 9_438_000 / 5_280_000, hand-derived.
    expect(defaultMaxFrontier({ rows: 3120, cols: 3025 })).toBe(53_625);
  });

  it('the committed mask resolves to 53_625', () => {
    // ?raw glob rather than node:fs, which would need a tsconfig.test.json entry.
    const raw = import.meta.glob<string>('/public/data/mask.meta.json', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const text = raw['/public/data/mask.meta.json'];
    expect(text, 'mask.meta.json not loaded').toBeTypeOf('string');
    const meta = JSON.parse(text ?? '') as MaskMeta;
    expect([meta.rows, meta.cols]).toEqual([3120, 3025]);
    expect(defaultMaxFrontier(meta)).toBe(53_625);
  });

  it('a small (synthetic-sized) mask keeps the 30_000 floor', () => {
    expect(defaultMaxFrontier({ rows: 100, cols: 100 })).toBe(30_000);
  });
});
