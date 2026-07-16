/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

import { clientsClaim } from 'workbox-core';
import { matchPrecache, precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { createPartialResponse } from 'workbox-range-requests';
import { registerRoute } from 'workbox-routing';

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
    return fetch(request); // dev / cache-miss fallthrough
  },
);

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});
