import { test, expect, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #320: grepped every spec under app/e2e/ — no `text-field`, symbol-layer, or
// label assertion existed anywhere. annotations.spec.ts only queries the
// app's OWN custom layers (sc-wind-barbs, sc-maneuver-circles); offline.spec.ts
// does a raw fetch() of a glyph .pbf expecting 200, which proves the SW cache
// serves the bytes, not that MapLibre ever turns them into a rendered label.
// So a regression that starves glyph loading — a CSP change, a cache-name
// change, a `glyphs:` URL template change, an SW route mismatch — could ship
// as a map with no labels, invisible to the whole suite. This file closes
// that gap.
//
// ★ Insight — the shape the issue itself suggested ("queryRenderedFeatures on
// a symbol layer with a non-empty text-field, gated on idle") was tried
// FIRST and is DISPROVEN by direct measurement, not by reasoning about it.
// maplibre-gl's glyph manager
// (node_modules/maplibre-gl/src/render/glyph_manager.ts,
// `_downloadAndCacheRangePromise`, maplibre-gl 6.1.0 as installed — re-check
// this comment if maplibre-gl is upgraded, same caveat this repo already
// carries for symbol_bucket.ts:391) catches EVERY glyph-range download
// failure internally and falls back to drawing the codepoint locally with
// TinySDF (`_drawGlyph`) — unconditionally, not gated by any style/map
// option. The symbol still gets PLACED either way, so
// `queryRenderedFeatures` reports the SAME count and the SAME feature names
// whether the real server-side glyph arrived or every range 404'd. Measured
// directly: pointing the style's `glyphs:` URL at a nonexistent path (a real
// 404 against a static file server with no SPA fallback — vite preview's own
// SPA fallback masks a broken glyph path as a 200 of index.html, which is a
// SEPARATE trap, see the mutation-check note in the PR description) left
// `queryRenderedFeatures({layers:['places_locality']})` returning an
// IDENTICAL count and identical names to the working build; only a
// pixel-level screenshot diff showed every label had silently switched to
// locally-rendered glyphs. This is the "a verification method that
// structurally cannot see a regression class will report green through it"
// trap from CLAUDE.md, one level deeper than the issue anticipated: the
// fallback is invisible even to `map.on('error')` (confirmed by reading the
// glyph manager's catch block — nothing re-throws or emits a map-level
// error), so the ONLY surviving signal is the `console.warn` maplibre emits
// via `warnOnce()`:
//   "Unable to load glyph range …. Rendering codepoint …locally instead."
// (glyph_manager.ts:144). A future maplibre-gl release could reword this
// message, and this test would then fail OPEN (silently stop catching the
// regression) rather than closed — a documented, narrowed-not-closed
// residual, not something to "fix" by pre-guessing future wording.
//
// So this test asserts THREE signals together; none is sufficient alone:
//  (A) queryRenderedFeatures on a text-field symbol layer is non-empty —
//      proves the layer/source/data pipeline produces PLACED symbols at all.
//      Cannot tell real glyphs from local fallback on its own — BUT it is
//      not a merely weak secondary check either: it is what LICENSES (B)'s
//      absence-of-warnings assertion. An empty warnings array only carries
//      information once you know the evidence-generating process actually
//      RAN — if nothing had been placed, zero warnings would be vacuously
//      true (nothing was attempted, so nothing could warn). (A) is that
//      "the process ran" proof. Do not delete (A) as "redundant with (B)"
//      in a future cleanup — that would silently reopen the hole this file
//      closes, with every remaining signal still green.
//  (B) zero "Unable to load glyph range" warnings fired anywhere in the
//      page's lifetime — proves placed symbols used the REAL server-fetched
//      glyphs, not maplibre's silent per-range local fallback (the
//      `_downloadAndCacheRangePromise` catch-and-fallback path described
//      above). Cannot tell "nothing to place" from "placed with real
//      glyphs" without (A).
//  (C) `map.getStyle().glyphs` equals the expected same-origin template —
//      closes a THIRD, more severe fail-open path that (A) and (B) are BOTH
//      blind to. maplibre-gl's glyph manager
//      (`_getAndCacheGlyphsPromise`, glyph_manager.ts:104-108) takes a
//      COMPLETELY SILENT local-TinySDF path whenever `this.url` (the
//      style's `glyphs` field) is falsy — no network attempt, no
//      `warnOnce`, nothing; it never reaches `_warnOnMissingGlyphRange`.
//      Under that path (A) stays green (symbols still placed) AND (B) stays
//      green (the warning is never emitted at all) while every label
//      renders 100% from local fallback. This needs no maplibre upgrade to
//      trigger and no network failure — `glyphManager.setURL()` is fed from
//      the style's `glyphs` field at TWO call sites in style.ts: the full
//      style-load path (`_load`, style.ts:491) and the style-DIFF/update
//      path (`setGlyphs`, style.ts:1953, invoked from `setState`'s diff
//      operations) — the second is exactly the path this repo's own
//      `lib/styleReload.ts` machinery exercises on every `styledata`
//      re-add when `MapView.tsx` rebuilds and re-applies its style (that
//      subsystem has real bug history here: #159, #163). A regression
//      dropping the `glyphs:` field from `MapView.tsx`'s `buildStyle()`, or
//      a future style-reload bug losing it on diff, produces exactly this
//      with zero diagnostic residue anywhere — worse than (B)'s
//      wording-drift residual, because it needs no version change. `glyphs`
//      is also documented OPTIONAL in the maplibre style spec ("omit to use
//      local fonts" is SDK-supported), so nothing in maplibre itself would
//      ever flag an accidentally-omitted value as wrong.
// Together: a regression that starves the glyph fetch (server 404s, wrong
// path but still non-empty) trips (B) without touching (A) or (C); a
// regression that empties the place data trips (A) without touching (B) or
// (C); a regression that drops the `glyphs` field entirely trips ONLY (C) —
// (A) and (B) both read green through it. All three are needed.
//
// Why a CSP-directive mutation can't be used as the mutation-check for (A)/
// (B): connect-src is not path-scoped, so tightening it enough to block the
// glyph .pbf requests ALSO blocks every other same-origin fetch this app
// makes (mask/harbors/polar JSON, the PMTiles archive, the sprite,
// glyph-manifest.json) — measured directly: removing 'self' from connect-src
// makes the ENTIRE map fail to initialize, which every EXISTING
// mapReady()-gated spec (compass.spec.ts, datalayers.spec.ts) already
// catches, since map.loaded() never becomes true. The gap (A)/(B) close is
// narrower than "CSP too tight overall" — it's a glyph URL/cache-path
// regression that leaves every OTHER same-origin fetch intact, which is
// exactly what a `glyphs:` URL typo or an SW glyph-route mismatch would
// produce. (C)'s mutation-check is a direct style-field removal instead —
// see the PR description for the verbatim three-signal outcome.
//
// Timing note: symbol placement is a separate async step from map.loaded()
// (see mapReady() below), so the settle wait races an 'idle' event against a
// 5s cap. Before this fix wave, that cap was silently indistinguishable from
// a healthy run — a genuinely hung placement pass would resolve via the cap
// and look identical to normal. The test now records WHICH branch resolved
// as a Playwright annotation (visible in the HTML/CI report) rather than
// hard-failing on a timeout: CI runners are documented as materially slower
// than dev machines, so treating every timeout-branch resolution as a test
// failure would trade a real diagnostic gap for CI flakiness. The annotation
// makes a persistently-late 'idle' visible to a human without making a slow
// (but eventually-correct) CI run red.

// Duplicated from compass.spec.ts/datalayers.spec.ts rather than imported —
// neither file exports it and helpers.ts is out of this change's scope; both
// existing copies already carry a comment flagging this as an extraction
// candidate. This is a third copy of the same house pattern, not a new one.
async function installMapHandle(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.maplibregl-map');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    let f = (el as unknown as Record<string, { memoizedState?: unknown; return?: unknown }>)[key];
    while (f) {
      let h = f.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
      let guard = 0;
      while (h && guard++ < 60) {
        const v = h.memoizedState as { getBearing?: unknown; project?: unknown } | undefined;
        if (v && typeof v.getBearing === 'function' && typeof v.project === 'function') {
          (window as unknown as Record<string, unknown>).__scE2eMap = v;
          return true;
        }
        h = h.next as typeof h;
      }
      f = f.return as typeof f;
    }
    return false;
  });
}

