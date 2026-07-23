// Shared between the service worker (src/sw.ts) and the window side
// (src/services/glyphWarmup.ts): both must agree on the runtime cache name
// and on what counts as a font glyph-range request, or the warm-up would
// fill a cache the SW never reads. offline.spec.ts's built-output guards
// mirror these values as literals (the e2e tsconfig project can't import
// app source) — keep them in sync when changing anything here.

/** Family prefix shared by every deployment's glyph runtime caches. */
export const GLYPH_CACHE_PREFIX = 'sailcommand-glyphs-';

/**
 * Cache version. Bump this to retire the current runtime cache (e.g. after a
 * font update) — see glyphCacheName()/isRetiredGlyphCache() and the version-
 * bump checklist below.
 */
export const GLYPH_CACHE_VERSION = 'v1';

/**
 * Delimiter separating the deployment slug from the version in a cache name.
 * `@` is deliberately a character that deploymentSlug() can never emit — see
 * the prefix-trap reasoning on isRetiredGlyphCache().
 */
const SLUG_VERSION_DELIM = '@';

/**
 * A deployment slug derived from the build's BASE_URL (#96). Cache Storage is
 * per-ORIGIN, and this app now ships two deployments to ONE origin — production
 * at `/sail_command/` and the UAT preview at `/sail_command/uat/`. Without a
 * per-deployment name their runtime glyph caches would collide and one SW's
 * activate cleanup would evict the other's ~11 MB of offline glyphs.
 *
 * Derivation: strip surrounding slashes, join inner path segments with `-`,
 * and reduce anything outside `[a-z0-9_-]` (incl. the delimiter char) to `-`
 * so a slug can never smuggle SLUG_VERSION_DELIM into a cache name. The empty
 * base (`/`, e.g. Vitest's default) maps to `root`.
 *   `/sail_command/`     -> `sail_command`
 *   `/sail_command/uat/` -> `sail_command-uat`
 */
export function deploymentSlug(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
  const safe = trimmed.replace(/[^a-z0-9_-]/gi, '-');
  return safe === '' ? 'root' : safe;
}

/**
 * The runtime cache name for the deployment served at `base`. Pure and
 * exported for tests; the exported GLYPH_CACHE_NAME binds it to the real
 * BASE_URL (statically replaced in both the app and injectManifest SW
 * bundles).
 *
 *   `/sail_command/`     -> `sailcommand-glyphs-sail_command@v1`
 *   `/sail_command/uat/` -> `sailcommand-glyphs-sail_command-uat@v1`
 */
export function glyphCacheName(base: string): string {
  return `${GLYPH_CACHE_PREFIX}${deploymentSlug(base)}${SLUG_VERSION_DELIM}${GLYPH_CACHE_VERSION}`;
}

/** The prefix that scopes a name to a single deployment (slug + delimiter). */
function deploymentScopedPrefix(base: string): string {
  return `${GLYPH_CACHE_PREFIX}${deploymentSlug(base)}${SLUG_VERSION_DELIM}`;
}

/**
 * Dedicated runtime cache for basemap font glyph ranges (#28), scoped to THIS
 * deployment (#96). The ~768 `basemap-assets/fonts/**` .pbf files are
 * deliberately NOT precached (vite.config.ts globIgnores): they dominated the
 * 791-entry install and could blow the browser's install-event budget on slow
 * connections. They are cached here on first use instead, and backfilled by
 * the app-side warm-up after the SW takes control.
 *
 * Retirement: cleanupOutdatedCaches() only manages workbox's precache caches,
 * so retiring this cache (font update) means bumping GLYPH_CACHE_VERSION —
 * sw.ts's activate handler then deletes every retired cache of THIS deployment
 * (via isRetiredGlyphCache below) on the next activation, so the old ~11 MB
 * never leaks. Bump checklist: GLYPH_CACHE_VERSION here AND the mirrored
 * cache-name literals in e2e/offline.spec.ts and glyphs.test.ts (see the
 * module comment above for why those literals can't import this).
 */
export const GLYPH_CACHE_NAME = glyphCacheName(import.meta.env.BASE_URL);

/**
 * True for a retired glyph cache of the deployment served at `base` — a name
 * with this deployment's slug but a non-current version. sw.ts's activate
 * handler deletes exactly these.
 *
 * Prefix-trap safety (#96): production's slug `sail_command` is a textual
 * prefix of UAT's `sail_command-uat`, so a naive `startsWith(slug)` on prod
 * would also match UAT's cache and evict it. Matching on the deployment-scoped
 * prefix `slug + '@'` instead closes that: after `sail_command`, prod's scoped
 * prefix demands `@` where UAT's name has `-`, so neither deployment's scoped
 * prefix can ever be a prefix of the other's full name (the delimiter `@`
 * cannot appear inside any slug). Same reasoning keeps it clear of workbox's
 * precache caches, which don't start with GLYPH_CACHE_PREFIX at all.
 */
export function isRetiredGlyphCache(name: string, base: string): boolean {
  return name.startsWith(deploymentScopedPrefix(base)) && name !== glyphCacheName(base);
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
 * never cache) nor basemap-archive Range requests (`.pmtiles.png`, legacy
 * `.pmtiles` — different path and extension, owned by sw.ts's
 * first-registered route).
 */
export function isGlyphPath(pathname: string): boolean {
  return pathname.endsWith('.pbf') && pathname.includes('/basemap-assets/fonts/');
}
