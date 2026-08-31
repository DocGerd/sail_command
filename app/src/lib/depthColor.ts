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
//   >=14 |  16.95+|     1 |   0 |     1 | 100% | no stripe at all — #648
//
// Read the z12 row twice: the OLD fixed pair was (8, 2), so the shipped
// constants were already correct — at exactly one zoom. The bug was
// applying them at the other thirteen.
//
// The >=14 row is #648 and has its own block below. Until then it read
// `1 | 3 | 4 | 25%` unbroken to z22, i.e. one painted cell 67.8 px wide at
// z16 and 4338 px wide at z22.
//
// WHAT THIS DOES NOT ACHIEVE, stated plainly rather than left to be
// discovered. This is STEPWISE invariance across discrete bands, NOT
// zoom-invariance:
//   * Between z9 and z13 the on-screen stripe is held to 7.9-16.9 px,
//     which is the range the wash-out complaint was about. Every zoom
//     here is DERIVED, not eyeballed: a mask cell reaches the 8 px
//     target at z12.917 (px = 8), the continuous stripe count would fall
//     to 1 at z12.332 (px = 5.333, where round(8/px) crosses 1.5), and
//     round(8/px) would reach 0 at z13.917 (px = 16). An earlier revision
//     wrote "~z13.6" at five sites; that value is none of the three.
//   * At z13 and above a single mask cell is ALREADY wider than the
//     target, so stripe = 1 cell is the finest thing a per-cell raster can
//     express and the on-screen stripe resumes doubling per zoom level.
//     It is exactly HALF the old width there (1 cell instead of 2), which
//     is an improvement, not a fix. z13 STILL WORKS EXACTLY THIS WAY and is
//     byte-identical to #599; #648 changes only z>=14, where it stops
//     drawing a stripe at all (see the #648 block below) rather than
//     letting the doubling run to 4338 px at z22. Genuinely rendering a
//     zoom-INVARIANT hatch still needs screen-space rendering (a
//     fill-pattern layer), which the maintainer weighed against this and
//     did not choose for #599 or for #648 — it needs a
//     mask-cells-to-polygons geometry pass, split out as #792.
//   * Below z9 the band is frozen, so the stripe shrinks again as the user
//     zooms further out. The reason is that z9 already shows the whole
//     dataset, not that the data overflows the screen: the mask bbox is
//     ~103 km wide, which at z9's 88.1 m/px is ~1166 px — comfortably
//     INSIDE a desktop viewport, so zooming out further adds empty sea
//     rather than detail. (An earlier revision said "wider than a desktop
//     viewport", which is false for width at any usual desktop size.)
//
// SAFETY: WHY THE GAP IS CAPPED AT HATCH_MAX_GAP_CELLS, MEASURED. Growing
// the period to hold the stripe near target also grows the GAP, and a
// marginal region small enough to fall entirely inside one gap renders
// NOTHING — a new, feature-selective way to under-signal that the old
// fixed pair did not have. That risk is bounded exactly, not estimated: a
// 4-connected region's (outRow + col) values form a CONTIGUOUS integer
// range, and a gap is exactly `gap` consecutive such values, so any region
// spanning gap+1 or more CONSECUTIVE diagonal indices ALWAYS contains a
// painted cell. Say WHICH COUNT that is, because the off-by-one matters:
// it is the NUMBER of distinct indices (sMax - sMin + 1), not the span
// (sMax - sMin). The bound is tight and empirically SATURATED — the
// largest blank region observed spans exactly `gap` indices (12 for the
// gap-12 bands, 15 for gap-15), i.e. one short of the guarantee.
//
// SCOPE OF THAT ARGUMENT — it is TRUE but does NOT bound what the safety
// claim needs bounded, and conflating the two is why this was missed
// twice. It bounds diagonal EXTENT; the safety claim is about AREA
// (regions of >=100 cells). Area does not imply extent: a region can be
// large and yet narrow ACROSS the stripes. Measured on the real failures —
// zero violations of the bound, and every blank >=100-cell region has a
// diagonal extent of just 11-12 (against gap 12) while spanning 101-115
// CELLS. So the bound holds and the failure happens anyway. Use it to
// reason about elongated regions; never as evidence that a big region is
// safe.
//
// Measured over the real committed mask (2200x2400) by labelling every
// 4-connected marginal region and counting those that receive zero painted
// cells, across EIGHT gates (2.2 / 2.5 / 2.8 / 3.0 / 3.5 / 4.0 / 5.0 / 10 m)
// x EVERY band this function can select over z0..z22 — 15 of them, because
// FRACTIONAL zooms are reachable by any pinch/wheel gesture and each
// integer stripe count from 15 down to 1 occurs. 120 combinations:
//
//   gap 15 -> blanks a >=100-cell region at gates 2.8, 3.0, 3.5, 4.0 AND
//             5.0 (not at 2.2 or 10).
//   gap 12 -> blanks a >=100-cell region in 14 of the 120. Largest blank
//             region of ANY size: 115 cells.
//
// TWO MECHANISMS CLOSE THIS, AND THEY DO DIFFERENT JOBS — do not collapse
// them, and never restore a claim that the cap alone suffices:
//
//   * HATCH_MAX_GAP_CELLS bounds the guarantee ABOVE. It is NECESSARY but
//     NOT SUFFICIENT on its own: blanking is PHASE-dependent, a function of
//     the whole (period, stripe) pair rather than of the gap, so capping
//     the gap does not by itself eliminate the failure. The 14 failing
//     combinations above are all gap-12 bands, every one at a FRACTIONAL
//     zoom, and they are NOT in an exotic corner of the zoom space — under
//     continuous selection they occupy:
//
//       25/13  z9.16 .. z9.27      (gate 2.2)
//       24/12  z9.27 .. z9.39      (gates 2.8, 3.0, 3.5, 4.0)
//       23/11  z9.39 .. z9.52      (gates 2.8, 3.0, 3.5, 4.0)
//       21/9   z9.67 .. z9.83      (gate 2.2)
//       18/6   z10.22 .. z10.46    (gates 2.8, 3.0, 3.5, 4.0)
//
//     MapView.tsx's initial ZOOM is 9. Every one of those ranges is within
//     ~0.2 to ~1.5 zoom levels of where every user starts — one small pinch
//     away, not a corner case. That, rather than a bare "14 of 120", is the
//     fact that justifies the quantisation below.
//   * hatchBandForZoom's Math.floor QUANTISATION is what makes the cap
//     sufficient, by shrinking the reachable band set from 15 to 5 as
//     measured at #599, amended by the #648 note below. Those 5
//     (27/15, 20/8, 16/4, 8/2, 4/1) are clean in ALL 40 of their gate x band
//     combinations, re-measured against the quantised selection itself
//     rather than inherited from the pre-quantisation sweep; largest blank
//     of any size 68 cells, against the >=100 threshold.
//     #648 adds a SIXTH reachable band, 1/1, and deliberately owes that
//     sweep NOTHING: its gap is ZERO, so there is no gap for a region of any
//     size to fall inside and the blanking question is vacuous rather than
//     re-opened. The 40 combinations above are also untouched — every zoom
//     that selects one of the original 5 (z13 and below) is unchanged.
//
// So the safety property is a CONSTRUCTION (a small, enumerated, swept band
// set), not a tuned constant. Removing the floor re-opens 14 failures even
// though the cap is untouched — which is exactly why it must not be
// "simplified" away as redundant rounding.
//
// COST, measured rather than assumed, because this is a TRADE and not a free
// win. Quantising means z12.9 renders the band chosen for z12, so the cell is
// ~2^0.9 larger on screen than that band was sized for — under Math.floor
// EVERY band is entered part-way through, and that is precisely what creates
// the band-top maxima below. Achieved on-screen stripe over z9..z13.917 (the
// range across which the continuous scheme still varied its stripe count):
//
//   continuous  min 5.34 px  max 15.99 px   (ratio 3.00x)
//   quantised   min 7.94 px  max 16.95 px   (ratio 2.13x)
//
// The min/max RATIO narrows (3.00x -> 2.13x) and the floor improves, but the
// MAXIMUM GETS WORSE, 15.99 -> 16.95 px. An
// earlier revision of this comment claimed quantisation "tightens the
// achieved stripe range"; that was true only of the ratio and is misleading
// about legibility, so it is stated as the trade it is. Still bounded, still
// far from the ~1 px wash-out #599 exists to fix. A finer quantisation (half
// zoom levels) would cut the worst deviation to ~1.41x, but it makes ~10
// bands reachable and would need its own 8-gate sweep before it could be
// called safe — not attempted here.
//
// Hence the cap is 12 cells (~560 m). Say precisely what that buys, because
// an earlier revision of this very sentence claimed the cap was "the largest
// gap at which no marginal region of >=100 cells can disappear at any gate
// tested" — the claim retracted above, left standing as the conclusion after
// its own premise had been withdrawn. It is NOT what the cap gives. The cap
// bounds the guarantee above; the quantisation below is what makes the set
// of reachable bands small enough for that bound to hold everywhere. Neither
// alone is sufficient. The cap is also what raises the duty cycle to 40-56% at z10 and below rather
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
// ---------------------------------------------------------------------------
// #648: GRACEFUL DEGRADATION PAST THE ZOOM WHERE A "STRIPE" IS A FICTION.
// ---------------------------------------------------------------------------
// The stripe count the target ASKS for is round(HATCH_TARGET_STRIPE_PX /
// screenPxPerCell(z)). Before #648 that sat inside Math.max(1, ...), so past
// the point where one mask cell is wider than TWICE the target it was the
// CLAMP, not the design, choosing the geometry — and it kept choosing (4, 1)
// unbroken to z22. What renders there is not a hatch: at z16 a 67.8 px black
// square every 271.2 px, at z22 a 4338.6 px one, laid out on a 45deg
// staircase whose position is pure PHASE ((outRow + col) % 4) and carries no
// information whatsoever. That is the hard-edged-squares defect reported in
// #648 against production v0.13.0.
//
// THE THRESHOLD IS DERIVED, NOT PICKED. The clamp begins to bind exactly
// where round(8 / px) reaches 0, i.e. px = 16, i.e. z = 13.917 — the same
// number the "WHAT THIS DOES NOT ACHIEVE" note above already derived for
// #599, not a new constant. Under the Math.floor quantisation the first
// INTEGER band past it is z14 (px 16.9475, raw stripe count 0.4720; z13 is
// px 8.4738, raw 0.9441, which still rounds to a real 1-cell stripe). So
// z13 and below are byte-identical to what #599 shipped, and only z>=14
// changes — "roughly z14" in #648's own words, arrived at from the
// arithmetic rather than chosen to match it.
//
// From z14 up the band is HATCH_WASH_BAND — period 1, stripe 1 — so
// `(outRow + col) % 1 < 1` holds for EVERY cell and every marginal cell is
// painted. Three consequences, in the order that matters:
//
//   * SAFETY, structurally rather than by measurement, and this is the
//     load-bearing one. The painted set goes from {marginal AND phase} to
//     {marginal}: a strict SUPERSET, at the IDENTICAL HATCH_RGBA. Nothing
//     about which cells are marginal, about HATCH_RGBA, about STOPS or
//     about the layer's opacity/resampling moves. So per pixel the
//     composited hatch alpha can only RISE, and since HATCH_RGBA is pure
//     black the composite is colour * (1 - alpha): every pixel renders at
//     most as light as it did before, and no marginal cell can lose its
//     hatch. The "never look more comfortable" property below is therefore
//     preserved in its strong form — this change can only move cells toward
//     the more-cautious end. The residual failure mode stays
//     under-signalling, and is strictly REDUCED: the 3 cells in 4 that the
//     (4, 1) band left unpainted at z>=14 are now painted.
//   * The gap-blanking analysis above is VACUOUS here rather than re-opened
//     — gap 0 admits no region of any size. See the sixth-band note in that
//     block.
//   * THE COST, stated as the trade it is. This is #648 option 4, the
//     maintainer's scoping call; option 1 (a screen-space fill pattern over
//     vectorized marginal cells, the only thing that fixes rather than
//     degrades) is split out as #792 and needs its own design pass. At
//     z>=14 the absolute ramp is no longer read THROUGH gaps over marginal
//     water: alpha 190 leaves 25.5% of the ramp colour, so hue survives
//     (black preserves hue) but the depth READING over marginal cells does
//     not. What gets BETTER is the marginal/clear BOUNDARY: every marginal
//     cell is now drawn individually instead of one in four, so the rendered
//     edge follows the mask's own ~46.7 m cell boundary — the same
//     quantisation buildDepthImageData's ramp layer already shows at these
//     zooms — instead of an artificial diagonal. A cell-quantised edge is
//     honest data resolution; the staircase was not.
//
// WHY NOT the "translucent wash or outline" #648's option-4 text sketches:
// both LOWER the alpha over cells painted today (an outline drops interior
// cells to zero outright), so both make some marginal water render LIGHTER
// than it does now — false comfort, the one direction #492 exists to
// prevent. Full coverage at the UNCHANGED HATCH_RGBA is the only shape of
// option 4 that is monotone-darkening by construction.
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

