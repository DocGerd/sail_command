import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRegionPinIntent, pinRegionsForPlan, regionReadiness } from './regionPinning';
import { __resetDbForTests, saveRegionPin } from './db';
import {
  REGION_ARCHIVE_PREFIX,
  REGION_MANIFEST_PATH,
  regionCacheName,
  type RegionBbox,
  type RegionManifest,
} from '../lib/basemapRegions';
import { resetCorridorAreaWarning } from '../lib/routeCorridor';
import type { Leg, Plan, PlanResultOk, RigResult } from '../types';

// #1225 fix wave (PWA review r4008640266): saveRegionPin's failure path is
// exercised by wrapping the REAL implementation in a vi.fn — every test gets
// real IndexedDB behaviour by default, and exactly one test below overrides
// it with mockRejectedValueOnce to prove pinRegionsForPlan reports a named
// outcome instead of rejecting after the archives are already cached.
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return { ...actual, saveRegionPin: vi.fn(actual.saveRegionPin) };
});

// #1164 T4: jsdom provides neither CacheStorage nor a real fetch — both are
// stubbed per test (mirroring glyphWarmup.test.ts's stubEnv pattern). A
// FakeCache/FakeCacheStorage pair is used rather than a bare Map so
// `caches.match` (top-level, searches every cache) behaves the way
// readManifestFromCache actually depends on — INCLUDING `ignoreSearch`
// (PWA review Blocker r4008640242): workbox stores an unhashed precached
// asset under a `?__WB_REVISION__=<rev>` key, not the bare path.

