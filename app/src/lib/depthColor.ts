// Depth-byte -> RGBA ramp for the map's bathymetry overlay (#39). Pure
// (bytes in, RGBA out) so it stays unit-testable without a canvas backend —
// the canvas/MapLibre wiring lives in components/DataLayers.tsx.
//
// HARD DOMAIN RULE: this ramp colors ABSOLUTE depth only — never
// navigability. Safety depth is a query-time user setting (CLAUDE.md) and
// must never influence the overlay; the stops below are fixed absolute
// depths chosen for chart-like readability, not derived from any setting.
//
// Byte encoding (mask.meta.json / NavMask): 0 = land or unknown (rendered
// fully transparent — the basemap already draws land), 1..254 = depth in
// decimetres floored (0.1..25.4 m), 255 = deep (>= 25.4 m).
//
// #492: buildNavigabilityHatchImageData (bottom of this file) is a SECOND,
// independently-composited image builder that intentionally BREAKS the
// rule above for its own narrow purpose — sparse hazard hatching keyed on
// the user's safetyDepthM. It is a deliberate, structurally separate
// exception: STOPS, depthByteToRgba and buildDepthImageData above stay
// byte-for-byte gate-blind, this function is never called from them, and
// its output is never merged into buildDepthImageData's buffer — it is
// composited as its own MapLibre layer (components/DataLayers.tsx). See
// that function's own doc comment for the full rationale.

import type { MaskMeta } from '../types';
import { cautiousDepthLowerBoundM } from './mask';

const LAND = 0;
const DEEP = 255;
const DEEP_M = 25.4;

export type Rgba = [r: number, g: number, b: number, a: number];

/**
 * Image-source corner coordinates for the depth raster, in MapLibre's required
 * order — top-left, top-right, bottom-right, bottom-left — derived from the
 * mask bbox. Kept here, next to buildDepthImageData, because the two are
 * coupled: buildDepthImageData flips mask rows south→north so image row 0 is
 * NORTH, and this anchors the source's top edge at `north` to match. A reorder
 * on either side silently mirrors the overlay, which neither the e2e pixel
 * check nor jsdom can catch — so it's pinned by a unit test here instead.
 */
export function depthSourceCorners(
  meta: MaskMeta,
): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [meta.west, meta.north], // top-left
    [meta.east, meta.north], // top-right
    [meta.east, meta.south], // bottom-right
    [meta.west, meta.south], // bottom-left
  ];
}

// Okabe-Ito-anchored sequential ramp: shallows scream warm (that's what a
// sailor scans for — the Salona 45 draws 2.1 m), then cools and fades so
// deep water leaves the basemap (and its labels) fully readable. Alpha is
// monotonically non-increasing with depth; the deep end fades to fully
// transparent.
const STOPS: ReadonlyArray<{ depthM: number; rgba: Rgba }> = [
  { depthM: 0.1, rgba: [213, 94, 0, 191] }, // vermillion — critical shallows
  { depthM: 2.0, rgba: [230, 159, 0, 166] }, // orange — around draft depth
  { depthM: 4.0, rgba: [240, 228, 66, 128] }, // yellow
  { depthM: 7.0, rgba: [86, 180, 233, 97] }, // sky blue
  { depthM: 12.0, rgba: [0, 114, 178, 61] }, // blue
  { depthM: DEEP_M, rgba: [0, 114, 178, 0] }, // fades out entirely
];

const TRANSPARENT: Rgba = [0, 0, 0, 0];

/**
 * Shared byte->metres decode (mask.meta.json's encoding, restated in this
 * file's own header comment). Used by depthByteToRgba below AND by
 * buildNavigabilityHatchImageData at the bottom of this file — extracted so
 * the two never carry two independently-maintained copies of the same
 * quantization arithmetic.
 */
function byteToDepthM(byte: number): number {
  return byte === DEEP ? DEEP_M : byte / 10;
}

