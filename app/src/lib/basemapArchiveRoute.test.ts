// #1164 T3: unit tests for the pure routing DECISION extracted from sw.ts.
// jsdom has no real ServiceWorker/CacheStorage, so this deliberately does NOT
// model real Range/CDN semantics — it uses the SAME workbox-range-requests
// createPartialResponse() sw.ts calls, against fake matchPrecache/Cache/fetch
// dependencies, to pin the ORDERING decision (precache -> region cache ->
// network) and the "never writes a cache" invariant. Functional CacheStorage/
// Range/CDN assurance comes from app/e2e/offline.spec.ts and
// basemap-fallback.spec.ts (see that file's own comment).

import { Blob as NodeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assertNonVacuousStrip, stripCommentsAndStrings } from '../test/sourceStrip';
import {
  respondToBasemapArchiveRequest,
  isRetiredBasemapRuntimeCache,
  type BasemapArchiveRouteDeps,
} from './basemapArchiveRoute';

// #1223 review r4008955321: jsdom and Node disagree on which `Blob` is
// global, and `createPartialResponse` (workbox-range-requests) calls
// `originalResponse.blob()`. Node 22.23.2 (CI) rejects the result against
// its OWN Blob (workbox's dev-mode instanceof assert throws -> 416, the
// required `app` check's actual CI failure); Node 24.15.0 accepts it but
// undici's `new Response(slicedBlob)` stringifies the Blob body to the
// literal `"[object Blob]"`, so a status/Content-Length-only assertion
// passes with the WRONG bytes. Stubbing node:buffer's Blob as the global
// makes the slice correct on BOTH Node versions. TEST-ONLY: sw.ts's real
// route runs inside a Chromium ServiceWorker, which has exactly one
// native, standards-correct Blob — this divergence is a Node/jsdom
// test-environment artifact, never a production one.
beforeAll(() => {
  vi.stubGlobal('Blob', NodeBlob);
});

const CORE_URL = 'https://example.test/sail_command/data/basemap.pmtiles.png';
const REGION_URL = 'https://example.test/sail_command/data/region-abc.pmtiles.png';

/**
 * sw.ts's own source, comments/strings stripped (#1223 review r4008628003):
 * a raw `indexOf` over unstripped source is fooled by a MENTION of a needle
 * inside a comment, so a mutation moving `precacheAndRoute` above the
 * archive route while leaving the needle in a comment stayed 11/11 green.
 * `stripCommentsAndStrings` removes comments outright (never merely masks
 * them), so a commented-out mention cannot satisfy indexOf after stripping.
 */
