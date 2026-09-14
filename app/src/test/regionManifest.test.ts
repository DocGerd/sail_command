import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCoreWithinPrecacheCap,
  buildRegionManifest,
  pmtilesHeaderBbox,
  type RegionManifestEntry,
} from '../../vite.config';

// #1164: exercises the build-time region-manifest plugin's pure logic
// (app/vite.config.ts's buildRegionManifest/pmtilesHeaderBbox/
// assertCoreWithinPrecacheCap) against real temp-directory fixtures rather
// than the real committed basemap archive — a hand-built, deterministic
// PMTiles header lets every test control the bbox/spec-version/length it
// asserts on, instead of coupling to a production asset that can change
// size or extent independently of this test (see tsconfig.test.json for
// why this file needs node:fs/imports vite.config.ts).

const CORE_FILE = 'basemap.pmtiles.png';
const HEADER_BYTES = 127;

/** Builds a minimal-but-valid 127-byte PMTiles v3 header with the given bbox — every OTHER
 * field is zeroed, which bytesToHeader accepts (it validates only the spec-version byte). */
function syntheticHeader(bbox: [number, number, number, number], specVersion = 3): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.writeUInt8(specVersion, 7);
  buf.writeUInt8(1, 96); // clustered
  buf.writeUInt8(1, 99); // tileType
  buf.writeUInt8(0, 100); // minZoom
  buf.writeUInt8(14, 101); // maxZoom
  const [minLon, minLat, maxLon, maxLat] = bbox;
  buf.writeInt32LE(Math.round(minLon * 1e7), 102);
  buf.writeInt32LE(Math.round(minLat * 1e7), 106);
  buf.writeInt32LE(Math.round(maxLon * 1e7), 110);
  buf.writeInt32LE(Math.round(maxLat * 1e7), 114);
  return buf;
}

const dirs: string[] = [];
function makeTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc-region-manifest-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('pmtilesHeaderBbox', () => {
  it('round-trips an arbitrary bbox through the real header layout', () => {
    const dir = makeTempDataDir();
    const path = join(dir, CORE_FILE);
    const bbox: [number, number, number, number] = [-5.1234567, 40.0000001, 179.9999999, 89.5];
    writeFileSync(path, syntheticHeader(bbox));
    const parsed = pmtilesHeaderBbox(path);
    for (let i = 0; i < 4; i++) expect(parsed[i]).toBeCloseTo(bbox[i], 6);
  });

  it('fails closed on a file shorter than the 127-byte header', () => {
    const dir = makeTempDataDir();
    const path = join(dir, CORE_FILE);
    writeFileSync(path, syntheticHeader([0, 0, 1, 1]).subarray(0, 50));
    expect(() => pmtilesHeaderBbox(path)).toThrow(/too short/);
  });

  it("fails closed on an unsupported spec version (bytesToHeader's own guard)", () => {
    const dir = makeTempDataDir();
    const path = join(dir, CORE_FILE);
    writeFileSync(path, syntheticHeader([0, 0, 1, 1], 99));
    expect(() => pmtilesHeaderBbox(path)).toThrow(/spec version/);
  });
});

describe('buildRegionManifest', () => {
  it('builds a core-only manifest when no region archives exist', () => {
    const dir = makeTempDataDir();
    const bbox: [number, number, number, number] = [9.4, 54.3, 11, 55.3];
    writeFileSync(join(dir, CORE_FILE), syntheticHeader(bbox));
    const manifest = buildRegionManifest(dir, CORE_FILE);
    expect(manifest.regions).toEqual([]);
    expect(manifest.core.id).toBe('core');
    expect(manifest.core.path).toBe('data/basemap.pmtiles.png');
    expect(manifest.core.bytes).toBe(HEADER_BYTES);
    for (let i = 0; i < 4; i++) expect(manifest.core.bbox[i]).toBeCloseTo(bbox[i], 6);
  });

  it('includes a synthetic second region, distinct from the core entry', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, CORE_FILE), syntheticHeader([9.4, 54.3, 11, 55.3]));
    const regionBbox: [number, number, number, number] = [9.0, 54.0, 9.5, 54.5];
    writeFileSync(join(dir, 'region-foo.pmtiles.png'), syntheticHeader(regionBbox));
    const manifest = buildRegionManifest(dir, CORE_FILE);
    expect(manifest.regions).toHaveLength(1);
    const region = manifest.regions[0] as RegionManifestEntry;
    expect(region.id).toBe('foo');
    expect(region.path).toBe('data/region-foo.pmtiles.png');
    for (let i = 0; i < 4; i++) expect(region.bbox[i]).toBeCloseTo(regionBbox[i], 6);
    // The core entry must stay independent of the region's presence/bbox.
    expect(manifest.core.id).toBe('core');
    const coreBbox: [number, number, number, number] = [9.4, 54.3, 11, 55.3];
    for (let i = 0; i < 4; i++) expect(manifest.core.bbox[i]).toBeCloseTo(coreBbox[i], 6);
  });

  it('sorts multiple regions deterministically by id', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, CORE_FILE), syntheticHeader([0, 0, 1, 1]));
    writeFileSync(join(dir, 'region-zzz.pmtiles.png'), syntheticHeader([0, 0, 1, 1]));
    writeFileSync(join(dir, 'region-aaa.pmtiles.png'), syntheticHeader([0, 0, 1, 1]));
    const manifest = buildRegionManifest(dir, CORE_FILE);
    expect(manifest.regions.map((r) => r.id)).toEqual(['aaa', 'zzz']);
  });

  it('fails closed when no core archive is present', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, 'region-foo.pmtiles.png'), syntheticHeader([0, 0, 1, 1]));
    expect(() => buildRegionManifest(dir, CORE_FILE)).toThrow(/no core archive/);
  });

  it('fails closed on a *.pmtiles*-shaped file matching neither naming convention', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, CORE_FILE), syntheticHeader([0, 0, 1, 1]));
    writeFileSync(join(dir, 'weird-name.pmtiles.png'), syntheticHeader([0, 0, 1, 1]));
    expect(() => buildRegionManifest(dir, CORE_FILE)).toThrow(/naming convention/);
  });

  it('fails closed when a region archive has an invalid header', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, CORE_FILE), syntheticHeader([0, 0, 1, 1]));
    writeFileSync(join(dir, 'region-bad.pmtiles.png'), Buffer.alloc(10));
    expect(() => buildRegionManifest(dir, CORE_FILE)).toThrow(/too short/);
  });

  it('ignores files that are not pmtiles-archive-shaped', () => {
    const dir = makeTempDataDir();
    writeFileSync(join(dir, CORE_FILE), syntheticHeader([0, 0, 1, 1]));
    writeFileSync(join(dir, 'README.txt'), 'not an archive');
    const manifest = buildRegionManifest(dir, CORE_FILE);
    expect(manifest.regions).toEqual([]);
  });
});

describe('assertCoreWithinPrecacheCap', () => {
  const entry = (bytes: number): RegionManifestEntry => ({
    id: 'core',
    path: 'data/basemap.pmtiles.png',
    bytes,
    bbox: [0, 0, 1, 1],
  });

  it('throws when the core archive exceeds the cap', () => {
    expect(() => assertCoreWithinPrecacheCap(entry(101), 100)).toThrow(/over the/);
  });

  it('does not throw at or under the cap', () => {
    expect(() => assertCoreWithinPrecacheCap(entry(100), 100)).not.toThrow();
    expect(() => assertCoreWithinPrecacheCap(entry(99), 100)).not.toThrow();
  });
});
