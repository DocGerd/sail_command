import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requiredRegions, type RegionBbox } from '../lib/basemapRegions';
import { AIS_CORRIDOR_HALF_WIDTH_NM, routeCorridorBoxes } from '../lib/routeCorridor';
import { selectTileArchive } from '../services/compositeBasemapProtocol';
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
 * field is zeroed, which bytesToHeader accepts (it validates only the spec-version byte).
 * Bytes 0-1 carry the real "PM" magic (see pmtilesHeaderBbox's own comment) so these fixtures
 * pass that check and exercise whichever OTHER condition each test targets. */
function syntheticHeader(bbox: [number, number, number, number], specVersion = 3): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.write('PM', 0, 'ascii');
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

  // PR #1220 review: an all-0x41 buffer with byte[7]=0 (a plausible spec-version byte) has no
  // PMTiles magic at bytes 0-1, and bytesToHeader alone would have parsed it to a bogus bbox —
  // exactly the reviewer's reproduction. The magic check must reject it before bytesToHeader
  // ever runs.
  it('fails closed on a non-PMTiles file with a plausible version byte (reviewer repro)', () => {
    const dir = makeTempDataDir();
    const path = join(dir, CORE_FILE);
    const bogus = Buffer.alloc(200, 0x41);
    bogus.writeUInt8(0, 7);
    writeFileSync(path, bogus);
    expect(() => pmtilesHeaderBbox(path)).toThrow(/bad magic number/);
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

// #295: the committed region archives (shape a2, pipeline/README.md), read
// from the real app/public/data — not synthetic headers.
describe('#295 committed region archives', () => {
  const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../public/data');
  const COVERAGE: RegionBbox = [9.4, 54.3, 11.6, 55.6];
  const manifest = buildRegionManifest(DATA_DIR, CORE_FILE);

  function zoomRange(path: string): [number, number] {
    const header = readFileSync(join(DATA_DIR, path.replace(/^data\//, '')));
    return [header.readUInt8(100), header.readUInt8(101)];
  }

  it('ships exactly the east and north regions beside the core', () => {
    expect(manifest.core.id).toBe('core');
    expect(manifest.regions.map((r) => r.id)).toEqual(['east', 'north']);
  });

  it('every region shares the core zoom range (the protocol advertises the core header)', () => {
    const core = zoomRange(manifest.core.path);
    for (const r of manifest.regions) expect(zoomRange(r.path), r.id).toEqual(core);
  });

  it('core and regions together span exactly the #295 coverage bbox', () => {
    const all = [manifest.core, ...manifest.regions].map((e) => e.bbox);
    const union = [
      Math.min(...all.map((b) => b[0])),
      Math.min(...all.map((b) => b[1])),
      Math.max(...all.map((b) => b[2])),
      Math.max(...all.map((b) => b[3])),
    ];
    for (let i = 0; i < 4; i++) expect(union[i]).toBeCloseTo(COVERAGE[i], 6);
  });

  it('every tile of the coverage bbox, z0-z13, is served by the core or a region (no gap)', () => {
    const gaps: string[] = [];
    const [minLon, minLat, maxLon, maxLat] = COVERAGE;
    for (let z = 0; z <= 13; z++) {
      const n = 2 ** z;
      const x0 = Math.floor(((minLon + 180) / 360) * n);
      const x1 = Math.floor(((maxLon + 180) / 360) * n);
      const row = (lat: number) =>
        Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
      for (let x = x0; x <= x1; x++) {
        for (let y = row(maxLat); y <= row(minLat); y++) {
          const choice = selectTileArchive(z, x, y, manifest.core.bbox, manifest.regions);
          if (choice.kind === 'none') gaps.push(`${z}/${x}/${y}`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  // Hand-drawn waypoint routes (APPROXIMATE: a solver route bows further out,
  // which only grows the corridor). Snaps for kolding/nyborg/burgstaaken are
  // #295's new harbours (PR #1245's harbors.json).
  const P = {
    flensburg: { lat: 54.798, lon: 9.4335 },
    fjordMouth: { lat: 54.84, lon: 9.98 },
    soenderborg: { lat: 54.9046, lon: 9.7833 },
    aaroesund: { lat: 55.26, lon: 9.7165 },
    assens: { lat: 55.2621, lon: 9.8778 },
    kolding: { lat: 55.4931, lon: 9.508 },
    bagenkop: { lat: 54.753, lon: 10.668 },
    nyborg: { lat: 55.3031, lon: 10.7975 },
    burgstaaken: { lat: 54.4094, lon: 11.1924 },
  };
  const route = (...pts: { lat: number; lon: number }[]) =>
    pts.slice(1).map((end, i) => ({ start: pts[i], end }));

  it.each([
    ['core-only Flensburg->Soenderborg', route(P.flensburg, P.fjordMouth, P.soenderborg), []],
    // Both harbours lie in the core; the 5 nm corridor still crosses 55.3N.
    ['core plan near 55.3N, Aaroesund->Assens', route(P.aaroesund, P.assens), ['north']],
    [
      'Flensburg->Kolding',
      route(
        P.flensburg,
        P.fjordMouth,
        { lat: 55.0, lon: 10.05 },
        { lat: 55.45, lon: 9.72 },
        P.kolding,
      ),
      ['north'],
    ],
    [
      'Bagenkop->Burgstaaken',
      route(P.bagenkop, { lat: 54.45, lon: 11.1 }, P.burgstaaken),
      ['east'],
    ],
    [
      'Nyborg->Burgstaaken (both new areas)',
      route(P.nyborg, { lat: 55.2, lon: 10.95 }, { lat: 54.5, lon: 11.0 }, P.burgstaaken),
      ['east', 'north'],
    ],
  ])('%s', (_name, legs, expected) => {
    const boxes = routeCorridorBoxes(legs, null, AIS_CORRIDOR_HALF_WIDTH_NM);
    expect(boxes.length).toBeGreaterThan(0); // under the area cap: a real corridor, not the fail-closed []
    const entries = [manifest.core, ...manifest.regions];
    expect([...requiredRegions(entries, boxes)].sort()).toEqual(expected);
  });
});
