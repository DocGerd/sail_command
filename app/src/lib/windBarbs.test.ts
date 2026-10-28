import { describe, expect, it, vi } from 'vitest';
import { barbSegments, registerBarbImages, type BarbSegment } from './windBarbs';
import { HALO_COLOR, INK_COLOR } from './mapColors';

describe('barbSegments (WMO geometry, 5 kn buckets)', () => {
  it('calm (< 2.5 kn) is a single station circle, no shaft', () => {
    expect(barbSegments(0)).toEqual([{ kind: 'circle', cx: 16, cy: 28, r: 4 }]);
    expect(barbSegments(2)).toEqual([{ kind: 'circle', cx: 16, cy: 28, r: 4 }]);
  });

  it('5 kn is a shaft + one half barb', () => {
    const segs = barbSegments(5);
    expect(segs.map((s) => s.kind)).toEqual(['stroke', 'stroke']);
    // shaft: station (16,28) up to tip (16,4)
    expect(segs[0]).toEqual({
      kind: 'stroke',
      points: [
        { x: 16, y: 28 },
        { x: 16, y: 4 },
      ],
    });
  });

  it('10 kn is a shaft + one full barb (no half)', () => {
    expect(barbSegments(10).map((s) => s.kind)).toEqual(['stroke', 'stroke']);
    expect(barbSegments(15).map((s) => s.kind)).toEqual(['stroke', 'stroke', 'stroke']); // full + half
  });

  it('50 kn is a shaft + one filled pennant', () => {
    const segs = barbSegments(50);
    expect(segs.map((s) => s.kind)).toEqual(['stroke', 'fill']);
    const pennant = segs[1] as Extract<BarbSegment, { kind: 'fill' }>;
    expect(pennant.points).toHaveLength(3); // triangle
  });

  it('65 kn decomposes into pennant(50) + full(10) + half(5)', () => {
    // shaft, pennant, full barb, half barb
    expect(barbSegments(65).map((s) => s.kind)).toEqual(['stroke', 'fill', 'stroke', 'stroke']);
  });

  it('rounds to the nearest 5 kn bucket (barb count is speed-driven)', () => {
    expect(barbSegments(12).map((s) => s.kind)).toEqual(barbSegments(10).map((s) => s.kind));
    expect(barbSegments(13).map((s) => s.kind)).toEqual(barbSegments(15).map((s) => s.kind));
  });

  it('pins literal feathered-barb coordinates (regression anchor, hardcoded from the WMO math)', () => {
    // Numbers computed by hand from the pre-extraction constants (CENTER_X=16,
    // TIP_Y=4, FEATHER_LENGTH=9, FEATHER_SPACING=6), NOT derived from
    // barbSegments — a wrong length/angle mutation must fail here.
    const s15 = barbSegments(15); // shaft, full barb, half barb
    const full = s15[1] as Extract<BarbSegment, { kind: 'stroke' }>;
    const half = s15[2] as Extract<BarbSegment, { kind: 'stroke' }>;
    // full barb: (16,4) -> (25, 0.4)   [x = 16+9, y = 4 - 6*0.6]
    expect(full.points[0]).toEqual({ x: 16, y: 4 });
    expect(full.points[1].x).toBe(25);
    expect(full.points[1].y).toBeCloseTo(0.4, 6);
    // half barb: (16,10) -> (20.5, 8.2)  [x = 16+9/2, y = 10 - 6*0.3]
    expect(half.points[0]).toEqual({ x: 16, y: 10 });
    expect(half.points[1].x).toBe(20.5);
    expect(half.points[1].y).toBeCloseTo(8.2, 6);
    // 50 kn pennant triangle: (16,4), (25,7), (16,10)
    const pennant = barbSegments(50)[1] as Extract<BarbSegment, { kind: 'fill' }>;
    expect(pennant.points).toEqual([
      { x: 16, y: 4 },
      { x: 25, y: 7 },
      { x: 16, y: 10 },
    ]);
  });
});

// Recording canvas context: captures the path/draw op stream, plus the stroke
// style and width at each stroke/fill, so the halo pass is pinned separately
// from the ink pass.
function recordingContext(log: string[]): CanvasRenderingContext2D {
  const ctx = {
    clearRect: (x: number, y: number, w: number, h: number) => log.push(`clear${x},${y},${w},${h}`),
    beginPath: () => log.push('begin'),
    moveTo: (x: number, y: number) => log.push(`M${x},${y}`),
    lineTo: (x: number, y: number) => log.push(`L${x},${y}`),
    arc: (cx: number, cy: number, r: number) => log.push(`A${cx},${cy},${r}`),
    closePath: () => log.push('close'),
    fill: () => log.push(`fill:${ctx.fillStyle}`),
    stroke: () => log.push(`stroke:${ctx.strokeStyle}@${ctx.lineWidth}`),
    getImageData: () => ({}) as ImageData,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

// #1854: the glyph box sits 2 px inside a 36 px canvas.
const PAD = 2;

function pathOps(seg: BarbSegment): string[] {
  const ops = ['begin'];
  if (seg.kind === 'circle') return [...ops, `A${seg.cx + PAD},${seg.cy + PAD},${seg.r}`];
  seg.points.forEach((p, i) => ops.push(`${i === 0 ? 'M' : 'L'}${p.x + PAD},${p.y + PAD}`));
  if (seg.kind === 'fill') ops.push('close');
  return ops;
}

/** Expected op stream for one barb: a halo pass over every segment, then the ink pass. */
function expectedOps(speedKn: number): string[] {
  const segs = barbSegments(speedKn);
  const ops = ['clear0,0,36,36'];
  for (const seg of segs) ops.push(...pathOps(seg), `stroke:${HALO_COLOR}@3.5`);
  for (const seg of segs)
    ops.push(
      ...pathOps(seg),
      seg.kind === 'fill' ? `fill:${INK_COLOR}` : `stroke:${INK_COLOR}@1.5`,
    );
  return ops;
}

describe('registerBarbImages replays barbSegments onto the canvas', () => {
  function register() {
    const log: string[] = [];
    const ctx = recordingContext(log);
    const canvases: { width: number; height: number }[] = [];
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') {
        const c = { width: 0, height: 0, getContext: () => ctx };
        canvases.push(c);
        return c as unknown as HTMLCanvasElement;
      }
      return document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElement;
    });
    const addImage = vi.fn();
    const getImageData = vi.spyOn(ctx, 'getImageData');
    const map = { hasImage: () => false, addImage } as unknown as Parameters<
      typeof registerBarbImages
    >[0];
    try {
      registerBarbImages(map);
    } finally {
      createSpy.mockRestore();
    }
    return { log, addImage, canvases, getImageData };
  }

  it('draws a halo pass, then the ink pass, for every 5 kn bucket 0..50', () => {
    const { log, addImage } = register();
    const expected: string[] = [];
    for (let speed = 0; speed <= 50; speed += 5) expected.push(...expectedOps(speed));
    expect(log).toEqual(expected);
    // 11 buckets registered (barb-0 .. barb-50).
    expect(addImage).toHaveBeenCalledTimes(11);
  });

  it('pads the canvas so the halo is not clipped at the glyph box edge', () => {
    const { canvases, getImageData } = register();
    expect(canvases.every((c) => c.width === 36 && c.height === 36)).toBe(true);
    expect(getImageData).toHaveBeenCalledWith(0, 0, 36, 36);
  });
});