/** Pure ramp: one mask byte -> RGBA (0..255 channels, unpremultiplied). */
export function depthByteToRgba(byte: number): Rgba {
  if (byte === LAND) return [...TRANSPARENT];
  const depthM = byteToDepthM(byte);
  if (depthM <= STOPS[0].depthM) return [...STOPS[0].rgba];
  for (let i = 1; i < STOPS.length; i++) {
    if (depthM > STOPS[i].depthM) continue;
    const lo = STOPS[i - 1];
    const hi = STOPS[i];
    const f = (depthM - lo.depthM) / (hi.depthM - lo.depthM);
    return lo.rgba.map((c, ch) => Math.round(c + (hi.rgba[ch] - c) * f)) as Rgba;
  }
  return [...STOPS[STOPS.length - 1].rgba];
}

/**
 * Full-mask RGBA image (rows*cols*4, row-major) for a canvas/ImageData,
 * VERTICALLY FLIPPED: the mask stores row 0 = southernmost (mask.meta.json),
 * while canvas/image row 0 is the top — which the MapLibre source anchors at
 * the bbox's NORTH edge — so output row r mirrors mask row (rows-1-r).
 */
export function buildDepthImageData(
  mask: Uint8Array,
  rows: number,
  cols: number,
): Uint8ClampedArray {
  if (mask.length !== rows * cols)
    throw new Error(`mask length ${mask.length} != rows*cols ${rows * cols}`);
  // 256-entry LUT: 5.28M cells at ~46 m resolution would otherwise pay the
  // piecewise-linear interpolation per cell.
  const lut = new Uint8ClampedArray(256 * 4);
  for (let b = 0; b < 256; b++) lut.set(depthByteToRgba(b), b * 4);
  const out = new Uint8ClampedArray(rows * cols * 4);
  for (let outRow = 0; outRow < rows; outRow++) {
    const maskRow = rows - 1 - outRow;
    for (let col = 0; col < cols; col++) {
      const byte = mask[maskRow * cols + col];
      out.set(lut.subarray(byte * 4, byte * 4 + 4), (outRow * cols + col) * 4);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// #492: navigability hatch — a SECOND, independently-composited raster.
// Everything above this line stays byte-for-byte gate-blind (HARD DOMAIN
// RULE, top of file). Nothing below is called from above, and nothing above
// calls anything below.
// ---------------------------------------------------------------------------

// Achromatic and near-opaque, deliberately NOT drawn from the STOPS palette
// above: the same reasoning components/DataLayers.tsx's HARBOR_CIRCLE_LAYER
// comment already gives for its own black+white marker treatment (#38/#39
// review) — black can't collide with any depth-ramp hue under
// colour-blindness, where a hatch colour borrowed from STOPS (e.g. the
// ~2 m orange band's [230,159,0]) would risk blending into the very band it
// exists to override.
export const HATCH_RGBA: Rgba = [0, 0, 0, 190];
// Sparse diagonal stripes, not a solid fill: the absolute ramp underneath
// must stay legible through the gaps, since the two layers are read
// TOGETHER — colour says how deep, hatch says whether that's enough. The
// stripe/gap pair is expressed in MASK CELLS and CHOSEN PER ZOOM by
// hatchBandForZoom below (#599); it used to be one fixed pair applied at
// every zoom, which is the defect that function exists to fix.
//
// ---------------------------------------------------------------------------
// #599: WHY THE PAIR HAS TO DEPEND ON ZOOM, and exactly what that buys.
// ---------------------------------------------------------------------------
// A canvas raster source is drawn in CELL space, so a cell-space pattern
// has no way to hold a fixed size on screen — the on-screen period scales
// with zoom, washing out to sub-pixel speckle at overview zoom and
// coarsening into individually huge bands close in (#492 review M8).
//
// THE METHOD, written out so it can be re-run backwards rather than
// re-trusted (this file's own lesson: a bare table of constants cannot be).
// MapLibre uses 512 px tiles, so
//
//   metresPerScreenPx(z) = 40075016.686 * cos(lat) / (512 * 2^z)
//   screenPxPerCell(z)   = MASK_CELL_M / metresPerScreenPx(z)
//
// At the region's ~54.8N centre that reduces to screenPxPerCell(z) =
// 2^z / 966.7. MEASURED in Chromium against the real map via
// map.project() one cell apart, which is what settled the constant: z9
// 0.5296, z12 4.2367, z16 67.7867 px per cell — all within 0.1% of the
// formula. TWIN: lib/mapOrientation.test.ts's metresPerPixel() derives the
// same ground resolution independently for the scale bar, in the same
// 512-px-tile form — check the two agree before changing either.
// NOTE the previous revision of this comment used 156543.03,
// the 256-px-tile constant, and so tabulated every on-screen figure at
// HALF its true value; the issue text of #599 inherited that table. Do
// not restore either.
//
// Given that, the band is picked to hold the on-screen STRIPE near
// HATCH_TARGET_STRIPE_PX, with the GAP capped (see the safety note below):
//
//   z    px/cell  stripe  gap  period  duty  | on-screen stripe px
//   -----|--------|-------|-----|-------|------|--------------------
//   <=9  |   0.53 |    15 |  12 |    27 |  56% | 7.9   (was 1.06)
//   10   |   1.06 |     8 |  12 |    20 |  40% | 8.5   (was 2.12)
//   11   |   2.12 |     4 |  12 |    16 |  25% | 8.5   (was 4.24)
//   12   |   4.24 |     2 |   6 |     8 |  25% | 8.5   (was 8.47 — SAME)
//   13   |   8.47 |     1 |   3 |     4 |  25% | 8.5   (was 16.9)
//   16   |  67.79 |     1 |   3 |     4 |  25% | 67.8  (was 135.6)
//   22   | 4338.4 |     1 |   3 |     4 |  25% | 4338  (was 8677)
//
// Read the z12 row twice: the OLD fixed pair was (8, 2), so the shipped
// constants were already correct — at exactly one zoom. The bug was
// applying them at the other thirteen.
//
// WHAT THIS DOES NOT ACHIEVE, stated plainly rather than left to be
// discovered. This is STEPWISE invariance across discrete bands, NOT
// zoom-invariance:
//   * Between z9 and ~z13.6 the on-screen stripe is held to 5.3-16 px
//     (the rounding spread of an integer cell count around an 8 px
//     target), which is the range the wash-out complaint was about.
//   * Above ~z13.6 a single mask cell is ALREADY wider than the target,
//     so stripe = 1 cell is the finest thing a per-cell raster can
//     express and the on-screen stripe resumes doubling per zoom level.
//     It is exactly HALF the old width there (1 cell instead of 2), which
//     is an improvement, not a fix. Genuinely fixing the close-zoom end
//     needs screen-space rendering (a fill-pattern layer), which the
//     maintainer weighed against this and did not choose for #599 — it
//     needs a mask-cells-to-polygons geometry pass.
//   * Below z9 the band is frozen (the whole ~103 km mask bbox is already
//     wider than a desktop viewport there), so the stripe shrinks again
//     as the user zooms further out.
//
// SAFETY: WHY THE GAP IS CAPPED AT HATCH_MAX_GAP_CELLS, MEASURED. Growing
// the period to hold the stripe near target also grows the GAP, and a
// marginal region small enough to fall entirely inside one gap renders
// NOTHING — a new, feature-selective way to under-signal that the old
// fixed pair did not have. That risk is bounded exactly, not estimated: a
// 4-connected region's (outRow + col) values form a CONTIGUOUS integer
// range, so a region whose diagonal extent is >= gap+1 ALWAYS contains a
// painted cell. Measured over the real committed mask (2200x2400) by
// labelling every 4-connected marginal region and counting those that
// receive zero painted cells, at gates 2.2 / 2.8 / 3.0 / 10 m:
//
//   gap 15 -> up to 1 region of >=100 cells renders blank (gates 2.8, 3.0)
//   gap 12 -> 0 of 89-167 regions of >=100 cells blank, at EVERY gate
//
// Hence the cap is 12 cells (~560 m), the largest gap at which no marginal
// region of >=100 cells (~0.2 km2) can disappear at any gate tested. The
// cap is what raises the duty cycle to 40-56% at z10 and below rather
// than holding 25%: MORE coverage than the design's nominal 25%, i.e. the
// over-signalling direction, which is the safe one for a hazard cue.
//
// WHY EVEN THE STILL-DEGRADED CASE IS SAFE (structural, not just measured,
// PR #591 re-review — unchanged by #599): HATCH_RGBA is pure black
// ([0, 0, 0, 190]), so compositing it over anything can only ever DECREASE
// luminance, never increase it — and on STOPS above, deeper renders
// LIGHTER (alpha is monotonically non-increasing with depth, fading fully
// transparent over the light basemap; pinned by depthColor.test.ts's
// "fades monotonically" case). So every possible effect of the hatch moves
// a cell toward the ramp's own shallower/more-cautious end, never toward
// deep, and black-over-colour preserves hue. The residual failure mode is
// under-signalling (a real marginal cell reads too faint, or too coarse,
// to notice), never FALSE COMFORT (a marginal cell reading as more clear
// than it is) — the one failure #492 exists to prevent.
//
// WHICH CELLS ARE MARGINAL IS UNTOUCHED BY ALL OF THIS. The band decides
// only which of the already-flagged cells get painted on this pass; the
// `marginal` LUT below is the safety surface and is gate-keyed only.
// app/src/test/maskTolerance.test.ts's #612 twin-pin reads that LUT back
// out of this function's own RGBA output and is deliberately left calling
// the 4-argument form, so it keeps exercising the fallback band.
const MASK_CELL_M = 46.67; // 1.6 deg / 2200 cols at ~54.8N (mask.meta.json)
const HATCH_BAND_LAT_DEG = 54.8; // region centre; cos varies <1% over 54.3-55.3
const HATCH_TARGET_STRIPE_PX = 8;
const HATCH_MAX_GAP_CELLS = 12; // measured cap — see the SAFETY note above
const HATCH_GAP_PER_STRIPE = 3; // 3:1 gap:stripe = the design's nominal 25% duty
// Below this the whole mask bbox already exceeds a desktop viewport, so
// there is no finer structure left to resolve and the band is frozen.
const HATCH_MIN_BAND_ZOOM = 9; // = MapView.tsx's own initial ZOOM
// Zoom used when a caller does not supply a band. Deliberately the value
// at which the pre-#599 fixed pair (8, 2) was already correct, so the
// fallback reproduces the shipped behaviour exactly rather than inventing
// a fourteenth one.
const HATCH_FALLBACK_ZOOM = 12;

/** Stripe geometry for one zoom band, in MASK CELLS (never screen px). */
export type HatchBand = {
  readonly periodCells: number;
  readonly stripeCells: number;
};

/** On-screen size of one mask cell at `zoom`. Exported for the band tests. */
export function hatchScreenPxPerCell(zoom: number): number {
  const metresPerScreenPx =
    (40075016.686 * Math.cos((HATCH_BAND_LAT_DEG * Math.PI) / 180)) / (512 * 2 ** zoom);
  return MASK_CELL_M / metresPerScreenPx;
}

/**
 * Stripe/gap geometry holding the on-screen stripe near
 * HATCH_TARGET_STRIPE_PX, subject to the two hard limits the raster
 * imposes: a stripe can never be finer than ONE mask cell, and the gap is
 * capped so no marginal region of >=100 cells can fall entirely inside it.
 * See the block comment above for the arithmetic and the measurements.
 */
export function hatchBandForZoom(zoom: number): HatchBand {
  const z = Math.max(HATCH_MIN_BAND_ZOOM, zoom);
  const stripeCells = Math.max(1, Math.round(HATCH_TARGET_STRIPE_PX / hatchScreenPxPerCell(z)));
  const gapCells = Math.min(HATCH_GAP_PER_STRIPE * stripeCells, HATCH_MAX_GAP_CELLS);
  return { periodCells: stripeCells + gapCells, stripeCells };
}

/** The band used when a caller supplies none — see HATCH_FALLBACK_ZOOM. */
export const HATCH_FALLBACK_BAND: HatchBand = hatchBandForZoom(HATCH_FALLBACK_ZOOM);

/**
 * Sparse hazard hatching for cells whose CONSERVATIVE depth reading falls
 * below the user's REQUESTED safetyDepthM — the navigability cue #492
 * reports missing. Composited as its own MapLibre canvas source/layer
 * directly above buildDepthImageData's absolute ramp (see
 * components/DataLayers.tsx's setupLayers), never merged into that buffer.
 *
 * BASIS, and why it is the CONSERVATIVE reading rather than the shipped
 * one: pipeline/build_mask.py blends bilinear over the conservative
 * Resampling.max reading only where the two agree within
 * mask.ts's MASK_TOLERANCE_M, so for every cell depth_blend <= depth_max +
 * MASK_TOLERANCE_M — run backwards, depth_max >= depth_blend -
 * MASK_TOLERANCE_M, a SOUND lower bound (mask.ts's own derivation for
 * cautiousDepthLowerBoundM; restated here because this is a second
 * consumer of the same inequality, not a new claim). Keying the hatch on
 * the SHIPPED byte instead — or anything more optimistic — can only ever
 * UNDER-hatch: exactly the false-all-clear #492 reports, where the ramp's
 * own colour can make a cell look more comfortably clear than the data can
 * prove. The conservative basis can only ever OVER-hatch (flag a cell that
 * later turns out fine), never the reverse — the one direction that is
 * safe to be wrong in.
 *
 * Same vertical flip and LAND (byte 0, never hatched) treatment as
 * buildDepthImageData above, and the same 256-entry-LUT shape (pay
 * cautiousDepthLowerBoundM's cost once per distinct BYTE, never once per
 * CELL — up to ~5.28M of them). The caller additionally DEBOUNCES calling
 * this at all, since safetyDepthM AND the zoom band can each change
 * repeatedly in quick succession (components/DataLayers.tsx has the
 * measured detail).
 *
 * `band` (#599) chooses the stripe geometry for the CURRENT zoom — pass
 * hatchBandForZoom(map.getZoom()). It is OPTIONAL only so that the two
 * source-of-truth guards which call the 4-argument form keep exercising
 * the fallback band unchanged (maskTolerance.test.ts's #612 twin-pin, and
 * depthColor.test.ts's own criterion pins); every PRODUCTION call site
 * must pass one, which depthColor.test.ts asserts by scanning
 * DataLayers.tsx's source. The band never affects WHICH cells are
 * marginal, only which marginal cells this pass paints.
 */
export function buildNavigabilityHatchImageData(
  mask: Uint8Array,
  rows: number,
  cols: number,
  safetyDepthM: number,
  band: HatchBand = HATCH_FALLBACK_BAND,
): Uint8ClampedArray {
  if (mask.length !== rows * cols)
    throw new Error(`mask length ${mask.length} != rows*cols ${rows * cols}`);
  const marginal = new Uint8Array(256); // 1 = this byte's conservative floor < safetyDepthM
  for (let b = 1; b < 256; b++) {
    // b === LAND (0) is left 0/false, matching buildDepthImageData's own
    // fully-transparent treatment. NOTE byte 0 is land OR unsurveyed OR
    // drying (< 0.1 m) — build_mask.py writes all three (`code[~known] = 0`,
    // `code[known & (dm < 1)] = 0`, `code[land] = 0`) and the mask cannot
    // distinguish them, so absence of hatch over byte 0 must never be read
    // as "clear". #492 review; tracked as #597.
    marginal[b] = cautiousDepthLowerBoundM(byteToDepthM(b)) < safetyDepthM ? 1 : 0;
  }
  const out = new Uint8ClampedArray(rows * cols * 4); // zero-init: fully transparent by default
  for (let outRow = 0; outRow < rows; outRow++) {
    const maskRow = rows - 1 - outRow; // same south->north flip as buildDepthImageData
    for (let col = 0; col < cols; col++) {
      const byte = mask[maskRow * cols + col];
      if (marginal[byte] && (outRow + col) % band.periodCells < band.stripeCells) {
        out.set(HATCH_RGBA, (outRow * cols + col) * 4);
      }
    }
  }
  return out;
}
