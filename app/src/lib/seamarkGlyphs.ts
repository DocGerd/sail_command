import type { Map as MaplibreMap } from 'maplibre-gl';
import type { SeamarkProperties } from '../types';

// Testing: the classification/bucketing helpers and seamarkSegments() (pure
// geometry) are unit-tested directly. registerSeamarkImages() replays those
// segments onto a canvas — same rationale as windBarbs.ts: plain jsdom's
// canvas.getContext('2d') returns null (no canvas/WebGL backend), so it
// no-ops there; registering real images against a live MapLibre GL map is
// browser-only (manual/Playwright verification).

const IMAGE_SIZE = 24; // smaller than windBarbs' 32: seamarks are a much
// denser point layer (~1,794 vs one barb per route sample). This is the
// LOGICAL glyph coordinate space every segment below is expressed in — kept
// at 24 so none of the hand-derived R1001 geometry constants (#165) below
// need touching. The registered image is drawn at a higher raster
// resolution (CANVAS_SIZE) via a canvas-transform scale in drawSeamark(), so
// every offset/line-width in the logical box scales up together instead of
// only a subset of hardcoded pixels being bumped (#191).
const CENTER = IMAGE_SIZE / 2;
// #191: on-screen seamarks were only ~13-20px (IMAGE_SIZE=24 registered at
// the implicit default pixelRatio 1) — too small to read at planning zooms.
// Raising the raster resolution with a MATCHING pixelRatio (rather than only
// widening seamarkGeoJson.ts's icon-size stops, which would upscale/blur the
// old 24px bitmap) grows the natural footprint from 24 to
// CANVAS_SIZE/PIXEL_RATIO = 32 logical px while keeping the glyph crisp.
const CANVAS_SIZE = 64;
const PIXEL_RATIO = 2;
const INK = '#1a1a1a'; // standard black used for topmarks/outlines, not data-driven
// Cardinal-mark yellow: raw CSS `yellow` (#ffff00) is too garish / low-contrast
// against the yellow-vs-black R1001 banding, so a defined IALA-style amber-yellow
// is used for the cardinal body bands (#165).
const CARDINAL_YELLOW = '#f5c400';
// Near-white keyline stroked around cardinal bodies/cones so their black bands
// don't merge with the app's dark-theme basemap (#165, §2.4).
const OUTLINE = '#f2f2f2';

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
  | { kind: 'ring'; cx: number; cy: number; r: number; stroke: string; width: number }
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

