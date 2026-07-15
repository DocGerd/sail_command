import type { Map as MaplibreMap } from 'maplibre-gl';

// Not unit-tested: jsdom's canvas.getContext('2d') returns null (no canvas/
// WebGL backend), so registerBarbImages() below always hits its "no 2d
// context" branch and never actually draws or registers anything under
// jsdom — real image registration against a MapLibre GL map can only be
// exercised in a real browser (manual/Playwright verification).

const IMAGE_SIZE = 32;
const CENTER_X = IMAGE_SIZE / 2;
const TAIL_Y = IMAGE_SIZE - 4; // station end (near the anchor point)
const TIP_Y = 4; // barb/feather end
const FEATHER_SPACING = 6;
const FEATHER_LENGTH = 9;
const STROKE = '#1a1a1a';

const STEP_KN = 5;
const MAX_KN = 50;

/**
 * Draws one WMO-style wind barb for `speedKn` onto `ctx`. The icon is drawn
 * "north-up" (shaft vertical, feathers at the top / tip) so that a MapLibre
 * `icon-rotate: dirFromDeg` (clockwise bearing) turns the feathered end to
 * point INTO the wind's FROM direction — the standard barb convention.
 */
function drawBarb(ctx: CanvasRenderingContext2D, speedKn: number): void {
  ctx.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  ctx.strokeStyle = STROKE;
  ctx.fillStyle = STROKE;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';

  const units = Math.round(speedKn / STEP_KN); // number of 5 kn increments

  if (units <= 0) {
    // Calm: a small circle at the station end, no shaft/feathers.
    ctx.beginPath();
    ctx.arc(CENTER_X, TAIL_Y, 4, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }

  // Shaft.
  ctx.beginPath();
  ctx.moveTo(CENTER_X, TAIL_Y);
  ctx.lineTo(CENTER_X, TIP_Y);
  ctx.stroke();

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
    ctx.beginPath();
    ctx.moveTo(CENTER_X, y);
    ctx.lineTo(CENTER_X + FEATHER_LENGTH, y + FEATHER_SPACING / 2);
    ctx.lineTo(CENTER_X, y + FEATHER_SPACING);
    ctx.closePath();
    ctx.fill();
    y += FEATHER_SPACING + 1;
  }
  for (let i = 0; i < fullBarbs; i++) {
    ctx.beginPath();
    ctx.moveTo(CENTER_X, y);
    ctx.lineTo(CENTER_X + FEATHER_LENGTH, y - FEATHER_SPACING * 0.6);
    ctx.stroke();
    y += FEATHER_SPACING;
  }
  if (halfBarb) {
    ctx.beginPath();
    ctx.moveTo(CENTER_X, y);
    ctx.lineTo(CENTER_X + FEATHER_LENGTH / 2, y - FEATHER_SPACING * 0.3);
    ctx.stroke();
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
