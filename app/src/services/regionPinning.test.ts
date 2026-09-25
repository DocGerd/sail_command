import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REGION_FETCH_STALL_MS,
  getRegionPinIntent,
  pinRegionsForPlan,
  regionDownloadBytes,
  regionReadiness,
} from './regionPinning';
import { __resetDbForTests, deletePlan, savePlan, saveRegionPin } from './db';
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
  // jsdom's Blob differs from Node's native Blob (basemapArchiveRoute.test.ts
  // has the precedent); readBodyWithStallWatchdog's `new Blob(chunks)` needs
  // the native one. Per-test (not beforeAll): afterEach unstubs every test.
  vi.stubGlobal('Blob', NodeBlob);
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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

    expect(await regionReadiness(plan)).toEqual({ state: 'ready', done: 0, total: 0 });
  });

  it('an empty leg list (fail-closed empty corridor) requires EVERY lazy region', async () => {
    const { fake } = stubEnv();
    await seedManifestInCache(fake, manifest());
    const plan = makePlan('p1', [[]]);
    await savePlan(plan);

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
    const p2 = makePlan('p2', [[]]);
    await savePlan(p2);
    const outcome = await pinRegionsForPlan(p2);
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
    await savePlan(plan);

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
    await savePlan(plan);
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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

    await pinRegionsForPlan(plan);

    const aUrl = BASE + m.regions[0].path;
    // The fetch URL carries a cache-busting `?pin=` suffix (see the
    // successor-fix test below), so match by PREFIX, not exact equality.
    const archiveFetchCall = fetchMock.mock.calls.find((call: unknown[]) =>
      (call[0] as string).startsWith(aUrl),
    );
    expect(archiveFetchCall?.[1]).toMatchObject({ cache: 'no-store' });
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
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const cache = await fake.open(REGION_CACHE_NAME);
    expect(await cache.match(BASE + m.regions[0].path)).toBeUndefined();
    expect(await regionReadiness(plan)).toEqual({ state: 'not-ready', reason: 'pending' });
  });

  it('a malformed manifest pins NOTHING and records no pin intent', async () => {
    const { fake, fetchMock } = stubEnv({ manifest: 'malformed' });
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);

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
    await savePlan(plan);

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
    await savePlan(plan);

    expect(await pinRegionsForPlan(plan)).toEqual({ status: 'manifest-unavailable' });
  });

  it('zero required regions: pins nothing, records an empty intent, and reports ready', async () => {
    const zeroRegionManifest = { ...manifest(), regions: [] };
    const { fake, fetchMock } = stubEnv({ manifest: zeroRegionManifest });
    await seedManifestInCache(fake, zeroRegionManifest);
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);

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
    await savePlan(plan);
    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });
    // No archive fetch at all — the archive was already present and must
    // not be re-fetched (not even through the cache-busting `?pin=` URL, so
    // this checks by PREFIX, never an exact bare-URL match — every real
    // archive fetch now goes through a `?pin=` URL, so an exact-match check
    // against the bare url would be vacuously true regardless of whether a
    // fetch happened).
    const archiveFetches = fetchMock.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).startsWith(aUrl),
    );
    expect(archiveFetches).toHaveLength(0);
  });

  it('a FAILED re-fetch of a stale-length entry (e.g. offline) leaves the existing entry INTACT — never delete-before-fetch (successor fix, PR review r4009096166)', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({ manifest: m });
    await seedManifestInCache(fake, m);
    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    // A stale entry from a previous build: wrong length, so isArchivePresent
    // reads it as absent — but the map can still be served 206s from it
    // until a VERIFIED replacement exists.
    await cache.put(
      aUrl,
      new Response(new Uint8Array(999), { headers: { 'content-length': '999' } }),
    );

    // Simulate offline: every archive fetch throws (the manifest is already
    // cache-resident via seedManifestInCache, so this never needs network).
    fetchMock.mockImplementation(async (input: string) => {
      if (input === MANIFEST_URL) return new Response(JSON.stringify(m), { status: 200 });
      throw new TypeError('Failed to fetch');
    });

    const plan = makePlan('p1', [[leg()]]); // requires region-a only
    await savePlan(plan);
    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    // The STALE entry must still be there — a failed re-pin must never have
    // deleted it first.
    const stillCached = await cache.match(aUrl);
    expect(stillCached).toBeDefined();
    expect(Number(stillCached?.headers.get('content-length'))).toBe(999);
  });

  it('a SUCCESSFUL re-fetch of a stale-length entry overwrites it in place (cache.put replaces — no delete needed)', async () => {
    const m = manifest();
    const { fake } = stubEnv({ manifest: m, archiveBody: () => pmtilesBytes(m.regions[0].bytes) });
    await seedManifestInCache(fake, m);
    const cache = await fake.open(REGION_CACHE_NAME);
    const aUrl = BASE + m.regions[0].path;
    await cache.put(
      aUrl,
      new Response(new Uint8Array(999), { headers: { 'content-length': '999' } }),
    );

    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);
    const outcome = await pinRegionsForPlan(plan);
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });

    const cached = await cache.match(aUrl);
    expect(Number(cached?.headers.get('content-length'))).toBe(m.regions[0].bytes);
  });

  it('fetches through a cache-busting `?pin=` URL, but cache.put stores the archive under the CANONICAL search-less URL (#1223 basemapArchiveRoute.ts does an EXACT-URL region-cache match with no ignoreSearch, so `?pin=` is what makes it miss and fall through to network)', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({
      manifest: m,
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
    });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);

    await pinRegionsForPlan(plan);

    const aUrl = BASE + m.regions[0].path;
    const archiveFetchCall = fetchMock.mock.calls.find((call: unknown[]) =>
      (call[0] as string).startsWith(aUrl),
    );
    expect(archiveFetchCall?.[0]).toMatch(/\?pin=\d+$/);
    expect(archiveFetchCall?.[0]).not.toBe(aUrl);

    const cache = await fake.open(REGION_CACHE_NAME);
    // EXACT match (no ignoreSearch, mirroring basemapArchiveRoute.ts's own
    // region-cache lookup) — only succeeds if the STORED key is bit-for-bit
    // the canonical URL, never the `?pin=`-suffixed one.
    expect(await cache.match(aUrl)).toBeDefined();
  });

  it('a saveRegionPin failure (e.g. the cross-deployment DB_VERSION VersionError window — maintainer ruling, #1164 issue comment 5669811466) returns a named outcome instead of rejecting after archives are already handled (PWA review Minor r4008640266)', async () => {
    vi.mocked(saveRegionPin).mockRejectedValueOnce(new Error('VersionError'));
    // Zero required regions keeps this test focused on the write failure
    // alone — no archive fetch is needed to exercise the saveRegionPin path.
    const zeroRegionManifest = { ...manifest(), regions: [] };
    const { fake } = stubEnv({ manifest: zeroRegionManifest });
    await seedManifestInCache(fake, zeroRegionManifest);
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);

    await expect(pinRegionsForPlan(plan)).resolves.toEqual({
      status: 'pin-record-failed',
      total: 0,
      pinned: 0,
    });
  });
});

