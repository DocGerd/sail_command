import type { Map as MaplibreMap } from 'maplibre-gl';
import type { SeamarkProperties } from '../types';

// Testing: the classification/bucketing helpers and seamarkSegments() (pure
// geometry) are unit-tested directly. registerSeamarkImages() replays those
// segments onto a canvas — same rationale as windBarbs.ts: plain jsdom's
// canvas.getContext('2d') returns null (no canvas/WebGL backend), so it
// no-ops there; registering real images against a live MapLibre GL map is
// browser-only (manual/Playwright verification).

const IMAGE_SIZE = 24; // smaller than windBarbs' 32: seamarks are a much
// denser point layer (~1,794 vs one barb per route sample)
const CENTER = IMAGE_SIZE / 2;
const INK = '#1a1a1a'; // standard black used for topmarks/outlines, not data-driven

export interface Point2D {
  x: number;
  y: number;
}

/**
 * One primitive of a seamark glyph in the 24x24 icon box. Unlike
 * BarbSegment (windBarbs.ts, one constant stroke colour per icon), seamark
 * glyphs mix several data-driven fill colours in one icon (lateral red vs
 * green, cardinal/safe-water/special-purpose/isolated-danger colour
 * banding), so colour travels on the segment itself rather than being a
 * fixed canvas style.
 */
export type SeamarkSegment =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { kind: 'polygon'; points: readonly Point2D[]; fill: string }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill: string }
  | { kind: 'line'; points: readonly Point2D[]; stroke: string; width: number };

/** Which glyph family a seamark:type resolves to. 'unknown' is a safety net
 * for a value the pipeline's core-AtoN prefix filter would never actually
 * let through — it never intentionally occurs. */
export type SeamarkFamily =
  | 'lateral'
  | 'cardinal'
  | 'safeWater'
  | 'specialPurpose'
  | 'isolatedDanger'
  | 'lightMajor'
  | 'lightMinor'
  | 'unknown';

/**
 * Classifies a raw `seamark:type` value (e.g. "buoy_lateral",
 * "beacon_cardinal", "light_minor") into a glyph family, by suffix/exact
 * match rather than a closed enum — a beacon_lateral and a buoy_lateral
 * render the same lateral glyph (colour/shape differ, not the family), and a
 * future re-pull that finds a seamark:type this repo hasn't seen yet (e.g. a
 * beacon_safe_water, absent from the current bbox pull) still degrades to
 * 'unknown' instead of a type error.
 */
export function classifySeamark(seamarkType: string): SeamarkFamily {
  if (seamarkType.endsWith('_lateral')) return 'lateral';
  if (seamarkType.endsWith('_cardinal')) return 'cardinal';
  if (seamarkType.endsWith('_safe_water')) return 'safeWater';
  if (seamarkType.endsWith('_special_purpose')) return 'specialPurpose';
  if (seamarkType.endsWith('_isolated_danger')) return 'isolatedDanger';
  if (seamarkType === 'light_major') return 'lightMajor';
  if (seamarkType === 'light_minor') return 'lightMinor';
  return 'unknown';
}

type ShapeBucket = 'can' | 'conical' | 'spar' | 'spherical' | 'pillar';

/** Buckets the raw OSM `shape` tag into one of a handful of drawable
 * silhouettes. Unrecognized/absent shapes (pillar, super-buoy, tower,
 * lattice, ...) fall back to 'pillar' — the generic buoy body. */
function bucketShape(shape: string | undefined): ShapeBucket {
  switch (shape) {
    case 'can':
    case 'barrel':
      return 'can';
    case 'conical':
      return 'conical';
    case 'spar':
    case 'stake':
    case 'pile':
    case 'pole':
      return 'spar';
    case 'spherical':
      return 'spherical';
    default:
      return 'pillar';
  }
}

const KNOWN_CSS_COLOURS = new Set([
  'red',
  'green',
  'yellow',
  'black',
  'white',
  'grey',
  'gray',
  'orange',
  'blue',
]);

/** Normalizes one OSM colour token to a CSS colour, defaulting anything
 * unrecognized to a neutral grey rather than passing an arbitrary string
 * through to canvas fillStyle. */
function cssColour(token: string | undefined): string {
  const t = token?.trim().toLowerCase();
  return t && KNOWN_CSS_COLOURS.has(t) ? t : '#888888';
}

/** Splits a raw OSM colour tag ("yellow;black;yellow", the rare
 * colon-typo'd "black:yellow:black") into normalized CSS colour tokens. */
