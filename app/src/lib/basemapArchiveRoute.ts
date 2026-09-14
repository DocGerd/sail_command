// #1164 T3: extends sw.ts's basemap archive route (registered before
// precacheAndRoute — see that file's own comment, unchanged by this) to also
// serve pinned per-region archives from their runtime cache. The routing
// DECISION is extracted here as a pure, dependency-injected function so it is
// unit-testable without a real ServiceWorker (jsdom has none — CLAUDE.md).
// CacheStorage/Range/CDN semantics stay untested here; that assurance comes
// from app/e2e/offline.spec.ts and basemap-fallback.spec.ts (T6 extends this
// to a real pinned-region offline round trip).
//
// Order: PRECACHE (core, always precached) -> REGION RUNTIME CACHE (pinned
// regions only, T4 writes it — this route never does) -> NETWORK. A hit at
// either cache tier returns a `createPartialResponse` slice for a Range
// request, or the whole cached Response otherwise. A region cache MISS (never
// pinned, or evicted) falls straight to network — same fallback shape the
// pre-#1164 core-only route already used on a precache miss — so an offline
// unpinned-region request simply fails the network fetch rather than ever
// serving a full-body 200 as if it were a Range response (the pmtiles
// FetchSource hazard sw.ts's own header comment names).

import { createPartialResponse } from 'workbox-range-requests';
import { isRegionArchivePath, isRetiredRegionCache } from './basemapRegions';
import { isRetiredGlyphCache } from './glyphs';

export interface BasemapArchiveRouteDeps {
  /** workbox-precaching's matchPrecache, or a fake for tests. */
  readonly matchPrecache: (url: string) => Promise<Response | undefined>;
  /** Opens THIS deployment's region runtime cache (basemapRegions.ts's regionCacheName(base)). */
  readonly openRegionCache: () => Promise<Cache>;
  /** The real network fetch, or a fake for tests. */
  readonly fetch: (request: Request) => Promise<Response>;
  /** console.warn, injected so a test can assert on it without polluting real console output. */
  readonly warn: (...args: unknown[]) => void;
}

/**
 * Route handler for a request matching `isBasemapArchivePath` (core or
 * region, `.pmtiles`/`.pmtiles.png`). Never writes to any cache — a region
 * archive is populated only by the pin service (T4) via `cache.put`; this
 * route only READS the precache and the region runtime cache and otherwise
 * falls through to the network, exactly as sw.ts's pre-#1164 core-only
 * handler did on a precache miss.
 */
export async function respondToBasemapArchiveRequest(
  request: Request,
  deps: BasemapArchiveRouteDeps,
): Promise<Response> {
  const precached = await deps.matchPrecache(request.url);
  if (precached) {
    return request.headers.has('range') ? createPartialResponse(request, precached) : precached;
  }

  if (isRegionArchivePath(new URL(request.url).pathname)) {
    const regionCache = await deps.openRegionCache();
    const cached = await regionCache.match(request.url);
    if (cached) {
      return request.headers.has('range') ? createPartialResponse(request, cached) : cached;
    }
  }

  deps.warn('[sw] basemap archive cache miss, falling through to network:', request.url);
  return deps.fetch(request);
}

/**
 * Names of caches this deployment's `activate` handler should delete: retired
 * glyph caches (GLYPH_CACHE_VERSION bump) OR retired region caches
 * (REGION_CACHE_VERSION bump), both scoped to `base` so a UAT activation can
 * never evict production's caches and vice versa (#96 — the same
 * deployment-scoped-prefix reasoning `isRetiredGlyphCache`/
 * `isRetiredRegionCache` each carry individually; this composes the two so
 * sw.ts's own activate wiring — untestable, jsdom has no real ServiceWorker —
 * stays a one-line `names.filter(isRetiredBasemapRuntimeCache(base))` over
 * logic that IS pinned here).
 */
export function isRetiredBasemapRuntimeCache(base: string): (name: string) => boolean {
  return (name: string) => isRetiredGlyphCache(name, base) || isRetiredRegionCache(name, base);
}