describe('#1233 Major (offline/PWA review): delete-during-pin race', () => {
  it('a plan deleted while its archive is still in flight leaves NO orphaned pin record', async () => {
    const m = manifest();
    const fake = new FakeCacheStorage();
    vi.stubGlobal('caches', fake);
    await seedManifestInCache(fake, m);

    const aUrl = BASE + m.regions[0].path;
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async (input: string) => {
      if (input.startsWith(aUrl)) {
        fetchStarted();
        await gate; // held open until the test releases it below
        return new Response(pmtilesBytes(m.regions[0].bytes), { status: 200 });
      }
      return new Response(JSON.stringify(m), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = makePlan('p-race', [[leg()]]);
    await savePlan(plan);

    const pinPromise = pinRegionsForPlan(plan);
    await started; // the archive fetch is now in flight
    await deletePlan('p-race');
    releaseFetch();
    const outcome = await pinPromise;

    expect(outcome.status).toBe('plan-gone');
    expect(await getRegionPinIntent('p-race')).toBeUndefined();
  });
});

describe('#1233 Major 2 (offline/PWA review): in-flight archive fetch coalescing', () => {
  it('5 concurrent pins of plans sharing one region produce exactly 1 fetch of that archive', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({
      manifest: m,
      archiveBody: () => pmtilesBytes(m.regions[0].bytes),
    });
    await seedManifestInCache(fake, m);

    const plans = Array.from({ length: 5 }, (_, i) => makePlan(`p${i}`, [[leg()]]));
    await Promise.all(plans.map((p) => savePlan(p)));

    const outcomes = await Promise.all(plans.map((p) => pinRegionsForPlan(p)));

    for (const outcome of outcomes) {
      expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });
    }
    const aUrl = BASE + m.regions[0].path;
    const archiveFetches = fetchMock.mock.calls.filter((call: unknown[]) =>
      (call[0] as string).startsWith(aUrl),
    );
    expect(archiveFetches).toHaveLength(1);
  });

  // #1246 residual (PR #1242 review r4009096166): the map entry's `.finally`
  // must clear it on FAILURE too, or a later, SEPARATE (non-concurrent) pin
  // for the same region would forever reuse the first attempt's resolved
  // `false` instead of trying again.
  it('a failed attempt clears the coalescing entry — a later, separate call re-fetches and can succeed', async () => {
    const m = manifest();
    const { fake } = stubEnv({ manifest: m });
    await seedManifestInCache(fake, m);
    const aUrl = BASE + m.regions[0].path;
    let archiveCalls = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input === MANIFEST_URL) return new Response(JSON.stringify(m), { status: 200 });
      if (String(input).startsWith(aUrl)) {
        archiveCalls += 1;
        // FIRST attempt fails; every later one succeeds.
        if (archiveCalls === 1) return new Response('nope', { status: 500 });
        return new Response(pmtilesBytes(m.regions[0].bytes), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan1 = makePlan('p1', [[leg()]]);
    await savePlan(plan1);
    expect(await pinRegionsForPlan(plan1)).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const plan2 = makePlan('p2', [[leg()]]);
    await savePlan(plan2);
    expect(await pinRegionsForPlan(plan2)).toEqual({ status: 'pinned', total: 1, pinned: 1 });

    expect(archiveCalls).toBe(2);
  });

  // #1246 residual (PR #1480 review 5311114321): the coalescing key was `url`
  // alone, so a waiter for a DIFFERENT manifest entry sharing the same
  // archive URL (e.g. two live manifests across an SW update) could accept a
  // `true` verified against the OTHER entry's byte count. Two regions here
  // deliberately share ONE archive path but declare DIFFERENT `bytes` —
  // constructible because parseRegionManifest/requiredRegions key on `id`,
  // never dedupe by `path`.
  it('two concurrent pins for the SAME archive url but DIFFERENT manifest byte counts never share one verified result', async () => {
    const sharedPath = `data/${REGION_ARCHIVE_PREFIX}shared.pmtiles.png`;
    const sharedUrl = BASE + sharedPath;
    const m: RegionManifest = {
      core: manifest().core,
      regions: [
        { id: 'region-a', path: sharedPath, bytes: 1024, bbox: REGION_A_BBOX },
        { id: 'region-x', path: sharedPath, bytes: 2048, bbox: REGION_B_BBOX },
      ],
    };
    const { fake } = stubEnv({ manifest: m });
    await seedManifestInCache(fake, m);

    // Both concurrent fetches of the shared url are held open until BOTH
    // callers have started, then released together with a body that only
    // satisfies region-a's 1024 B — a waiter sharing region-a's in-flight
    // result WITHOUT checking its own 2048 B requirement would incorrectly
    // report region-x as pinned too.
    let releaseArchiveFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseArchiveFetch = resolve;
    });
    const fetchMock = vi.fn(async (input: string) => {
      if (input === MANIFEST_URL) return new Response(JSON.stringify(m), { status: 200 });
      if (String(input).startsWith(sharedUrl)) {
        await gate;
        return new Response(pmtilesBytes(1024), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const planA = makePlan('pA', [[leg()]]); // requires region-a only
    const planX = makePlan('pX', [
      [leg({ start: { lat: 60.5, lon: 20.5 }, end: { lat: 60.5, lon: 20.52 } })],
    ]); // requires region-x only
    await savePlan(planA);
    await savePlan(planX);

    const pendingA = pinRegionsForPlan(planA);
    // Let planA's pinOneRegion reach and start its (gated) fetch — creating
    // its in-flight entry — before planX starts.
    await Promise.resolve();
    await Promise.resolve();
    const pendingX = pinRegionsForPlan(planX);
    await Promise.resolve();
    await Promise.resolve();

    releaseArchiveFetch();
    const [outcomeA, outcomeX] = await Promise.all([pendingA, pendingX]);

    expect(outcomeA).toEqual({ status: 'pinned', total: 1, pinned: 1 });
    // planX's own 2048 B requirement is NEVER met by the served 1024 B body.
    expect(outcomeX).toEqual({ status: 'pinned', total: 1, pinned: 0 });

    const archiveFetches = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).startsWith(sharedUrl),
    );
    expect(archiveFetches).toHaveLength(2);
  });
});

