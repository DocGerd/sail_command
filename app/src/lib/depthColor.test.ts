import { describe, it, expect } from 'vitest';
import {
  buildDepthImageData,
  buildNavigabilityHatchImageData,
  depthByteToRgba,
  depthSourceCorners,
  hatchBandForZoom,
  hatchScreenPxPerCell,
  HATCH_FALLBACK_BAND,
  HATCH_WASH_BAND,
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
    // Exact, not approximate: this call passes no band, so it uses
    // HATCH_FALLBACK_BAND — period 8, stripe 2 — and an 8x8 grid is exactly
    // one period in both dimensions, so the diagonal stripe visits exactly
    // 2 of every 8 columns per row (64 * 2/8 = 16) with no boundary
    // remainder. (#599 renamed the constants this comment used to cite;
    // the assertion itself is unchanged, and the fallback band deliberately
    // reproduces the pre-#599 fixed pair so it stays 16.)
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

  it('holds the on-screen stripe within 7.9-17 px across z9..z13, where the old pair spanned 1.1-19 px', () => {
    // THE DEFECT, stated as a comparison rather than asserted in prose: the
    // old fixed 2-cell stripe is what produced #599's sub-pixel wash.
    //
    // SAMPLING IS PART OF THE ASSERTION HERE. An earlier revision swept
    // z9..z13.5 on a 0.25 grid and asserted `<= 16`, which PASSED at a
    // sampled max of 14.25 — while the true maximum is 16.95, at the TOP of
    // a band. The grid stepped straight over every band top, so the guard
    // was vacuous: it passed because of where it looked, not because the
    // property held. The sweep now explicitly includes each band's last
    // reachable moment.
    const zooms: number[] = [];
    for (let z = 9; z <= 13; z += 0.25) zooms.push(z);
    for (const n of [9, 10, 11, 12]) zooms.push(n + 0.999); // band tops
    const widths = zooms.map((z) => hatchBandForZoom(z).stripeCells * expectedPxPerCell(z));
    const oldWidths = zooms.map((z) => 2 * expectedPxPerCell(z));
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(7.9);
    expect(Math.max(...widths)).toBeLessThanOrEqual(17);
    // NON-VACUITY: the band tops really are where the maximum lives, so the
    // bound above is exercised rather than stepped over. Reds if the sweep
    // ever stops sampling them.
    expect(Math.max(...widths)).toBeGreaterThan(16);
    // THE CONTROL, corrected: an earlier revision asserted the old pair's
    // max exceeded 18 px, which is only true if the sweep runs past z13 —
    // over z9..z13 the old max is 16.95, INSIDE the band asserted above, so
    // that form of the control was false here rather than discriminating.
    // What actually separates the two schemes at this range is the FLOOR and
    // the SPREAD: the old fixed pair washes out to ~1 px at z9 and spans 16x,
    // where the band scheme holds a 7.9 px floor and spans 2.1x.
    const spread = (a: number[]) => Math.max(...a) / Math.min(...a);
    expect(Math.min(...oldWidths)).toBeLessThan(1.2);
    expect(spread(oldWidths)).toBeGreaterThan(10);
    expect(spread(widths)).toBeLessThan(2.5);
  });

  it('never asks the raster for a sub-cell stripe, and clamps to 1 cell at z13 — then degrades (#648)', () => {
    // z13, not the "~z13.6" an earlier revision used: under the shipped
    // Math.floor quantisation the stripe count is round(8 / px(floor(z))),
    // which reaches 1 at floor(z) = 13 exactly. (The three real thresholds
    // in the continuous scheme are z12.332, z12.917 and z13.917 — see
    // depthColor.ts; none of them is 13.6.)
    //
    // #648 SPLIT THIS RANGE. Before it, (4, 1) was held unbroken to z22 and
    // the single painted cell grew to 67.8 px at z16 / 4338 px at z22 — the
    // hard-edged squares #648 reports. The clamp now stops where it starts
    // being a fiction: round(8 / px) reaches 0 at px = 16, i.e. z = 13.917,
    // so under Math.floor the LAST striped band is z13 and z14 is the first
    // washed one. Both halves are asserted, and the boundary is asserted as
    // a boundary — a threshold moved either way reds one of the three.
    for (let z = 13; z < 14; z += 0.2) {
      expect(hatchBandForZoom(z)).toEqual({ periodCells: 4, stripeCells: 1 });
    }
    for (let z = 14; z <= 22; z += 0.2) {
      expect(hatchBandForZoom(z)).toEqual(HATCH_WASH_BAND);
    }
    // The boundary itself, at the tightest reachable pair.
    expect(hatchBandForZoom(13.999)).toEqual({ periodCells: 4, stripeCells: 1 });
    expect(hatchBandForZoom(14)).toEqual(HATCH_WASH_BAND);
  });

  it('#648 SAFETY: degrading at z14 can only ever paint MORE, never less', () => {
    // THE STRUCTURAL INVARIANT, asserted at the byte level rather than
    // argued: HATCH_RGBA is unchanged and the marginal criterion is
    // unchanged, so the only thing #648 moves is WHICH marginal cells this
    // pass paints. Because the wash band has period 1, its painted set is
    // {marginal} — a strict SUPERSET of the z13 band's {marginal AND phase}
    // — so alpha rises pointwise and, black over anything, luminance can
    // only fall. No marginal cell can render lighter or lose its hatch.
    //
    // Non-vacuous by construction: reverting hatchBandForZoom's degradation
    // makes the two bands IDENTICAL, so the strict-inequality row reds.
    const COLS = 64;
    const ROWS = 64;
    const data = new Uint8Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) data[r * COLS + c] = 1 + (c % 200);
    for (const gate of [2.2, 3.0, 10]) {
      const striped = buildNavigabilityHatchImageData(data, ROWS, COLS, gate, hatchBandForZoom(13));
      const washed = buildNavigabilityHatchImageData(data, ROWS, COLS, gate, hatchBandForZoom(16));
      let stripedPainted = 0;
      let washedPainted = 0;
      for (let i = 0; i < ROWS * COLS; i++) {
        const a = striped[i * 4 + 3];
        const b = washed[i * 4 + 3];
        if (a !== 0) stripedPainted++;
        if (b !== 0) washedPainted++;
        // Pointwise monotone: never lighter, and never a different colour.
        expect(b).toBeGreaterThanOrEqual(a);
        if (a !== 0) {
          expect([washed[i * 4], washed[i * 4 + 1], washed[i * 4 + 2], b]).toEqual([
            striped[i * 4],
            striped[i * 4 + 1],
            striped[i * 4 + 2],
            a,
          ]);
        }
      }
      expect(stripedPainted, `gate ${gate}: the z13 band must paint something`).toBeGreaterThan(0);
      expect(
        washedPainted,
        `gate ${gate}: z16 must paint strictly MORE cells than z13, not the same band`,
      ).toBeGreaterThan(stripedPainted);
    }
  });

  it('caps the GAP at 12 cells at every zoom — the measured no-blank-region bound', () => {
    // The gap bounds whether a marginal region can fall entirely between
    // stripes: a 4-connected region's (outRow + col) values are a contiguous
    // range and a gap is exactly `gap` consecutive values, so a region
    // spanning gap+1 or more distinct indices always catches a stripe
    // (COUNT of indices, sMax - sMin + 1 — not the span; the bound is tight
    // and observed saturated at exactly `gap`). 12 is the largest gap at
    // which no marginal region of >=100 cells goes unpainted anywhere in the
    // real mask at the five reachable bands, across eight gates
    // (2.2/2.5/2.8/3.0/3.5/4.0/5.0/10) — 40 clean combinations. The cap is
    // NOT sufficient alone: blanking is phase-dependent, and before the
    // Math.floor quantisation 15 bands were reachable, 14 of whose
    // combinations blanked a >=100-cell region. The quantisation is what
    // makes the cap sufficient, by shrinking the reachable set to those 5 —
    // see depthColor.ts's SAFETY note for which mechanism does which. This
    // test pins the CAP; the band-set size is pinned by the two tests below.
    for (let z = 0; z <= 22; z += 0.5) {
      const { periodCells, stripeCells } = hatchBandForZoom(z);
      expect(periodCells - stripeCells).toBeLessThanOrEqual(12);
      expect(stripeCells).toBeGreaterThanOrEqual(1);
      // #648: a solid fill is now REQUIRED above the degradation threshold
      // and still FORBIDDEN below it — asserted as an exact partition rather
      // than relaxed to an unconditional bound, so neither half can drift.
      // Its gap is 0, which is why the >=100-cell blanking sweep behind the
      // cap above owes it nothing: no gap, no region can fall inside one.
      if (z >= 14) {
        expect(periodCells).toBe(stripeCells);
        expect(periodCells - stripeCells).toBe(0);
      } else {
        expect(periodCells).toBeGreaterThan(stripeCells);
      }
    }
  });

  it('#599/#648 SAFETY: quantises to whole zoom levels, so only SIX bands are reachable', () => {
    // THE KEEPER FOR Math.floor. Without it 15 bands are reachable and 14
    // gate x band combinations blank a marginal region of >=100 cells in the
    // real mask (depthColor.ts's SAFETY note). The safety property here is
    // the SIZE and MEMBERSHIP of this set, not any one band, so a future
    // reader cannot "simplify" the floor away as redundant rounding without
    // reddening this.
    const seen = new Map<string, number>();
    for (let z = 0; z <= 22; z += 0.05) {
      const b = hatchBandForZoom(z);
      seen.set(`${b.periodCells}/${b.stripeCells}`, b.periodCells - b.stripeCells);
    }
    // '1/1' is #648's degraded wash band (z14 up). The other five are #599's
    // and are the ones the 8-gate x 5-band blanking sweep covered; the wash
    // has gap 0 and so cannot blank a region of any size.
    expect([...seen.keys()].sort()).toEqual(['1/1', '16/4', '20/8', '27/15', '4/1', '8/2']);
    expect(seen.get('1/1'), 'the wash band must have ZERO gap').toBe(0);
    // A fractional zoom must give the SAME band as the integer below it.
    for (const [z, frac] of [
      [9, 9.9],
      [10, 10.5],
      [11, 11.99],
      [12, 12.5],
      [13, 13.75],
    ] as const) {
      expect(hatchBandForZoom(frac)).toEqual(hatchBandForZoom(z));
    }
  });

  it('#599 SAFETY: fails CLOSED on a non-finite zoom instead of painting nothing', () => {
    // A NaN zoom used to yield { periodCells: NaN, stripeCells: NaN }, and
    // `(outRow + col) % NaN < NaN` is false for every cell — a map with ZERO
    // hatch, silently. Marginal water rendering as unmarked is the one
    // direction a safety cue must never fail in.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(hatchBandForZoom(bad)).toEqual(HATCH_FALLBACK_BAND);
      // The property that actually matters is that the band can PAINT: both
      // fields finite, and a non-empty stripe within the period.
      const { periodCells, stripeCells } = hatchBandForZoom(bad);
      expect(Number.isFinite(periodCells) && Number.isFinite(stripeCells)).toBe(true);
      expect(stripeCells).toBeGreaterThanOrEqual(1);
      expect(periodCells).toBeGreaterThan(stripeCells);
    }
    // END-TO-END, not just the band object: a NaN zoom must still hatch a
    // uniformly-marginal mask. This is the assertion that would have caught
    // the original defect, since the band object alone looks harmless.
    const mask = new Uint8Array(64).fill(1); // 8x8, always marginal
    const img = buildNavigabilityHatchImageData(mask, 8, 8, 10, hatchBandForZoom(NaN));
    let painted = 0;
    for (let i = 0; i < 64; i++) if (img[i * 4 + 3] !== 0) painted++;
    expect(painted, 'a non-finite zoom must not silently paint zero hatch').toBeGreaterThan(0);
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