function stripQuery(url: string): string {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

class FakeCache {
  private readonly store = new Map<string, Response>();

  async match(
    request: string,
    options?: { ignoreSearch?: boolean },
  ): Promise<Response | undefined> {
    if (options?.ignoreSearch) {
      const target = stripQuery(request);
      for (const [key, res] of this.store) {
        if (stripQuery(key) === target) return res.clone();
      }
      return undefined;
    }
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

  async match(
    request: string,
    options?: { ignoreSearch?: boolean },
  ): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const res = await c.match(request, options);
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
// The real precache key shape (workbox-precaching's createCacheKey) — never
// the bare MANIFEST_URL. Every seedManifestInCache call below stores under
// THIS key, so any test relying on readManifestFromCache finding the
// manifest is exercising the realistic fake, not the bare-URL shortcut the
// Blocker was filed against.
const MANIFEST_REVISION_QUERY = '?__WB_REVISION__=test-rev';

/** A minimal but genuine PMTiles-magic-prefixed byte buffer of length `n`,
 * for archiveBody generators that must survive pinOneRegion's magic-number
 * check (PWA review Minor r4008640259) to reach the assertion under test. */
function pmtilesBytes(n: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(n);
  b[0] = 0x50; // 'P'
  b[1] = 0x4d; // 'M'
  return b;
}

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
    .then((c) =>
      c.put(
        MANIFEST_URL + MANIFEST_REVISION_QUERY,
        new Response(JSON.stringify(m), { status: 200 }),
      ),
    );
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
    const body = opts.archiveBody?.(input) ?? pmtilesBytes(0);
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

describe('#1225 PWA review Blocker r4008640242: workbox precache revision key', () => {
  it('regionReadiness finds the manifest even though it is stored under a `?__WB_REVISION__=` key, not the bare BASE_URL path', async () => {
    const { fake } = stubEnv();
    await seedManifestInCache(fake, manifest());
    const plan = makePlan('p1', [[leg()]]); // requires region-a only

    // A bare, non-ignoreSearch cache.match would miss the revision-keyed
    // entry entirely and report not-ready/manifest-unavailable.
    const readiness = await regionReadiness(plan);
    expect(readiness).not.toEqual({ state: 'not-ready', reason: 'manifest-unavailable' });
    expect(readiness).toEqual({ state: 'not-ready', reason: 'pending' }); // manifest found; nothing pinned yet
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
      archiveBody: () => pmtilesBytes(1024),
    });
    vi.stubGlobal('caches', fake2);
    const outcome = await pinRegionsForPlan(makePlan('p2', [[]]));
    expect(outcome.status).toBe('pinned');
    if (outcome.status === 'pinned') expect(outcome.total).toBe(2);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('progresses not-ready(pending) -> not-ready(pending) -> ready as required archives are pinned one at a time — never a "downloading" state this network-free snapshot cannot verify (PWA review Minor r4008640274)', async () => {
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
    // ONE of two required archives present — still not-ready, never a
    // separate "downloading" state (this is a snapshot check; it cannot
    // tell "in flight" from "permanently partial").
    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });

    const bUrl = BASE + m.regions[1].path;
    await cache.put(
      bUrl,
      new Response(new Uint8Array(m.regions[1].bytes), {
        headers: { 'content-length': String(m.regions[1].bytes) },
      }),
    );
    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 2, total: 2 });
  });

  it('a permanently PARTIAL pin (one archive never recovered) reports not-ready forever, never a stuck "downloading" — this is exactly the state the removed state name would have misrepresented', async () => {
    const { fake } = stubEnv();
    const m = manifest();
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [
      [leg({ start: { lat: 60.5, lon: 20.5 }, end: { lat: 54.65, lon: 10.0 } })],
    ]); // requires region-a AND region-b

    const cache = await fake.open(REGION_CACHE_NAME);
    // region-a pinned; region-b permanently missing (e.g. it 404'd forever).
    await cache.put(
      BASE + m.regions[0].path,
      new Response(new Uint8Array(m.regions[0].bytes), {
        headers: { 'content-length': String(m.regions[0].bytes) },
      }),
    );

    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
    // Re-checking later changes nothing — there is nothing "in flight".
    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });

  it('a cached archive whose stored length disagrees with the manifest does NOT count as present (UNDERSIZED direction)', async () => {
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

  it('a cached archive whose stored length EXCEEDS the manifest does NOT count as present either (conventions review r4008643175: isArchivePresent uses ===, not >=)', async () => {
    const { fake } = stubEnv();
    const m = manifest();
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]); // requires region-a only

    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    // Stored length is GREATER than entry.bytes — an `isArchivePresent`
    // written with `len >= entry.bytes` would wrongly accept this.
    await cache.put(
      aUrl,
      new Response(new Uint8Array(m.regions[0].bytes + 1), {
        headers: { 'content-length': String(m.regions[0].bytes + 1) },
      }),
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
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
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

  it('fetches the archive with cache: "no-store" (PWA review Minor r4008640259 — region paths are unhashed)', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({
      manifest: m,
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
    });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);

    await pinRegionsForPlan(plan);

    const aUrl = BASE + m.regions[0].path;
    expect(fetchMock).toHaveBeenCalledWith(aUrl, { cache: 'no-store' });
  });

  it('rejects a body that is not a PMTiles archive (fails the magic-number check) even when the length matches (PWA review Minor r4008640259)', async () => {
    const m = manifest();
    // Zero-filled, correct LENGTH, wrong (absent) magic.
    const { fake } = stubEnv({
      manifest: m,
      archiveBody: () => new Uint8Array(m.regions[0].bytes),
    });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const cache = await fake.open(REGION_CACHE_NAME);
    expect(await cache.match(BASE + m.regions[0].path)).toBeUndefined();
  });

  it('rejects a short body: the archive is NOT cached and readiness stays not-ready', async () => {
    const m = manifest();
    // Server answers with far fewer bytes than the manifest promises.
    const { fake } = stubEnv({ manifest: m, archiveBody: () => pmtilesBytes(10) });
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
    // corrupted/substituted archive) — `>=` would wrongly accept this. PM
    // magic is present so this discriminates the LENGTH check specifically,
    // not the (independent) magic-number check above.
    const { fake } = stubEnv({
      manifest: m,
      archiveBody: () => pmtilesBytes(m.regions[0].bytes + 1),
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

  it('a non-OK manifest response with a VALID JSON body is still rejected — the `!res.ok` guard, not JSON parsing, is what catches it (PWA review Minor r4008640282)', async () => {
    const m = manifest();
    const fetchMock = vi.fn(async (input: string) => {
      // A well-formed manifest body on a 500 response — if `!res.ok` were
      // deleted, `.json()` would succeed and parseRegionManifest would
      // accept it, silently ignoring the error status.
      if (input === MANIFEST_URL) return new Response(JSON.stringify(m), { status: 500 });
      return new Response(pmtilesBytes(0), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('caches', new FakeCacheStorage()); // nothing precached -> forces the network branch
    const plan = makePlan('p1', [[leg()]]);

    expect(await pinRegionsForPlan(plan)).toEqual({ status: 'manifest-unavailable' });
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
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
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

  it('deletes a STALE cached entry BEFORE re-fetching, so a real SW Range route cannot keep serving stale bytes forever (cross-PR Major, #1223 review r4008628008)', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({
      manifest: m,
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
    });
    await seedManifestInCache(fake, m);
    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    // A stale entry from a previous build: wrong length, so isArchivePresent
    // reads it as absent — but it is STILL occupying the cache key sw.ts's
    // own Range route would otherwise keep serving stale bytes from.
    await cache.put(
      aUrl,
      new Response(new Uint8Array(999), { headers: { 'content-length': '999' } }),
    );

    const calls: string[] = [];
    vi.spyOn(cache, 'delete').mockImplementation(async (req: string) => {
      calls.push(`delete:${req}`);
      return true;
    });
    fetchMock.mockImplementation(async (input: string) => {
      calls.push(`fetch:${input}`);
      return new Response(pmtilesBytes(m.regions[0].bytes), { status: 200 });
    });

    const plan = makePlan('p1', [[leg()]]);
    const outcome = await pinRegionsForPlan(plan);

    // Order matters: delete must precede fetch, or a real SW route reading
    // this same cache would still answer from the stale entry.
    expect(calls).toEqual([`delete:${aUrl}`, `fetch:${aUrl}`]);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });
  });

  it('a saveRegionPin failure (e.g. the cross-deployment DB_VERSION VersionError window — maintainer ruling, #1164 issue comment 5669811466) returns a named outcome instead of rejecting after archives are already handled (PWA review Minor r4008640266)', async () => {
    vi.mocked(saveRegionPin).mockRejectedValueOnce(new Error('VersionError'));
    // Zero required regions keeps this test focused on the write failure
    // alone — no archive fetch is needed to exercise the saveRegionPin path.
    const zeroRegionManifest = { ...manifest(), regions: [] };
    const { fake } = stubEnv({ manifest: zeroRegionManifest });
    await seedManifestInCache(fake, zeroRegionManifest);
    const plan = makePlan('p1', [[leg()]]);

    await expect(pinRegionsForPlan(plan)).resolves.toEqual({
      status: 'pin-record-failed',
      total: 0,
      pinned: 0,
    });
  });
});