/**
 * Even base rank per family (#200), ordered in four tiers: the marks whose
 * hazard warning is self-contained come first and are never displaced;
 * everything below them is ranked on how useful the mark is AT THE SCALE WHERE
 * CULLING HAPPENS — `sc-seamarks` only collision-culls below z12 — which for
 * the middle tiers means scarcity and design range, not warning content.
 *
 * So this is NOT a pure danger-content ordering, and Tier 2 is where it
 * departs: a lighthouse and a fairway mark carry no danger information at all
 * (R1001 is explicit for safe water), yet both outrank the dense lateral
 * sequence because 6 and 23 in-area marks that anchor a landfall are what a
 * skipper reads at z8-z10, while an individual lateral out of 828 is not.
 * The tier boundary above them is the hard one: nothing may displace a
 * cardinal or isolated-danger mark, whatever its scale-appropriateness.
 *
 * #144 shipped a single ordering by on-screen prominence, which let 107 minor
 * lights systematically out-place 121 cardinals and 6 isolated-danger marks:
 * a mark warning of a hazard was no more likely to survive a collision than a
 * routine one.
 *
 * Gaps of 2 leave room for the lit-ness promotion (-1) without families ever
 * interleaving: a lit lateral (7) beats an unlit lateral (8) but never any
 * cardinal (1/2).
 *
 * Tiers, with the IALA R1001 Ed 2.0 (2022) basis for each:
 *
 * TIER 1 — the two marks whose warning is SELF-CONTAINED: one symbol carries
 * the whole message, at any scale, and nothing may displace them.
 * - `isolatedDanger` §2.3.1 — sits on a danger with navigable water all around
 *   it, and the safe passing distance "cannot be specified", so nothing else
 *   on screen implies it.
 * - `cardinal` §2.2.3 — "To indicate the safe side on which to pass a danger."
 *
 * TIER 2 — scarce marks that anchor a passage at PLANNING scale. Neither
 * carries danger information, and both are ranked on a property R1001 states
 * about them plus the fact that culling only happens below z12, where
 * scale-appropriateness is what matters:
 * - `lightMajor` §2.7.1.1 — a lighthouse provides "a long or medium range
 *   light" and "a significant daymark"; R1001 §2.7 files it under "OTHER
 *   MARKS", outside the six MBS types (§1.2), but range is precisely what
 *   makes a mark usable at small scale. 6 in the forecast area.
 * - `safeWater` §2.4.1.1 — indicates "channel entrance, port or estuary
 *   approach, landfall, or best point of passage under bridges": the decision
 *   points of a passage plan. 23 in the forecast area.
 *   §2.4.1 is explicit that it "does not mark a danger", which is why it
 *   cannot enter Tier 1 — but the same on-deck reasoning that lifts a
 *   lighthouse above the dense sequence marks lifts a fairway mark too, and
 *   granting it to one and not the other would be an unprincipled asymmetry
 *   (raised in review of #200 and accepted).
 *
 * TIER 3 — `lateral`, the dense sequence marks. §3.1 Table 16 has a "New
 * Danger" column listing Lateral, Cardinal, Isolated Danger and Emergency
 * Wreck — §3.2.2 spells it out — and §2.5.2.4 says "the limit of safe
 * navigation ... will continue to be marked by Lateral (or Cardinal) marks",
 * so laterals ARE danger-bearing and stay above everything below them. They
 * rank under Tiers 1-2 because a lateral is not a self-contained instruction:
 * §2.1.1 has them "denote the port and starboard sides of channels" relative
 * to a conventional direction of buoyage, so a single lateral is one datum on
 * a channel edge described by many marks, whereas a cardinal or
 * isolated-danger mark is a complete instruction on its own. 828 in-area.
 *
 * TIER 4 — no danger information and not scarce:
 * - `lightMinor`: §2.7 again, but short-range and dense (107 in-area).
 * - `specialPurpose`: §2.5.1 — special marks "are not generally intended to
 *   mark channels or obstructions where the MBS provides suitable
 *   alternatives".
 * - `unknown`: an unclassifiable mark must never displace a cardinal, so
 *   failing to the bottom is the safe direction.
 *
 * NOTE for a future pipeline re-pull — where the gaps actually are:
 * - R1001 §2.6's Emergency Wreck mark would rank above `isolatedDanger` (it
 *   marks a NEW danger, by definition absent from every chart AND from this
 *   app's own depth mask). OSM has no `seamark:type` for it; such a buoy is
 *   mapped as `seamark:type=buoy_special_purpose` with a blue/yellow colour
 *   tag, which passes the pipeline's `buoy_` prefix filter and then
 *   classifySeamark's `_special_purpose` suffix rule, landing at
 *   `specialPurpose` = 12 — the LOWEST real rank. It would not land in
 *   `unknown`, so a guard must watch classifySeamark, not this table's floor.
 *   No blue-striped mark (R1001 Table 11) exists in the committed pull.
 * - `light_vessel` and `light_float` (R1001 §2.7.5 Major Floating Aids) DO
 *   pass the `light_` prefix filter and then fall through classifySeamark to
 *   `unknown` = 14 — below `specialPurpose` — despite being the long-range
 *   aids the `lightMajor` bullet argues should rank high. Neither is in the
 *   current pull, so nothing is broken today.
 */
const FAMILY_RANK: Record<SeamarkFamily, number> = {
  isolatedDanger: 0,
  cardinal: 2,
  lightMajor: 4,
  safeWater: 6,
  lateral: 8,
  lightMinor: 10,
  specialPurpose: 12,
  unknown: 14,
};

/**
 * Collision-culling priority for the `sc-seamarks` layer's
 * `symbol-sort-key` (#144): LOWER sorts first, and MapLibre places symbols
 * in sort order, so lower keys win collisions. Stamped per feature at
 * data-build time (seamarkFeatureCollectionWithIcons) — never re-derived in
 * a style expression. Lit marks (any light field present) outrank unlit
 * peers of the same family; integers only.
 *
 * The lit-ness promotion is deliberately smaller than the family gap, so it
 * can only ever reorder marks WITHIN a family (#200): a lit lateral (7) still
 * loses to the worst unlit safe-water mark (6), and a lit lighthouse (3) still
 * loses to the worst unlit cardinal (2). Lit-ness is a visibility property,
 * never a reason to reorder the tiers above.
 */