function colourTokens(colour: string | undefined): string[] {
  if (!colour) return [];
  return colour
    .split(/[;:]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(cssColour);
}

/** First colour token, or a neutral grey fallback — used where a glyph has
 * one dominant fill rather than a banded pattern (lateral buoy bodies). */
function primaryColour(colour: string | undefined): string {
  return colourTokens(colour)[0] ?? '#888888';
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fills `box` with equal-sized bands of `tokens` (>=1), horizontal or
 * vertical. Falls back to a single neutral-grey band when no colour tag was
 * present at all. */
function bandSegments(
  tokens: readonly string[],
  orientation: 'horizontal' | 'vertical',
  box: Box,
): SeamarkSegment[] {
  const fills = tokens.length > 0 ? tokens : ['#888888'];
  return fills.map((fill, i) => {
    if (orientation === 'horizontal') {
      const bandH = box.h / fills.length;
      return { kind: 'rect', x: box.x, y: box.y + i * bandH, w: box.w, h: bandH, fill };
    }
    const bandW = box.w / fills.length;
    return { kind: 'rect', x: box.x + i * bandW, y: box.y, w: bandW, h: box.h, fill };
  });
}

function lateralSegments(props: SeamarkProperties): SeamarkSegment[] {
  const fill = primaryColour(props.colour);
  switch (bucketShape(props.shape)) {
    case 'can':
      return [{ kind: 'rect', x: 7, y: 9, w: 10, h: 11, fill }];
    case 'conical':
      return [
        {
          kind: 'polygon',
          points: [
            { x: 12, y: 6 },
            { x: 18, y: 20 },
            { x: 6, y: 20 },
          ],
          fill,
        },
      ];
    case 'spar':
      return [{ kind: 'rect', x: 10, y: 5, w: 4, h: 16, fill }];
    case 'spherical':
      return [{ kind: 'circle', cx: 12, cy: 13, r: 6, fill }];
    case 'pillar':
    default:
      return [
        { kind: 'rect', x: 9, y: 10, w: 6, h: 11, fill },
        { kind: 'circle', cx: 12, cy: 8, r: 3, fill },
      ];
  }
}

type ConeDir = 'up' | 'down';

// Standard IALA-A cardinal topmark orientation, by category — NOT
// data-driven (the pipeline doesn't carry a topmark tag; this is the fixed
// convention). North: both cones point up. South: both point down. East:
// base-to-base (top up, bottom down). West: point-to-point (top down,
// bottom up).
const CARDINAL_CONES: Record<string, { top: ConeDir; bottom: ConeDir }> = {
  north: { top: 'up', bottom: 'up' },
  south: { top: 'down', bottom: 'down' },
  east: { top: 'up', bottom: 'down' },
  west: { top: 'down', bottom: 'up' },
};

function coneTriangle(apexY: number, dir: ConeDir): Point2D[] {
  const baseY = dir === 'up' ? apexY + 5 : apexY - 5;
  return [
    { x: 12, y: apexY },
    { x: 16, y: baseY },
    { x: 8, y: baseY },
  ];
}

function cardinalSegments(props: SeamarkProperties): SeamarkSegment[] {
  const orient = CARDINAL_CONES[props.category ?? ''] ?? CARDINAL_CONES.north;
  return [
    { kind: 'rect', x: 10, y: 11, w: 4, h: 10, fill: INK },
    { kind: 'polygon', points: coneTriangle(3, orient.top), fill: INK },
    { kind: 'polygon', points: coneTriangle(9, orient.bottom), fill: INK },
  ];
}

function safeWaterSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['red', 'white'], 'vertical', {
    x: 7,
    y: 9,
    w: 10,
    h: 12,
  });
  return [...bands, { kind: 'circle', cx: 12, cy: 6, r: 3, fill: INK }];
}

function specialPurposeSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['yellow'], 'horizontal', {
    x: 7,
    y: 9,
    w: 10,
    h: 12,
  });
  return [
    ...bands,
    {
      kind: 'line',
      points: [
        { x: 9, y: 4 },
        { x: 15, y: 10 },
      ],
      stroke: INK,
      width: 1.5,
    },
    {
      kind: 'line',
      points: [
        { x: 15, y: 4 },
        { x: 9, y: 10 },
      ],
      stroke: INK,
      width: 1.5,
    },
  ];
}

function isolatedDangerSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['black', 'red', 'black'], 'horizontal', {
    x: 7,
    y: 10,
    w: 10,
    h: 11,
  });
  return [
    ...bands,
    { kind: 'circle', cx: 12, cy: 7, r: 2.5, fill: INK },
    { kind: 'circle', cx: 12, cy: 2.5, r: 2.5, fill: INK },
  ];
}

