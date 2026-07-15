import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_MASK_META, TEST_POLAR } from '../test/fixtures';
import type { Harbor, PolarTable } from '../types';

const FOCK: PolarTable = { ...TEST_POLAR, rig: 'fock' };
const HARBORS: Harbor[] = [
  { id: 'h1', names: { de: 'Hafen', da: 'Havn', en: 'Harbor' }, country: 'DE', snap: { lat: 54.5, lon: 10.0 } },
];

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
    if (overrides.maskMeta && url.includes('mask.meta.json')) return Promise.resolve(overrides.maskMeta());
    if (url.includes('mask.meta.json')) return Promise.resolve(jsonResponse(TEST_MASK_META));
    if (overrides.maskBin && url.includes('mask.bin')) return Promise.resolve(overrides.maskBin());
    if (url.includes('mask.bin')) return Promise.resolve(new Response(maskArrayBuffer(), { status: 200 }));
    if (overrides.polarGenoa && url.includes('polar-genoa.json')) return Promise.resolve(overrides.polarGenoa());
    if (url.includes('polar-genoa.json')) return Promise.resolve(jsonResponse(TEST_POLAR));
    if (overrides.polarFock && url.includes('polar-fock.json')) return Promise.resolve(overrides.polarFock());
    if (url.includes('polar-fock.json')) return Promise.resolve(jsonResponse(FOCK));
    if (overrides.harbors && url.includes('harbors.json')) return Promise.resolve(overrides.harbors());
    if (url.includes('harbors.json')) return Promise.resolve(jsonResponse(HARBORS));
    throw new Error(`unexpected fetch: ${url}`);
  });
}

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

  it('fetches mask meta/buffer, both polars, and harbors from BASE_URL-relative paths', async () => {
    const mock = fetchMock();
    vi.stubGlobal('fetch', mock);

    const { loadRoutingAssets } = await import('./assets');
    const assets = await loadRoutingAssets();

    expect(assets.maskMeta).toEqual(TEST_MASK_META);
    expect(assets.polarGenoa).toEqual(TEST_POLAR);
    expect(assets.polarFock).toEqual(FOCK);
    expect(assets.harbors).toEqual(HARBORS);
    expect(new Uint8Array(assets.maskBuffer)).toEqual(new Uint8Array(maskArrayBuffer()));
    expect(mock).toHaveBeenCalledTimes(5);
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
    expect(mock).toHaveBeenCalledTimes(5);
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
    expect(healthy).toHaveBeenCalledTimes(5);
  });
});
