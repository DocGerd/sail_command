import { describe, expect, it, vi } from 'vitest';
import {
  SEAMARK_DISPLAY_TIER_ALL,
  SEAMARK_DISPLAY_TIER_BASE,
  SEAMARK_DISPLAY_TIER_STANDARD,
  classifySeamark,
  registerSeamarkImages,
  seamarkDisplayTier,
  seamarkImageId,
  seamarkImageIds,
  seamarkPriority,
  seamarkRasterConfig,
  seamarkSegments,
  type SeamarkSegment,
} from './seamarkGlyphs';
import type { SeamarkProperties } from '../types';

// #484 F4: canvasSize/naturalIconPx at a non-integer scale, where a bare
// `BASE_CANVAS_SIZE * scale` would silently truncate against
// canvas.width/getImageData's WebIDL integer types (measured in real
// Chromium, not inferred from the spec — see seamarkGlyphs.ts's own #484 F4
// comment). Every expected value below is HAND-DERIVED from
// BASE_CANVAS_SIZE=64 / BASE_PIXEL_RATIO=2 (both read directly off
// seamarkGlyphs.ts, not copied from seamarkRasterConfig's own output), not
// computed by calling seamarkRasterConfig itself — the #50 equivalence-test
// tautology this repo has been bitten by before.
describe('seamarkRasterConfig (#484 F4): CANVAS_SIZE rounding at a non-integer scale', () => {
  it("at scale 1.6 (this PR's own mutation-check scale), canvasSize rounds 102.4 to 102 and naturalIconPx becomes 31.875, not the idealized 32", () => {
    // Hand math: canvasSize = round(64 * 1.6) = round(102.4) = 102.
    // pixelRatio = 2 * 1.6 = 3.2 (never rounded — only canvasSize feeds a
    // WebIDL-integer canvas property; pixelRatio is a plain numeric option
    // to map.addImage with no such constraint).
    // naturalIconPx = 102 / 3.2 = 31.875.
    const config = seamarkRasterConfig(1.6);
    expect(config.canvasSize).toBe(102);
    expect(config.pixelRatio).toBe(3.2);
    expect(config.naturalIconPx).toBe(31.875);
  });

  it('at the shipped default scale of 1, every value is byte-identical to before #484 (64 / 2 / 32)', () => {
    const config = seamarkRasterConfig(1);
    expect(config.canvasSize).toBe(64);
    expect(config.pixelRatio).toBe(2);
    expect(config.naturalIconPx).toBe(32);
  });

  it('canvasSize is always an integer, at every scale — the property canvas.width/getImageData actually require', () => {
    for (const scale of [1, 1.1, 1.5, 1.6, 1.75, 2, 2.4, 0.5]) {
      expect(Number.isInteger(seamarkRasterConfig(scale).canvasSize)).toBe(true);
    }
  });
});

describe('classifySeamark (family bucketing by seamark:type suffix)', () => {
  it('buckets buoy_/beacon_ variants of the same family together', () => {
    expect(classifySeamark('buoy_lateral')).toBe('lateral');
    expect(classifySeamark('beacon_lateral')).toBe('lateral');
    expect(classifySeamark('buoy_cardinal')).toBe('cardinal');
    expect(classifySeamark('beacon_cardinal')).toBe('cardinal');
    expect(classifySeamark('buoy_safe_water')).toBe('safeWater');
    expect(classifySeamark('buoy_special_purpose')).toBe('specialPurpose');
    expect(classifySeamark('beacon_special_purpose')).toBe('specialPurpose');
    expect(classifySeamark('buoy_isolated_danger')).toBe('isolatedDanger');
    expect(classifySeamark('beacon_isolated_danger')).toBe('isolatedDanger');
  });

  it('distinguishes light_major from light_minor by exact match (not suffix)', () => {
    expect(classifySeamark('light_major')).toBe('lightMajor');
    expect(classifySeamark('light_minor')).toBe('lightMinor');
  });

  it('falls back to unknown for anything outside the pipeline core-AtoN filter', () => {
    expect(classifySeamark('mooring')).toBe('unknown');
    expect(classifySeamark('rock')).toBe('unknown');
    expect(classifySeamark('')).toBe('unknown');
  });
});

describe('seamarkImageId (family + the fields the glyph actually varies on)', () => {
  it('lateral: keys off shape bucket + primary colour, not just seamarkType', () => {
    expect(
      seamarkImageId({
        seamarkType: 'buoy_lateral',
        shape: 'pillar',
        colour: 'red',
        category: 'port',
      }),
    ).toBe('seamark-lateral-pillar-red-port');
    expect(seamarkImageId({ seamarkType: 'beacon_lateral', shape: 'can', colour: 'green' })).toBe(
      'seamark-lateral-can-green',
    );
    // Different seamarkType, same shape/colour -> same image id (a buoy and a
    // beacon lateral render identically).
    expect(seamarkImageId({ seamarkType: 'buoy_lateral', colour: 'red' })).toBe(
      seamarkImageId({ seamarkType: 'beacon_lateral', colour: 'red' }),
    );
  });

  // #298: the pillar/default bucket's topmark is derived from `category`, so
  // the id must separate categories or one registered image serves both sides
  // of the channel. In the committed pull `seamark-lateral-pillar-red` alone
  // covers {port: 49, preferred_channel_starboard: 1} and
  // `seamark-lateral-pillar-grey` covers {port: 7, starboard: 4}.
  it('lateral pillar: separates categories, because the topmark differs by side', () => {
    const port = seamarkImageId({ seamarkType: 'buoy_lateral', colour: 'grey', category: 'port' });
    const stbd = seamarkImageId({
      seamarkType: 'buoy_lateral',
      colour: 'grey',
      category: 'starboard',
    });
    expect(port).not.toBe(stbd);
    // Untagged category still resolves to a stable id (it draws a bare body).
    expect(seamarkImageId({ seamarkType: 'buoy_lateral', colour: 'grey' })).toBe(
      'seamark-lateral-pillar-grey-unknown',
    );
  });

  // #307: spar now draws a topmark too (category-derived, same as pillar),
  // so it must separate categories exactly like the pillar test above — a
  // grey spar mark's port and starboard image ids must differ, or the cache
  // under-keys and one registered image serves both sides of the channel.
  it('lateral spar: separates categories, because the topmark differs by side', () => {
    const port = seamarkImageId({
      seamarkType: 'buoy_lateral',
      shape: 'spar',
      colour: 'grey',
      category: 'port',
    });
    const stbd = seamarkImageId({
      seamarkType: 'buoy_lateral',
      shape: 'spar',
      colour: 'grey',
      category: 'starboard',
    });
    expect(port).not.toBe(stbd);
    // stake/pile/pole all bucket to 'spar' and must share its category-suffixed id.
    expect(
      seamarkImageId({
        seamarkType: 'buoy_lateral',
        shape: 'stake',
        colour: 'grey',
        category: 'port',
      }),
    ).toBe(port);
    // Untagged category still resolves to a stable id (it draws a bare body).
    expect(seamarkImageId({ seamarkType: 'buoy_lateral', shape: 'spar', colour: 'grey' })).toBe(
      'seamark-lateral-spar-grey-unknown',
    );
  });

  // The remaining buckets draw no topmark, so their glyph does not vary on
  // category and their ids must not fragment the image cache by it.
  it('lateral can/conical/spherical ids stay category-independent', () => {
    for (const shape of ['can', 'conical', 'spherical']) {
      const a = seamarkImageId({ seamarkType: 'buoy_lateral', shape, colour: 'red' });
      const b = seamarkImageId({
        seamarkType: 'buoy_lateral',
        shape,
        colour: 'red',
        category: 'port',
      });
      expect(a, `${shape} id`).toBe(b);
    }
  });

  it('cardinal: keys off category, defaulting to "unknown" when untagged', () => {
    expect(seamarkImageId({ seamarkType: 'buoy_cardinal', category: 'east' })).toBe(
      'seamark-cardinal-east',
    );
    expect(seamarkImageId({ seamarkType: 'beacon_cardinal' })).toBe('seamark-cardinal-unknown');
  });

  it('safe-water/special-purpose/isolated-danger: keys off the full colour band', () => {
    expect(seamarkImageId({ seamarkType: 'buoy_safe_water', colour: 'red;white' })).toBe(
      'seamark-safewater-red-white',
    );
    expect(seamarkImageId({ seamarkType: 'buoy_safe_water' })).toBe('seamark-safewater-default');
    expect(seamarkImageId({ seamarkType: 'buoy_special_purpose', colour: 'yellow' })).toBe(
      'seamark-special-yellow',
    );
    expect(seamarkImageId({ seamarkType: 'buoy_isolated_danger', colour: 'black;red;black' })).toBe(
      'seamark-isolated-black-red-black',
    );
  });

  it('lights: one fixed id per major/minor, colour-independent', () => {
    expect(seamarkImageId({ seamarkType: 'light_major' })).toBe('seamark-light-major');
    expect(seamarkImageId({ seamarkType: 'light_minor' })).toBe('seamark-light-minor');
  });

  it('falls back to a single unknown id', () => {
    expect(seamarkImageId({ seamarkType: 'mooring' })).toBe('seamark-unknown');
  });
});