export function seamarkPriority(props: SeamarkProperties): number {
  const lit =
    props.lightCharacter !== undefined ||
    props.lightColour !== undefined ||
    props.lightPeriod !== undefined;
  return FAMILY_RANK[classifySeamark(props.seamarkType)] - (lit ? 1 : 0);
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

/**
 * R1001 Ed 2.0 §2.2 Tables 5–6: a lateral mark's topmark SHAPE is tied to the
 * side of the channel, never to its colour — a port-hand mark carries a single
 * CAN, a starboard-hand mark a single CONE point up. That mapping is
 * region-independent (Region B swaps the colours and keeps the shapes), so it
 * is a fixed convention here rather than anything data-driven beyond category.
 *
 * The two preferred-channel categories INVERT relative to their name, and an
 * `endsWith('port')` test would get both of them wrong: a
 * `preferred_channel_port` mark says the preferred channel lies to port, i.e.
 * leave the mark to starboard — it is a modified STARBOARD-hand mark and
 * carries a cone. Hence the explicit table.
 *
 * Category is the only sound source: in the committed pull, **51** laterals
 * carry a colour that contradicts their category, and deriving the side from
 * the colour would put the wrong side indication on every one of them. 45 of
 * the 51 carry a colour naming the wrong side or no side at all — 18 port
 * marks tagged black, 15 port and 9 starboard grey, 2 starboard white, and one
 * PORT mark green — and the remaining 6 (4 starboard, 2 port) carry NO colour
 * tag at all, so `primaryColour` resolves them to the neutral grey fallback.
 * (Measured: no lateral carries an unrecognized colour token; the fallback is
 * reached only by absence.) 51 is the canonical figure and the one the
 * CHANGELOG uses — quote it, not the 45-mark enumeration above (#298).
 *
 * Reach: only the 11 of those 51 in the PILLAR bucket are corrected here,
 * pillar being the only bucket that draws a topmark. The other 40 are spars
 * and one can, still carry no topmark, and still rest on colour (#307).
 */
const LATERAL_TOPMARK: Record<string, 'can' | 'cone'> = {
  port: 'can',
  preferred_channel_starboard: 'can', // modified port-hand mark (red, green band)
  starboard: 'cone',
  preferred_channel_port: 'cone', // modified starboard-hand mark (green, red band)
};

/**
 * Pillar/unknown-shape lateral budget in the 24×24 box (#298). Before this,
 * the body (x 9..15) and a ball topmark (cx 12, r 3 -> x 9..15) were the SAME
 * WIDTH, overlapped by 1px and shared one fill, so the pair rendered as a
 * single rounded-top box rather than a topmark above a body.
 *
 * The three separators are the ones the compliant cardinal glyph already uses:
 * a background GAP (2 units between topmark and body here, against the
 * cardinal's 1 — both measured between shape outlines, which is also what the
 * S1 test measures; in rendered INK the keyline stroke costs 0.5 wherever it
 * traces an outer edge, so the cone reads 1.5 and the cardinal 0.5, while the
 * can keeps the full 2 because its keyline is inset), a WIDTH CONTRAST
 * (topmark 6 vs. body 8 — the cardinal runs 8 vs. 10), and the near-white
 * KEYLINE. Equal width is what actually reads as "one shape", so the contrast
 * is not decoration.
 */
const LATERAL_PILLAR_BODY: Box = { x: 8, y: 9, w: 8, h: 12 };
const LATERAL_CAN_TOPMARK: Box = { x: 9, y: 2, w: 6, h: 5 };
const LATERAL_CONE_TOPMARK: readonly Point2D[] = [
  { x: 12, y: 1 },
  { x: 15, y: 7 },
  { x: 9, y: 7 },
];

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
    default: {
      // A pillar (and every unrecognized shape falling back to it) has no
      // silhouette of its own that carries the side, so R1001 makes the
      // topmark the whole message here — unlike a can or conical body, where
      // the topmark is "if any" because the body already says it.
      const segments: SeamarkSegment[] = [
        { kind: 'rect', ...LATERAL_PILLAR_BODY, fill },
        bodyOutline(LATERAL_PILLAR_BODY),
      ];
      // An untagged/unrecognized category draws NO topmark rather than a
      // guessed one: showing the wrong side is worse than showing none — the
      // same nav-safety rule the cardinal path applies to an unknown category.
      switch (LATERAL_TOPMARK[props.category ?? '']) {
        case 'can':
          segments.push(
            { kind: 'rect', ...LATERAL_CAN_TOPMARK, fill },
            bodyOutline(LATERAL_CAN_TOPMARK),
          );
          break;
        case 'cone':
          segments.push(
            { kind: 'polygon', points: LATERAL_CONE_TOPMARK, fill },
            coneOutline(LATERAL_CONE_TOPMARK),
          );
          break;
      }
      return segments;
    }
  }
}

