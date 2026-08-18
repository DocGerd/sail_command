import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_MASK_META, TEST_POLAR } from '../test/fixtures';
import type { Harbor, PolarTable } from '../types';
import type { SeamarkFeatureCollection } from '../lib/seamarkGeoJson';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const HARBORS: Harbor[] = [
  {
    id: 'h1',
    names: { de: 'Hafen', da: 'Havn', en: 'Harbor' },
    country: 'DE',
    snap: { lat: 54.5, lon: 10.0 },
  },
];
const SEAMARKS: SeamarkFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10.0, 54.5] },
      properties: { seamarkType: 'buoy_lateral', category: 'port', colour: 'red' },
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function maskArrayBuffer(): ArrayBuffer {
  const buf = new ArrayBuffer(TEST_MASK_META.rows * TEST_MASK_META.cols);
  new Uint8Array(buf).fill(200);
  return buf;
}

function fetchMock(overrides: Partial<Record<string, () => Response>> = {}) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (overrides.maskMeta && url.includes('mask.meta.json'))
      return Promise.resolve(overrides.maskMeta());
    if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
    if (overrides.maskBin && url.includes('mask.bin')) return Promise.resolve(overrides.maskBin());
    if (url.includes('mask.bin'))
      return Promise.resolve(new Response(maskArrayBuffer(), { status: 200 }));
    if (overrides.polarGenoa && url.includes('salona-45-genoa.json'))
      return Promise.resolve(overrides.polarGenoa());
    if (url.includes('salona-45-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (overrides.polarFock && url.includes('salona-45-fock.json'))
      return Promise.resolve(overrides.polarFock());
    if (url.includes('salona-45-fock.json')) return Promise.resolve(jsonResponse(FOCK));
    // #54 spec N: the two tier-C fleet boats' four tables. Served generically
    // and AFTER the salona-45 branches above, so the reference boat's two
    // overridable fixtures keep their identity (the assertions below still
    // distinguish TEST_POLAR from FOCK by value) while a new catalogue boat
    // does not have to be enumerated here to keep the suite running. What a
    // new boat DOES have to do is appear in the hand-written key list below —
    // that list is the guard, this branch is only plumbing.
    if (url.includes('/data/polars/')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (overrides.harbors && url.includes('harbors.json'))
      return Promise.resolve(overrides.harbors());
    if (url.includes('harbors.json')) return Promise.resolve(jsonResponse(HARBORS));
    if (overrides.seamarks && url.includes('seamarks.json'))
      return Promise.resolve(overrides.seamarks());
    if (url.includes('seamarks.json')) return Promise.resolve(jsonResponse(SEAMARKS));
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// One fetch per shipped asset: mask.meta.json + mask.bin + harbors.json +
// seamarks.json, plus one per catalogue boat x sail. #54 spec N took the
// catalogue from one boat to three, so the polar half went 2 -> 6 and this
// went 6 -> 10. HAND-WRITTEN, deliberately not derived from BOATS: these three
// assertions exist to catch a DUPLICATE or extra fetch (the module-cache rows
// below are the point), and a count computed from the same array the fetch
// manifest is built from could never fail (#388).
const EXPECTED_FETCHES = 10;

describe('loadRoutingAssets', () => {
  beforeEach(() => {
    // The module caches its result in a top-level singleton; force a fresh
    // module instance per test so each test's mock fetch is what gets cached,
    // not a previous test's.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches mask meta/buffer, both polars, harbors, and seamarks from BASE_URL-relative paths', async () => {
    const mock = fetchMock();
    vi.stubGlobal('fetch', mock);

    const { loadRoutingAssets } = await import('./assets');
    const assets = await loadRoutingAssets();

    expect(assets.maskMeta).toEqual(TEST_MASK_META);
    // #54: one key per catalogue boat x sail, `${boatId}/${sailId}`. The
    // expected list is HAND-WRITTEN, never derived from BOATS — deriving
    // needle and haystack from the same source is the #388 tautology, and
    // this row's whole job is to notice when the catalogue and the fetch
    // manifest stop agreeing.
    expect(Object.keys(assets.polars).sort()).toEqual([
      'elan-444/fock',
      'elan-444/genoa',
      'salona-44/fock',
      'salona-44/genoa',
      'salona-45/fock',
      'salona-45/genoa',
    ]);
    expect(assets.polars['salona-45/genoa']).toEqual(TEST_POLAR);
    expect(assets.polars['salona-45/fock']).toEqual(FOCK);
    expect(assets.harbors).toEqual(HARBORS);
    expect(assets.seamarks).toEqual(SEAMARKS);
    expect(new Uint8Array(assets.maskBuffer)).toEqual(new Uint8Array(maskArrayBuffer()));
    expect(mock).toHaveBeenCalledTimes(EXPECTED_FETCHES);
    for (const call of mock.mock.calls) {
      expect(String(call[0])).toContain(import.meta.env.BASE_URL);
    }
  });

  it('module-caches: a second call does not re-fetch and returns the same object', async () => {
    const mock = fetchMock();
    vi.stubGlobal('fetch', mock);

    const { loadRoutingAssets } = await import('./assets');
    const first = await loadRoutingAssets();
    const second = await loadRoutingAssets();

    expect(second).toBe(first);
    expect(mock).toHaveBeenCalledTimes(EXPECTED_FETCHES);
  });

  it('throws when a fetch response is not ok', async () => {
    const mock = fetchMock({ maskMeta: () => new Response('nope', { status: 500 }) });
    vi.stubGlobal('fetch', mock);

    const { loadRoutingAssets } = await import('./assets');
    await expect(loadRoutingAssets()).rejects.toThrow(/mask\.meta\.json/);
  });

  it('resets the cache on rejection so a later call retries instead of replaying the same failure', async () => {
    const failing = fetchMock({ maskMeta: () => new Response('nope', { status: 500 }) });
    vi.stubGlobal('fetch', failing);

    const { loadRoutingAssets } = await import('./assets');
    await expect(loadRoutingAssets()).rejects.toThrow(/mask\.meta\.json/);

    // Simulate the transient failure clearing up (e.g. a first-load network
    // blip) — a second call must re-fetch, not keep replaying the pinned
    // rejection.
    const healthy = fetchMock();
    vi.stubGlobal('fetch', healthy);

    const assets = await loadRoutingAssets();
    expect(assets.maskMeta).toEqual(TEST_MASK_META);
    expect(healthy).toHaveBeenCalledTimes(EXPECTED_FETCHES);
  });
});
