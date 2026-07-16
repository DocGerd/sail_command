import { describe, expect, it, vi } from 'vitest';
import { barbSegments, registerBarbImages, type BarbSegment } from './windBarbs';

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
});

// Recording canvas context: captures only the path/draw op stream (ignores
// style sets), so we can prove the private drawBarb replays barbSegments
// verbatim — i.e. the canvas registration output is unchanged by the
// extraction.
function recordingContext(log: string[]): CanvasRenderingContext2D {
  const ctx = {
    clearRect: () => log.push('clear'),
    beginPath: () => log.push('begin'),
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
    lineCap: '',
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

/** Expected op stream for one barb, derived straight from barbSegments. */
function expectedOps(speedKn: number): string[] {
  const ops = ['clear'];
  for (const seg of barbSegments(speedKn)) {
    ops.push('begin');
    if (seg.kind === 'circle') {
      ops.push(`A${seg.cx},${seg.cy},${seg.r}`, 'stroke');
      continue;
    }
    seg.points.forEach((p, i) => ops.push(`${i === 0 ? 'M' : 'L'}${p.x},${p.y}`));
    if (seg.kind === 'fill') ops.push('close', 'fill');
    else ops.push('stroke');
  }
  return ops;
}

describe('registerBarbImages replays barbSegments onto the canvas', () => {
  it('draws the exact op stream barbSegments implies for every 5 kn bucket 0..50', () => {
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
      typeof registerBarbImages
    >[0];

    try {
      registerBarbImages(map);
    } finally {
      createSpy.mockRestore();
    }

    const expected: string[] = [];
    for (let speed = 0; speed <= 50; speed += 5) expected.push(...expectedOps(speed));
    expect(log).toEqual(expected);
    // 11 buckets registered (barb-0 .. barb-50).
    expect(addImage).toHaveBeenCalledTimes(11);
  });
});