type ConeDir = 'up' | 'down';

// Cardinal topmark orientation, by category — region-independent per IALA
// R1001 Ed 2.0 §2.2.1.1 (cardinal marks are identical in Regions A and B),
// NOT data-driven (the pipeline carries no topmark tag; this is the fixed
// R1001 convention). North: both cones point up. South: both point down.
// East: base-to-base (top up, bottom down) → diamond. West: point-to-point
// (top down, bottom up) → hourglass. The cone points also indicate where the
// BLACK body band sits (N up = black top; S down = black bottom; E apart =
// black top+bottom; W inward = black middle).
const CARDINAL_CONES: Record<string, { top: ConeDir; bottom: ConeDir }> = {
  north: { top: 'up', bottom: 'up' },
  south: { top: 'down', bottom: 'down' },
  east: { top: 'up', bottom: 'down' },
  west: { top: 'down', bottom: 'up' },
};

// Body colour bands top→bottom per category, hand-derived from R1001 Tables 5–6.
const CARDINAL_BANDS: Record<string, string[]> = {
  north: [INK, CARDINAL_YELLOW], // black over yellow
  south: [CARDINAL_YELLOW, INK], // yellow over black
  east: [INK, CARDINAL_YELLOW, INK], // black-yellow-black
  west: [CARDINAL_YELLOW, INK, CARDINAL_YELLOW], // yellow-black-yellow
};

// Topmark cone geometry (24×24 box). The two cones meet at a shared middle row
// CONE_MID, with extremes CONE_TOP / CONE_BOT so every vertex stays on-canvas
// (fixes the old fixed-apex off-canvas clipping); apex on centre column CX,
// base half-width HW (x 8..16).
const CONE_TOP = 1;
const CONE_MID = 6;
const CONE_BOT = 11;
const CX = 12;
const HW = 4;

// One cone as [apex, base+HW, base−HW]. `isTop` selects the y-band; `dir` is
// the pointing (apex) direction — an up cone apexes at the smaller y of its
// band, a down cone at the larger. So a top-down and a bottom-up cone both
// apex at CONE_MID (West's hourglass), and a top-up and bottom-down cone both
// base at CONE_MID (East's diamond).
function cardinalCone(isTop: boolean, dir: ConeDir): Point2D[] {
  const rows = isTop ? [CONE_TOP, CONE_MID] : [CONE_MID, CONE_BOT];
  const [apexY, baseY] = dir === 'up' ? rows : [rows[1], rows[0]];
  return [
    { x: CX, y: apexY },
    { x: CX + HW, y: baseY },
    { x: CX - HW, y: baseY },
  ];
}

// Light near-white keyline around the body box, inset 0.5px so the 1px stroke
// isn't clipped at the y=24 canvas boundary (dark-theme legibility, §2.4).
function bodyOutline(box: Box): SeamarkSegment {
  const x0 = box.x + 0.5;
  const y0 = box.y + 0.5;
  const x1 = box.x + box.w - 0.5;
  const y1 = box.y + box.h - 0.5;
  return {
    kind: 'line',
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: x0, y: y0 },
    ],
    stroke: OUTLINE,
    width: 1,
  };
}

// Light keyline tracing a cone's 3 vertices, repeating the apex to close it.
function coneOutline(points: readonly Point2D[]): SeamarkSegment {
  return { kind: 'line', points: [...points, points[0]], stroke: OUTLINE, width: 1 };
}

// The same keyline for a sphere topmark, stroked ON the circle just as
// coneOutline strokes on a cone's edges (#298). Two callers, two reasons:
// isolated danger, where the spheres sit over a black body band and above one
// another, so without it "two spheres, vertically disposed" renders as a
// single lozenge; and safe water, where nothing merges but an INK sphere on
// transparent canvas is otherwise unreadable against the dark-theme basemap.
function sphereOutline(cx: number, cy: number, r: number): SeamarkSegment {
  return { kind: 'ring', cx, cy, r, stroke: OUTLINE, width: 1 };
}

