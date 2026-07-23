import { describe, expect, it } from 'vitest';
import { glyphCacheName, isGlyphPath, isRetiredGlyphCache } from './glyphs';

// Literal cache names, pinned independently of the functions under test
// (mutation-honesty, #50): a mutant slug/delimiter derivation must break these.
// Keep in sync with e2e/offline.spec.ts when GLYPH_CACHE_VERSION is bumped.
const PROD_BASE = '/sail_command/';
const UAT_BASE = '/sail_command/uat/';
const PROD_CACHE = 'sailcommand-glyphs-sail_command@v1';
const UAT_CACHE = 'sailcommand-glyphs-sail_command-uat@v1';

// sw.ts itself has no unit-test harness (it needs a ServiceWorkerGlobalScope
// plus live workbox internals), so its two glyph decisions — which requests
// the runtime route may claim, and which caches the activate cleanup may
// delete — live here as pure predicates and are pinned down directly.

describe('isGlyphPath (runtime route scoping)', () => {
  it('matches font glyph-range requests', () => {
    expect(isGlyphPath('/sail_command/basemap-assets/fonts/Noto Sans Regular/0-255.pbf')).toBe(
      true,
    );
    expect(isGlyphPath('/basemap-assets/fonts/Noto Sans Italic/9984-10239.pbf')).toBe(true);
  });

  it('never matches the basemap archive — that belongs to the first-registered Range→206 route', () => {
    expect(isGlyphPath('/sail_command/data/basemap.pmtiles')).toBe(false);
    // #118: the archive now ships renamed to .pmtiles.png — still not a glyph.
    expect(isGlyphPath('/sail_command/data/basemap.pmtiles.png')).toBe(false);
  });

  it('never matches non-font .pbf or fonts-path non-.pbf requests', () => {
    expect(isGlyphPath('/sail_command/data/tiles.pbf')).toBe(false);
    expect(isGlyphPath('/sail_command/basemap-assets/fonts/index.json')).toBe(false);
  });

  it('never matches Open-Meteo-shaped API paths', () => {
    // Belt and suspenders: sw.ts additionally gates on sameOrigin, so a
    // cross-origin URL can't reach this predicate in the first place.
    expect(isGlyphPath('/v1/forecast')).toBe(false);
  });
});

describe('glyphCacheName (per-deployment scoping, #96)', () => {
  it('gives production and UAT DISTINCT cache names on the shared origin', () => {
    // Pinned literals — Cache Storage is per-origin, so the two deployments'
    // runtime caches MUST NOT collide.
    expect(glyphCacheName(PROD_BASE)).toBe(PROD_CACHE);
    expect(glyphCacheName(UAT_BASE)).toBe(UAT_CACHE);
    expect(glyphCacheName(PROD_BASE)).not.toBe(glyphCacheName(UAT_BASE));
  });
});

describe('isRetiredGlyphCache (activate cleanup scoping, #96)', () => {
  it('never evicts the SIBLING deployment (anti-cross-eviction invariant)', () => {
    // The core #96 guarantee: prod's slug `sail_command` is a textual prefix
    // of UAT's `sail_command-uat`, so a naive startsWith would cross-evict.
    // Neither deployment's activate cleanup may touch the other's live cache.
    expect(isRetiredGlyphCache(UAT_CACHE, PROD_BASE)).toBe(false);
    expect(isRetiredGlyphCache(PROD_CACHE, UAT_BASE)).toBe(false);
  });

  it('retires only THIS deployment’s own non-current versions', () => {
    // Old version of the SAME deployment -> reaped.
    expect(isRetiredGlyphCache('sailcommand-glyphs-sail_command@v0', PROD_BASE)).toBe(true);
    expect(isRetiredGlyphCache('sailcommand-glyphs-sail_command-uat@v0', UAT_BASE)).toBe(true);
    // Current version of the SAME deployment -> kept.
    expect(isRetiredGlyphCache(PROD_CACHE, PROD_BASE)).toBe(false);
    expect(isRetiredGlyphCache(UAT_CACHE, UAT_BASE)).toBe(false);
  });

  it('never matches workbox precache caches or unrelated names', () => {
    expect(
      isRetiredGlyphCache('workbox-precache-v2-https://example.test/sail_command/', PROD_BASE),
    ).toBe(false);
    expect(isRetiredGlyphCache('sailcommand-somethingelse-v1', PROD_BASE)).toBe(false);
  });
});