describe('seamarkSegments (pure glyph geometry, 24x24 icon box)', () => {
  // Every expectation below is computed BY HAND from the geometry constants
  // in seamarkGlyphs.ts (IMAGE_SIZE=24, CENTER=12, INK='#1a1a1a'), not by
  // calling seamarkSegments() itself — a wrong offset/orientation mutation
  // must fail here (mirrors windBarbs.test.ts's literal-pinning rationale).

  // #298 — every literal below is hand-derived from IALA R1001 Ed 2.0 §2.2
  // Tables 5-6 plus the S1/S2 separation rules stated below, NOT from the
  // renderer (the full derivation is in the PR body):
  //   * a PORT-hand mark carries a single CAN, a STARBOARD-hand mark a single
  //     CONE point up. A single SPHERE is the SAFE-WATER topmark, so the ball
  //     this glyph used to draw was wrong symbology as well as illegible.
  //   * that shape mapping is region-independent (Region B swaps the colours,
  //     not the shapes) and INVERTS for the preferred-channel categories: a
  //     `preferred_channel_port` mark is a modified STARBOARD-hand mark.
  //   * body {8,9,8,12}; topmarks 6 wide against an 8-wide body (width
  //     contrast 2), clearing it by 2 units between shapes — 2 of that
  //     surviving as ink under the can, whose keyline is inset, and 1.5 under
  //     the cone, whose keyline traces its outer edge; near-white keyline
  //     'f2f2f2' on both, as the compliant cardinal glyph already does.
  const LATERAL_BODY = (fill: string) =>
    [
      { kind: 'rect', x: 8, y: 9, w: 8, h: 12, fill },
      {
        kind: 'line',
        points: [
          { x: 8.5, y: 9.5 },
          { x: 15.5, y: 9.5 },
          { x: 15.5, y: 20.5 },
          { x: 8.5, y: 20.5 },
          { x: 8.5, y: 9.5 },
        ],
        stroke: '#f2f2f2',
        width: 1,
      },
    ] as const;
  const CAN_TOPMARK = (fill: string) =>
    [
      { kind: 'rect', x: 9, y: 2, w: 6, h: 5, fill },
      {
        kind: 'line',
        points: [
          { x: 9.5, y: 2.5 },
          { x: 14.5, y: 2.5 },
          { x: 14.5, y: 6.5 },
          { x: 9.5, y: 6.5 },
          { x: 9.5, y: 2.5 },
        ],
        stroke: '#f2f2f2',
        width: 1,
      },
    ] as const;
  const CONE_POINTS = [
    { x: 12, y: 1 },
    { x: 15, y: 7 },
    { x: 9, y: 7 },
  ];
  const CONE_TOPMARK = (fill: string) =>
    [
      { kind: 'polygon', points: CONE_POINTS, fill },
      {
        kind: 'line',
        points: [...CONE_POINTS, CONE_POINTS[0]],
        stroke: '#f2f2f2',
        width: 1,
      },
    ] as const;

  it('lateral pillar, port: R1001 CAN topmark clear of the body (not a same-width ball)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', colour: 'red', category: 'port' });
    expect(segs).toEqual([...LATERAL_BODY('red'), ...CAN_TOPMARK('red')]);
  });

  it('lateral pillar, starboard: R1001 CONE point up', () => {
    const segs = seamarkSegments({
      seamarkType: 'buoy_lateral',
      colour: 'green',
      category: 'starboard',
    });
    expect(segs).toEqual([...LATERAL_BODY('green'), ...CONE_TOPMARK('green')]);
  });

  // The inversion an `endsWith('port')` shortcut gets wrong in both
  // directions: "preferred channel to port" means leave the mark to
  // starboard, so it is a modified STARBOARD-hand mark and takes the cone.
  it('preferred-channel categories invert: to-port takes the cone, to-starboard the can', () => {
    const toPort = seamarkSegments({
      seamarkType: 'buoy_lateral',
      colour: 'green;red;green',
      category: 'preferred_channel_port',
    });
    expect(toPort).toEqual([...LATERAL_BODY('green'), ...CONE_TOPMARK('green')]);
    const toStarboard = seamarkSegments({
      seamarkType: 'buoy_lateral',
      colour: 'red;green;red',
      category: 'preferred_channel_starboard',
    });
    expect(toStarboard).toEqual([...LATERAL_BODY('red'), ...CAN_TOPMARK('red')]);
  });

  // Same nav-safety rule the cardinal path applies to an unknown category:
  // showing the wrong side is worse than showing none.
  it('lateral pillar with an untagged category draws NO topmark (never a guessed side)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', colour: 'red' });
    expect(segs).toEqual([...LATERAL_BODY('red')]);
    expect(segs.some((s) => s.kind === 'polygon')).toBe(false);
    expect(segs).not.toEqual(
      seamarkSegments({ seamarkType: 'buoy_lateral', colour: 'red', category: 'port' }),
    );
  });

  // The topmark is keyed off `category`, never off `colour`. Measured over the
  // committed pull, 51 laterals carry a colour contradicting their category
  // (18 port marks tagged black, 15 port and 9 starboard grey, 4 starboard and
  // 2 port untagged, 2 starboard white, and one PORT mark green) — every one
  // of which a colour rule would put on the wrong side of the channel.
  //
  // Reach, updated by #307: the pillar bucket's 11 (port 7, starboard 4,
  // both grey) and the spar bucket's 39 (18 port tagged black, 8 port / 5
  // starboard grey, 2 starboard white, 2 port / 4 starboard untagged) of the
  // 51 are now corrected — every bucket that draws a topmark keys it off
  // `category`. Only the one remaining can (the PORT mark tagged green) is
  // untouched, and by design: a can's SILHOUETTE already indicates port
  // regardless of its colour tag, unlike a spar or pillar's uniform body.
  // The green-tagged PORT mark below is a pillar-shaped stand-in that pins
  // the RULE; the real one in the data is that can.
  it('derives the topmark from category, not colour (a green PORT mark still gets a can)', () => {
    const segs = seamarkSegments({
      seamarkType: 'buoy_lateral',
      colour: 'green',
      category: 'port',
    });
    expect(segs).toEqual([...LATERAL_BODY('green'), ...CAN_TOPMARK('green')]);
  });

  it('lateral can shape: flat-top rect only', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', shape: 'can', colour: 'green' });
    expect(segs).toEqual([{ kind: 'rect', x: 7, y: 9, w: 10, h: 11, fill: 'green' }]);
  });

  it('lateral conical shape with no colour tag: neutral-grey fallback fill', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', shape: 'conical' });
    expect(segs).toEqual([
      {
        kind: 'polygon',
        points: [
          { x: 12, y: 6 },
          { x: 18, y: 20 },
          { x: 6, y: 20 },
        ],
        fill: '#888888',
      },
    ]);
  });

  // #307: spar (and stake/pile/pole, which bucket to the same silhouette)
  // is the 524-mark majority of laterals and, before this, carried NO
  // topmark at all — its side rested on colour alone. Geometry hand-derived
  // from the tighter canvas budget above a spar's thin pole body (see the
  // LATERAL_SPAR_CAN_TOPMARK/_CONE_TOPMARK docblock in seamarkGlyphs.ts):
  // body {10,5,4,16}, no outline (unchanged, #307 is topmark-only scope);
  // topmark box {9,1,6,3} — 1 unit of empty canvas above the body (S1) and
  // 6 vs. the body's 4 (S2 = 2, contrast in the WIDER direction this time —
  // see the S2 comment further down for why direction is shape-dependent).
  const SPAR_BODY = (fill: string) => [{ kind: 'rect', x: 10, y: 5, w: 4, h: 16, fill }] as const;
  const SPAR_CAN_TOPMARK = (fill: string) =>
    [
      { kind: 'rect', x: 9, y: 1, w: 6, h: 3, fill },
      {
        kind: 'line',
        points: [
          { x: 9.5, y: 1.5 },
          { x: 14.5, y: 1.5 },
          { x: 14.5, y: 3.5 },
          { x: 9.5, y: 3.5 },
          { x: 9.5, y: 1.5 },
        ],
        stroke: '#f2f2f2',
        width: 1,
      },
    ] as const;
  const SPAR_CONE_POINTS = [
    { x: 12, y: 1 },
    { x: 15, y: 4 },
    { x: 9, y: 4 },
  ];
  const SPAR_CONE_TOPMARK = (fill: string) =>
    [
      { kind: 'polygon', points: SPAR_CONE_POINTS, fill },
      {
        kind: 'line',
        points: [...SPAR_CONE_POINTS, SPAR_CONE_POINTS[0]],
        stroke: '#f2f2f2',
        width: 1,
      },
    ] as const;

  it('lateral spar, port: R1001 CAN topmark (previously no topmark at all)', () => {
    const segs = seamarkSegments({
      seamarkType: 'buoy_lateral',
      shape: 'spar',
      colour: 'red',
      category: 'port',
    });
    expect(segs).toEqual([...SPAR_BODY('red'), ...SPAR_CAN_TOPMARK('red')]);
  });

  it('lateral spar, starboard: R1001 CONE point up (previously no topmark at all)', () => {
    const segs = seamarkSegments({
      seamarkType: 'buoy_lateral',
      shape: 'spar',
      colour: 'green',
      category: 'starboard',
    });
    expect(segs).toEqual([...SPAR_BODY('green'), ...SPAR_CONE_TOPMARK('green')]);
  });

  // stake/pile/pole all bucket to the same 'spar' silhouette (bucketShape)
  // and must draw the identical topmark.
  it('lateral stake/pile/pole shapes draw the same spar topmark', () => {
    for (const shape of ['stake', 'pile', 'pole']) {
      const segs = seamarkSegments({
        seamarkType: 'buoy_lateral',
        shape,
        colour: 'red',
        category: 'port',
      });
      expect(segs, shape).toEqual([...SPAR_BODY('red'), ...SPAR_CAN_TOPMARK('red')]);
    }
  });

  // Same nav-safety rule as the pillar bucket: an untagged category must
  // never guess a side.
  it('lateral spar with an untagged category draws NO topmark (never a guessed side)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', shape: 'spar', colour: 'red' });
    expect(segs).toEqual([...SPAR_BODY('red')]);
    expect(segs.some((s) => s.kind === 'polygon')).toBe(false);
  });

  // #165 (nav-safety): cardinal glyphs get IALA R1001 Ed 2.0 Tables 5-6 colour
  // bands + on-canvas topmark cones. Every expected value below is hand-derived
  // from R1001 (cone points indicate where the BLACK band sits: N up = black
  // top; S down = black bottom; E apart = black top+bottom; W inward = black
  // middle) and the §2 canvas budget — NEVER read back from the renderer (that
  // was the bug). INK='#1a1a1a', CARDINAL_YELLOW='#f5c400', OUTLINE='#f2f2f2';
  // body box {x:7,y:12,w:10,h:12}; cones meet at shared mid y6, extremes y1/y11,
  // apex on x12, base half-width 4 (x 8..16). Body outline is inset 0.5px so the
  // 1px stroke isn't clipped at the y=24 boundary; each cone outline retraces its
  // 3 vertices + the apex.
  const INK = '#1a1a1a';
  const YEL = '#f5c400';
  const OUT = '#f2f2f2';
  const bodyOutlineSeg = {
    kind: 'line',
    points: [
      { x: 7.5, y: 12.5 },
      { x: 16.5, y: 12.5 },
      { x: 16.5, y: 23.5 },
      { x: 7.5, y: 23.5 },
      { x: 7.5, y: 12.5 },
    ],
    stroke: OUT,
    width: 1,
  } as const;
  // Cone vertices [apex, base+HW, base-HW], hand-derived from R1001 orientation.
  const NORTH_TOP = [
    { x: 12, y: 1 },
    { x: 16, y: 6 },
    { x: 8, y: 6 },
  ];
  const NORTH_BOT = [
    { x: 12, y: 6 },
    { x: 16, y: 11 },
    { x: 8, y: 11 },
  ];
  const SOUTH_TOP = [
    { x: 12, y: 6 },
    { x: 16, y: 1 },
    { x: 8, y: 1 },
  ];
  const SOUTH_BOT = [
    { x: 12, y: 11 },
    { x: 16, y: 6 },
    { x: 8, y: 6 },
  ];
  // East: top up + bottom down, bases share y6 -> diamond (base-to-base).
  const EAST_TOP = NORTH_TOP;
  const EAST_BOT = SOUTH_BOT;
  // West: top down + bottom up, apexes share (12,6) -> hourglass (point-to-point).
  const WEST_TOP = SOUTH_TOP;
  const WEST_BOT = NORTH_BOT;
  const coneFill = (points: { x: number; y: number }[]) => ({
    kind: 'polygon',
    points,
    fill: INK,
  });
  const coneOut = (points: { x: number; y: number }[]) => ({
    kind: 'line',
    points: [...points, points[0]],
    stroke: OUT,
    width: 1,
  });

  it('cardinal north: black-over-yellow body + two up cones (R1001 Tables 5-6)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'north' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 12, w: 10, h: 6, fill: INK },
      { kind: 'rect', x: 7, y: 18, w: 10, h: 6, fill: YEL },
      bodyOutlineSeg,
      coneFill(NORTH_TOP),
      coneOut(NORTH_TOP),
      coneFill(NORTH_BOT),
      coneOut(NORTH_BOT),
    ]);
  });

  it('cardinal south: yellow-over-black body + two down cones (R1001 Tables 5-6)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'south' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 12, w: 10, h: 6, fill: YEL },
      { kind: 'rect', x: 7, y: 18, w: 10, h: 6, fill: INK },
      bodyOutlineSeg,
      coneFill(SOUTH_TOP),
      coneOut(SOUTH_TOP),
      coneFill(SOUTH_BOT),
      coneOut(SOUTH_BOT),
    ]);
  });

  it('cardinal east: black-yellow-black body + base-to-base diamond cones (R1001 Tables 5-6)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'east' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 12, w: 10, h: 4, fill: INK },
      { kind: 'rect', x: 7, y: 16, w: 10, h: 4, fill: YEL },
      { kind: 'rect', x: 7, y: 20, w: 10, h: 4, fill: INK },
      bodyOutlineSeg,
      coneFill(EAST_TOP),
      coneOut(EAST_TOP),
      coneFill(EAST_BOT),
      coneOut(EAST_BOT),
    ]);
  });

  it('cardinal west: yellow-black-yellow body + point-to-point hourglass cones (R1001 Tables 5-6)', () => {
    const segs = seamarkSegments({ seamarkType: 'beacon_cardinal', category: 'west' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 12, w: 10, h: 4, fill: YEL },
      { kind: 'rect', x: 7, y: 16, w: 10, h: 4, fill: INK },
      { kind: 'rect', x: 7, y: 20, w: 10, h: 4, fill: YEL },
      bodyOutlineSeg,
      coneFill(WEST_TOP),
      coneOut(WEST_TOP),
      coneFill(WEST_BOT),
      coneOut(WEST_BOT),
    ]);
  });

  // Generalized from cardinal-only in #298: moving a topmark up to open a gap
  // is exactly the edit that can push it off the top of the canvas, so every
  // family is swept, not just the one whose cones clipped in #165.
  const ON_CANVAS_CASES: { label: string; props: SeamarkProperties }[] = [
    ...['north', 'south', 'east', 'west'].map((category) => ({
      label: `cardinal ${category}`,
      props: { seamarkType: 'buoy_cardinal', category },
    })),
    { label: 'cardinal untagged', props: { seamarkType: 'buoy_cardinal' } },
    ...['port', 'starboard', 'preferred_channel_port', 'preferred_channel_starboard'].map(
      (category) => ({
        label: `lateral pillar ${category}`,
        props: { seamarkType: 'buoy_lateral', colour: 'red', category },
      }),
    ),
    ...['can', 'conical', 'spar', 'spherical'].map((shape) => ({
      label: `lateral ${shape}`,
      props: { seamarkType: 'buoy_lateral', shape, colour: 'green', category: 'starboard' },
    })),
    // #307: the starboard case above already exercises the spar CONE, but
    // the CAN topmark (port) has its own, differently-shaped geometry and
    // needs its own on-canvas check.
    {
      label: 'lateral spar port',
      props: { seamarkType: 'buoy_lateral', shape: 'spar', colour: 'red', category: 'port' },
    },
    { label: 'safe water', props: { seamarkType: 'buoy_safe_water', colour: 'red;white' } },
    { label: 'special purpose', props: { seamarkType: 'buoy_special_purpose', colour: 'yellow' } },
    {
      label: 'isolated danger',
      props: { seamarkType: 'buoy_isolated_danger', colour: 'black;red;black' },
    },
    { label: 'light major', props: { seamarkType: 'light_major' } },
    { label: 'light minor', props: { seamarkType: 'light_minor' } },
    { label: 'unknown', props: { seamarkType: 'mooring' } },
  ];

  it('every segment of every family stays on-canvas 0..24 (guards the #2 top-cone clip)', () => {
    for (const { label: cat, props } of ON_CANVAS_CASES) {
      const segs = seamarkSegments(props);
      const pts: { x: number; y: number }[] = [];
      for (const seg of segs) {
        if (seg.kind === 'rect') {
          pts.push({ x: seg.x, y: seg.y }, { x: seg.x + seg.w, y: seg.y + seg.h });
        } else if (seg.kind === 'polygon' || seg.kind === 'line') {
          pts.push(...seg.points);
        } else {
          pts.push(
            { x: seg.cx - seg.r, y: seg.cy - seg.r },
            { x: seg.cx + seg.r, y: seg.cy + seg.r },
          );
        }
      }
      for (const p of pts) {
        expect(p.x, `${cat} x on-canvas`).toBeGreaterThanOrEqual(0);
        expect(p.x, `${cat} x on-canvas`).toBeLessThanOrEqual(24);
        expect(p.y, `${cat} y on-canvas`).toBeGreaterThanOrEqual(0);
        expect(p.y, `${cat} y on-canvas`).toBeLessThanOrEqual(24);
      }
    }
  });

  const conePolys = (props: SeamarkProperties) =>
    seamarkSegments(props).filter(
      (s): s is Extract<SeamarkSegment, { kind: 'polygon' }> => s.kind === 'polygon',
    );

  it('west topmark is geometrically distinct from north (guards #4: West must never read as North)', () => {
    const west = conePolys({ seamarkType: 'buoy_cardinal', category: 'west' });
    const north = conePolys({ seamarkType: 'buoy_cardinal', category: 'north' });
    expect(west).not.toEqual(north);
    // West apexes both meet at the shared middle (12,6); North apexes are at y1 & y6.
    expect(west.map((c) => c.points[0])).toEqual([
      { x: 12, y: 6 },
      { x: 12, y: 6 },
    ]);
  });

  it('east cones are base-to-base (both bases y6) and distinct from west apex-to-apex (guards #3)', () => {
    const east = conePolys({ seamarkType: 'buoy_cardinal', category: 'east' });
    // Each east cone has its two BASE vertices (indices 1,2) at y6; apexes apart (y1,y11).
    for (const c of east) {
      expect(c.points[1].y).toBe(6);
      expect(c.points[2].y).toBe(6);
    }
    expect(east.map((c) => c.points[0].y)).toEqual([1, 11]);
    // West is apex-to-apex, so its cone set differs from east's.
    const west = conePolys({ seamarkType: 'buoy_cardinal', category: 'west' });
    expect(east).not.toEqual(west);
  });

  it('cardinal banding present & ordered per R1001 (guards #1: no bands = the bug)', () => {
    const firstBand = (cat: string) => {
      const first = seamarkSegments({ seamarkType: 'buoy_cardinal', category: cat })[0];
      return first.kind === 'rect' ? first.fill : undefined;
    };
    const bandCount = (cat: string) =>
      seamarkSegments({ seamarkType: 'buoy_cardinal', category: cat }).filter(
        (s) => s.kind === 'rect',
      ).length;
    // Top-of-body colour: N/E black, S/W yellow.
    expect(firstBand('north')).toBe(INK);
    expect(firstBand('east')).toBe(INK);
    expect(firstBand('south')).toBe(YEL);
    expect(firstBand('west')).toBe(YEL);
    // Band count: N/S = 2 bands, E/W = 3 bands.
    expect(bandCount('north')).toBe(2);
    expect(bandCount('south')).toBe(2);
    expect(bandCount('east')).toBe(3);
    expect(bandCount('west')).toBe(3);
  });

  it('cardinal with an untagged/unknown category is a neutral grey body with NO cones (never North)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_cardinal' });
    expect(segs).toEqual([{ kind: 'rect', x: 7, y: 12, w: 10, h: 12, fill: '#888888' }]);
    // Must NOT masquerade as North (the exact #165 failure class).
    expect(segs).not.toEqual(seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'north' }));
    // No topmark cones at all.
    expect(segs.some((s) => s.kind === 'polygon')).toBe(false);
  });

  // R1001 §2.4: red/white VERTICAL stripes, single sphere topmark. The sphere
  // is INK rather than the specified red by design — a red sphere over red
  // stripes is the very merge #298 closes, and chart practice (INT-1) draws
  // topmarks as black shapes. cy 4 (was 6) puts it 2 units clear of the body
  // outline — 1.5 in rendered ink, once its keyline is counted — where it used
  // to touch the body exactly.
  it('safe-water: vertical colour bands + a sphere topmark clear of the body', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_safe_water', colour: 'red;white' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 9, w: 5, h: 12, fill: 'red' },
      { kind: 'rect', x: 12, y: 9, w: 5, h: 12, fill: 'white' },
      { kind: 'circle', cx: 12, cy: 4, r: 3, fill: '#1a1a1a' },
      // Same keyline every other topmark carries: an INK sphere is otherwise
      // near-invisible against the dark-theme basemap (#165, §2.4).
      { kind: 'ring', cx: 12, cy: 4, r: 3, stroke: '#f2f2f2', width: 1 },
    ]);
  });

  // R1001 §2.5: single X topmark, INK for the same reason as the safe-water
  // sphere (yellow on a yellow body is no mark). Raised to y1..7 so it clears
  // the body at y9 — its lower tips used to reach y10, one unit INTO the body.
  // The widest stroke on these points is the 3-wide keyline, and on a 45° line
  // that extends (3/2)·sin45° ≈ 1.06 in y, so worst-case ink lands at y ≈ 8.06
  // for a real clearance of ≈ 0.94 (see the note in specialPurposeSegments —
  // this is the one place S1's point-based reading of 2 overstates the ink).
  //
  // #308: the body itself now also carries the near-white bodyOutline() every
  // other multi-band family (cardinal, isolated danger, lateral pillar/spar)
  // already has — a `colour=black` special-purpose body (133 of 703 in the
  // committed pull) was otherwise a solid INK rect on transparent canvas,
  // invisible against the dark-theme basemap the same way the pre-#306 X was.
  const SPECIAL_BODY_OUTLINE = {
    kind: 'line',
    points: [
      { x: 7.5, y: 9.5 },
      { x: 16.5, y: 9.5 },
      { x: 16.5, y: 20.5 },
      { x: 7.5, y: 20.5 },
      { x: 7.5, y: 9.5 },
    ],
    stroke: OUT,
    width: 1,
  } as const;

  it('special-purpose with no colour tag: single yellow-fallback band + keylined X topmark', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_special_purpose' });
    // A stroked glyph takes its keyline as a wider near-white UNDERLAY on the
    // same points, not an outline path. Both underlays precede both INK
    // strokes so neither can paint over the other's ink where the X crosses.
    const stroke1 = [
      { x: 9, y: 1 },
      { x: 15, y: 7 },
    ];
    const stroke2 = [
      { x: 15, y: 1 },
      { x: 9, y: 7 },
    ];
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 9, w: 10, h: 12, fill: 'yellow' },
      SPECIAL_BODY_OUTLINE,
      { kind: 'line', points: stroke1, stroke: OUT, width: 3 },
      { kind: 'line', points: stroke2, stroke: OUT, width: 3 },
      { kind: 'line', points: stroke1, stroke: INK, width: 1.5 },
      { kind: 'line', points: stroke2, stroke: INK, width: 1.5 },
    ]);
  });

  // #308: the actual reported defect — a solid black body — gets the same
  // keyline, making it legible instead of a near-invisible box on the
  // dark-theme basemap.
  it('special-purpose, black-tagged: body gets a near-white keyline for dark-basemap contrast', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_special_purpose', colour: 'black' });
    expect(segs[0]).toEqual({ kind: 'rect', x: 7, y: 9, w: 10, h: 12, fill: 'black' });
    expect(segs[1]).toEqual(SPECIAL_BODY_OUTLINE);
  });

  // R1001 §2.3: black body with broad red band(s), topmark TWO black spheres
  // "vertically disposed". Hand-derived: r 2 at cy 3 and cy 8.5 gives 1.5
  // units between the spheres and 1.5 above a body that takes the cardinal's
  // y12 origin (a two-element topmark needs the cardinal's vertical budget) —
  // both measured between the CIRCLES, which is what the literals below pin.
  // Each keyline is stroked ON its circle and eats 0.5 per ring facing a gap,
  // so in rendered ink those become 0.5 between the spheres (a ring on each
  // side) and 1.0 above the body (one ring; the body outline is inset). See
  // the docblock on ISOLATED_DANGER_BODY for why both are intended.
  // Before #298 the two spheres OVERLAPPED each other by 0.5 in one fill and
  // sat 0.5 above a black body band, i.e. one lozenge.
  it('isolated-danger: horizontal colour bands + two separated, ringed sphere topmarks', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_isolated_danger', colour: 'black;red' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 12, w: 10, h: 5.5, fill: 'black' },
      { kind: 'rect', x: 7, y: 17.5, w: 10, h: 5.5, fill: 'red' },
      {
        kind: 'line',
        points: [
          { x: 7.5, y: 12.5 },
          { x: 16.5, y: 12.5 },
          { x: 16.5, y: 22.5 },
          { x: 7.5, y: 22.5 },
          { x: 7.5, y: 12.5 },
        ],
        stroke: OUT,
        width: 1,
      },
      { kind: 'circle', cx: 12, cy: 3, r: 2, fill: INK },
      { kind: 'ring', cx: 12, cy: 3, r: 2, stroke: OUT, width: 1 },
      { kind: 'circle', cx: 12, cy: 8.5, r: 2, fill: INK },
      { kind: 'ring', cx: 12, cy: 8.5, r: 2, stroke: OUT, width: 1 },
    ]);
  });

  // ---------------------------------------------------------------------
  // #298 structural rules. R1001 says WHAT is drawn, not pixels; these two
  // properties are hand-derived from what a reader must be able to
  // discriminate at native size, and they hold across every family that
  // carries a topmark rather than per-family coordinates:
  //
  //   S1 BOUNDARY      an empty horizontal band of >= 1 unit separates the
  //                    topmark from the body, so the two can never form one
  //                    contiguous silhouette.
  //   S2 WIDTH CONTRAST |topmark width - body width| >= 2. Equal width IS the
  //                    defect: a shape the same width as the body reads as a
  //                    cap on it. (Direction is shape-dependent and both are
  //                    valid symbology — a narrow topmark on a broad pillar, a
  //                    wide topmark on a slender spar.)
  //
  // Extents are taken from each segment's geometry, keylines included but
  // stroke width not expanded — a keyline is the separator, not the thing
  // being separated.
  interface Extent {
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  const extentOf = (seg: SeamarkSegment): Extent => {
    if (seg.kind === 'rect') {
      return { x0: seg.x, x1: seg.x + seg.w, y0: seg.y, y1: seg.y + seg.h };
    }
    if (seg.kind === 'circle' || seg.kind === 'ring') {
      return { x0: seg.cx - seg.r, x1: seg.cx + seg.r, y0: seg.cy - seg.r, y1: seg.cy + seg.r };
    }
    const xs = seg.points.map((p) => p.x);
    const ys = seg.points.map((p) => p.y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  /**
   * The LOWEST empty horizontal band in the glyph — the one adjacent to the
   * body — plus the widths of the ink above and below it. Computed only from
   * the returned segments, so it is independent of how any family happens to
   * order or name them.
   *
   * "Lowest", not "widest", is load-bearing. A multi-part topmark has more
   * than one candidate band, and for the isolated-danger mark the two are the
   * SAME size (sphere-to-sphere [5..6.5] and topmark-to-body [10.5..12], both
   * 1.5), so a widest-band rule kept the sphere-to-sphere one: S1 then
   * measured a gap INTERNAL to the topmark and S2 compared one sphere (4)
   * against the other sphere plus the body (10) — neither ever compared the
   * topmark to the body, and shrinking the real topmark/body gap to 0.5 left
   * both rules green. Second instance of the degenerate-pass class already
   * fixed once below in S2, so it is spelled out rather than quietly patched.
   *
   * Why the lowest band is the topmark/body boundary for any topmark part
   * count: a body is emitted by `bandSegments`, whose rects are placed at
   * `box.y + i*bandH` with height `bandH` and so tile the box, plus a
   * `bodyOutline` inset 0.5 INSIDE it. For every band count this app actually
   * ships (1, 2 and 3 — the colour tags top out at three tokens) the seam
   * arithmetic cancels to EXACTLY 0, so a body contains no internal empty
   * band, every internal band belongs to the topmark, and the lowest band is
   * the boundary.
   *
   * Narrowed, not universal, and the residual is named: that cancellation is
   * floating-point, not algebraic — `(box.y + i*bandH) + bandH` and
   * `box.y + (i+1)*bandH` are the same real number but not always the same
   * double. At 5 bands it leaves ~3.55e-15 and at 7 bands ~1.78e-15. No
   * shipped body reaches those counts, and if one ever did the crumb is
   * smaller than any real gap, so `separation()` would report ≈0 and fail
   * LOUDLY rather than pass.
   *
   * The failure direction is safe for that mechanism, but it is not
   * unconditionally safe: a body with an internal gap of ≥1 WOULD mask a
   * smaller topmark/body gap, exactly as the widest-band rule did. Nothing
   * produces such a gap today — the only real mechanism produces 1e-15 — so
   * this is a bounded residual rather than a closed case. Deliberately no
   * epsilon: it would harden a case that cannot currently occur and add a
   * magic constant to a rule whose whole value is being easy to check.
   */
  const separation = (props: SeamarkProperties) => {
    const extents = seamarkSegments(props)
      .map(extentOf)
      .sort((a, b) => a.y0 - b.y0);
    let covered = extents[0].y1;
    let gap = 0;
    let gapTop = extents[0].y1;
    for (const e of extents.slice(1)) {
      // Assign on EVERY band, so the last (lowest) one wins.
      if (e.y0 - covered > 0) {
        gap = e.y0 - covered;
        gapTop = covered;
      }
      covered = Math.max(covered, e.y1);
    }
    const width = (group: Extent[]) =>
      group.length === 0
        ? 0
        : Math.max(...group.map((e) => e.x1)) - Math.min(...group.map((e) => e.x0));
    return {
      gap,
      topmarkWidth: width(extents.filter((e) => e.y1 <= gapTop)),
      bodyWidth: width(extents.filter((e) => e.y0 >= gapTop + gap)),
    };
  };

  // Every family that R1001 gives a topmark. The cardinal row is the shipped
  // precedent this generalizes and must stay green untouched.
  const TOPMARK_GLYPHS: { label: string; props: SeamarkProperties }[] = [
    {
      label: 'lateral pillar port (can)',
      props: { seamarkType: 'buoy_lateral', colour: 'red', category: 'port' },
    },
    {
      label: 'lateral pillar starboard (cone)',
      props: { seamarkType: 'buoy_lateral', colour: 'green', category: 'starboard' },
    },
    // #307: the tighter spar budget (gap 1, width contrast 2) sits right at
    // both S1/S2 thresholds — this is exactly the row that would catch a
    // regression squeezing the spar topmark any further.
    {
      label: 'lateral spar port (can)',
      props: { seamarkType: 'buoy_lateral', shape: 'spar', colour: 'red', category: 'port' },
    },
    {
      label: 'lateral spar starboard (cone)',
      props: { seamarkType: 'buoy_lateral', shape: 'spar', colour: 'green', category: 'starboard' },
    },
    { label: 'cardinal north', props: { seamarkType: 'buoy_cardinal', category: 'north' } },
    { label: 'cardinal west', props: { seamarkType: 'buoy_cardinal', category: 'west' } },
    { label: 'safe water', props: { seamarkType: 'buoy_safe_water', colour: 'red;white' } },
    { label: 'special purpose', props: { seamarkType: 'buoy_special_purpose', colour: 'yellow' } },
    {
      label: 'isolated danger',
      props: { seamarkType: 'buoy_isolated_danger', colour: 'black;red;black' },
    },
  ];

  it('S1: every topmark clears its body by at least one unit of empty canvas', () => {
    for (const { label, props } of TOPMARK_GLYPHS) {
      expect(
        separation(props).gap,
        `${label}: empty band between topmark and body`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('S2: no topmark is the same width as the body it sits on (>= 2 units of contrast)', () => {
    for (const { label, props } of TOPMARK_GLYPHS) {
      const { topmarkWidth, bodyWidth } = separation(props);
      // Without this the rule can pass DEGENERATELY: where no gap exists the
      // partition puts everything on one side, the empty side measures 0, and
      // |w - 0| clears the threshold while nothing was ever compared. That is
      // the shape #216 warns about — a row passing for a second reason — and
      // it is exactly what a same-width, touching topmark produces.
      expect(
        Math.min(topmarkWidth, bodyWidth),
        `${label}: topmark ${topmarkWidth} / body ${bodyWidth} — both groups must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        Math.abs(topmarkWidth - bodyWidth),
        `${label}: |topmark ${topmarkWidth} - body ${bodyWidth}|`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('S1/S2 also hold for the two spheres of an isolated-danger topmark', () => {
    // The pair must read as two spheres, not one lozenge: measured between the
    // two circles alone, ignoring the body below them.
    const spheres = seamarkSegments({
      seamarkType: 'buoy_isolated_danger',
      colour: 'black;red;black',
    })
      .filter((s): s is Extract<SeamarkSegment, { kind: 'circle' }> => s.kind === 'circle')
      .map(extentOf)
      .sort((a, b) => a.y0 - b.y0);
    expect(spheres).toHaveLength(2);
    expect(spheres[1].y0 - spheres[0].y1, 'gap between the two spheres').toBeGreaterThanOrEqual(1);
  });

  it('lights: a ray/star burst, major strictly larger than minor', () => {
    const minor = seamarkSegments({ seamarkType: 'light_minor' });
    const major = seamarkSegments({ seamarkType: 'light_major' });
    // 8 rays + 1 centre circle, all in the amber "light" colour.
    expect(minor).toHaveLength(9);
    expect(major).toHaveLength(9);
    const rayLength = (segs: SeamarkSegment[], i: number) => {
      const seg = segs[i] as Extract<SeamarkSegment, { kind: 'line' }>;
      const dx = seg.points[1].x - seg.points[0].x;
      const dy = seg.points[1].y - seg.points[0].y;
      return Math.sqrt(dx * dx + dy * dy);
    };
    expect(rayLength(minor, 0)).toBeCloseTo(6, 6);
    expect(rayLength(major, 0)).toBeCloseTo(10, 6);
    // First ray (i=0, angle 0) points due "east" from the 12,12 centre.
    expect(minor[0]).toEqual({
      kind: 'line',
      points: [
        { x: 12, y: 12 },
        { x: 18, y: 12 },
      ],
      stroke: '#e0a010',
      width: 1.5,
    });
    expect(minor[8]).toEqual({ kind: 'circle', cx: 12, cy: 12, r: 2, fill: '#e0a010' });
    expect(major[8]).toEqual({ kind: 'circle', cx: 12, cy: 12, r: 3, fill: '#e0a010' });
  });

  it('an unrecognized seamarkType (should never occur post-pipeline-filter) falls back to a neutral dot', () => {
    expect(seamarkSegments({ seamarkType: 'mooring' })).toEqual([
      { kind: 'circle', cx: 12, cy: 12, r: 5, fill: '#888888' },
    ]);
  });
});

// Recording canvas context — same technique as windBarbs.test.ts: captures
// only the path/draw op stream, proving the private drawSeamark replays
// seamarkSegments() verbatim.
function recordingContext(log: string[]): CanvasRenderingContext2D {
  const ctx = {
    clearRect: () => log.push('clear'),
    // #191 review: a no-op scale stub can't detect a wrong, missing, or
    // duplicated ctx.scale() call — exactly the transform that maps the
    // logical 24-unit coordinate space onto the bigger raster and protects
    // the R1001 cone/band geometry (#165) at the new resolution. Recording
    // it into the same op log makes drawSeamark's ordering (clear, scale,
    // THEN segments) and the exact factor part of what expectedOps() pins.
    scale: (x: number, y: number) => log.push(`scale:${x},${y}`),
    beginPath: () => log.push('begin'),
    rect: (x: number, y: number, w: number, h: number) => log.push(`R${x},${y},${w},${h}`),
    moveTo: (x: number, y: number) => log.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => log.push(`L${x},${y}`),
    arc: (cx: number, cy: number, r: number) => log.push(`A${cx},${cy},${r}`),
    closePath: () => log.push('close'),
    fill: () => log.push('fill'),
    stroke: () => log.push('stroke'),
    getImageData: () => ({}) as ImageData,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

// Hand-derived from drawSeamark's own constants (CANVAS_SIZE=64, IMAGE_SIZE=24
// — not imported/read back from the implementation, same rationale as the
// segment-geometry literals above): the ratio every drawSeamark() call must
// scale the canvas by, exactly once, right after clearRect and before any
// segment is replayed.
const SEAMARK_SCALE = 64 / 24;

function expectedOps(props: SeamarkProperties): string[] {
  const ops = ['clear', `scale:${SEAMARK_SCALE},${SEAMARK_SCALE}`];
  for (const seg of seamarkSegments(props)) {
    ops.push('begin');
    if (seg.kind === 'rect') {
      ops.push(`R${seg.x},${seg.y},${seg.w},${seg.h}`, 'fill');
    } else if (seg.kind === 'circle') {
      ops.push(`A${seg.cx},${seg.cy},${seg.r}`, 'fill');
    } else if (seg.kind === 'ring') {
      ops.push(`A${seg.cx},${seg.cy},${seg.r}`, 'stroke');
    } else if (seg.kind === 'polygon') {
      seg.points.forEach((p, i) => ops.push(`${i === 0 ? 'M' : 'L'}${p.x},${p.y}`));
      ops.push('close', 'fill');
    } else {
      seg.points.forEach((p, i) => ops.push(`${i === 0 ? 'M' : 'L'}${p.x},${p.y}`));
      ops.push('stroke');
    }
  }
  return ops;
}

describe('registerSeamarkImages', () => {
  it('registers one image per distinct seamarkImageId, replaying seamarkSegments onto the canvas', () => {
    const log: string[] = [];
    const ctx = recordingContext(log);
    // Captures every canvas the production code creates, so the registration
    // contract below (64x64 raster) is asserted on what registerSeamarkImages
    // actually did to the element, not a hardcoded assumption.
    const canvases: { width: number; height: number }[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerSeamarkImages
    >[0];

    const props: SeamarkProperties[] = [
      { seamarkType: 'buoy_lateral', colour: 'red', category: 'port' },
      // same image id — must draw only once
      { seamarkType: 'beacon_lateral', colour: 'red', category: 'port' },
      { seamarkType: 'light_major' },
      // #298: the ONLY family here that emits a `ring` segment. Without it the
      // `case 'ring'` arm added to drawSeamark — this change's only new canvas
      // code path — is never driven through the recorder, and expectedOps'
      // matching branch is never taken either.
      { seamarkType: 'buoy_isolated_danger', colour: 'black;red;black' },
    ];

    try {
      registerSeamarkImages(map, props);
    } finally {
      createSpy.mockRestore();
    }

    // 3 distinct ids (lateral-pillar-red-port, light-major, isolated) -> 3
    // draws, not 4: the beacon_lateral duplicate must still collapse.
    expect(addImage).toHaveBeenCalledTimes(3);
    expect(addImage.mock.calls[0][0]).toBe('seamark-lateral-pillar-red-port');
    expect(addImage.mock.calls[1][0]).toBe('seamark-light-major');
    expect(addImage.mock.calls[2][0]).toBe('seamark-isolated-black-red-black');

    // The ring arm actually ran: a stroked arc appears in the op stream, which
    // no other prop in this set can produce.
    expect(log.filter((op) => op.startsWith('A')).length).toBeGreaterThan(0);
    const arcIndexes = log.map((op, i) => (op.startsWith('A') ? i : -1)).filter((i) => i >= 0);
    expect(
      arcIndexes.some((i) => log[i + 1] === 'stroke'),
      `an arc followed by stroke (the ring path) in: ${log.join(' ')}`,
    ).toBe(true);

    // #191 registration contract: a 64x64 raster registered at pixelRatio 2
    // (dropping pixelRatio was literally #191's original bug, and would
    // otherwise pass every other assertion here silently).
    expect(canvases).toHaveLength(3);
    for (const canvas of canvases) {
      expect(canvas.width).toBe(64);
      expect(canvas.height).toBe(64);
    }
    expect(addImage.mock.calls[0][2]).toEqual({ pixelRatio: 2 });
    expect(addImage.mock.calls[1][2]).toEqual({ pixelRatio: 2 });
    expect(addImage.mock.calls[2][2]).toEqual({ pixelRatio: 2 });

    // Explicit, order-independent guard on top of the full-log check below:
    // exactly one scale call per drawn image, at the exact expected factor —
    // catches a wrong/missing/duplicated ctx.scale() even if some future
    // change to segment ops made the full-log diff harder to read.
    const scaleCalls = log.filter((op) => op.startsWith('scale:'));
    expect(scaleCalls).toEqual([
      `scale:${SEAMARK_SCALE},${SEAMARK_SCALE}`,
      `scale:${SEAMARK_SCALE},${SEAMARK_SCALE}`,
      `scale:${SEAMARK_SCALE},${SEAMARK_SCALE}`,
    ]);

    const expected = [...expectedOps(props[0]), ...expectedOps(props[2]), ...expectedOps(props[3])];
    expect(log).toEqual(expected);
  });

  it('skips an id the map already has registered', () => {
    const ctx = recordingContext([]);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = {
      hasImage: (id: string) => id === 'seamark-light-minor',
      addImage,
    } as unknown as Parameters<typeof registerSeamarkImages>[0];

    try {
      registerSeamarkImages(map, [{ seamarkType: 'light_minor' }, { seamarkType: 'light_major' }]);
    } finally {
      createSpy.mockRestore();
    }

    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addImage.mock.calls[0][0]).toBe('seamark-light-major');
  });

  // #353 PR2: registerSeamarkImages' third `scale` argument, which #484's
  // suite never drove (it always used the default). A NON-default scale must
  // change the registered raster size/pixelRatio, not just be accepted
  // syntactically — that's the actual mechanism a live size-slider change
  // depends on.
  it('at a non-default scale, registers the canvas at seamarkRasterConfig(scale)`s size/pixelRatio, not the default', () => {
    const ctx = recordingContext([]);
    // Same convention as the first test in this describe block: capture the
    // ACTUAL canvas element(s) production code creates and sizes, rather
    // than reading a width/height back off getImageData (recordingContext's
    // own stub returns `{}` there — it exists to record draw-call ops, not
    // to model a real ImageData).
    const canvases: { width: number; height: number }[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerSeamarkImages
    >[0];

    try {
      registerSeamarkImages(map, [{ seamarkType: 'light_major' }], 1.6);
    } finally {
      createSpy.mockRestore();
    }

    // Hand-derived from seamarkRasterConfig's own formula (pinned
    // independently above, not re-derived from the function under test):
    // canvasSize = round(64 * 1.6) = 102, pixelRatio = 2 * 1.6 = 3.2.
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addImage.mock.calls[0][2]).toEqual({ pixelRatio: 3.2 });
    expect(canvases).toHaveLength(1);
    expect(canvases[0].width).toBe(102);
    expect(canvases[0].height).toBe(102);
  });

  it('omitting scale reproduces the default (SEAMARK_SIZE_SCALE = 1) exactly', () => {
    const ctx = recordingContext([]);
    const canvases: { width: number; height: number }[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const canvas = { width: 0, height: 0, getContext: () => ctx };
        canvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerSeamarkImages
    >[0];

    try {
      registerSeamarkImages(map, [{ seamarkType: 'light_major' }]);
    } finally {
      createSpy.mockRestore();
    }

    expect(addImage.mock.calls[0][2]).toEqual({ pixelRatio: 2 });
    expect(canvases[0].width).toBe(64);
  });
});

describe('seamarkImageIds (#353 PR2: the id set DataLayers.tsx removeImage()s before a rescale)', () => {
  it('dedupes to one id per distinct seamarkImageId, in first-seen order', () => {
    const props: SeamarkProperties[] = [
      { seamarkType: 'buoy_lateral', colour: 'red', category: 'port' },
      { seamarkType: 'light_major' },
      // same id as the first — must collapse, not appear twice.
      { seamarkType: 'beacon_lateral', colour: 'red', category: 'port' },
    ];
    expect(seamarkImageIds(props)).toEqual([
      'seamark-lateral-pillar-red-port',
      'seamark-light-major',
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(seamarkImageIds([])).toEqual([]);
  });
});

// Expected values hand-derived from the design formula
//   rank = familyRank - (lit ? 1 : 0)
// with the #200 family ranks, which are read off IALA R1001 Ed 2.0 rather
// than off the implementation (repo tautology lesson). The R1001 chain is:
//   TIER 1, the self-contained warnings — one symbol, whole message:
//     §2.3.1 isolated danger — sits ON a danger with navigable water all
//       round; safe passing distance "cannot be specified".
//     §2.2.3 cardinal — "the safe side on which to pass a danger".
//   TIER 2, scarce marks that anchor a passage at planning scale (neither
//   carries danger information; culling only happens below z12):
//     §2.7.1.1 lighthouse — "a long or medium range light", "a significant
//       daymark"; §2.7 files it outside the six MBS types (§1.2).
//     §2.4.1.1 safe water — "channel entrance, port or estuary approach,
//       landfall, or best point of passage under bridges". §2.4.1 is explicit
//       that it "does not mark a danger", which is why it is not Tier 1.
//   TIER 3, the dense sequence marks:
//     §3.1 Table 16 "New Danger" + §3.2.2 + §2.5.2.4 — laterals are
//       danger-bearing and mark "the limit of safe navigation", so above
//       Tier 4; but §2.1.1 has them "denote the port and starboard sides of
//       channels" relative to a conventional direction of buoyage, i.e. one
//       datum on an edge described by many marks, so below Tiers 1-2.
//   TIER 4, neither danger-bearing nor scarce:
//     §2.7 minor lights — short-range, 107 in-area vs 6 lighthouses.
//     §2.5.1 special marks — "not generally intended to mark channels or
//       obstructions".
//     unknown — an unclassifiable mark must not displace a cardinal.
// giving isolatedDanger=0, cardinal=2, lightMajor=4, safeWater=6, lateral=8,
// lightMinor=10, specialPurpose=12, unknown=14.
describe('seamarkPriority (#144/#200 symbol-sort-key: lower = placed first = wins collisions)', () => {
  it('ranks each family at its hand-derived unlit value', () => {
    expect(seamarkPriority({ seamarkType: 'buoy_isolated_danger' })).toBe(0);
    expect(seamarkPriority({ seamarkType: 'buoy_cardinal' })).toBe(2);
    expect(seamarkPriority({ seamarkType: 'light_major' })).toBe(4);
    expect(seamarkPriority({ seamarkType: 'buoy_safe_water' })).toBe(6);
    expect(seamarkPriority({ seamarkType: 'buoy_lateral' })).toBe(8);
    expect(seamarkPriority({ seamarkType: 'light_minor' })).toBe(10);
    expect(seamarkPriority({ seamarkType: 'buoy_special_purpose' })).toBe(12);
    expect(seamarkPriority({ seamarkType: 'mooring' })).toBe(14);
  });

  it('lit-ness (any light field present) promotes by exactly 1 within the family', () => {
    expect(seamarkPriority({ seamarkType: 'buoy_cardinal', lightCharacter: 'Q' })).toBe(1);
    expect(
      seamarkPriority({
        seamarkType: 'buoy_lateral',
        lightCharacter: 'Fl',
        lightColour: 'red',
        lightPeriod: '4',
      }),
    ).toBe(7);
    // Each light field alone counts as lit — presence, not completeness.
    expect(seamarkPriority({ seamarkType: 'buoy_lateral', lightColour: 'green' })).toBe(7);
    expect(seamarkPriority({ seamarkType: 'buoy_lateral', lightPeriod: '6' })).toBe(7);
    // A lit isolated-danger mark outranks everything, including its unlit self.
    expect(seamarkPriority({ seamarkType: 'buoy_isolated_danger', lightCharacter: 'Fl(2)' })).toBe(
      -1,
    );
  });

  it('never lets a lateral (lit or not) outrank any cardinal', () => {
    const bestLateral = seamarkPriority({ seamarkType: 'buoy_lateral', lightCharacter: 'Fl' });
    const worstCardinal = seamarkPriority({ seamarkType: 'beacon_cardinal' });
    expect(bestLateral).toBeGreaterThan(worstCardinal); // 7 > 2
  });

  // The #200 invariant. R1001 §2.3.1/§2.2.3 make isolated-danger and cardinal
  // marks the two self-contained hazard warnings; nothing else may be placed
  // ahead of either, however conspicuous. The margin is exactly 1 by design —
  // worst warning (unlit cardinal, 2) vs best other (lit lightMajor, 3) — so
  // this also pins the lit promotion as strictly intra-family.
  it('never lets any other family outrank a cardinal or isolated-danger mark, even when lit', () => {
    const warnings = ['buoy_isolated_danger', 'beacon_isolated_danger', 'buoy_cardinal'];
    const others = [
      'light_major',
      'buoy_lateral',
      'buoy_safe_water',
      'light_minor',
      'buoy_special_purpose',
      'mooring',
    ];
    const worstWarning = Math.max(
      ...warnings.map((seamarkType) => seamarkPriority({ seamarkType })),
    );
    const bestOther = Math.min(
      ...others.map((seamarkType) =>
        seamarkPriority({ seamarkType, lightCharacter: 'Fl', lightColour: 'white' }),
      ),
    );
    expect(worstWarning).toBe(2); // unlit cardinal
    expect(bestOther).toBe(3); // lit light_major
    expect(bestOther).toBeGreaterThan(worstWarning);
  });

  // #200: the #144 ordering ranked by prominence, which put BOTH light
  // families ahead of every buoyage mark. R1001 §2.7 files lighthouses and
  // minor lights under "OTHER MARKS", outside the six MBS types, so a minor
  // light must never displace a mark that reports on navigable water — and no
  // light of either kind may displace a hazard warning.
  it('keeps minor lights below every mark that reports on navigable water', () => {
    const litMinor = seamarkPriority({ seamarkType: 'light_minor', lightCharacter: 'Fl' });
    for (const seamarkType of [
      'buoy_isolated_danger',
      'buoy_cardinal',
      'buoy_lateral',
      'buoy_safe_water',
    ]) {
      expect(litMinor).toBeGreaterThan(seamarkPriority({ seamarkType }));
    }
    // ...and a minor light never outranks a major one.
    expect(litMinor).toBeGreaterThan(seamarkPriority({ seamarkType: 'light_major' }));
  });

  // R1001 §2.5.1 — a special mark is "not generally intended to mark channels
  // or obstructions". #200 suggested ranking special marks ABOVE lateral
  // marks; §3.1 Table 16's New Danger column lists Lateral and not Special,
  // and that half of the disagreement stands.
  it('ranks special marks below lateral marks (R1001 Table 16 / §2.5.1)', () => {
    const worstLateral = seamarkPriority({ seamarkType: 'beacon_lateral' });
    expect(
      seamarkPriority({ seamarkType: 'buoy_special_purpose', lightColour: 'yellow' }),
    ).toBeGreaterThan(worstLateral);
  });

  // Tier 2: the two scarce, non-danger-bearing marks that anchor a passage at
  // planning scale both sit between the self-contained warnings and the dense
  // sequence marks. Granting the on-deck argument to lighthouses (§2.7.1.1
  // range) but not to fairway marks (§2.4.1.1 channel entrance / landfall /
  // best point of passage) would be an unprincipled asymmetry — raised in
  // review of #200 and accepted. Both must still lose to every cardinal.
  it('slots major lights and safe-water marks between the warnings and laterals', () => {
    const worstCardinal = seamarkPriority({ seamarkType: 'beacon_cardinal' });
    const bestLateral = seamarkPriority({ seamarkType: 'buoy_lateral', lightCharacter: 'Fl' });
    for (const seamarkType of ['light_major', 'buoy_safe_water']) {
      const lit = seamarkPriority({ seamarkType, lightCharacter: 'Oc' });
      expect(lit).toBeGreaterThan(worstCardinal);
      expect(seamarkPriority({ seamarkType })).toBeLessThan(bestLateral);
    }
  });

  it('classifies buoy_ and beacon_ variants identically (family, not carrier)', () => {
    expect(seamarkPriority({ seamarkType: 'beacon_lateral' })).toBe(
      seamarkPriority({ seamarkType: 'buoy_lateral' }),
    );
    expect(seamarkPriority({ seamarkType: 'beacon_isolated_danger' })).toBe(0);
  });
});

// #353 PR2: expected tiers hand-derived from the design grouping (BASE =
// every family R1001 §3.1 Table 16 lists as danger-bearing; STANDARD adds
// the scarce, no-danger-information families; ALL adds the dense,
// no-danger-information families) — see seamarkGlyphs.ts's own
// `seamarkDisplayTier` doc comment for the full citation chain.
describe('seamarkDisplayTier (#353 PR2: the display-category floor/ladder)', () => {
  it('BASE: isolatedDanger, cardinal and lateral are NEVER hidden by any selection', () => {
    for (const seamarkType of ['buoy_isolated_danger', 'beacon_cardinal', 'buoy_lateral']) {
      expect(seamarkDisplayTier({ seamarkType })).toBe(SEAMARK_DISPLAY_TIER_BASE);
    }
  });

  it('STANDARD: lightMajor and safeWater', () => {
    for (const seamarkType of ['light_major', 'buoy_safe_water']) {
      expect(seamarkDisplayTier({ seamarkType })).toBe(SEAMARK_DISPLAY_TIER_STANDARD);
    }
  });

  it('ALL: lightMinor, specialPurpose and unknown', () => {
    for (const seamarkType of ['light_minor', 'buoy_special_purpose', 'mooring']) {
      expect(seamarkDisplayTier({ seamarkType })).toBe(SEAMARK_DISPLAY_TIER_ALL);
    }
  });

  it('classifies buoy_ and beacon_ variants of the same family identically', () => {
    expect(seamarkDisplayTier({ seamarkType: 'beacon_lateral' })).toBe(
      seamarkDisplayTier({ seamarkType: 'buoy_lateral' }),
    );
  });

  it('is independent of lit-ness (unlike seamarkPriority, which promotes lit marks)', () => {
    expect(seamarkDisplayTier({ seamarkType: 'buoy_lateral', lightCharacter: 'Fl' })).toBe(
      seamarkDisplayTier({ seamarkType: 'buoy_lateral' }),
    );
  });
});
