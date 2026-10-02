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

  it('lets a full-width box taller than wide claim only the bottom, never a side', () => {
    const phone: Box = { left: 0, top: 0, right: 390, bottom: 844 };
    const p = fitPadding(phone, [{ left: 0, top: 380, right: 390, bottom: 844 }]);
    expect(p).toEqual({ top: 48, right: 48, bottom: 480, left: 48 });
  });

  it('sends a second box to the axis a first one has not loaded', () => {
    const tablet: Box = { left: 0, top: 121, right: 820, bottom: 1180 };
    const p = fitPadding(tablet, [
      { left: 8, top: 129, right: 139, bottom: 295 },
      { left: 0, top: 591, right: 820, bottom: 1180 },
    ]);
    expect(p).toEqual({ top: 48, right: 48, bottom: 605, left: 155 });
  });

  it('weighs a claim against the room its axis has left, not the full extent', () => {
    const square: Box = { left: 0, top: 0, right: 1000, bottom: 1000 };
    const p = fitPadding(square, [
      { left: 0, top: 600, right: 1000, bottom: 1000 },
      { left: 0, top: 0, right: 300, bottom: 290 },
    ]);
    expect(p).toEqual({ top: 48, right: 48, bottom: 416, left: 316 });
  });

  it('charges a claim only for what it adds to an already loaded edge', () => {
    const square: Box = { left: 0, top: 0, right: 1000, bottom: 1000 };
    const p = fitPadding(square, [
      { left: 0, top: 600, right: 1000, bottom: 1000 },
      { left: 0, top: 700, right: 300, bottom: 1000 },
    ]);
    expect(p).toEqual({ top: 48, right: 48, bottom: 416, left: 48 });
  });

  it('ignores chrome outside the map', () => {
    expect(fitPadding(MAP, [{ left: 1000, top: 0, right: 1400, bottom: 800 }])).toEqual({
      top: 48,
      right: 48,
      bottom: 48,
      left: 48,
    });
  });

  it('caps an axis without pushing either edge below the base', () => {
    const both = fitPadding(MAP, [
      { left: 0, top: 0, right: 450, bottom: 800 },
      { left: 550, top: 0, right: 1000, bottom: 800 },
    ]);
    expect(both.left + both.right).toBeCloseTo(700, 6);
    expect(both.left).toBeCloseTo(both.right, 6);

    const lone = fitPadding(MAP, [{ left: 0, top: 0, right: 900, bottom: 800 }]);
    expect(lone.right).toBe(48);
    expect(lone.left).toBeCloseTo(652, 6);
  });
});
