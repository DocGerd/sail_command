import { describe, expect, it, vi } from 'vitest';
import {
  classifySeamark,
  registerSeamarkImages,
  seamarkImageId,
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

  it('cardinal north: both topmark cones point up (standard IALA-A orientation)', () => {
    const segs = seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'north' });
    expect(segs).toEqual([
      { kind: 'rect', x: 10, y: 11, w: 4, h: 10, fill: '#1a1a1a' },
      {
        kind: 'polygon',
        points: [
          { x: 12, y: 3 },
          { x: 16, y: 8 },
          { x: 8, y: 8 },
        ],
        fill: '#1a1a1a',
      },
      {
        kind: 'polygon',
        points: [
          { x: 12, y: 9 },
          { x: 16, y: 14 },
          { x: 8, y: 14 },
        ],
        fill: '#1a1a1a',
      },
    ]);
  });

  it('cardinal west: point-to-point (top cone down, bottom cone up)', () => {
    const segs = seamarkSegments({ seamarkType: 'beacon_cardinal', category: 'west' });
    expect(segs).toEqual([
      { kind: 'rect', x: 10, y: 11, w: 4, h: 10, fill: '#1a1a1a' },
      {
        kind: 'polygon',
        points: [
          { x: 12, y: 3 },
          { x: 16, y: -2 },
          { x: 8, y: -2 },
        ],
        fill: '#1a1a1a',
      },
      {
        kind: 'polygon',
        points: [
          { x: 12, y: 9 },
          { x: 16, y: 14 },
          { x: 8, y: 14 },
        ],
        fill: '#1a1a1a',
      },
    ]);
  });

  it('cardinal with an untagged category falls back to the north orientation', () => {
    expect(seamarkSegments({ seamarkType: 'buoy_cardinal' })).toEqual(
      seamarkSegments({ seamarkType: 'buoy_cardinal', category: 'north' }),
    );
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
