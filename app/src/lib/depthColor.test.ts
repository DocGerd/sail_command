import { describe, it, expect } from 'vitest';
import { buildDepthImageData, depthByteToRgba, depthSourceCorners } from './depthColor';
import { TEST_MASK_META } from '../test/fixtures';

describe('depthByteToRgba', () => {
  it('renders land/unknown (byte 0) fully transparent', () => {
    expect(depthByteToRgba(0)).toEqual([0, 0, 0, 0]);
  });

  it('renders deep water (byte 255, >= 25.4 m) fully transparent', () => {
    expect(depthByteToRgba(255)[3]).toBe(0);
  });

  it('clamps sub-first-stop shallows to the shallowest ramp color', () => {
    // byte 1 = 0.1 m — exactly the first stop; the shallowest color must be
    // warm (vermillion: r > g > b) and strongly visible.
    const [r, g, b, a] = depthByteToRgba(1);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(a).toBeGreaterThan(150);
  });

  it('hits ramp stops exactly (byte 40 = 4.0 m = yellow stop)', () => {
    expect(depthByteToRgba(40)).toEqual([240, 228, 66, 128]);
  });

  it('interpolates between stops (3.0 m is midway between the 2 m and 4 m stops)', () => {
    // stops: 2.0 m -> [230,159,0,166], 4.0 m -> [240,228,66,128]
    expect(depthByteToRgba(30)).toEqual([235, 194, 33, 147]);
  });

  it('fades monotonically: alpha never increases as depth grows', () => {
    let prev = depthByteToRgba(1)[3];
    for (let byte = 2; byte <= 255; byte++) {
      const a = depthByteToRgba(byte)[3];
      expect(a).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });

  it('never encodes navigability: the ramp is a fixed function of the byte alone', () => {
    // Guards the hard domain rule indirectly: same byte, same color — there
    // is no second input (e.g. a safety depth) that could change the result.
    expect(depthByteToRgba(23)).toEqual(depthByteToRgba(23));
    expect(depthByteToRgba(23)[3]).toBeGreaterThan(0);
  });
});

describe('buildDepthImageData', () => {
  it('throws on a rows*cols mismatch', () => {
    expect(() => buildDepthImageData(new Uint8Array(5), 2, 3)).toThrow(/rows\*cols/);
  });

  it('flips vertically: mask row 0 (south) becomes the bottom image row', () => {
    // 2 rows x 3 cols; south row = shallow (byte 10), north row = land (0).
    const mask = new Uint8Array([10, 10, 10, 0, 0, 0]);
    const img = buildDepthImageData(mask, 2, 3);
    const land = depthByteToRgba(0);
    const shallow = depthByteToRgba(10);
    // Image row 0 (top = north) must be the land row…
    expect(Array.from(img.subarray(0, 4))).toEqual(land);
    // …and image row 1 (bottom = south) the shallow row.
    expect(Array.from(img.subarray(3 * 4, 3 * 4 + 4))).toEqual(shallow);
  });

  it('maps every cell through the same ramp as depthByteToRgba', () => {
    const bytes = [0, 1, 42, 254, 255, 128];
    const img = buildDepthImageData(new Uint8Array(bytes), 1, 6);
    for (let i = 0; i < bytes.length; i++) {
      expect(Array.from(img.subarray(i * 4, i * 4 + 4))).toEqual(depthByteToRgba(bytes[i]));
    }
  });
});

describe('depthSourceCorners', () => {
  it('orders corners TL, TR, BR, BL from the mask bbox (locks the flip↔corner coupling)', () => {
    const { west, south, east, north } = TEST_MASK_META;
    // Any reorder here mirrors the raster; must match buildDepthImageData's
    // south→north row flip, which anchors image row 0 at `north`.
    expect(depthSourceCorners(TEST_MASK_META)).toEqual([
      [west, north], // top-left
      [east, north], // top-right
      [east, south], // bottom-right
      [west, south], // bottom-left
    ]);
  });
});
