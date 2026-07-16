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

const LAND = 0;
const DEEP = 255;
const DEEP_M = 25.4;

export type Rgba = [r: number, g: number, b: number, a: number];

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

/** Pure ramp: one mask byte -> RGBA (0..255 channels, unpremultiplied). */
export function depthByteToRgba(byte: number): Rgba {
  if (byte === LAND) return [...TRANSPARENT];
  const depthM = byte === DEEP ? DEEP_M : byte / 10;
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
