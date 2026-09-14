import { describe, expect, it } from 'vitest';
import type { AisBoundingBox } from '../services/aisStream';
import {
  CORE_REGION_ID,
  REGION_ARCHIVE_PREFIX,
  isRegionArchivePath,
  isRetiredRegionCache,
  regionById,
  regionCacheName,
  requiredRegions,
  type RegionManifestEntry,
} from './basemapRegions';

// Literal cache names, pinned independently of the functions under test
// (mutation-honesty, #50): a mutant slug/delimiter derivation must break
// these. Mirrors glyphs.test.ts's PROD_BASE/UAT_BASE/PROD_CACHE/UAT_CACHE
// pattern for the #96 deployment-scoped cache convention.
const PROD_BASE = '/sail_command/';
const UAT_BASE = '/sail_command/uat/';
const PROD_CACHE = 'sailcommand-regions-sail_command@v1';
const UAT_CACHE = 'sailcommand-regions-sail_command-uat@v1';

const box = (latMin: number, lonMin: number, latMax: number, lonMax: number): AisBoundingBox => [
  [latMin, lonMin],
  [latMax, lonMax],
];

const entry = (id: string, bbox: AisBoundingBox): RegionManifestEntry => ({
  id,
  path: `data/${REGION_ARCHIVE_PREFIX}${id}.pmtiles.png`,
  bytes: 1024,
  bbox,
});

describe('REGION_ARCHIVE_PREFIX', () => {
  it('is the flat, non-subdirectory basename prefix the maintainer ruling settled on', () => {
    // deploy.yml's smoke-probe/archive-discovery globs are data/*.pmtiles*
    // and do not recurse — a subdirectory would silently escape both.
    expect(REGION_ARCHIVE_PREFIX).toBe('region-');
    expect(REGION_ARCHIVE_PREFIX.includes('/')).toBe(false);
  });
});

describe('isRegionArchivePath', () => {
  it('matches a bare region archive path in both suffix forms', () => {
    expect(isRegionArchivePath('data/region-abc.pmtiles.png')).toBe(true);
    expect(isRegionArchivePath('data/region-abc.pmtiles')).toBe(true);
  });

  it('matches under BOTH BASE_URL shapes (prod and /uat/)', () => {
    expect(isRegionArchivePath('/sail_command/data/region-abc.pmtiles.png')).toBe(true);
    expect(isRegionArchivePath('/sail_command/uat/data/region-abc.pmtiles.png')).toBe(true);
  });

  it('never matches the CORE archive — the distinction this predicate exists for', () => {
    expect(isRegionArchivePath('data/basemap.pmtiles.png')).toBe(false);
    expect(isRegionArchivePath('/sail_command/data/basemap.pmtiles.png')).toBe(false);
    expect(isRegionArchivePath('data/basemap.pmtiles')).toBe(false);
  });

  it('never matches a non-archive path, even one containing "region-" mid-path', () => {
    expect(isRegionArchivePath('data/region-abc.json')).toBe(false);
    expect(isRegionArchivePath('data/subregion-abc.pmtiles.png')).toBe(false);
    expect(isRegionArchivePath('data/notes/region-abc.txt')).toBe(false);
  });
});

describe('regionCacheName (per-deployment scoping, #96)', () => {
  it('gives production and UAT DISTINCT cache names on the shared origin', () => {
    expect(regionCacheName(PROD_BASE)).toBe(PROD_CACHE);
    expect(regionCacheName(UAT_BASE)).toBe(UAT_CACHE);
    expect(regionCacheName(PROD_BASE)).not.toBe(regionCacheName(UAT_BASE));
  });
});

