import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRegionPinIntent,
  parseRegionManifest,
  pinRegionsForPlan,
  regionReadiness,
  REGION_MANIFEST_PATH,
  type RegionManifest,
} from './regionPinning';
import { REGION_ARCHIVE_PREFIX, regionCacheName, type RegionBbox } from '../lib/basemapRegions';
import { resetCorridorAreaWarning } from '../lib/routeCorridor';
import { __resetDbForTests } from './db';
import type { Leg, Plan, PlanResultOk, RigResult } from '../types';

// #1164 T4: jsdom provides neither CacheStorage nor a real fetch — both are
// stubbed per test (mirroring glyphWarmup.test.ts's stubEnv pattern). A
// FakeCache/FakeCacheStorage pair is used rather than a bare Map so
// `caches.match` (top-level, searches every cache) behaves the way
// readManifestFromCache actually depends on.

class FakeCache {
  private readonly store = new Map<string, Response>();

  async match(request: string): Promise<Response | undefined> {
    const res = this.store.get(request);
    return res ? res.clone() : undefined;
  }

  async put(request: string, response: Response): Promise<void> {
    this.store.set(request, response.clone());
  }

  async delete(request: string): Promise<boolean> {
    return this.store.delete(request);
  }
}

class FakeCacheStorage {
  private readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }

  async match(request: string): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const res = await c.match(request);
      if (res) return res;
    }
    return undefined;
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

const BASE = import.meta.env.BASE_URL;
const REGION_CACHE_NAME = regionCacheName(BASE);
const MANIFEST_URL = BASE + REGION_MANIFEST_PATH;

const bbox = (minLon: number, minLat: number, maxLon: number, maxLat: number): RegionBbox => [
  minLon,
  minLat,
  maxLon,
  maxLat,
];

// A small box around the test leg's own coordinates — intersects it after
// the ~5 nm corridor padding with plenty of margin.
const REGION_A_BBOX = bbox(9.5, 54.4, 10.5, 54.9);
// Far from the test leg (and from REGION_A_BBOX) under any padding.
const REGION_B_BBOX = bbox(20.0, 60.0, 21.0, 61.0);

function manifest(bytes: { core?: number; a?: number; b?: number } = {}): RegionManifest {
  return {
    core: {
      id: 'core',
      path: 'data/basemap.pmtiles.png',
      bytes: bytes.core ?? 999,
      bbox: bbox(9.4, 54.3, 11.0, 55.3),
    },
    regions: [
      {
        id: 'region-a',
        path: `data/${REGION_ARCHIVE_PREFIX}a.pmtiles.png`,
        bytes: bytes.a ?? 1024,
        bbox: REGION_A_BBOX,
      },
      {
        id: 'region-b',
        path: `data/${REGION_ARCHIVE_PREFIX}b.pmtiles.png`,
        bytes: bytes.b ?? 2048,
        bbox: REGION_B_BBOX,
      },
    ],
  };
}

function leg(overrides: Partial<Leg> = {}): Leg {
  return {
    kind: 'motor',
    board: null,
    maneuverAtStart: null,
    start: { lat: 54.65, lon: 10.0 },
    end: { lat: 54.65, lon: 10.02 },
    startTimeMs: 0,
    endTimeMs: 1000,
    headingDeg: 90,
    twsKn: 10,
    speedKn: 5,
    distanceNm: 1,
    ...overrides,
  } as Leg;
}

function rigResult(legs: Leg[]): RigResult {
  return {
    sailId: 'genoa',
    legs,
    etaMs: 1000,
    durationMs: 1000,
    distanceNm: 1,
    maneuverCount: 0,
    motorDistanceNm: 1,
  };
}

/** Minimal Plan fixture — only `id` and `result.sails[].result.legs` are
 * read by the module under test, so every other field is irrelevant to it
 * (same `as unknown as Plan` convention db.test.ts uses for records that
 * don't need to exercise the full Plan shape). */
