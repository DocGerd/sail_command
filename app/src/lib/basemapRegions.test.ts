import { describe, expect, it } from 'vitest';
import type { AisBoundingBox } from '../services/aisStream';
import {
  CORE_REGION_ID,
  REGION_ARCHIVE_PREFIX,
  REGION_MANIFEST_PATH,
  isRegionArchivePath,
  isRetiredRegionCache,
  isValidRegionBbox,
  parseRegionManifest,
  regionById,
  regionCacheName,
  requiredRegions,
  type RegionBbox,
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

/** A corridor box in the AIS-domain shape ([[latMin,lonMin],[latMax,lonMax]]). */
const corridorBox = (
  latMin: number,
  lonMin: number,
  latMax: number,
  lonMax: number,
): AisBoundingBox => [
  [latMin, lonMin],
  [latMax, lonMax],
];

/** A manifest entry's bbox in T2's own shape ([minLon,minLat,maxLon,maxLat]). */
const regionBbox = (minLon: number, minLat: number, maxLon: number, maxLat: number): RegionBbox => [
  minLon,
  minLat,
  maxLon,
  maxLat,
];

const entry = (id: string, bbox: RegionBbox): RegionManifestEntry => ({
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
    const entries = [entry('a', regionBbox(0, 0, 1, 1)), entry('b', regionBbox(2, 2, 3, 3))];
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
      const entries = [entry('a', regionBbox(0, 0, 1, 1))];
      expect(regionById(entries, name)).toBeUndefined();
    },
  );

  it('still resolves an entry whose id IS an Object.prototype member name', () => {
    // The converse control: such an id must resolve to the REAL entry, not
    // fall through to a false miss either.
    const entries = [entry('toString', regionBbox(0, 0, 1, 1))];
    expect(regionById(entries, 'toString')?.id).toBe('toString');
  });
});