function readStrippedSwSource(): string {
  const swPath = resolve(dirname(fileURLToPath(import.meta.url)), '../sw.ts');
  return stripCommentsAndStrings(readFileSync(swPath, 'utf8'));
}

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
    const body = new Response('0123456789abcdefghijklmnopqrstuv', { status: 200 });
    const d = deps({ matchPrecache: async () => body });
    const req = new Request(CORE_URL, { headers: { Range: 'bytes=10-19' } });
    const res = await respondToBasemapArchiveRequest(req, d);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Content-Range')).toBe('bytes 10-19/32');
    expect(await res.text()).toBe('abcdefghij');
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
    const body = new Response('0123456789abcdefghijklmnopqrstuv', { status: 200 });
    const cache = fakeCache(new Map([[REGION_URL, body]]));
    const d = deps({ openRegionCache: async () => cache });
    const req = new Request(REGION_URL, { headers: { Range: 'bytes=0-7' } });
    const res = await respondToBasemapArchiveRequest(req, d);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Length')).toBe('8');
    expect(res.headers.get('Content-Range')).toBe('bytes 0-7/32');
    expect(await res.text()).toBe('01234567');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('falls through to the network for an UNPINNED region, and never populates the region cache', async () => {
    const cache = fakeCache(new Map());
    const d = deps({ openRegionCache: async () => cache });
    const res = await respondToBasemapArchiveRequest(new Request(REGION_URL), d);
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.put).not.toHaveBeenCalled();
    expect(await res.text()).toBe('network');
    // #1223 review r4008628015: an unpinned region's miss is the NORMAL
    // pre-pin state (fires on every Range read of an online unpinned
    // region) — it must stay SILENT so it never buries the one diagnostic
    // this warn exists for, an exceptional CORE/legacy precache miss.
    expect(d.warnSpy).not.toHaveBeenCalled();
  });

  it('forwards the Range header to the network on an UNPINNED region fall-through (#1223 review r4008628020)', async () => {
    const cache = fakeCache(new Map());
    const d = deps({ openRegionCache: async () => cache });
    const req = new Request(REGION_URL, { headers: { Range: 'bytes=0-15' } });
    await respondToBasemapArchiveRequest(req, d);
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
    const forwarded = d.fetchSpy.mock.calls[0]?.[0] as Request;
    expect(forwarded.headers.get('range')).toBe('bytes=0-15');
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('never opens the region cache for the CORE archive on a precache miss (legacy .pmtiles transition)', async () => {
    const openRegionCache = vi.fn(async () => fakeCache(new Map()));
    const d = deps({ openRegionCache });
    await respondToBasemapArchiveRequest(new Request(CORE_URL), d);
    expect(openRegionCache).not.toHaveBeenCalled();
    expect(d.fetchSpy).toHaveBeenCalledTimes(1);
    // #1223 review r4008628015: a CORE/legacy precache miss is the
    // EXCEPTIONAL case this warn exists to diagnose (e.g. an archive
    // dropped by maximumFileSizeToCacheInBytes) — it must still fire here.
    expect(d.warnSpy).toHaveBeenCalledWith(
      '[sw] basemap archive cache miss, falling through to network:',
      CORE_URL,
    );
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
    const stripped = readStrippedSwSource();
    assertNonVacuousStrip(stripped, 'isBasemapArchivePath', 'sw.ts');
    assertNonVacuousStrip(stripped, 'precacheAndRoute', 'sw.ts');

    const predicateIndex = stripped.indexOf('isBasemapArchivePath(url.pathname)');
    expect(predicateIndex).toBeGreaterThan(-1);
    // Anchor the route needle on registerRoute( PLUS the predicate (#1223
    // review r4008628003), tighter than the predicate alone: the nearest
    // preceding `registerRoute(` must sit close enough to be the SAME call.
    const routeIndex = stripped.lastIndexOf('registerRoute(', predicateIndex);
    expect(routeIndex).toBeGreaterThan(-1);
    expect(predicateIndex - routeIndex).toBeLessThan(200);

    const precacheIndex = stripped.indexOf('precacheAndRoute(self.__WB_MANIFEST)');
    expect(precacheIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeLessThan(precacheIndex);
  });

  it('the activate handler chains isRetiredBasemapRuntimeCache DIRECTLY into the delete .map (#1223 review r4008955333)', () => {
    const stripped = readStrippedSwSource();
    // 'activate' itself is a STRING literal, which stripCommentsAndStrings
    // masks to spaces (it strips comments outright but only MASKS string
    // content) — so the control needle here is `caches`, ordinary code,
    // not string content.
    assertNonVacuousStrip(stripped, 'caches', 'sw.ts');
    // A bare substring check on the filter call site alone is satisfied by
    // `.filter(isRetiredBasemapRuntimeCache(...)).filter(() => false)` — a
    // no-op chained AFTER the real filter, which stays green (#1223 review
    // r4008955333, measured: 13/13). Requiring `.map(` immediately
    // (only whitespace between) after the filter call's closing paren
    // means an inserted `.filter(...)` in between breaks the match, so
    // this reds on that exact mutation.
    expect(stripped).toMatch(
      /\.filter\(isRetiredBasemapRuntimeCache\(import\.meta\.env\.BASE_URL\)\)\s*\.map\(/,
    );
  });
});
