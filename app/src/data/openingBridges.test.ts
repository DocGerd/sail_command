import { describe, expect, it } from 'vitest';
import { OPENING_BRIDGES } from './openingBridges';
import { haversineNm } from '../lib/geo';
import { pointToSegmentM } from '../lib/seamarkProximity';

// #1881: shape invariants. The pin of span and URL to
// pipeline/charted-channels.json is test/openingBridgesPin.test.ts.
const MASK_CELL_M = 46;

describe('#1881 OPENING_BRIDGES', () => {
  it('is non-empty with unique ids', () => {
    expect(OPENING_BRIDGES.length).toBeGreaterThan(0);
    const ids = OPENING_BRIDGES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every passage line passes through its span and is neither a dot nor wider than a sound', () => {
    for (const b of OPENING_BRIDGES) {
      const { a, b: end } = b.passageLine;
      expect(pointToSegmentM(b.span, a, end), b.id).toBeLessThan(MASK_CELL_M);
      const lengthM = haversineNm(a, end) * 1852;
      expect(lengthM, b.id).toBeGreaterThan(MASK_CELL_M);
      expect(lengthM, b.id).toBeLessThan(500);
    }
  });

  it('infoUrls are https Danske Havnelods bridge pages', () => {
    for (const b of OPENING_BRIDGES) {
      expect(b.infoUrl, b.id).toMatch(
        /^https:\/\/www\.danskehavnelods\.dk\/Havnelodsen\/bridges\/[0-9a-f-]+\.html$/,
      );
    }
  });
});
