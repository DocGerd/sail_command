// #1164 T3: unit tests for the pure routing DECISION extracted from sw.ts.
// jsdom has no real ServiceWorker/CacheStorage, so this deliberately does NOT
// model real Range/CDN semantics — it uses the SAME workbox-range-requests
// createPartialResponse() sw.ts calls, against fake matchPrecache/Cache/fetch
// dependencies, to pin the ORDERING decision (precache -> region cache ->
// network) and the "never writes a cache" invariant. Functional CacheStorage/
// Range/CDN assurance comes from app/e2e/offline.spec.ts and
// basemap-fallback.spec.ts (see that file's own comment).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  respondToBasemapArchiveRequest,
  isRetiredBasemapRuntimeCache,
  type BasemapArchiveRouteDeps,
} from './basemapArchiveRoute';

const CORE_URL = 'https://example.test/sail_command/data/basemap.pmtiles.png';
const REGION_URL = 'https://example.test/sail_command/data/region-abc.pmtiles.png';

/** A fake Cache good enough for match()/put() call assertions — never a real CacheStorage. */
function fakeCache(
  entries: ReadonlyMap<string, Response>,
): Cache & { readonly put: ReturnType<typeof vi.fn> } {
  const put = vi.fn();
  return {
    put,
    match: async (request: RequestInfo | URL) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof Request
            ? request.url
            : request.toString();
      return entries.get(url);
    },
  } as unknown as Cache & { readonly put: ReturnType<typeof vi.fn> };
}

function deps(overrides: Partial<BasemapArchiveRouteDeps> = {}): BasemapArchiveRouteDeps & {
  readonly warnSpy: ReturnType<typeof vi.fn>;
  readonly fetchSpy: ReturnType<typeof vi.fn>;
} {
  const warnSpy = vi.fn();
  const fetchSpy = vi.fn(async () => new Response('network', { status: 200 }));
  return {
    matchPrecache: async () => undefined,
    openRegionCache: async () => fakeCache(new Map()),
    fetch: fetchSpy,
    warn: warnSpy,
    warnSpy,
    fetchSpy,
    ...overrides,
  };
}

describe('respondToBasemapArchiveRequest', () => {
  it('serves the CORE archive from the precache, full body for a non-Range request', async () => {
    const body = new Response('core-bytes', { status: 200 });
    const d = deps({ matchPrecache: async (url) => (url === CORE_URL ? body : undefined) });
    const res = await respondToBasemapArchiveRequest(new Request(CORE_URL), d);
    expect(res).toBe(body);
    expect(d.fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a 206 partial response from the precache for a Range request', async () => {
    const body = new Response('x'.repeat(32), { status: 200 });
    const d = deps({ matchPrecache: async () => body });
    const req = new Request(CORE_URL, { headers: { Range: 'bytes=0-15' } });
    const res = await respondToBasemapArchiveRequest(req, d);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Length')).toBe('16');
  });

  it('serves a PINNED region from its runtime cache, full body for a non-Range request', async () => {
    const body = new Response('region-bytes', { status: 200 });
    const cache = fakeCache(new Map([[REGION_URL, body]]));
    const d = deps({ openRegionCache: async () => cache });
    const res = await respondToBasemapArchiveRequest(new Request(REGION_URL), d);
    expect(res).toBe(body);
    expect(cache.put).not.toHaveBeenCalled();
    expect(d.fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a 206 partial response from the region cache for a Range request', async () => {
    const body = new Response('x'.repeat(64), { status: 200 });
    const cache = fakeCache(new Map([[REGION_URL, body]]));
    const d = deps({ openRegionCache: async () => cache });
    const req = new Request(REGION_URL, { headers: { Range: 'bytes=0-7' } });
    const res = await respondToBasemapArchiveRequest(req, d);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Length')).toBe('8');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('falls through to the network for an UNPINNED region, and never populates the region cache', async () => {
    const cache = fakeCache(new Map());
    const d = deps({ openRegionCache: async () => cache });
    const res = await respondToBasemapArchiveRequest(new Request(REGION_URL), d);
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    expect(await res.text()).toBe('network');
    expect(d.warnSpy).toHaveBeenCalledWith(
      '[sw] basemap archive cache miss, falling through to network:',
      REGION_URL,
    );
  });

  it('never opens the region cache for the CORE archive on a precache miss (legacy .pmtiles transition)', async () => {
    const openRegionCache = vi.fn(async () => fakeCache(new Map()));
    const d = deps({ openRegionCache });
    await respondToBasemapArchiveRequest(new Request(CORE_URL), d);
    expect(openRegionCache).not.toHaveBeenCalled();
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('isRetiredBasemapRuntimeCache (activate cleanup scoping, #96)', () => {
  const PROD_BASE = '/sail_command/';
  const UAT_BASE = '/sail_command/uat/';

  it("retires THIS deployment's own non-current-version REGION cache", () => {
    expect(isRetiredBasemapRuntimeCache(PROD_BASE)('sailcommand-regions-sail_command@v0')).toBe(
      true,
    );
    expect(isRetiredBasemapRuntimeCache(UAT_BASE)('sailcommand-regions-sail_command-uat@v0')).toBe(
      true,
    );
  });

  it("retires THIS deployment's own non-current-version GLYPH cache", () => {
    expect(isRetiredBasemapRuntimeCache(PROD_BASE)('sailcommand-glyphs-sail_command@v0')).toBe(
      true,
    );
    expect(isRetiredBasemapRuntimeCache(UAT_BASE)('sailcommand-glyphs-sail_command-uat@v0')).toBe(
      true,
    );
  });

  it("never evicts the SIBLING deployment's current caches (either family, either direction)", () => {
    expect(isRetiredBasemapRuntimeCache(PROD_BASE)('sailcommand-regions-sail_command-uat@v1')).toBe(
      false,
    );
    expect(isRetiredBasemapRuntimeCache(UAT_BASE)('sailcommand-regions-sail_command@v1')).toBe(
      false,
    );
    expect(isRetiredBasemapRuntimeCache(PROD_BASE)('sailcommand-glyphs-sail_command-uat@v1')).toBe(
      false,
    );
    expect(isRetiredBasemapRuntimeCache(UAT_BASE)('sailcommand-glyphs-sail_command@v1')).toBe(
      false,
    );
  });

  it('never matches an unrelated (e.g. workbox precache) cache name', () => {
    expect(
      isRetiredBasemapRuntimeCache(PROD_BASE)(
        'workbox-precache-v2-https://example.test/sail_command/',
      ),
    ).toBe(false);
  });
});

describe('#1164 T3: Range→206 route stays registered BEFORE precacheAndRoute (sw.ts)', () => {
  it('the basemap archive registerRoute call appears earlier in source than precacheAndRoute()', () => {
    const swPath = resolve(dirname(fileURLToPath(import.meta.url)), '../sw.ts');
    const source = readFileSync(swPath, 'utf8');
    const routeIndex = source.indexOf('isBasemapArchivePath(url.pathname)');
    const precacheIndex = source.indexOf('precacheAndRoute(self.__WB_MANIFEST)');
    expect(routeIndex).toBeGreaterThan(-1);
    expect(precacheIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeLessThan(precacheIndex);
  });
});