/**
 * #648: the degraded band used from z14 up — the ONE band in
 * this module with no gap. `(outRow + col) % 1 < 1` is true for every cell,
 * so buildNavigabilityHatchImageData paints every marginal cell and nothing
 * else; period === stripe is what expresses "no stripe pattern any more",
 * deliberately, rather than a second code path in the painter. See the #648
 * block above for why full coverage at the UNCHANGED HATCH_RGBA is the only
 * degradation that cannot make marginal water render lighter.
 */
export const HATCH_WASH_BAND: HatchBand = { periodCells: 1, stripeCells: 1 };

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
 * Once even a ONE-cell stripe is more than twice the target — z14 up, where
 * the old Math.max(1, ...) clamp was inventing a stripe the design never
 * asked for — it degrades to HATCH_WASH_BAND instead (#648).
 * See the block comment above for the arithmetic and the measurements.
 */
export function hatchBandForZoom(zoom: number): HatchBand {
  // FAIL CLOSED on a non-finite zoom. Not because a NaN zoom is expected —
  // no call site produces one today — but because of the DIRECTION it fails
  // in, which this PR newly made reachable: before #599 the band was a fixed
  // pair, so no zoom value could reach it at all.
  //
  // MEASURED, not assumed: a NaN zoom propagates through Math.floor, the
  // rounding and Math.max to give { periodCells: NaN, stripeCells: NaN }, and
  // the paint predicate `(outRow + col) % NaN < NaN` is false for EVERY cell.
  // The result is a map with ZERO hatch and no error, no warning, nothing —
  // marginal water rendering as unmarked, which is precisely the direction
  // this repo's guard-asymmetry rule forbids for a safety cue: it must fail
  // toward OVER-warning, never toward looking clear.
  //
  // Number.isFinite, NOT `typeof zoom === 'number'`: typeof NaN and typeof
  // Infinity are both 'number', so that test admits exactly the values this
  // guard exists to reject.
  //
  // ±Infinity is included for determinism rather than to fix a second silent
  // failure — measured, they land on real bands by accident of the arithmetic
  // rather than by design (HATCH_WASH_BAND and (27,15) since #648; (4,1) and
  // (27,15) before it). HATCH_FALLBACK_BAND is
  // declared below, which is safe because this module's own initialisation
  // calls this function with a finite zoom and so never takes this branch.
  if (!Number.isFinite(zoom)) return HATCH_FALLBACK_BAND;
  // QUANTISED to whole zoom levels (#599 fix wave). Two reasons, in order of
  // importance. (1) SAFETY, by construction: continuous selection makes 15
  // distinct STRIPED bands reachable, 14 of whose gate x band combinations
  // blank a marginal region of >=100 cells, where flooring makes the
  // reachable set small enough to sweep exhaustively. The SAFETY note above
  // carries that set's membership and the sweep, and depthColor.test.ts pins
  // its size — deliberately NOT restated here: this copy of the counts went
  // stale at #648 while the block comment and DataLayers.tsx were updated,
  // which is the whole argument against writing a count down twice.
  // (2) It cuts rebuild churn over a z9->z22 sweep (MEASURED), all at integer
  // crossings.
  const z = Math.max(HATCH_MIN_BAND_ZOOM, Math.floor(zoom));
  // #648: the stripe count the TARGET asks for, before any clamp. This is
  // the quantity that says whether a per-cell raster can still express the
  // design at all — reaching 0 means one cell is already wider than twice
  // HATCH_TARGET_STRIPE_PX, so any stripe drawn from here on is the clamp's
  // invention, not the design's. The pre-#648 code wrapped this in
  // Math.max(1, ...) and shipped that invention to z22.
  const targetStripeCells = Math.round(HATCH_TARGET_STRIPE_PX / hatchScreenPxPerCell(z));
  if (targetStripeCells < 1) return HATCH_WASH_BAND;
  const gapCells = Math.min(HATCH_GAP_PER_STRIPE * targetStripeCells, HATCH_MAX_GAP_CELLS);
  return { periodCells: targetStripeCells + gapCells, stripeCells: targetStripeCells };
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
