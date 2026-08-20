import { describe, it, expect } from 'vitest';
import {
  buildDepthImageData,
  buildNavigabilityHatchImageData,
  depthByteToRgba,
  depthSourceCorners,
  hatchBandForZoom,
  hatchScreenPxPerCell,
  HATCH_FALLBACK_BAND,
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

const DATA_LAYERS_SOURCES = import.meta.glob<string>('../components/DataLayers.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const DATA_LAYERS_SOURCE = (() => {
  const hit = Object.entries(DATA_LAYERS_SOURCES).find(([k]) =>
    k.endsWith('components/DataLayers.tsx'),
  );
  // Fail CLOSED: a glob that stops matching must red, not silently pass.
  if (!hit) throw new Error('DataLayers.tsx source not found via import.meta.glob');
  return hit[1];
})();

describe('hatchBandForZoom (#599)', () => {
  // Independent re-derivation of screenPxPerCell, deliberately NOT importing
  // hatchScreenPxPerCell: deriving the expectation from the function under
  // test is the tautology this repo keeps paying for. These four constants
  // are the ones a reader can check against mask.meta.json and the Web
  // Mercator definition, and the results were confirmed in a real browser
  // via map.project() (z9 0.5296, z12 4.2367, z16 67.7867 px/cell).
  const expectedPxPerCell = (z: number) =>
    46.67 / ((40075016.686 * Math.cos((54.8 * Math.PI) / 180)) / (512 * 2 ** z));

  it('agrees with the real browser measurement to within 0.05% at every zoom', () => {
    // RELATIVE, not toBeCloseTo: the quantity spans 0.53 px at z9 to 271 px
    // at z18, so a fixed decimal tolerance is vacuously loose at one end and
    // impossible at the other. Right-hand values are the MEASURED ones from
    // Chromium (map.project() on two points one mask cell apart).
    for (const [z, measured] of [
      [9, 0.5296],
      [11, 2.1183],
      [12, 4.2367],
      [16, 67.7867],
      [18, 271.1469],
    ] as const) {
      for (const derived of [expectedPxPerCell(z), hatchScreenPxPerCell(z)]) {
        expect(Math.abs(derived - measured) / measured).toBeLessThan(0.0005);
      }
    }
  });

  it('reproduces the pre-#599 fixed pair (8, 2) at z12 — the one zoom it was right for', () => {
    expect(hatchBandForZoom(12)).toEqual({ periodCells: 8, stripeCells: 2 });
    expect(HATCH_FALLBACK_BAND).toEqual({ periodCells: 8, stripeCells: 2 });
  });

  it('holds the on-screen stripe within 5.3-16 px across z9..z13.5, where the old pair spanned 1.1-19 px', () => {
    // THE DEFECT, stated as a comparison rather than asserted in prose: the
    // old fixed 2-cell stripe is what produced #599's sub-pixel wash.
    const widths: number[] = [];
    const oldWidths: number[] = [];
    for (let z = 9; z <= 13.5; z += 0.25) {
      const px = expectedPxPerCell(z);
      widths.push(hatchBandForZoom(z).stripeCells * px);
      oldWidths.push(2 * px);
    }
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(5.3);
    expect(Math.max(...widths)).toBeLessThanOrEqual(16);
    // The control: the old constants are OUTSIDE that band at both ends, so
    // the assertion above is not one every band would satisfy.
    expect(Math.min(...oldWidths)).toBeLessThan(1.2);
    expect(Math.max(...oldWidths)).toBeGreaterThan(18);
  });

  it('never asks the raster for a sub-cell stripe, and clamps to 1 cell above ~z13.6', () => {
    for (let z = 13.6; z <= 22; z += 0.2) {
      expect(hatchBandForZoom(z)).toEqual({ periodCells: 4, stripeCells: 1 });
    }
  });

  it('caps the GAP at 12 cells at every zoom — the measured no-blank-region bound', () => {
    // Gap, not period, is what decides whether a marginal region can fall
    // entirely between stripes: a 4-connected region's (outRow + col) values
    // are a contiguous range, so extent >= gap+1 always catches a stripe.
    // 12 is the largest gap at which no marginal region of >=100 cells goes
    // unpainted anywhere in the real mask, at gates 2.2/2.8/3.0/10 — see
    // depthColor.ts's SAFETY note for the measurement.
    for (let z = 0; z <= 22; z += 0.5) {
      const { periodCells, stripeCells } = hatchBandForZoom(z);
      expect(periodCells - stripeCells).toBeLessThanOrEqual(12);
      expect(stripeCells).toBeGreaterThanOrEqual(1);
      expect(periodCells).toBeGreaterThan(stripeCells); // never a solid fill
    }
  });

  it('freezes below z9 rather than growing the band without bound', () => {
    expect(hatchBandForZoom(0)).toEqual(hatchBandForZoom(9));
    expect(hatchBandForZoom(-5)).toEqual(hatchBandForZoom(9));
  });

  it('#599 SAFETY: the band changes WHICH marginal cells are painted, never WHICH are marginal', () => {
    // The set of marginal cells is the safety surface (#612's twin-pin reads
    // it back out of this same function). Recover it band-independently: a
    // 1-cell period paints every marginal cell, so that set is the criterion
    // itself. It must be identical for every band the zoom range can select.
    const COLS = 256;
    const ROWS = 32;
    const data = new Uint8Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) data[r * COLS + c] = c;
    const solid = { periodCells: 1, stripeCells: 1 };
    for (const gate of [2.2, 2.8, 3.0, 5.0, 10]) {
      const all = buildNavigabilityHatchImageData(data, ROWS, COLS, gate, solid);
      const marginalBytes = new Set<number>();
      for (let c = 0; c < COLS; c++) if (all[c * 4 + 3] !== 0) marginalBytes.add(c);
      // Every band paints a SUBSET of that set and never anything outside it.
      for (const z of [9, 10, 11, 12, 13, 16, 22]) {
        const img = buildNavigabilityHatchImageData(data, ROWS, COLS, gate, hatchBandForZoom(z));
        const painted = new Set<number>();
        for (let r = 0; r < ROWS; r++)
          for (let c = 0; c < COLS; c++) if (img[(r * COLS + c) * 4 + 3] !== 0) painted.add(c);
        // ROWS(32) >= every period, so each column meets the stripe at least
        // once and `painted` recovers the full criterion, not a phase sample.
        expect([...painted].sort((a, b) => a - b)).toEqual(
          [...marginalBytes].sort((a, b) => a - b),
        );
      }
    }
  });

  it('#599: every PRODUCTION call site passes a band (the optional parameter is for guards only)', () => {
    // buildNavigabilityHatchImageData's `band` is optional so the two
    // criterion guards that call the 4-argument form keep exercising the
    // fallback band unchanged. That optionality would otherwise let a
    // production call site silently ship the pre-#599 fixed pair at every
    // zoom, which no type error and no unit test would catch — so the
    // production source is scanned instead.
    //
    // `import.meta.glob(..., '?raw')` rather than node:fs — the browser-safe
    // form (relaxedDepth.test.ts / sailLiteralCallSites.test.ts), which needs
    // no tsconfig.app.json exclusion. Keys are relative to THIS file's own
    // directory, and the lookup fails CLOSED so a glob that stops matching
    // reds instead of silently passing.
    const src = DATA_LAYERS_SOURCE;
    const calls = src.split('buildNavigabilityHatchImageData(').slice(1);
    expect(calls.length, 'expected DataLayers.tsx to still call the hatch builder').toBe(2);
    for (const call of calls) {
      expect(call.slice(0, 400)).toContain('hatchBandForZoom(map.getZoom())');
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
