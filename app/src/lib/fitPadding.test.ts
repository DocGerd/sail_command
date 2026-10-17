import { describe, expect, it } from 'vitest';
import { FIT_PADDING_BASE_PX, fitPadding, labelOverhang, type Box } from './fitPadding';

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

describe('label overhang (#1641)', () => {
  const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
  const rectAt = (left: number, top: number, right: number, bottom: number): Box => ({
    left,
    top,
    right,
    bottom,
  });

  it('adds extra padding on top of the chrome claims', () => {
    const chrome = [{ left: 760, top: 12, right: 992, bottom: 470 }];
    const base = fitPadding(MAP, chrome);
    expect(fitPadding(MAP, chrome, { top: 7, right: 30, bottom: 5, left: 11 })).toEqual({
      top: base.top + 7,
      right: base.right + 30,
      bottom: base.bottom + 5,
      left: base.left + 11,
    });
  });

  it('measures a label against the top and bottom map edges', () => {
    expect(labelOverhang(MAP, [], [rectAt(100, -20, 200, -4)])).toEqual({ ...NONE, top: 28 });
    expect(labelOverhang(MAP, [], [rectAt(100, 790, 200, 806)])).toEqual({ ...NONE, bottom: 14 });
  });

  it('measures a label against the chrome that claimed the bottom edge', () => {
    // The sheet starts 200 px above the bottom edge.
    const sheet = [{ left: 0, top: 600, right: 1000, bottom: 800 }];
    expect(labelOverhang(MAP, sheet, [rectAt(100, 560, 200, 576)])).toEqual(NONE);
    expect(labelOverhang(MAP, sheet, [rectAt(100, 590, 200, 606)])).toEqual({
      ...NONE,
      bottom: 14,
    });
  });

  it('measures a label against the map edge where no chrome claims it', () => {
    expect(labelOverhang(MAP, [], [rectAt(-40, 100, 80, 116)])).toEqual({ ...NONE, left: 48 });
  });

  it('measures a label against the chrome edge that claimed the side', () => {
    const chrome = [{ left: 760, top: 12, right: 992, bottom: 470 }];
    // The controls start 240 px from the right edge.
    expect(labelOverhang(MAP, chrome, [rectAt(500, 600, 740, 616)])).toEqual(NONE);
    expect(labelOverhang(MAP, chrome, [rectAt(500, 600, 780, 616)])).toEqual({
      ...NONE,
      right: 28,
    });
  });

  it('reports nothing for labels inside the room, or an unmeasurable map', () => {
    expect(labelOverhang(MAP, [], [rectAt(100, 100, 200, 120)])).toEqual(NONE);
    const zero: Box = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(labelOverhang(zero, [], [rectAt(-5, -5, 5, 5)])).toEqual(NONE);
  });
});
