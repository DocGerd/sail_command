import { describe, expect, it, vi } from 'vitest';
import {
  classifySeamark,
  registerSeamarkImages,
  seamarkImageId,
  seamarkPriority,
  seamarkSegments,
  type SeamarkSegment,
} from './seamarkGlyphs';
import type { SeamarkProperties } from '../types';

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
    expect(seamarkImageId({ seamarkType: 'buoy_lateral', shape: 'pillar', colour: 'red' })).toBe(
      'seamark-lateral-pillar-red',
    );
    expect(seamarkImageId({ seamarkType: 'beacon_lateral', shape: 'can', colour: 'green' })).toBe(
      'seamark-lateral-can-green',
    );
    // Different seamarkType, same shape/colour -> same image id (a buoy and a
    // beacon lateral render identically).
    expect(seamarkImageId({ seamarkType: 'buoy_lateral', colour: 'red' })).toBe(
      seamarkImageId({ seamarkType: 'beacon_lateral', colour: 'red' }),
    );
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

  it('lateral pillar (default/unknown shape): body rect + ball topmark, both the primary colour', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_lateral', colour: 'red' });
    expect(segs).toEqual([
      { kind: 'rect', x: 9, y: 10, w: 6, h: 11, fill: 'red' },
      { kind: 'circle', cx: 12, cy: 8, r: 3, fill: 'red' },
    ]);
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

  it('every cardinal segment stays on-canvas 0..24 (guards the #2 top-cone clip)', () => {
    for (const cat of ['north', 'south', 'east', 'west']) {
      const segs = seamarkSegments({ seamarkType: 'buoy_cardinal', category: cat });
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

  it('safe-water: vertical colour bands + a sphere topmark', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_safe_water', colour: 'red;white' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 9, w: 5, h: 12, fill: 'red' },
      { kind: 'rect', x: 12, y: 9, w: 5, h: 12, fill: 'white' },
      { kind: 'circle', cx: 12, cy: 6, r: 3, fill: '#1a1a1a' },
    ]);
  });

  it('special-purpose with no colour tag: single yellow-fallback band + X topmark', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_special_purpose' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 9, w: 10, h: 12, fill: 'yellow' },
      {
        kind: 'line',
        points: [
          { x: 9, y: 4 },
          { x: 15, y: 10 },
        ],
        stroke: '#1a1a1a',
        width: 1.5,
      },
      {
        kind: 'line',
        points: [
          { x: 15, y: 4 },
          { x: 9, y: 10 },
        ],
        stroke: '#1a1a1a',
        width: 1.5,
      },
    ]);
  });

  it('isolated-danger: horizontal colour bands + two sphere topmarks', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_isolated_danger', colour: 'black;red' });
    expect(segs).toEqual([
      { kind: 'rect', x: 7, y: 10, w: 10, h: 5.5, fill: 'black' },
      { kind: 'rect', x: 7, y: 15.5, w: 10, h: 5.5, fill: 'red' },
      { kind: 'circle', cx: 12, cy: 7, r: 2.5, fill: '#1a1a1a' },
      { kind: 'circle', cx: 12, cy: 2.5, r: 2.5, fill: '#1a1a1a' },
    ]);
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

function expectedOps(props: SeamarkProperties): string[] {
  const ops = ['clear'];
  for (const seg of seamarkSegments(props)) {
    ops.push('begin');
    if (seg.kind === 'rect') {
      ops.push(`R${seg.x},${seg.y},${seg.w},${seg.h}`, 'fill');
    } else if (seg.kind === 'circle') {
      ops.push(`A${seg.cx},${seg.cy},${seg.r}`, 'fill');
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
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerSeamarkImages
    >[0];

    const props: SeamarkProperties[] = [
      { seamarkType: 'buoy_lateral', colour: 'red' },
      { seamarkType: 'beacon_lateral', colour: 'red' }, // same image id — must draw only once
      { seamarkType: 'light_major' },
    ];

    try {
      registerSeamarkImages(map, props);
    } finally {
      createSpy.mockRestore();
    }

    // 2 distinct ids (lateral-pillar-red, light-major) -> 2 draws, not 3.
    expect(addImage).toHaveBeenCalledTimes(2);
    expect(addImage.mock.calls[0][0]).toBe('seamark-lateral-pillar-red');
    expect(addImage.mock.calls[1][0]).toBe('seamark-light-major');

    const expected = [...expectedOps(props[0]), ...expectedOps(props[2])];
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
});

// #144: expected values hand-derived from the design formula
// rank = familyRank - (lit ? 1 : 0) with family ranks
// lightMajor=0, lightMinor=2, isolatedDanger=4, cardinal=6, safeWater=8,
// lateral=10, specialPurpose=12, unknown=14 — NOT read back from the
// implementation (repo tautology lesson).
describe('seamarkPriority (#144 symbol-sort-key: lower = placed first = wins collisions)', () => {
  it('ranks each family at its hand-derived unlit value', () => {
    expect(seamarkPriority({ seamarkType: 'light_major' })).toBe(0);
    expect(seamarkPriority({ seamarkType: 'light_minor' })).toBe(2);
    expect(seamarkPriority({ seamarkType: 'buoy_isolated_danger' })).toBe(4);
    expect(seamarkPriority({ seamarkType: 'buoy_cardinal' })).toBe(6);
    expect(seamarkPriority({ seamarkType: 'buoy_safe_water' })).toBe(8);
    expect(seamarkPriority({ seamarkType: 'buoy_lateral' })).toBe(10);
    expect(seamarkPriority({ seamarkType: 'buoy_special_purpose' })).toBe(12);
    expect(seamarkPriority({ seamarkType: 'mooring' })).toBe(14);
  });

  it('lit-ness (any light field present) promotes by exactly 1 within the family', () => {
    expect(seamarkPriority({ seamarkType: 'buoy_cardinal', lightCharacter: 'Q' })).toBe(5);
    expect(
      seamarkPriority({
        seamarkType: 'buoy_lateral',
        lightCharacter: 'Fl',
        lightColour: 'red',
        lightPeriod: '4',
      }),
    ).toBe(9);
    // Each light field alone counts as lit — presence, not completeness.
    expect(seamarkPriority({ seamarkType: 'buoy_lateral', lightColour: 'green' })).toBe(9);
    expect(seamarkPriority({ seamarkType: 'buoy_lateral', lightPeriod: '6' })).toBe(9);
    // A lit light_major outranks everything, including its unlit self.
    expect(seamarkPriority({ seamarkType: 'light_major', lightCharacter: 'Oc' })).toBe(-1);
  });

  it('never lets a lateral (lit or not) outrank any cardinal', () => {
    const bestLateral = seamarkPriority({ seamarkType: 'buoy_lateral', lightCharacter: 'Fl' });
    const worstCardinal = seamarkPriority({ seamarkType: 'beacon_cardinal' });
    expect(bestLateral).toBeGreaterThan(worstCardinal); // 9 > 6
  });

  it('classifies buoy_ and beacon_ variants identically (family, not carrier)', () => {
    expect(seamarkPriority({ seamarkType: 'beacon_lateral' })).toBe(
      seamarkPriority({ seamarkType: 'buoy_lateral' }),
    );
    expect(seamarkPriority({ seamarkType: 'beacon_isolated_danger' })).toBe(4);
  });
});
