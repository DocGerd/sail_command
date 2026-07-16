// #28: background warm-up of the font glyph runtime cache.
//
// Fonts are excluded from the SW precache (vite.config.ts globIgnores) so
// the install stays within the browser's install-event budget; sw.ts serves
// them through a runtime CacheFirst route instead. The trade-off: a glyph
// range the map never requested while online would be unavailable offline.
// This module closes that gap from the WINDOW side — never from the SW's
// install/activate waitUntil, which must not grow (install already awaits
// the ~33 MB precache) — by fetching every not-yet-cached range once the
// SW controls the page and the app is idle.
//
// Resilience contract (issue #28): every failure here is non-fatal and
// silent — a missed range is simply retried on the next visit because the
// cache.keys() diff below will still list it. The warm-up never runs while
// offline and bails mid-run if the connection drops.
import { GLYPH_CACHE_NAME, GLYPH_MANIFEST_PATH } from '../lib/glyphs';

/**
 * Terminal states: 'done' = every manifest range was fetched (or already
 * cached) this run; 'partial' = some fetches failed or the connection
 * dropped mid-run (retried next visit); 'skipped' = preconditions unmet
 * (no SW/Cache API, offline at start, or no usable manifest — which only
 * happens under a STALE controlling SW; in dev the run never gets that far,
 * it parks in whenControlled() because no SW ever registers).
 */
export type GlyphWarmupOutcome = 'done' | 'partial' | 'skipped';

declare global {
  interface Window {
    /**
     * Test-facing terminal state of the glyph warm-up. offline.spec.ts
     * waits for 'done' before killing the preview server — the deterministic
     * signal that the offline reload's labels can only come from the cache.
     */
    __sailGlyphWarmup?: GlyphWarmupOutcome;
  }
}

// Small enough to stay polite to the main thread and the connection (the
// ranges are mostly a few KB to ~50 KB, avg ~14 KB, with a CJK-heavy tail
// running larger); large enough that ~768 ranges warm in a few seconds on
// a decent link.
const BATCH_SIZE = 8;

function whenControlled(): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  // No controller and none ever arriving (e.g. dev mode, where no SW is
  // registered at all, or a hard reload that bypassed the controller):
  // this promise simply stays pending — one dormant listener, no timers,
  // and the warm-up just doesn't happen this visit.
  return new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
  });
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      // The timeout caps how long first-load work (map style parse, asset
      // fetches, a running plan) can defer the warm-up.
      window.requestIdleCallback(() => resolve(), { timeout: 5_000 });
    } else {
      setTimeout(resolve, 1_000);
    }
  });
}

async function fetchManifest(): Promise<string[] | null> {
  let manifest: string[] | null = null;
  try {
    const res = await fetch(import.meta.env.BASE_URL + GLYPH_MANIFEST_PATH);
    if (res.ok) {
      const data: unknown = await res.json();
      if (Array.isArray(data) && data.every((p): p is string => typeof p === 'string')) {
        manifest = data;
      }
    }
  } catch {
    // fall through to the shared warn below
  }
  if (!manifest) {
    // Reachable only under a controlling SW whose precache predates the
    // manifest (a stale deploy) or a genuinely broken response — never in
    // dev, where whenControlled() parks forever before this fetch. warn,
    // not error: this is a degraded-but-working state (glyph coverage
    // still grows on demand), and the offline e2e's console collector
    // rightly treats type=error as a failure.
    console.warn(
      '[glyphWarmup] glyph manifest unavailable; offline glyph coverage grows on demand only',
    );
  }
  return manifest;
}

async function warmOne(href: string): Promise<boolean> {
  try {
    // Plain fetch on a controlled page: sw.ts's CacheFirst glyph route is
    // what actually populates the cache, so warmed entries are cached
    // exactly like map-demanded ones. Same-origin static asset only — the
    // manifest can never name the Open-Meteo origin (it's generated from
    // public/basemap-assets/fonts/ at build time).
    const res = await fetch(href);
    if (!res.ok) return false;
    // Drain our branch of the body: the SW caches a clone, and a cloned
    // stream only finishes when both branches are consumed.
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** Core warm-up; exported for unit tests. Use scheduleGlyphWarmup() in app code. */
export async function runGlyphWarmup(): Promise<GlyphWarmupOutcome> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) return 'skipped';
  await whenControlled();
  await whenIdle();
  if (!navigator.onLine) return 'skipped';

  const paths = await fetchManifest();
  if (!paths) return 'skipped';

  const cache = await caches.open(GLYPH_CACHE_NAME);
  const cachedUrls = new Set((await cache.keys()).map((req) => req.url));
  const missing = paths
    .map((path) => new URL(import.meta.env.BASE_URL + path, location.href).href)
    .filter((href) => !cachedUrls.has(href));

  let failed = 0;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    // Connection dropped mid-run: stop burning failed fetches; whatever is
    // still missing is picked up on the next visit.
    if (!navigator.onLine) return 'partial';
    const batch = missing.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(warmOne));
    failed += results.filter((ok) => !ok).length;
  }
  return failed === 0 ? 'done' : 'partial';
}

let scheduled: Promise<GlyphWarmupOutcome> | null = null;

/**
 * Fire-and-forget entry point (main.tsx). Idempotent per page load; never
 * rejects (any unexpected error degrades to 'skipped' — see the resilience
 * contract in the module comment).
 */
export function scheduleGlyphWarmup(): Promise<GlyphWarmupOutcome> {
  scheduled ??= runGlyphWarmup()
    .catch((err: unknown): GlyphWarmupOutcome => {
      // Unexpected — every anticipated failure path already resolves as
      // 'skipped'/'partial' inside runGlyphWarmup. Surfaced as warn, kept
      // non-fatal per the module's resilience contract.
      console.warn('[glyphWarmup] failed', err);
      return 'skipped';
    })
    .then((outcome) => {
      window.__sailGlyphWarmup = outcome;
      return outcome;
    });
  return scheduled;
}