describe('requiredRegions', () => {
  const near = entry('near', regionBbox(10.0, 54.0, 10.5, 54.5));
  const far = entry('far', regionBbox(12.0, 56.0, 12.5, 56.5));
  const core = entry(CORE_REGION_ID, regionBbox(0, 0, 90, 90)); // covers everything

  it('never includes the core region even when its bbox covers every corridor box', () => {
    expect(requiredRegions([core], [corridorBox(10, 10, 20, 20)])).toEqual([]);
  });

  it('requires only the region(s) whose bbox intersects a corridor box', () => {
    expect(requiredRegions([core, near, far], [corridorBox(54.1, 10.1, 54.2, 10.2)])).toEqual([
      'near',
    ]);
  });

  it('counts a touching (inclusive-edge) box as intersecting', () => {
    // touching shares near's NE corner (lon 10.5, lat 54.5)
    const touching = entry('touching', regionBbox(10.5, 54.5, 11.0, 55.0));
    expect(requiredRegions([near, touching], [corridorBox(54.5, 10.5, 54.6, 10.6)])).toEqual([
      'near',
      'touching',
    ]);
  });

  it('requires nothing when no corridor box intersects any region and the corridor is non-empty', () => {
    expect(requiredRegions([far], [corridorBox(0, 0, 1, 1)])).toEqual([]);
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

  it("treats a manifest entry literally shaped like T2's output correctly (axis order, PR #1220)", () => {
    // Copied verbatim from T2's own worked manifest example:
    // {"core":{"id":"core","path":"data/basemap.pmtiles.png","bytes":27201789,
    // "bbox":[9.4,54.3,11,55.3]},"regions":[]} — applied here to a LAZY
    // region entry (never id CORE_REGION_ID, which requiredRegions always
    // excludes) so the test actually exercises axis handling. bbox is
    // [minLon,minLat,maxLon,maxLat] = [9.4, 54.3, 11, 55.3], the pre-#295
    // operating area and still the core basemap's extent (54.3-55.3 degN,
    // 9.4-11.0 degE). An axis swap (treating this as [minLat,minLon,maxLat,
    // maxLon]) would place the "region" near the equator/Persian Gulf
    // instead, missing a real Flensburg-area corridor box entirely.
    const flensburgShaped: RegionManifestEntry = {
      id: 'flensburg',
      path: 'data/basemap.pmtiles.png',
      bytes: 27201789,
      bbox: [9.4, 54.3, 11, 55.3],
    };
    const corridorInside = corridorBox(54.5, 10.0, 54.6, 10.1); // real Flensburg-area lat/lon
    expect(requiredRegions([flensburgShaped], [corridorInside])).toEqual(['flensburg']);
  });
});

describe('malformed bbox — fail-closed, never under-require', () => {
  it('a manifest entry with a NaN bbox is required despite a corridor box far away', () => {
    const broken = entry('broken', [NaN, 0, 1, 1]);
    const farAway = corridorBox(0, 0, 0.1, 0.1);
    expect(requiredRegions([broken], [farAway])).toEqual(['broken']);
  });

  it('a manifest entry with a non-finite (Infinity) bbox is required despite a corridor box far away', () => {
    const broken = entry('broken', [0, 0, Infinity, 1]);
    const farAway = corridorBox(80, 80, 81, 81);
    expect(requiredRegions([broken], [farAway])).toEqual(['broken']);
  });

  it('a manifest entry with a reversed (min>max) bbox is required despite a corridor box far away', () => {
    const reversed = entry('reversed', [10, 10, 5, 5]); // maxLon<minLon, maxLat<minLat
    const farAway = corridorBox(80, 80, 81, 81);
    expect(requiredRegions([reversed], [farAway])).toEqual(['reversed']);
  });

  it('a NaN corridor box forces EVERY region to be required, not just the geographically matching one', () => {
    const near = entry('near', regionBbox(10.0, 54.0, 10.5, 54.5));
    const far = entry('far', regionBbox(12.0, 56.0, 12.5, 56.5));
    const brokenCorridor: AisBoundingBox = [
      [NaN, 0],
      [1, 1],
    ];
    const result = requiredRegions([near, far], [brokenCorridor]);
    expect(result).toEqual(expect.arrayContaining(['near', 'far']));
    expect(result).toHaveLength(2);
  });

  it('a reversed (min>max) corridor box also forces every region to be required', () => {
    const near = entry('near', regionBbox(10.0, 54.0, 10.5, 54.5));
    const far = entry('far', regionBbox(12.0, 56.0, 12.5, 56.5));
    const reversedCorridor: AisBoundingBox = [
      [10, 10],
      [0, 0],
    ]; // max < min on both axes
    const result = requiredRegions([near, far], [reversedCorridor]);
    expect(result).toEqual(expect.arrayContaining(['near', 'far']));
    expect(result).toHaveLength(2);
  });
});

// #1225/#1224 consolidation (PR #1224 review r4008717160): isValidRegionBbox
// and parseRegionManifest were EXPORTED here so both PR #1225's pin service
// and PR #1224's composite protocol (once it switches over) share one
// definition instead of two that could drift.
describe('isValidRegionBbox', () => {
  it('accepts a well-formed bbox', () => {
    expect(isValidRegionBbox(regionBbox(9.4, 54.3, 11.0, 55.3))).toBe(true);
  });

  it('rejects a NaN coordinate', () => {
    expect(isValidRegionBbox([NaN, 0, 1, 1])).toBe(false);
  });

  it('rejects a non-finite (Infinity) coordinate', () => {
    expect(isValidRegionBbox([0, 0, Infinity, 1])).toBe(false);
  });

  it('rejects a reversed (min > max) bbox on either axis', () => {
    expect(isValidRegionBbox([10, 0, 5, 1])).toBe(false); // maxLon < minLon
    expect(isValidRegionBbox([0, 10, 1, 5])).toBe(false); // maxLat < minLat
  });

  it('accepts a degenerate but valid bbox (min === max)', () => {
    expect(isValidRegionBbox([1, 1, 1, 1])).toBe(true);
  });
});

describe('REGION_MANIFEST_PATH', () => {
  it('is the flat, BASE_URL-relative filename T2 emits', () => {
    expect(REGION_MANIFEST_PATH).toBe('basemap-regions.json');
    expect(REGION_MANIFEST_PATH.includes('/')).toBe(false);
  });
});

describe('parseRegionManifest', () => {
  const validCore = {
    id: CORE_REGION_ID,
    path: 'data/basemap.pmtiles.png',
    bytes: 999,
    bbox: [9.4, 54.3, 11, 55.3],
  };
  const validRegion = {
    id: 'a',
    path: `data/${REGION_ARCHIVE_PREFIX}a.pmtiles.png`,
    bytes: 1024,
    bbox: [9.5, 54.4, 10.5, 54.9],
  };

  it('accepts a well-formed manifest and returns it structurally unchanged', () => {
    const parsed = parseRegionManifest({ core: validCore, regions: [validRegion] });
    expect(parsed).toEqual({ core: validCore, regions: [validRegion] });
  });

  it('accepts a well-formed manifest with zero regions (single-archive deployment)', () => {
    expect(parseRegionManifest({ core: validCore, regions: [] })).toEqual({
      core: validCore,
      regions: [],
    });
  });

  it.each([
    ['not an object', null],
    ['an array', [1, 2, 3]],
    ['missing core', { regions: [] }],
    ["core.id is not literally 'core'", { core: { ...validCore, id: 'not-core' }, regions: [] }],
    ['core missing bbox', { core: { id: CORE_REGION_ID, path: 'x', bytes: 1 }, regions: [] }],
    [
      'core bbox has only 3 numbers',
      { core: { id: CORE_REGION_ID, path: 'x', bytes: 1, bbox: [1, 2, 3] }, regions: [] },
    ],
    [
      'core bbox is reversed (min > max)',
      { core: { ...validCore, bbox: [11, 55.3, 9.4, 54.3] }, regions: [] },
    ],
    ['regions is not an array', { core: validCore, regions: 'nope' }],
    [
      'a region entry is malformed (missing bytes)',
      {
        core: validCore,
        regions: [{ id: 'r', path: 'data/region-r.pmtiles.png', bbox: [0, 0, 1, 1] }],
      },
    ],
    [
      'a region entry has a reversed (min > max) bbox',
      { core: validCore, regions: [{ ...validRegion, bbox: [10.5, 54.9, 9.5, 54.4] }] },
    ],
    [
      "a region entry's path does not match the region naming convention (#1224 review — the #1225-only gap this consolidation closes)",
      { core: validCore, regions: [{ ...validRegion, path: 'data/notaregion.pmtiles.png' }] },
    ],
    [
      "a region entry's path is actually the CORE archive path",
      { core: validCore, regions: [{ ...validRegion, path: 'data/basemap.pmtiles.png' }] },
    ],
  ])('rejects (ALL-OR-NOTHING, fail-closed): %s', (_name, data) => {
    expect(parseRegionManifest(data)).toBeNull();
  });

  it('rejects the WHOLE manifest when only the SECOND region entry is malformed (all-or-nothing, never a partial region list)', () => {
    const secondBroken = {
      ...validRegion,
      id: 'b',
      path: `data/${REGION_ARCHIVE_PREFIX}b.pmtiles.png`,
      bbox: [1, 1, 0, 0],
    };
    expect(
      parseRegionManifest({ core: validCore, regions: [validRegion, secondBroken] }),
    ).toBeNull();
  });
});
