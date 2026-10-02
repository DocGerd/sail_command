import { describe, expect, it } from 'vitest';
import { FIT_PADDING_BASE_PX, fitPadding, type Box } from './fitPadding';

const MAP: Box = { left: 0, top: 0, right: 1000, bottom: 800 };

describe('fitPadding (#1626)', () => {
  it('is uniform without chrome or with an unmeasurable map', () => {
    const base = {
      top: FIT_PADDING_BASE_PX,
      right: FIT_PADDING_BASE_PX,
      bottom: FIT_PADDING_BASE_PX,
      left: FIT_PADDING_BASE_PX,
    };
    expect(fitPadding(MAP, [])).toEqual(base);
    const zero: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(fitPadding(zero, [{ left: 0, top: 0, right: 10, bottom: 10 }])).toEqual(base);
  });

  it('pads the right edge for a tall top-right cluster instead of the top edge', () => {
    const p = fitPadding(MAP, [{ left: 760, top: 12, right: 992, bottom: 470 }]);
    expect(p).toEqual({ top: 48, right: 256, bottom: 48, left: 48 });
  });

  it('pads the left edge for a tall top-left cluster', () => {
    const p = fitPadding(MAP, [{ left: 8, top: 12, right: 140, bottom: 300 }]);
    expect(p.left).toBe(156);
    expect(p.right).toBe(48);
  });

  it('pads the bottom edge for a wide bottom sheet and the top edge for a wide top strip', () => {
    expect(fitPadding(MAP, [{ left: 0, top: 500, right: 1000, bottom: 800 }]).bottom).toBe(316);
    expect(fitPadding(MAP, [{ left: 0, top: 0, right: 1000, bottom: 60 }]).top).toBe(76);
  });

  it('ignores chrome outside the map and clips chrome that overhangs it', () => {
    expect(fitPadding(MAP, [{ left: 1000, top: 0, right: 1400, bottom: 800 }]).right).toBe(48);
    expect(fitPadding(MAP, [{ left: 900, top: 0, right: 1400, bottom: 800 }]).right).toBe(116);
  });

  it('caps each axis so the route keeps room', () => {
    const p = fitPadding(MAP, [
      { left: 0, top: 0, right: 450, bottom: 800 },
      { left: 550, top: 0, right: 1000, bottom: 800 },
    ]);
    expect(p.left + p.right).toBeCloseTo(700, 6);
    expect(p.left).toBeCloseTo(p.right, 6);
  });
});