function cardinalSegments(props: SeamarkProperties): SeamarkSegment[] {
  const cat = props.category ?? '';
  const cones = CARDINAL_CONES[cat];
  const bands = CARDINAL_BANDS[cat];
  const body: Box = { x: 7, y: 12, w: 10, h: 12 };
  // Untagged / unknown category → neutral grey body with NO cones. It must
  // never masquerade as North — the exact nav-safety failure class of #165.
  if (!cones || !bands) {
    return bandSegments(['#888888'], 'horizontal', body);
  }
  const topCone = cardinalCone(true, cones.top);
  const bottomCone = cardinalCone(false, cones.bottom);
  return [
    ...bandSegments(bands, 'horizontal', body),
    bodyOutline(body),
    { kind: 'polygon', points: topCone, fill: INK },
    coneOutline(topCone),
    { kind: 'polygon', points: bottomCone, fill: INK },
    coneOutline(bottomCone),
  ];
}

// R1001 §2.4 specifies a single sphere topmark, and specifies it RED. It is
// drawn in INK here instead, deliberately: the body is red/white VERTICALLY
// striped, so a red sphere resting on it would recreate exactly the
// same-colour merge #298 exists to close. Chart practice (INT-1) likewise
// renders topmarks as black shapes whatever the mark's colour. The sphere now
// sits 2 units clear of the body outline (1.5 in rendered ink, once its
// keyline is counted) — it used to be tangent to it (#298).
function safeWaterSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(tokens.length > 0 ? tokens : ['red', 'white'], 'vertical', {
    x: 7,
    y: 9,
    w: 10,
    h: 12,
  });
  return [...bands, { kind: 'circle', cx: CX, cy: 4, r: 3, fill: INK }, sphereOutline(CX, 4, 3)];
}

// R1001 §2.5 specifies a single X topmark; INK rather than the specified
// yellow for the same reason as the safe-water sphere above (yellow on a
// yellow body is no mark at all). Its lower tips used to reach y10 against a
// body starting at y9 — an overlap, though a cross-colour one — and now clear
// it (#298).
//
// The clearance, re-derived after the keyline was added: these are 45° lines,
// so a stroke of width w centred on the path extends w/2 PERPENDICULAR to it,
// i.e. (w/2)·sin45° ≈ 0.354·w in y — NOT w/2 straight down. The widest stroke
// on these points is the 3-wide keyline, putting worst-case ink at
// y = 7 + 1.061 = 8.061 against a body at y9: clearance ≈ 0.94.
//
// That is under the 1-unit S1 rule, and it is the ONE place where S1 does not
// bound what is actually rendered: `extentOf` measures a line by its POINTS
// and never expands by stroke width, so S1 reads this gap as 2. The mark still
// clears the body and there is no merge — but the honest number is 0.94, and
// the limitation is recorded rather than implied away.
//
// If a true ≥1 is ever wanted, NARROW THE KEYLINE — do not raise the X. The
// same 0.354·w relation runs in both directions, so the top tips already sit
// at y = 1 − 1.061 = −0.061, marginally off-canvas; lifting the glyph to buy
// 0.061 at the bottom would push the top to ≈ −0.12 and trade one end for the
// other. Solving (w/2)·sin45° ≤ 1 gives w ≤ 2.828, and w = 2.8 yields a
// clearance of 1.010 while ALSO returning the top tip on-canvas at +0.010 —
// no glyph movement, and S1's reading is unchanged either way.
//
// Opening that gap is exactly why the X needs the keyline its INK siblings
// already carry: on base its lower ~1 unit still overlapped the yellow body,
// so a fraction of it had a contrasting backdrop; now that it clears the body
// entirely, 100% of it sits on transparent canvas, where INK '#1a1a1a' is
// unreadable against the dark-theme basemap. A stroked glyph takes that
// keyline as a wider near-white UNDERLAY on the same points rather than an
// outline path — which also leaves the S1/S2 measurements untouched, since
// they read a line's extent from its POINTS and never expand by stroke width.
const SPECIAL_X_STROKES: readonly (readonly Point2D[])[] = [
  [
    { x: 9, y: 1 },
    { x: 15, y: 7 },
  ],
  [
    { x: 15, y: 1 },
    { x: 9, y: 7 },
  ],
];
const SPECIAL_X_WIDTH = 1.5;
const SPECIAL_X_KEYLINE_WIDTH = 3;

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
    // Both keyline underlays first, so neither can paint over the other
    // stroke's INK where the two cross at the centre of the X.
    ...SPECIAL_X_STROKES.map((points): SeamarkSegment => ({
      kind: 'line',
      points,
      stroke: OUTLINE,
      width: SPECIAL_X_KEYLINE_WIDTH,
    })),
    ...SPECIAL_X_STROKES.map((points): SeamarkSegment => ({
      kind: 'line',
      points,
      stroke: INK,
      width: SPECIAL_X_WIDTH,
    })),
  ];
}