describe('isRetiredRegionCache (activate cleanup scoping, #96)', () => {
  it('never evicts the SIBLING deployment (anti-cross-eviction invariant)', () => {
    // prod's slug `sail_command` is a textual prefix of UAT's
    // `sail_command-uat` — the prefix trap a bare startsWith(slug) would fall
    // into. Neither deployment's activate cleanup may touch the other's cache.
    expect(isRetiredRegionCache(UAT_CACHE, PROD_BASE)).toBe(false);
    expect(isRetiredRegionCache(PROD_CACHE, UAT_BASE)).toBe(false);
  });

  it("retires only THIS deployment's own non-current versions", () => {
    expect(isRetiredRegionCache('sailcommand-regions-sail_command@v0', PROD_BASE)).toBe(true);
    expect(isRetiredRegionCache('sailcommand-regions-sail_command-uat@v0', UAT_BASE)).toBe(true);
    expect(isRetiredRegionCache(PROD_CACHE, PROD_BASE)).toBe(false);
    expect(isRetiredRegionCache(UAT_CACHE, UAT_BASE)).toBe(false);
  });

  it('never matches workbox precache caches, the glyph cache family, or unrelated names', () => {
    expect(
      isRetiredRegionCache('workbox-precache-v2-https://example.test/sail_command/', PROD_BASE),
    ).toBe(false);
    expect(isRetiredRegionCache('sailcommand-glyphs-sail_command@v1', PROD_BASE)).toBe(false);
    expect(isRetiredRegionCache('sailcommand-somethingelse-v1', PROD_BASE)).toBe(false);
  });
});

describe('regionById (prototype-safe lookup)', () => {
  it('resolves a real id and misses an absent one', () => {
    const entries = [entry('a', box(0, 0, 1, 1)), entry('b', box(2, 2, 3, 3))];
    expect(regionById(entries, 'a')?.id).toBe('a');
    expect(regionById(entries, 'missing')).toBeUndefined();
  });

  // Sourced from Object.getOwnPropertyNames(Object.prototype) itself, not a
  // hand-copied list, so needle (the engine's own member set) and haystack
  // (the production lookup) stay independent — CLAUDE.md's `in`-vs-hasOwn
  // rule (#614): a bare `in`/bracket lookup on a `{}` literal resolves every
  // one of these through the prototype chain even when no entry carries it.
  it.each(Object.getOwnPropertyNames(Object.prototype))(
    'treats the Object.prototype member %s as a genuine miss when absent',
    (name) => {
      const entries = [entry('a', box(0, 0, 1, 1))];
      expect(regionById(entries, name)).toBeUndefined();
    },
  );

  it('still resolves an entry whose id IS an Object.prototype member name', () => {
    // The converse control: such an id must resolve to the REAL entry, not
    // fall through to a false miss either.
    const entries = [entry('toString', box(0, 0, 1, 1))];
    expect(regionById(entries, 'toString')?.id).toBe('toString');
  });
});

describe('requiredRegions', () => {
  const near = entry('near', box(54.0, 10.0, 54.5, 10.5));
  const far = entry('far', box(56.0, 12.0, 56.5, 12.5));
  const core = entry(CORE_REGION_ID, box(0, 0, 90, 90)); // covers everything

  it('never includes the core region even when its bbox covers every corridor box', () => {
    expect(requiredRegions([core], [box(10, 10, 20, 20)])).toEqual([]);
  });

  it('requires only the region(s) whose bbox intersects a corridor box', () => {
    expect(requiredRegions([core, near, far], [box(54.1, 10.1, 54.2, 10.2)])).toEqual(['near']);
  });

  it('counts a touching (inclusive-edge) box as intersecting', () => {
    const touching = entry('touching', box(54.5, 10.5, 55.0, 11.0)); // shares near's NE corner
    expect(requiredRegions([near, touching], [box(54.5, 10.5, 54.6, 10.6)])).toEqual([
      'near',
      'touching',
    ]);
  });

  it('requires nothing when no corridor box intersects any region and the corridor is non-empty', () => {
    expect(requiredRegions([far], [box(0, 0, 1, 1)])).toEqual([]);
  });

  it('requires EVERY lazy region when the corridor is empty (fail-closed, #1164 plan §3.3)', () => {
    // routeCorridorBoxes() returns [] when the AIS_CORRIDOR_MAX_AREA_NM2 cap
    // drops coverage — that means "coverage was dropped", never "nothing is
    // needed". Reading [] as "require nothing" would report a plan
    // offline-ready having pinned zero regions.
    expect(requiredRegions([core, near, far], [])).toEqual(expect.arrayContaining(['near', 'far']));
    expect(requiredRegions([core, near, far], [])).toHaveLength(2);
  });

  it('an empty corridor over a core-only manifest still requires nothing (single-archive v0.34.0 case)', () => {
    expect(requiredRegions([core], [])).toEqual([]);
  });
});
