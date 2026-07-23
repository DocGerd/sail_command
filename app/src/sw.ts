/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { matchPrecache, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { createPartialResponse } from 'workbox-range-requests';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { isBasemapArchivePath } from './lib/basemap';
import { GLYPH_CACHE_NAME, isGlyphPath, isRetiredGlyphCache } from './lib/glyphs';

// MUST be registered before precacheAndRoute: first-registered route wins, and the
// default precache route replays a full 200 to Range requests, which makes
// pmtiles' FetchSource throw (verified against pmtiles 4.4.1 source).
// #118: the archive is deployed as `basemap.pmtiles.png` (the .png masquerade
// dodges the CDN's gzip-of-range mangling for UNCONTROLLED pages — see
// src/lib/basemap.ts); the predicate still owns the legacy bare `.pmtiles`
// shape so an installed SW updating across the rename keeps serving it.
registerRoute(
  ({ url }) => isBasemapArchivePath(url.pathname),
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
// nor basemap-archive requests (`.pmtiles.png`/legacy `.pmtiles`, owned by
// the Range→206 route above, which must stay the FIRST registration).
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && isGlyphPath(url.pathname),
  new CacheFirst({ cacheName: GLYPH_CACHE_NAME }),
);

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

// #28 (glyph cache lifecycle): cleanupOutdatedCaches() above only manages
// workbox's PRECACHE caches — a GLYPH_CACHE_VERSION bump would leak the
// retired runtime cache's ~11 MB forever without this. Bounded work (one
// caches.keys() + targeted deletes of THIS deployment's retired glyph caches),
// so extending activate via waitUntil is fine here; it does not delay page
// takeover — clientsClaim() registers its own activate listener whose
// clients.claim() call fires regardless of this handler's pending waitUntil.
// #96: isRetiredGlyphCache is scoped to this deployment's BASE_URL (statically
// replaced in this injectManifest bundle) so a UAT deploy never evicts
// production's live glyph cache (or vice versa) on the shared Pages origin.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => isRetiredGlyphCache(name, import.meta.env.BASE_URL))
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