/**
 * R1001 §2.3: black body with one or more broad red horizontal bands, topmark
 * TWO black spheres vertically disposed.
 *
 * The same #298 defect as the lateral pillar, in its worst form: the two
 * spheres (r 2.5 at cy 2.5 and cy 7) overlapped EACH OTHER by 0.5 units in one
 * INK fill, and the lower one came within 0.5 of a body whose top band is also
 * black — so the pair read as a single lozenge on a black box, losing the
 * "two spheres" that distinguish this mark from a safe-water one. Separated
 * here by 1.5 units both sphere-to-sphere and sphere-to-body, measured between
 * the circles themselves. Each keyline is stroked ON its circle, so it eats
 * 0.5 per ring FACING the gap: the sphere-to-sphere gap has a ring on BOTH
 * sides and loses 1.0, leaving 0.5, while the sphere-to-body gap has only the
 * lower sphere's ring — the body outline is inset — and loses 0.5, leaving
 * 1.0. Both are intended: two white rings meeting still read as two spheres
 * where two black fills do not.
 * The body takes the cardinal's y12 origin because a two-element topmark needs
 * the same vertical budget the cardinal's two cones do.
 */
const ISOLATED_DANGER_BODY: Box = { x: 7, y: 12, w: 10, h: 11 };
const ISOLATED_DANGER_SPHERE_R = 2;
const ISOLATED_DANGER_SPHERE_CY = [3, 8.5] as const;

function isolatedDangerSegments(props: SeamarkProperties): SeamarkSegment[] {
  const tokens = colourTokens(props.colour);
  const bands = bandSegments(
    tokens.length > 0 ? tokens : ['black', 'red', 'black'],
    'horizontal',
    ISOLATED_DANGER_BODY,
  );
  return [
    ...bands,
    bodyOutline(ISOLATED_DANGER_BODY),
    ...ISOLATED_DANGER_SPHERE_CY.flatMap((cy): SeamarkSegment[] => [
      { kind: 'circle', cx: CX, cy, r: ISOLATED_DANGER_SPHERE_R, fill: INK },
      sphereOutline(CX, cy, ISOLATED_DANGER_SPHERE_R),
    ]),
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
    case 'lateral': {
      const shape = bucketShape(props.shape);
      const base = `seamark-lateral-${shape}-${primaryColour(props.colour)}`;
      // The pillar/default silhouette is the only lateral bucket that draws a
      // topmark, and that topmark is derived from `category` (#298) — so this
      // id must carry the category too, or the cache under-keys and one
      // registered image serves both sides of the channel. It is not
      // hypothetical: 7 of the 14 lateral ids in the committed pull cover more
      // than one category, spanning 571 marks. The 2 of those in the `pillar`
      // bucket are the ones this suffix actually separates and account for 61
      // of them: `pillar-red` = {port 49, preferred_channel_starboard 1} and
      // `pillar-grey` = {port 7, starboard 4}. The other 5 ids (510 marks —
      // spar-green 247, spar-red 238, spar-grey 13, can-green 6,
      // spar-#888888 6) stay deliberately unsuffixed, because those buckets
      // draw no topmark and so their glyph does not vary on category — this
      // function's rule is to key only on what the glyph actually varies on.
      // Extend the condition if a topmark is ever added to another bucket.
      return shape === 'pillar' ? `${base}-${props.category ?? 'unknown'}` : base;
    }
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
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  // Map the logical 24-unit coordinate space onto the higher-resolution
  // raster canvas: every segment coordinate/line-width below is expressed in
  // IMAGE_SIZE (24) units and scales up together (#191), so the R1001 cone
  // geometry and colour bands (#165) survive the resize unmodified.
  ctx.scale(CANVAS_SIZE / IMAGE_SIZE, CANVAS_SIZE / IMAGE_SIZE);
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
      case 'ring':
        ctx.strokeStyle = seg.stroke;
        ctx.lineWidth = seg.width;
        ctx.arc(seg.cx, seg.cy, seg.r, 0, Math.PI * 2);
        ctx.stroke();
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
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue; // no 2d context available (e.g. headless test env) — nothing to register
    drawSeamark(ctx, props);
    map.addImage(id, ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE), { pixelRatio: PIXEL_RATIO });
  }
}
