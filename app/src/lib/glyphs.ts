// Shared between the service worker (src/sw.ts) and the window side
// (src/services/glyphWarmup.ts): both must agree on the runtime cache name
// and on what counts as a font glyph-range request, or the warm-up would
// fill a cache the SW never reads. offline.spec.ts's built-output guards
// mirror these values as literals (the e2e tsconfig project can't import
// app source) — keep them in sync when changing anything here.

/** Family prefix for glyph runtime caches — see isRetiredGlyphCache(). */
export const GLYPH_CACHE_PREFIX = 'sailcommand-glyphs-';

/**
 * Dedicated runtime cache for basemap font glyph ranges (#28). The ~768
 * `basemap-assets/fonts/**` .pbf files are deliberately NOT precached
 * (vite.config.ts globIgnores): they dominated the 791-entry install and
 * could blow the browser's install-event budget on slow connections. They
 * are cached here on first use instead, and backfilled by the app-side
 * warm-up after the SW takes control.
 *
 * Versioned suffix: cleanupOutdatedCaches() only manages workbox's precache
 * caches, so retiring this cache (e.g. after a font update) means bumping
 * the version here — sw.ts's activate handler then deletes every retired
 * `sailcommand-glyphs-*` cache (via isRetiredGlyphCache below) on the next
 * activation, so the old ~11 MB never leaks. Bump checklist: the version
 * suffix here AND the mirrored cache-name literal in e2e/offline.spec.ts
 * (see the module comment above for why that literal can't import this).
 */
export const GLYPH_CACHE_NAME = `${GLYPH_CACHE_PREFIX}v1`;

/**
 * True for glyph caches of any version OTHER than the current one —
 * sw.ts's activate handler deletes exactly these. Prefix-scoped so it can
 * never touch workbox's precache caches (or anything else).
 */
export function isRetiredGlyphCache(name: string): boolean {
  return name.startsWith(GLYPH_CACHE_PREFIX) && name !== GLYPH_CACHE_NAME;
}

/**
 * Build-time manifest of every glyph-range path, emitted into dist/ by
 * vite.config.ts's glyphManifest() plugin — paths relative to BASE_URL.
 * Build-only, but that's moot in `vite dev`: with no SW ever registering
 * there, the warm-up parks in whenControlled() and never reaches the
 * manifest fetch. A 404 for this file only happens under a STALE
 * controlling SW whose precache predates it; the warm-up then warns and
 * skips (offline glyph coverage grows on demand only).
 */
export const GLYPH_MANIFEST_PATH = 'glyph-manifest.json';

/**
 * True for font glyph-range requests and nothing else. Deliberately narrow
 * (path prefix AND extension): combined with a same-origin check at the
 * call site, this can never match the Open-Meteo origin (which the SW must
 * never cache) nor `.pmtiles` Range requests (different path and extension,
 * owned by sw.ts's first-registered route).
 */
export function isGlyphPath(pathname: string): boolean {
  return pathname.endsWith('.pbf') && pathname.includes('/basemap-assets/fonts/');
}