interface ScTestMap {
  loaded(): boolean;
  getStyle(): { sources: Record<string, unknown>; glyphs?: string };
  isSourceLoaded(id: string): boolean;
  queryRenderedFeatures(opts: { layers: string[] }): Array<{ properties: Record<string, unknown> }>;
  once(type: string, cb: () => void): void;
}

async function mapReadyState(page: Page): Promise<string> {
  if (!(await installMapHandle(page))) return 'no-map-handle';
  return page.evaluate(() => {
    const map = (window as unknown as { __scE2eMap?: ScTestMap }).__scE2eMap;
    if (!map) return 'handle-lost';
    if (!map.loaded()) {
      const pending = Object.keys(map.getStyle().sources).filter((id) => !map.isSourceLoaded(id));
      return `not-loaded (pending sources: ${pending.join(', ') || 'none — style still parsing'})`;
    }
    return 'loaded';
  });
}

/** Gate a spec on a map that has actually rendered, reporting WHY if it hasn't. */
async function mapReady(page: Page): Promise<void> {
  await expect.poll(() => mapReadyState(page), { timeout: 60_000 }).toBe('loaded');
}

test('map labels: a place label is placed and uses the real (non-fallback) glyph pipeline (#320)', async ({
  page,
}) => {
  const server = await startPreview();
  // Installed before navigation so it captures every glyph-fallback warning
  // for the whole page lifetime, not just after some later manual trigger —
  // same rationale as csp.spec.ts's securitypolicyviolation listener.
  const glyphFallbackWarnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning' && msg.text().startsWith('Unable to load glyph range')) {
      glyphFallbackWarnings.push(msg.text());
    }
  });
  try {
    await page.goto(server.url);
    await mapReady(page);

    // Symbol placement can lag map.loaded() by a frame or two (tiles loaded
    // != collision/placement settled). Wait for one 'idle' — the same signal
    // annotations.spec.ts's barb-density assertions settle on — with a
    // capped fallback in case 'idle' already fired before this listener
    // attached. Which branch resolved is returned rather than discarded (see
    // "Timing note" in the file header): a hang and a healthy run must not
    // look identical.
    const settleBranch = await page.evaluate(
      () =>
        new Promise<'idle' | 'timeout-cap'>((resolve) => {
          const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
          let settled = false;
          const done = (branch: 'idle' | 'timeout-cap') => {
            if (settled) return;
            settled = true;
            resolve(branch);
          };
          map.once('idle', () => done('idle'));
          setTimeout(() => done('timeout-cap'), 5_000);
        }),
    );
    test.info().annotations.push({
      type: 'symbol-placement-settle',
      description: `resolved via: ${settleBranch}`,
    });

    // Signal (C): the THIRD, more severe fail-open path — see file header.
    // Timing-independent by design: unlike (A)/(B), which depend on
    // placement having actually run, the style's `glyphs` field is set at
    // style-load time and does not change with settling, so this is
    // asserted regardless of which settleBranch fired above.
    const expectedGlyphsTemplate = '/sail_command/basemap-assets/fonts/{fontstack}/{range}.pbf';
    const actualGlyphsTemplate = await page.evaluate(() => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      return map.getStyle().glyphs;
    });
    expect(
      actualGlyphsTemplate,
      `expected the style's glyphs template to be '${expectedGlyphsTemplate}', got: ${JSON.stringify(actualGlyphsTemplate)} ` +
        `— a falsy/missing 'glyphs' field makes maplibre-gl take a COMPLETELY SILENT local-fallback path ` +
        `(glyph_manager.ts's _getAndCacheGlyphsPromise, gated on '!this.url') that neither Signal (A) nor ` +
        `Signal (B) above can detect (see file header)`,
    ).toBe(expectedGlyphsTemplate);

    const placedLabels = await page.evaluate(() => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      return map
        .queryRenderedFeatures({ layers: ['places_locality'] })
        .map((f) => f.properties.name)
        .filter((name): name is string => typeof name === 'string');
    });

    // Signal (A): the layer actually placed something. Not merely a weak
    // secondary check — it LICENSES Signal (B) below (see file header) and
    // separately rules out a different regression (place-name data absent
    // from the basemap extract at the default view).
    expect(
      placedLabels.length,
      `expected at least one placed 'places_locality' label at the default view, got: ${JSON.stringify(placedLabels)}`,
    ).toBeGreaterThan(0);

    // Signal (B): the ACTUAL discriminator for #320 — see file header. A
    // nonempty array here means maplibre silently degraded at least one
    // glyph to a locally-drawn fallback instead of the real server glyph.
    expect(
      glyphFallbackWarnings,
      `expected zero glyph-load fallback warnings (labels must use the real server-fetched glyphs, ` +
        `not maplibre's local TinySDF fallback), got: ${JSON.stringify(glyphFallbackWarnings)}`,
    ).toEqual([]);
  } finally {
    server.kill();
  }
});
