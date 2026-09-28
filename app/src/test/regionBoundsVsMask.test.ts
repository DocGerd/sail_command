import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRegionManifest } from '../../vite.config';

// #1483 (#1253 item 5): mask.meta.json's routable bounds and the shipped
// PMTiles archives' bboxes are two INDEPENDENTLY maintained sources — the
// mask from pipeline/build_mask.py's own hardcoded bbox, the archives from
// pipeline/extract_basemap.sh's region cuts — with no shared constant and,
// until now, no cross-check. A mask widened without a matching region
// extract (or vice versa) would silently route over water the shipped
// basemap can never download tiles for.
//
// READ-ONLY: reads the real committed app/public/data/ assets and never
// writes them (CLAUDE.md's generated-asset rule) — a real coverage gap
// this test finds is a `pipeline/**` fix (mask.py's bounds or
// extract_basemap.sh's region cuts), never something this test could patch
// by adjusting either side.
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = resolve(APP_DIR, 'public/data');
const CORE_FILE = 'basemap.pmtiles.png';

interface MaskMetaBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

function maskBounds(): MaskMetaBounds {
  const raw: unknown = JSON.parse(readFileSync(resolve(DATA_DIR, 'mask.meta.json'), 'utf-8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('west' in raw) ||
    !('south' in raw) ||
    !('east' in raw) ||
    !('north' in raw)
  ) {
    throw new Error('regionBoundsVsMask: mask.meta.json is missing a west/south/east/north field');
  }
  return raw as MaskMetaBounds;
}

/** True iff the union of every archive's bbox reaches or exceeds every edge of `mask` —
 * outer-envelope coverage, not a claim that the archives tile the mask with no internal gap. */
function coversBounds(
  archives: readonly { readonly bbox: readonly [number, number, number, number] }[],
  mask: MaskMetaBounds,
): boolean {
  const unionMinLon = Math.min(...archives.map((a) => a.bbox[0]));
  const unionMinLat = Math.min(...archives.map((a) => a.bbox[1]));
  const unionMaxLon = Math.max(...archives.map((a) => a.bbox[2]));
  const unionMaxLat = Math.max(...archives.map((a) => a.bbox[3]));
  return (
    unionMinLon <= mask.west &&
    unionMinLat <= mask.south &&
    unionMaxLon >= mask.east &&
    unionMaxLat >= mask.north
  );
}

describe('#1483 coversBounds', () => {
  // Positive control (synthetic, not the real assets): proves the function
  // can actually fail — a mutation collapsing it to `return true`
  // unconditionally reds this row.
  it('is FALSE when the archive union does not reach every edge of the mask', () => {
    const archives = [{ bbox: [9.4, 54.3, 10.5, 55.0] as const }];
    const mask: MaskMetaBounds = { west: 9.4, south: 54.3, east: 11.6, north: 55.6 };
    expect(coversBounds(archives, mask)).toBe(false);
  });

  it('is TRUE once a second archive extends the union to cover the remaining edges', () => {
    const archives = [
      { bbox: [9.4, 54.3, 10.5, 55.0] as const },
      { bbox: [10.5, 54.3, 11.6, 55.6] as const },
    ];
    const mask: MaskMetaBounds = { west: 9.4, south: 54.3, east: 11.6, north: 55.6 };
    expect(coversBounds(archives, mask)).toBe(true);
  });
});

describe('#1483 region PMTiles bboxes vs mask.meta.json bounds', () => {
  it('the union of the core + every region archive bbox covers every edge of the real mask bounds', () => {
    const manifest = buildRegionManifest(DATA_DIR, CORE_FILE);
    const archives = [manifest.core, ...manifest.regions];
    expect(archives.length).toBeGreaterThan(1); // non-vacuity: core plus at least one region were read

    expect(coversBounds(archives, maskBounds())).toBe(true);
  });

  // Names the two archives item 5's own wording calls out, so a rename or a
  // dropped region silently narrowing the union above is also caught here.
  it('region-north and region-east are both present in the manifest', () => {
    const manifest = buildRegionManifest(DATA_DIR, CORE_FILE);
    expect(manifest.regions.map((r) => r.id).sort()).toEqual(['east', 'north']);
  });
});