function makePlan(id: string, legsPerSail: Leg[][]): Plan {
  const result: PlanResultOk = {
    status: 'ok',
    sails: legsPerSail.map((legs, i) => ({
      sailId: i === 0 ? 'genoa' : 'fock',
      result: legs.length === 0 && i > 0 ? null : rigResult(legs),
      reason: legs.length === 0 && i > 0 ? 'unreachable' : null,
    })),
    recommended: 'genoa',
    comparisonComplete: true,
    snappedOrigin: { lat: 54.65, lon: 10.0 },
    snappedDestination: { lat: 54.65, lon: 10.02 },
  };
  return { id, result } as unknown as Plan;
}

function seedManifestInCache(fake: FakeCacheStorage, m: RegionManifest): Promise<void> {
  return fake
    .open('workbox-precache-fake')
    .then((c) => c.put(MANIFEST_URL, new Response(JSON.stringify(m), { status: 200 })));
}

interface Env {
  fake: FakeCacheStorage;
  fetchMock: ReturnType<typeof vi.fn>;
}

function stubEnv(
  opts: {
    manifest?: RegionManifest | 'malformed' | 'unreachable';
    archiveBody?: (path: string) => Uint8Array<ArrayBuffer> | null;
  } = {},
): Env {
  const fake = new FakeCacheStorage();
  vi.stubGlobal('caches', fake);

  const fetchMock = vi.fn(async (input: string) => {
    if (input === MANIFEST_URL) {
      if (opts.manifest === 'unreachable') return new Response('nope', { status: 500 });
      if (opts.manifest === 'malformed' || opts.manifest === undefined) {
        return new Response(JSON.stringify({ core: 'not-an-entry' }), { status: 200 });
      }
      return new Response(JSON.stringify(opts.manifest), { status: 200 });
    }
    const body = opts.archiveBody?.(input) ?? new Uint8Array(0);
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);

  return { fake, fetchMock };
}

beforeEach(async () => {
  await __resetDbForTests();
  resetCorridorAreaWarning();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseRegionManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(parseRegionManifest(manifest())).not.toBeNull();
  });

  it.each([
    ['not an object', null],
    ['missing core', { regions: [] }],
    ['core missing bbox', { core: { id: 'core', path: 'x', bytes: 1 }, regions: [] }],
    [
      'core bbox has only 3 numbers',
      { core: { id: 'core', path: 'x', bytes: 1, bbox: [1, 2, 3] }, regions: [] },
    ],
    [
      'regions is not an array',
      { core: { id: 'core', path: 'x', bytes: 1, bbox: [1, 2, 3, 4] }, regions: 'nope' },
    ],
    [
      'a region entry is malformed',
      {
        core: { id: 'core', path: 'x', bytes: 1, bbox: [1, 2, 3, 4] },
        regions: [{ id: 'r', path: 'x' }],
      },
    ],
  ])('rejects: %s', (_name, data) => {
    expect(parseRegionManifest(data)).toBeNull();
  });
});

