/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { matchPrecache, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  respondToBasemapArchiveRequest,
  isRetiredBasemapRuntimeCache,
} from './lib/basemapArchiveRoute';
import { isBasemapArchivePath } from './lib/basemap';
import { regionCacheName } from './lib/basemapRegions';
import { GLYPH_CACHE_NAME, isGlyphPath } from './lib/glyphs';

// MUST be registered before precacheAndRoute: first-registered route wins, and the
// default precache route replays a full 200 to Range requests, which makes
// pmtiles' FetchSource throw (verified against pmtiles 4.4.1 source).
// #118: the archive is deployed as `basemap.pmtiles.png` (the .png masquerade
// dodges the CDN's gzip-of-range mangling for UNCONTROLLED pages — see
// src/lib/basemap.ts). The legacy bare `.pmtiles` shape stays OWNED BY THIS
// ROUTE for the update transition — but the new precache holds only the
// renamed file, so a legacy request matchPrecache-MISSES and degrades to a
// network fetch (404 post-rename), self-healing on the update reload.
// #1164 T3: also serves a PINNED per-region archive from its runtime cache —
// see lib/basemapArchiveRoute.ts's own header for the full precache -> region
// cache -> network order and why a miss never writes to any cache here.
registerRoute(
  ({ url }) => isBasemapArchivePath(url.pathname),
  ({ request }) =>
    respondToBasemapArchiveRequest(request, {
      matchPrecache: (url) => matchPrecache(url),
      openRegionCache: () => caches.open(regionCacheName(import.meta.env.BASE_URL)),
      fetch: (req) => fetch(req),
      warn: (...args) => console.warn(...args),
    }),
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
// #1164 T3: isRetiredBasemapRuntimeCache (lib/basemapArchiveRoute.ts) ALSO
// deletes this deployment's retired region caches on a REGION_CACHE_VERSION
// bump — same deployment-scoping guarantee, composed there so it stays
// unit-testable (this handler itself is not: jsdom has no real
// ServiceWorker/activate event).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter(isRetiredBasemapRuntimeCache(import.meta.env.BASE_URL))
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
