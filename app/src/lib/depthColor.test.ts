import { describe, it, expect } from 'vitest';
import {
  buildDepthImageData,
  buildNavigabilityHatchImageData,
  depthByteToRgba,
  depthSourceCorners,
  HATCH_RGBA,
} from './depthColor';
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

describe('buildNavigabilityHatchImageData (#492)', () => {
  it('throws on a rows*cols mismatch', () => {
    expect(() => buildNavigabilityHatchImageData(new Uint8Array(5), 2, 3, 3)).toThrow(/rows\*cols/);
  });

  it('land (byte 0) never hatches, even at an absurdly high safetyDepthM', () => {
    const mask = new Uint8Array([0, 0, 0, 0]);
    const img = buildNavigabilityHatchImageData(mask, 1, 4, 1000);
    expect(Array.from(img).every((v) => v === 0)).toBe(true);
  });

  // #492 discriminating control: the SAME cell, only safetyDepthM differs.
  // byte 30 = 3.0 m shipped -> cautiousDepthLowerBoundM = 2.1 m, hand-derived
  // from mask.ts's own formula (never re-called here, to avoid re-deriving
  // the expectation from the function under test): floor((3.0 -
  // MASK_TOLERANCE_M) * 10) / 10 = floor((3.0 - 0.9) * 10) / 10 = 2.1.
  it('ABSENT below the gate, APPEARS above it, for the identical mask', () => {
    const mask = new Uint8Array(64).fill(30); // 8x8, uniform 3.0 m shipped depth
    const clear = buildNavigabilityHatchImageData(mask, 8, 8, 2.0); // 2.1 < 2.0 is false
    expect(Array.from(clear).every((v) => v === 0)).toBe(true); // control: absent
    const marginal = buildNavigabilityHatchImageData(mask, 8, 8, 3.0); // 2.1 < 3.0 is true
    expect(Array.from(marginal).some((v) => v !== 0)).toBe(true); // appears
  });

  it("deep water (byte 255) never hatches, even at the UI's own maximum safetyDepthM (10)", () => {
    const mask = new Uint8Array(4).fill(255);
    const img = buildNavigabilityHatchImageData(mask, 1, 4, 10);
    expect(Array.from(img).every((v) => v === 0)).toBe(true);
  });

  it('hatches SPARSELY, not a solid fill: exactly 2 of every 8 columns per row (25% coverage)', () => {
    const mask = new Uint8Array(64).fill(1); // 8x8, uniformly very shallow (0.1 m) — always marginal
    const img = buildNavigabilityHatchImageData(mask, 8, 8, 10);
    let hatched = 0;
    for (let i = 0; i < 64; i++) if (img[i * 4 + 3] !== 0) hatched++;
    // Exact, not approximate: an 8x8 grid is exactly one HATCH_PERIOD_PX (8)
    // in both dimensions, so the diagonal stripe visits exactly 2 of every 8
    // columns per row (64 * 2/8 = 16) with no boundary remainder.
    expect(hatched).toBe(16);
  });

  it('paints the fixed HATCH_RGBA colour, never a depth-dependent one', () => {
    const mask = new Uint8Array(64).fill(1);
    const img = buildNavigabilityHatchImageData(mask, 8, 8, 10);
    // row 0, col 0: (0 + 0) % 8 = 0 < 2 -> hatched.
    expect(Array.from(img.subarray(0, 4))).toEqual(HATCH_RGBA);
  });

  it('flips vertically the same way buildDepthImageData does', () => {
    // 2 rows x 8 cols; south row (mask index 0..7) shallow+marginal, north
    // row (mask index 8..15) land — same south/north convention as
    // buildDepthImageData's own flip test above.
    const south = new Array(8).fill(1); // shallow, marginal at a high gate
    const north = new Array(8).fill(0); // land
    const mask = new Uint8Array([...south, ...north]);
    const img = buildNavigabilityHatchImageData(mask, 2, 8, 10);
    // Image row 0 (top = north = land) must be fully transparent throughout.
    expect(Array.from(img.subarray(0, 32)).every((v) => v === 0)).toBe(true);
    // Image row 1 (bottom = south = shallow) must have at least one hatched pixel.
    expect(Array.from(img.subarray(32, 64)).some((v) => v !== 0)).toBe(true);
  });

  it('is structurally unreachable from the absolute ramp: neither ramp function accepts a safetyDepthM parameter', () => {
    const m = new Uint8Array(1);
    // @ts-expect-error HARD DOMAIN RULE: the absolute ramp must have no slot for
    // safetyDepthM. Reds at COMPILE time if one is ever added — including a
    // DEFAULTED one, which Function.length cannot see (PR #591 review, MEASURED).
    expect(() => buildDepthImageData(m, 1, 1, 3)).not.toThrow();
    // @ts-expect-error same rule for the per-byte ramp
    expect(depthByteToRgba(1, 3)).toBeDefined();
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