describe('regionReadiness', () => {
  it('reports not-ready when the manifest cannot be read from CacheStorage at all (never fetches)', async () => {
    const { fetchMock } = stubEnv(); // manifest never seeded into any fake cache
    const plan = makePlan('p1', [[leg()]]);

    expect(await regionReadiness(plan)).toEqual({
      state: 'not-ready',
      reason: 'manifest-unavailable',
    });
    // Network-free contract: regionReadiness must never call fetch, even
    // when it cannot find the manifest.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not-ready when the cached manifest is malformed', async () => {
    const { fake, fetchMock } = stubEnv();
    await seedManifestInCache(fake, { core: 'not-an-entry' } as unknown as RegionManifest);
    const plan = makePlan('p1', [[leg()]]);

    expect(await regionReadiness(plan)).toEqual({
      state: 'not-ready',
      reason: 'manifest-unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports ready with total 0 when the corridor requires no lazy region (zero-regions manifest)', async () => {
    const { fake } = stubEnv();
    await seedManifestInCache(fake, { ...manifest(), regions: [] });
    const plan = makePlan('p1', [[leg()]]);

    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 0, total: 0 });
  });

  it('an empty leg list (fail-closed empty corridor) requires EVERY lazy region', async () => {
    const { fake } = stubEnv();
    await seedManifestInCache(fake, manifest());
    const plan = makePlan('p1', [[]]);

    const readiness = await regionReadiness(plan);
    expect(readiness).toEqual({ state: 'not-ready', reason: 'pending' });
    // Corroborate via pinRegionsForPlan's own `total`, which is derived the
    // same way: both lazy regions (region-a AND region-b), not just the one
    // the leg's own coordinates intersect.
    const { fake: fake2, fetchMock } = stubEnv({
      manifest: manifest(),
      archiveBody: () => new Uint8Array(1024),
    });
    vi.stubGlobal('caches', fake2);
    const outcome = await pinRegionsForPlan(makePlan('p2', [[]]));
    expect(outcome.status).toBe('pinned');
    if (outcome.status === 'pinned') expect(outcome.total).toBe(2);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('progresses not-ready -> downloading -> ready as required archives are pinned one at a time', async () => {
    const { fake } = stubEnv();
    const m = manifest();
    await seedManifestInCache(fake, m);
    // A leg whose padded corridor intersects BOTH region-a and region-b, so
    // total === 2 and partial progress is observable.
    const plan = makePlan('p1', [
      [leg({ start: { lat: 60.5, lon: 20.5 }, end: { lat: 54.65, lon: 10.0 } })],
    ]);

    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });

    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    await cache.put(
      aUrl,
      new Response(new Uint8Array(m.regions[0].bytes), {
        headers: { 'content-length': String(m.regions[0].bytes) },
      }),
    );
    expect(await regionReadiness(plan)).toEqual({ state: 'downloading', done: 1, total: 2 });

    const bUrl = BASE + m.regions[1].path;
    await cache.put(
      bUrl,
      new Response(new Uint8Array(m.regions[1].bytes), {
        headers: { 'content-length': String(m.regions[1].bytes) },
      }),
    );
    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 2, total: 2 });
  });

  it('a cached archive whose stored length disagrees with the manifest does NOT count as present', async () => {
    const { fake } = stubEnv();
    const m = manifest();
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]); // requires region-a only

    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    await cache.put(
      aUrl,
      new Response(new Uint8Array(10), { headers: { 'content-length': '10' } }),
    );

    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });

  it('a REGION_CACHE_VERSION-style retirement (the region cache is gone) reverts a previously-ready plan to not-ready', async () => {
    const { fake } = stubEnv();
    const m = manifest();
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]); // requires region-a only

    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    await cache.put(
      aUrl,
      new Response(new Uint8Array(m.regions[0].bytes), {
        headers: { 'content-length': String(m.regions[0].bytes) },
      }),
    );
    expect((await regionReadiness(plan)).state).toBe('ready');

    // Simulate the sw.ts activate cleanup a version bump triggers: the whole
    // deployment-scoped region cache is deleted, never a per-entry eviction.
    await fake.delete(REGION_CACHE_NAME);

    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });
});

