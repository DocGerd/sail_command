import type { Map as MaplibreMap } from 'maplibre-gl';

// Testing: barbSegments() (the WMO geometry) is pure and unit-tested, and
// windBarbs.test.ts also replays registerBarbImages() through a recording 2d
// context to pin the segment->canvas-op stream. Plain jsdom's
// canvas.getContext('2d') returns null (no canvas/WebGL backend), so
// registerBarbImages() no-ops there; registering real images against a live
// MapLibre GL map is still browser-only (manual/Playwright verification).

const IMAGE_SIZE = 32;
const CENTER_X = IMAGE_SIZE / 2;
const TAIL_Y = IMAGE_SIZE - 4; // station end (near the anchor point)
const TIP_Y = 4; // barb/feather end
const FEATHER_SPACING = 6;
const FEATHER_LENGTH = 9;
const STROKE = '#1a1a1a';

const STEP_KN = 5;
const MAX_KN = 50;

export interface BarbPoint {
  x: number;
  y: number;
}

/**
 * One primitive of a wind-barb glyph in the 32x32 icon box. `circle` is the
 * calm marker (stroked, no fill); `stroke` is the shaft and the full/half
 * feathers (open polyline); `fill` is a 50 kn pennant (closed, filled
 * triangle).
 */
export type BarbSegment =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'stroke'; points: readonly BarbPoint[] }
  | { kind: 'fill'; points: readonly BarbPoint[] };

/**
 * Pure WMO wind-barb geometry for `speedKn`, in the 32x32 icon box, drawn
 * "north-up" (shaft vertical, station end at the bottom near the anchor,
 * feathers at the top / tip) so a clockwise rotation by the meteorological
 * FROM bearing turns the feathered end INTO the wind — the standard barb
 * convention. 5 kn buckets: pennant = 50 kn (filled triangle), full barb =
 * 10 kn, half barb = 5 kn. This is the single source of truth for the barb
 * shape shared by the canvas `drawBarb` (map icons) and the depth profile's
 * SVG glyphs.
 */
export function barbSegments(speedKn: number): BarbSegment[] {
  const units = Math.round(speedKn / STEP_KN); // number of 5 kn increments

  if (units <= 0) {
    // Calm: a small circle at the station end, no shaft/feathers.
    return [{ kind: 'circle', cx: CENTER_X, cy: TAIL_Y, r: 4 }];
  }

  const segments: BarbSegment[] = [
    // Shaft.
    {
      kind: 'stroke',
      points: [
        { x: CENTER_X, y: TAIL_Y },
        { x: CENTER_X, y: TIP_Y },
      ],
    },
  ];

  let remaining = units;
  const pennants = Math.floor(remaining / 10); // 50 kn each
  remaining %= 10;
  const fullBarbs = Math.floor(remaining / 2); // 10 kn each
  const halfBarb = remaining % 2 === 1; // 5 kn

  // Feathers are attached starting at the tip and stepping down the shaft
  // toward the station, in descending order of weight (pennants, then full
  // barbs, then a trailing half barb).
  let y = TIP_Y;
  for (let i = 0; i < pennants; i++) {
    segments.push({
      kind: 'fill',
      points: [
        { x: CENTER_X, y },
        { x: CENTER_X + FEATHER_LENGTH, y: y + FEATHER_SPACING / 2 },
        { x: CENTER_X, y: y + FEATHER_SPACING },
      ],
    });
    y += FEATHER_SPACING + 1;
  }
  for (let i = 0; i < fullBarbs; i++) {
    segments.push({
      kind: 'stroke',
      points: [
        { x: CENTER_X, y },
        { x: CENTER_X + FEATHER_LENGTH, y: y - FEATHER_SPACING * 0.6 },
      ],
    });
    y += FEATHER_SPACING;
  }
  if (halfBarb) {
    segments.push({
      kind: 'stroke',
      points: [
        { x: CENTER_X, y },
        { x: CENTER_X + FEATHER_LENGTH / 2, y: y - FEATHER_SPACING * 0.3 },
      ],
    });
  }
  return segments;
}

/**
 * Draws one WMO-style wind barb for `speedKn` onto `ctx`, replaying the
 * shared `barbSegments` geometry. The icon is drawn "north-up" (shaft
 * vertical, feathers at the top / tip) so that a MapLibre `icon-rotate:
 * dirFromDeg` (clockwise bearing) turns the feathered end to point INTO the
 * wind's FROM direction — the standard barb convention.
 */
function drawBarb(ctx: CanvasRenderingContext2D, speedKn: number): void {
  ctx.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  ctx.strokeStyle = STROKE;
  ctx.fillStyle = STROKE;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';

  for (const seg of barbSegments(speedKn)) {
    ctx.beginPath();
    if (seg.kind === 'circle') {
      ctx.arc(seg.cx, seg.cy, seg.r, 0, Math.PI * 2);
      ctx.stroke();
      continue;
    }
    seg.points.forEach((pt, i) => {
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    if (seg.kind === 'fill') {
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }
}

/** `bark-N` image ids registered by this function, N = 0, 5, 10, ..., 50. */
export function barbImageId(speedKn: number): string {
  const clamped = Math.max(0, Math.min(MAX_KN, speedKn));
  const bucket = Math.round(clamped / STEP_KN) * STEP_KN;
  return `barb-${bucket}`;
}

/**
 * Registers one canvas-drawn image per 5 kn bucket (0..50) on `map`, so a
 * symbol layer can reference `icon-image: barb-{round(speed/5)*5}`. Safe to
 * call more than once per map instance — already-registered images are
 * skipped.
 */
export function registerBarbImages(map: MaplibreMap): void {
  for (let speed = 0; speed <= MAX_KN; speed += STEP_KN) {
    const id = `barb-${speed}`;
    if (map.hasImage(id)) continue;
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_SIZE;
    canvas.height = IMAGE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue; // no 2d context available (e.g. headless test env) — nothing to register
    drawBarb(ctx, speed);
    map.addImage(id, ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE));
  }
}