// Lights get a ray/star glyph rather than a buoy-body silhouette — a fixed
// light has no floating body, and the per-sector colour/range tagging on
// light_major is too complex to fold into one glyph colour (v1: a single
// neutral amber star, sized by major/minor only).
function lightSegments(major: boolean): SeamarkSegment[] {
  const r = major ? 10 : 6;
  const rayColour = '#e0a010';
  const rays = 8;
  const segments: SeamarkSegment[] = [];
  for (let i = 0; i < rays; i++) {
    const angle = (Math.PI * 2 * i) / rays;
    segments.push({
      kind: 'line',
      points: [
        { x: CENTER, y: CENTER },
        { x: CENTER + Math.cos(angle) * r, y: CENTER + Math.sin(angle) * r },
      ],
      stroke: rayColour,
      width: 1.5,
    });
  }
  segments.push({ kind: 'circle', cx: CENTER, cy: CENTER, r: major ? 3 : 2, fill: rayColour });
  return segments;
}

function unknownSegments(): SeamarkSegment[] {
  return [{ kind: 'circle', cx: CENTER, cy: CENTER, r: 5, fill: '#888888' }];
}

/** Pure per-family glyph geometry in the 24x24 icon box — the single source
 * of truth shared by the canvas draw below and any future SVG rendering
 * (mirrors barbSegments()' role in windBarbs.ts). */
export function seamarkSegments(props: SeamarkProperties): SeamarkSegment[] {
  switch (classifySeamark(props.seamarkType)) {
    case 'lateral':
      return lateralSegments(props);
    case 'cardinal':
      return cardinalSegments(props);
    case 'safeWater':
      return safeWaterSegments(props);
    case 'specialPurpose':
      return specialPurposeSegments(props);
    case 'isolatedDanger':
      return isolatedDangerSegments(props);
    case 'lightMajor':
      return lightSegments(true);
    case 'lightMinor':
      return lightSegments(false);
    default:
      return unknownSegments();
  }
}

/**
 * Deterministic `map.addImage()` id for a seamark, derived from its glyph
 * family plus whatever else the glyph actually varies on (shape for
 * lateral, category for cardinal, the full colour band for the
 * colour-keyed families) — this is what "icon-image keyed off
 * seamarkType/category" resolves to in practice: seamarkType alone can't
 * distinguish a red from a green lateral buoy, which the design's own
 * "canvas-drawn... red/green" glyph fidelity requires.
 */
export function seamarkImageId(props: SeamarkProperties): string {
  const family = classifySeamark(props.seamarkType);
  switch (family) {
    case 'lateral':
      return `seamark-lateral-${bucketShape(props.shape)}-${primaryColour(props.colour)}`;
    case 'cardinal':
      return `seamark-cardinal-${props.category ?? 'unknown'}`;
    case 'safeWater':
      return `seamark-safewater-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'specialPurpose':
      return `seamark-special-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'isolatedDanger':
      return `seamark-isolated-${colourTokens(props.colour).join('-') || 'default'}`;
    case 'lightMajor':
      return 'seamark-light-major';
    case 'lightMinor':
      return 'seamark-light-minor';
    default:
      return 'seamark-unknown';
  }
}

function drawSeamark(ctx: CanvasRenderingContext2D, props: SeamarkProperties): void {
  ctx.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  for (const seg of seamarkSegments(props)) {
    ctx.beginPath();
    switch (seg.kind) {
      case 'rect':
        ctx.fillStyle = seg.fill;
        ctx.rect(seg.x, seg.y, seg.w, seg.h);
        ctx.fill();
        break;
      case 'circle':
        ctx.fillStyle = seg.fill;
        ctx.arc(seg.cx, seg.cy, seg.r, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'polygon':
        ctx.fillStyle = seg.fill;
        seg.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        break;
      case 'line':
        ctx.strokeStyle = seg.stroke;
        ctx.lineWidth = seg.width;
        seg.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.stroke();
        break;
    }
  }
}

/**
 * Registers one canvas-drawn image per distinct `seamarkImageId()` actually
 * present in `allProperties`, so the `sc-seamarks` symbol layer can
 * reference `icon-image: ['get', 'icon']`. Safe to call more than once —
 * already-registered images are skipped, same convention as
 * registerBarbImages().
 */
export function registerSeamarkImages(
  map: MaplibreMap,
  allProperties: readonly SeamarkProperties[],
): void {
  const seen = new Set<string>();
  for (const props of allProperties) {
    const id = seamarkImageId(props);
    if (seen.has(id)) continue;
    seen.add(id);
    if (map.hasImage(id)) continue;
    const canvas = document.createElement('canvas');
    canvas.width = IMAGE_SIZE;
    canvas.height = IMAGE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue; // no 2d context available (e.g. headless test env) — nothing to register
    drawSeamark(ctx, props);
    map.addImage(id, ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE));
  }
}
