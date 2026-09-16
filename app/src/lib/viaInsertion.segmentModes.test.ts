import { describe, expect, it } from 'vitest';
import {
  emptySegmentModes,
  requestSegmentModes,
  segmentModesAfterInsert,
  segmentModesAfterMove,
  segmentModesAfterRemove,
  segmentModesAfterSwap,
} from './viaInsertion';

// #885 §5.2 / R6. Segments of [O, v0, v1, D]: s0 = O-v0, s1 = v0-v1, s2 = v1-D.
// Expectations derived by hand from which segments each edit splits or touches.
describe('#885 draft segment modes under via edits', () => {
  it('starts with one null per segment', () => {
    expect(emptySegmentModes(0)).toEqual([null]);
    expect(emptySegmentModes(2)).toEqual([null, null, null]);
  });

  it('insertion copies the split segment mode to both halves (R6)', () => {
    // A via inserted at via index 1 lands between v0 and v1, splitting s1.
    expect(segmentModesAfterInsert(['sail', 'motor', null], 1)).toEqual([
      'sail',
      'motor',
      'motor',
      null,
    ]);
    // Inserting before v0 splits s0.
    expect(segmentModesAfterInsert(['sail', 'motor', null], 0)).toEqual([
      'sail',
      'sail',
      'motor',
      null,
    ]);
  });

  it('an append splits the last segment by index', () => {
    expect(segmentModesAfterInsert(['sail', 'motor', 'sail'], 2)).toEqual([
      'sail',
      'motor',
      'sail',
      'sail',
    ]);
    expect(segmentModesAfterInsert(['motor'], 0)).toEqual(['motor', 'motor']);
  });

  it('removal merges the two touching segments into one, cleared', () => {
    expect(segmentModesAfterRemove(['sail', 'motor', 'sail'], 0)).toEqual([null, 'sail']);
    expect(segmentModesAfterRemove(['sail', 'motor', 'sail'], 1)).toEqual(['sail', null]);
  });

  it('a moved via clears the two segments touching it', () => {
    expect(segmentModesAfterMove(['sail', 'motor', 'sail'], 1)).toEqual(['sail', null, null]);
  });

  it('swapping adjacent vias clears every segment touching either', () => {
    // [O, v0, v1, v2, D]: swapping v0 and v1 touches s0, s1, s2 but not s3.
    expect(segmentModesAfterSwap(['sail', 'motor', 'sail', 'motor'], 0)).toEqual([
      null,
      null,
      null,
      'motor',
    ]);
  });

  it('every edit keeps length === vias + 1', () => {
    const modes = ['sail', null, 'motor'] as const; // 2 vias
    expect(segmentModesAfterInsert(modes, 1)).toHaveLength(4);
    expect(segmentModesAfterRemove(modes, 1)).toHaveLength(2);
    expect(segmentModesAfterMove(modes, 0)).toHaveLength(3);
    expect(segmentModesAfterSwap(modes, 0)).toHaveLength(3);
  });

  it('the request carries modes only when something is forced', () => {
    expect(requestSegmentModes([null, null])).toEqual({});
    expect(requestSegmentModes([null, 'sail'])).toEqual({ segmentModes: [null, 'sail'] });
  });
});
