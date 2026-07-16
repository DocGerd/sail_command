/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { matchPrecache, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { createPartialResponse } from 'workbox-range-requests';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { GLYPH_CACHE_NAME, isGlyphPath } from './lib/glyphs';

// MUST be registered before precacheAndRoute: first-registered route wins, and the
// default precache route replays a full 200 to Range requests, which makes
// pmtiles' FetchSource throw (verified against pmtiles 4.4.1 source).
registerRoute(
  ({ url }) => url.pathname.endsWith('.pmtiles'),
  async ({ request }) => {
    const full = await matchPrecache(request.url);
    if (full) {
      return request.headers.has('range') ? createPartialResponse(request, full) : full;
    }
    // Cache miss, e.g. a file exceeding maximumFileSizeToCacheInBytes was
    // dropped from the manifest at build time (the SW never runs in dev —
    // devOptions is disabled).
    console.warn('[sw] pmtiles precache miss, falling through to network:', request.url);
    return fetch(request);
  },
);

// #28: font glyph ranges are runtime-cached, not precached — see
// GLYPH_CACHE_NAME's comment (src/lib/glyphs.ts) for the install-budget
// rationale and vite.config.ts's globIgnores for the manifest-side half.
// CacheFirst is correct here: a given glyph range's bytes never change for
// a given basemap release. Offline coverage converges via on-demand map
// fetches plus the app-side warm-up (src/services/glyphWarmup.ts).
// Scoping (fails review if loosened): `sameOrigin` plus isGlyphPath's
// path-prefix + .pbf check means this route can never match the Open-Meteo
// origin (which the SW must NEVER cache — wind lives per plan in IndexedDB)
// nor `.pmtiles` requests (owned by the Range→206 route above, which must
// stay the FIRST registration).
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isGlyphPath(url.pathname),
  new CacheFirst({ cacheName: GLYPH_CACHE_NAME }),
);

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