describe('pinRegionsForPlan', () => {
  it('pins the one required region, verifies its byte length, and records pin intent', async () => {
    const m = manifest();
    const { fake } = stubEnv({
      manifest: m,
      archiveBody: () => new Uint8Array(m.regions[0].bytes),
    });
    // The manifest is a precached build asset in production (like
    // glyph-manifest.json) — seed it into CacheStorage so the readiness
    // check at the end of this test (network-free by contract) can see it.
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]); // requires region-a only

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });

    const cache = await fake.open(REGION_CACHE_NAME);
    const cached = await cache.match(BASE + m.regions[0].path);
    expect(cached).toBeDefined();
    expect(Number(cached?.headers.get('content-length'))).toBe(m.regions[0].bytes);
    // region-b was never fetched or cached — it doesn't intersect the corridor.
    expect(await cache.match(BASE + m.regions[1].path)).toBeUndefined();

    const intent = await getRegionPinIntent('p1');
    expect(intent).toEqual({
      planId: 'p1',
      regionIds: ['region-a'],
      pinnedAtMs: expect.any(Number),
    });

    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 1, total: 1 });
  });

  it('rejects a short body: the archive is NOT cached and readiness stays not-ready', async () => {
    const m = manifest();
    // Server answers with far fewer bytes than the manifest promises.
    const { fake } = stubEnv({ manifest: m, archiveBody: () => new Uint8Array(10) });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const cache = await fake.open(REGION_CACHE_NAME);
    expect(await cache.match(BASE + m.regions[0].path)).toBeUndefined();
    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });

  it('rejects an OVERSIZED body too — byte-length is checked for EQUALITY, not a lower bound', async () => {
    const m = manifest();
    // Server answers with MORE bytes than the manifest promises (e.g. a
    // corrupted/substituted archive) — `>=` would wrongly accept this.
    const { fake } = stubEnv({
      manifest: m,
      archiveBody: () => new Uint8Array(m.regions[0].bytes + 1),
    });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const cache = await fake.open(REGION_CACHE_NAME);
    expect(await cache.match(BASE + m.regions[0].path)).toBeUndefined();
    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });

  it('a malformed manifest pins NOTHING and records no pin intent', async () => {
    const { fake, fetchMock } = stubEnv({ manifest: 'malformed' });
    const plan = makePlan('p1', [[leg()]]);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'manifest-unavailable' });
    expect(await getRegionPinIntent('p1')).toBeUndefined();
    // Only the manifest fetch itself may have run — no archive fetch, since
    // the required set could never be determined.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe(MANIFEST_URL);
    }

    expect(await regionReadiness(plan)).toEqual({
      state: 'not-ready',
      reason: 'manifest-unavailable',
    });
    expect(
      await fake.open(REGION_CACHE_NAME).then((c) => c.match(BASE + 'data/region-a.pmtiles.png')),
    ).toBeUndefined();
  });

  it('an unreachable manifest (network failure) pins NOTHING', async () => {
    stubEnv({ manifest: 'unreachable' });
    const plan = makePlan('p1', [[leg()]]);

    expect(await pinRegionsForPlan(plan)).toEqual({ status: 'manifest-unavailable' });
    expect(await getRegionPinIntent('p1')).toBeUndefined();
  });

  it('zero required regions: pins nothing, records an empty intent, and reports ready', async () => {
    const zeroRegionManifest = { ...manifest(), regions: [] };
    const { fake, fetchMock } = stubEnv({ manifest: zeroRegionManifest });
    await seedManifestInCache(fake, zeroRegionManifest);
    const plan = makePlan('p1', [[leg()]]);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 0, pinned: 0 });
    expect(await getRegionPinIntent('p1')).toEqual({
      planId: 'p1',
      regionIds: [],
      pinnedAtMs: expect.any(Number),
    });
    // No archive fetch at all — the manifest was already in cache, so not
    // even that needed a network round trip.
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 0, total: 0 });
  });

  it('an already-pinned archive short-circuits without a network fetch', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({
      manifest: m,
      archiveBody: () => new Uint8Array(m.regions[0].bytes),
    });
    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    await cache.put(
      aUrl,
      new Response(new Uint8Array(m.regions[0].bytes), {
        headers: { 'content-length': String(m.regions[0].bytes) },
      }),
    );

    const plan = makePlan('p1', [[leg()]]);
    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });
    // Only the manifest may have been fetched over the network (it was
    // seeded via stubEnv's fetch mock, not pre-cached here) — the archive
    // itself was already present and must not be re-fetched.
    expect(fetchMock).not.toHaveBeenCalledWith(aUrl);
  });
});
