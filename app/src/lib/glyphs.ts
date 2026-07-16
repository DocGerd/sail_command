// Shared between the service worker (src/sw.ts) and the window side
// (src/services/glyphWarmup.ts): both must agree on the runtime cache name
// and on what counts as a font glyph-range request, or the warm-up would
// fill a cache the SW never reads. offline.spec.ts's built-output guards
// mirror these values as literals (the e2e tsconfig project can't import
// app source) — keep them in sync when changing anything here.

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
 * the name and deleting the old one in an activate handler.
 */
export const GLYPH_CACHE_NAME = 'sailcommand-glyphs-v1';

/**
 * Build-time manifest of every glyph-range path, emitted into dist/ by
 * vite.config.ts's glyphManifest() plugin — paths relative to BASE_URL.
 * Build-only: `vite dev` never emits it (and never registers a SW either),
 * so the warm-up treats a failed manifest fetch as a silent skip.
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
