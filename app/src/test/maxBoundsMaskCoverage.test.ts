import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { MaskMeta } from '../types';

// #295: MapView.tsx's MAX_BOUNDS literal and mask.meta.json are coupled by
// hand only. If the camera bounds stop enclosing the data domain, harbours and
// via points near the edge become un-pannable with nothing going red (a
// revert to the pre-#295 [11.5, 55.55] corner left every other guard green).
// Reads both files and fails closed if the literal stops parsing, mirroring
// windLatticeMaskCoverage.test.ts. DATA_AREA is pinned to mask.meta.json
// separately (gpx.parse.test.ts), so it is covered transitively.

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_VIEW_PATH = resolve(HERE, '../components/MapView.tsx');
const MASK_META_PATH = resolve(HERE, '../../public/data/mask.meta.json');

/** Minimum clearance on every side, in degrees (the shipped margins are
 * 0.25 deg N/S and 0.5 deg E/W). */
const MIN_MARGIN_DEG = 0.2;

function readMaxBounds(source: string) {
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const re = new RegExp(
    `const MAX_BOUNDS: LngLatBoundsLike = \\[\\s*\\[${num}, ${num}\\],\\s*\\[${num}, ${num}\\],?\\s*\\];`,
  );
  const m = source.match(re);
  if (!m) {
    throw new Error(
      "MapView.tsx's MAX_BOUNDS no longer matches '[[west, south], [east, north]]' — " +
        'update this regex rather than let the guard pass on a stale match (fail-closed).',
    );
  }
  const [west, south, east, north] = m.slice(1, 5).map(Number) as [number, number, number, number];
  return { west, south, east, north };
}

describe('#295: MAX_BOUNDS encloses the mask domain with margin', () => {
  it('MAX_BOUNDS still parses (fail-closed control)', () => {
    expect(() => readMaxBounds(readFileSync(MAP_VIEW_PATH, 'utf8'))).not.toThrow();
  });

  it('every side clears mask.meta.json by at least MIN_MARGIN_DEG', () => {
    const b = readMaxBounds(readFileSync(MAP_VIEW_PATH, 'utf8'));
    const meta = JSON.parse(readFileSync(MASK_META_PATH, 'utf8')) as MaskMeta;
    const margins = {
      west: meta.west - b.west,
      south: meta.south - b.south,
      east: b.east - meta.east,
      north: b.north - meta.north,
    };
    for (const [side, margin] of Object.entries(margins)) {
      expect(margin, `${side} margin ${margin.toFixed(3)} deg`).toBeGreaterThanOrEqual(
        MIN_MARGIN_DEG - 1e-9,
      );
    }
  });
});
