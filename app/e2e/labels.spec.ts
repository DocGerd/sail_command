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
// Settle note (PR #375 review, round 4 — this is the SECOND full rewrite of
// this comment; round 3's version described an idle/5s-cap race that
// MEASUREMENT then showed does not exist. Read this one, not history.)
//
// Symbol placement is a separate async step from map.loaded() (see
// mapReady() below): map.loaded() only requires SOURCES loaded, 'idle'
// additionally requires placement/collision to have settled. The original
// design raced a `map.once('idle', ...)` listener against a 5s cap,
// reasoning that placement might still be running when mapReady() resolves.
// Instrumented directly (PR #375 review round 4): on this spec's page, a
// NON-once `map.on('idle', ...)` attached immediately after mapReady()
// resolves and monitored for a full 8s saw ZERO idle events
// (`loadedAtAttach:true, isMovingAtAttach:false, idleTimestamps:[]`). The
// map's one-shot initial 'idle' had already fired before the listener could
// attach — mapReady()'s own poll takes long enough that by the time it
// observes loaded()===true, placement has typically already settled too. So
// the idle listener was structurally unable to fire in this test, and the
// block was an UNCONDITIONAL 5-second sleep wearing a state-signal costume —
// exactly the shape CLAUDE.md's e2e determinism rule forbids ("no fixed
// waitForTimeout as a synchronization wait; gate on state signals").
//
// The fix: poll the ACTUAL state this test cares about — the placed
// `places_locality` label set — until two consecutive reads are IDENTICAL
// (same sorted names, not just the same count: a same-count swap, one label
// culled while a different one is placed, would read stable under a
// count-only compare, the same blindness class this PR keeps finding
// elsewhere). This mirrors datalayers.spec.ts's `settledCanvas` idiom
// (poll on a fixed cadence via `page.waitForTimeout` — a POLL INTERVAL
// inside a stabilization loop, not a synchronization wait itself — until two
// consecutive reads match) with ONE deliberate divergence: `settledCanvas`
// returns its last frame best-effort if it never stabilizes (fail OPEN —
// acceptable there because a subsequent byte-compare against that frame
// still fails correctly if the raster is genuinely different). Here,
// proceeding on an unstable read would let Signal (A)/(B) below validate a
// still-settling snapshot as "the map's labels" — silently, since nothing
// downstream would notice. So this gate fails CLOSED: exhausting its budget
// throws, naming the full count history AND the last two label arrays it
// saw (not just counts — see the swap case above), rather than returning
// best-effort and letting an unstable state slip through as evidence.
//
// annotations.spec.ts's barb-density assertion uses the identical
// `map.once('idle', ...)` shape and likely has the same defect — NOT fixed
// here (out of this PR's scope; the coordinator is filing it separately).
//
// Two output channels for the settle diagnostic, kept for different
// readers: a `console.log` line (what reaches a human on an ordinary CI
// run — `ci.yml`'s only step running `playwright test` is `npm run e2e`,
// whose stdout the `list` reporter streams to the job log on BOTH a pass
// and a fail) and a `test.info().annotations` entry (the correct structured
// form for a local HTML report or `--reporter=json`, but NOT what reaches
// CI's log on a pass — `ci.yml`'s `playwright-report` upload is gated
// `if: failure()`, so the HTML report is never produced on a passing run,
// and the `list` reporter prints nothing for a custom annotation on green;
// measured directly in round 3). Neither channel alone is enough; both are
// kept.

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

const SETTLE_POLL_INTERVAL_MS = 250;
// ~10s budget at 250ms cadence — generous against the near-instant
// stabilization actually measured (placement typically already settled by
// the time mapReady() resolves; see the file header), with CI slack per
// CLAUDE.md's documented 6-10x runner-speed ratio.
const SETTLE_MAX_READS = 40;

interface SettledPlacedLabels {
  labels: string[];
  /** Total reads taken, including the two that matched. */
  reads: number;
  elapsedMs: number;
}

/**
 * Polls the placed `places_locality` label set (sorted names) until two
 * CONSECUTIVE reads are identical, then returns that stable set. Fails
 * CLOSED — throws, naming the full count history and the last two label
 * arrays observed, rather than returning a possibly-still-settling read —
 * see the file header's "Settle note" for why this deliberately diverges
 * from datalayers.spec.ts's `settledCanvas`, which returns best-effort.
 * `page.waitForTimeout` below is the POLL CADENCE inside this stabilization
 * loop (the same idiom `settledCanvas` uses), not a synchronization wait.
 */
async function settledPlacedLabels(page: Page): Promise<SettledPlacedLabels> {
  const readLabels = () =>
    page.evaluate(() => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      return map
        .queryRenderedFeatures({ layers: ['places_locality'] })
        .map((f) => f.properties.name)
        .filter((name): name is string => typeof name === 'string')
        .sort();
    });

  const start = Date.now();
  const countHistory: number[] = [];
  // secondToLast/last track the two most recent reads' full arrays (not
  // just their counts) so a failure message can show a same-count SWAP —
  // see the comparison comment below for why count alone isn't enough.
  let secondToLast: string[] | null = null;
  let last = await readLabels();
  countHistory.push(last.length);
  for (let extraReads = 1; extraReads <= SETTLE_MAX_READS; extraReads++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = await readLabels();
    countHistory.push(next.length);
    // Compare the SORTED IDENTITY, not just the count — a same-count swap
    // (one label culled while a different one is placed the same instant)
    // would read stable under a count-only compare, the exact blindness
    // class this PR keeps finding elsewhere.
    if (JSON.stringify(next) === JSON.stringify(last)) {
      const reads = extraReads + 1;
      return { labels: next, reads, elapsedMs: Date.now() - start };
    }
    secondToLast = last;
    last = next;
  }
  const totalReads = countHistory.length;
  throw new Error(
    `places_locality placement never stabilized across ${totalReads} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ~${(totalReads * SETTLE_POLL_INTERVAL_MS) / 1000}s budget); ` +
      `counts seen: ${JSON.stringify(countHistory)}; last two label sets: ` +
      `${JSON.stringify(secondToLast)} -> ${JSON.stringify(last)}`,
  );
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

    // Signal (C): the THIRD, more severe fail-open path — see file header.
    // Timing-independent by design: unlike (A)/(B) below, which depend on
    // placement having actually run, the style's `glyphs` field is set at
    // style-load time and does not change with settling, so this is
    // asserted before the settle gate rather than after it.
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

    // The settle gate — see the file header's "Settle note" for the
    // measurement that replaced the old idle/5s-cap race with this. Two
    // output channels for the diagnostic (see the same note for why both):
    // a console.log line (reaches CI's job log on every run) and a
    // Playwright annotation (structured form for a local/JSON report).
    const { labels: placedLabels, reads, elapsedMs } = await settledPlacedLabels(page);
    console.log(
      `[#320 labels.spec.ts] places_locality placement stabilized after ${reads} reads (${elapsedMs}ms)`,
    );
    test.info().annotations.push({
      type: 'symbol-placement-settle',
      description: `stabilized after ${reads} reads (${elapsedMs}ms)`,
    });

    // Signal (A): the layer actually placed something (asserted on the
    // GATE's stable read, distinct from the gate itself — the gate proves
    // stability, this proves non-emptiness). Not merely a weak secondary
    // check — it LICENSES Signal (B) below (see file header) and separately
    // rules out a different regression (place-name data absent from the
    // basemap extract at the default view).
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
