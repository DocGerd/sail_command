import { describe, expect, it } from 'vitest';
import { GLYPH_CACHE_NAME, GLYPH_CACHE_PREFIX, isGlyphPath, isRetiredGlyphCache } from './glyphs';

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

  it('never matches .pmtiles — those belong to the first-registered Range→206 route', () => {
    expect(isGlyphPath('/sail_command/data/basemap.pmtiles')).toBe(false);
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

describe('isRetiredGlyphCache (activate cleanup scoping)', () => {
  it('matches only glyph caches of a version other than the current one', () => {
    expect(isRetiredGlyphCache(`${GLYPH_CACHE_PREFIX}v0`)).toBe(true);
    expect(isRetiredGlyphCache(`${GLYPH_CACHE_PREFIX}v2`)).toBe(true);
    expect(isRetiredGlyphCache(GLYPH_CACHE_NAME)).toBe(false);
  });

  it('never matches workbox precache caches or unrelated names', () => {
    expect(isRetiredGlyphCache('workbox-precache-v2-https://example.test/sail_command/')).toBe(
      false,
    );
    expect(isRetiredGlyphCache('sailcommand-somethingelse-v1')).toBe(false);
  });
});
