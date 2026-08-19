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
// TOGETHER — colour says how deep, hatch says whether that's enough. 8px
// period / 2px stripe width is 25% coverage: enough to read as a hazard
// pattern at a glance, sparse enough that the ramp colour dominates.
const HATCH_PERIOD_PX = 8;
const HATCH_STRIPE_WIDTH_PX = 2;

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
 * this at all, since safetyDepthM can change repeatedly in quick
 * succession (components/DataLayers.tsx has the measured detail).
 */
export function buildNavigabilityHatchImageData(
  mask: Uint8Array,
  rows: number,
  cols: number,
  safetyDepthM: number,
): Uint8ClampedArray {
  if (mask.length !== rows * cols)
    throw new Error(`mask length ${mask.length} != rows*cols ${rows * cols}`);
  const marginal = new Uint8Array(256); // 1 = this byte's conservative floor < safetyDepthM
  for (let b = 1; b < 256; b++) {
    // b === LAND (0) is left 0/false: land never hatches, matching
    // buildDepthImageData's own fully-transparent land treatment.
    marginal[b] = cautiousDepthLowerBoundM(byteToDepthM(b)) < safetyDepthM ? 1 : 0;
  }
  const out = new Uint8ClampedArray(rows * cols * 4); // zero-init: fully transparent by default
  for (let outRow = 0; outRow < rows; outRow++) {
    const maskRow = rows - 1 - outRow; // same south->north flip as buildDepthImageData
    for (let col = 0; col < cols; col++) {
      const byte = mask[maskRow * cols + col];
      if (marginal[byte] && (outRow + col) % HATCH_PERIOD_PX < HATCH_STRIPE_WIDTH_PX) {
        out.set(HATCH_RGBA, (outRow * cols + col) * 4);
      }
    }
  }
  return out;
}