// #295 (PWA review r4016341249): the chip's download size.
describe('regionDownloadBytes', () => {
  it('sums the required regions from the cached manifest', async () => {
    const { fake, fetchMock } = stubEnv();
    await seedManifestInCache(fake, manifest({ a: 12_603_919 }));
    expect(await regionDownloadBytes(makePlan('p1', [[leg()]]))).toBe(12_603_919);
    // An empty corridor requires every region (fail-closed), so both count.
    expect(await regionDownloadBytes(makePlan('p2', [[]]))).toBe(12_603_919 + 2048);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is 0 when no region is required and null without a cached manifest', async () => {
    const { fake } = stubEnv();
    expect(await regionDownloadBytes(makePlan('p1', [[leg()]]))).toBeNull();
    await seedManifestInCache(fake, { ...manifest(), regions: [] });
    expect(await regionDownloadBytes(makePlan('p1', [[leg()]]))).toBe(0);
  });
});

// #295 (PWA review r4016341243) / #1253: a stalled archive download must
// settle so the chip can offer a retry — but the watchdog is now a
// NO-PROGRESS timer, not a whole-download deadline sized from the archive's
// total bytes (see fetchAndCacheRegion's own comment for why).
describe('region fetch deadline', () => {
  it('aborts a fetch that never even returns a response, at REGION_FETCH_STALL_MS', async () => {
    const m = manifest();
    const { fake, fetchMock } = stubEnv({ manifest: m });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);
    const aUrl = BASE + m.regions[0].path;
    let aborted = false;
    fetchMock.mockImplementation(
      (input: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (!input.startsWith(aUrl)) {
            resolve(new Response(JSON.stringify(m), { status: 200 }));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: Awaited<ReturnType<typeof pinRegionsForPlan>> | undefined;
    const pending = pinRegionsForPlan(plan).then((o) => (outcome = o));
    try {
      for (
        let i = 0;
        i < 100 && !fetchMock.mock.calls.some((c) => String(c[0]).startsWith(aUrl));
        i++
      ) {
        await Promise.resolve();
      }
      expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith(aUrl))).toBe(true);
      vi.advanceTimersByTime(REGION_FETCH_STALL_MS - 1);
      expect(aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await pending;
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 0 });
  });

  it('a slow-but-moving download (every gap under the stall window) still completes, where the OLD whole-download deadline for this small archive would already have aborted it', async () => {
    // region-a's fixture size is 1024 B, well under the old floor's 60 s
    // minimum — so the old regionFetchTimeoutMs(1024) deadline was exactly
    // REGION_FETCH_STALL_MS. Two gaps just under that, delivered
    // sequentially, sum to ~2x it: the old whole-download deadline would
    // have fired partway through the second gap; the new per-gap watchdog
    // never sees a gap that long and lets it finish. The body is a hand-
    // rolled `getReader().read()` (not a real ReadableStream/Response) so
    // its only timing dependency is the SAME faked setTimeout the watchdog
    // itself uses — fetchAndCacheRegion never reads anything else off `res`
    // once past `res.ok`.
    const m = manifest();
    const { fake } = stubEnv({ manifest: m });
    await seedManifestInCache(fake, m);
    const plan = makePlan('p1', [[leg()]]);
    await savePlan(plan);
    const aUrl = BASE + m.regions[0].path;
    const full = pmtilesBytes(m.regions[0].bytes);
    const half = Math.ceil(full.length / 2);
    const chunks = [full.slice(0, half), full.slice(half)];

    const gapMs = REGION_FETCH_STALL_MS - 1000;
    let chunkIndex = 0;
    // The synthetic reader listens on `init.signal` exactly like a real
    // ReadableStream would — required for this test to be a genuine
    // discriminator: without it, fetchAndCacheRegion's abort() call would
    // have no observable effect here and the test would pass regardless of
    // whether progress actually re-arms the watchdog.
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input === MANIFEST_URL) return new Response(JSON.stringify(m), { status: 200 });
      if (!String(input).startsWith(aUrl)) return new Response('', { status: 404 });
      const signal = init?.signal;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                const onAbort = () => {
                  clearTimeout(timer);
                  reject(new DOMException('aborted', 'AbortError'));
                };
                const timer = setTimeout(() => {
                  signal?.removeEventListener('abort', onAbort);
                  if (chunkIndex < chunks.length) {
                    resolve({ done: false, value: chunks[chunkIndex] });
                    chunkIndex += 1;
                  } else {
                    resolve({ done: true, value: undefined });
                  }
                }, gapMs);
                signal?.addEventListener('abort', onAbort, { once: true });
              }),
          }),
        },
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome: Awaited<ReturnType<typeof pinRegionsForPlan>> | undefined;
    const pending = pinRegionsForPlan(plan).then((o) => (outcome = o));
    try {
      await vi.advanceTimersByTimeAsync(3 * gapMs);
    } finally {
      vi.useRealTimers();
    }
    await pending;
    expect(outcome).toEqual({ status: 'pinned', total: 1, pinned: 1 });
  });
});
