import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreview } from './helpers';

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Flagship E2E: plan -> save -> kill the server -> offline reload -> the
// saved plan is still there and loads. See helpers.ts's playwright.config.ts
// comment and the research-verified constraint below for why this spec
// spawns its own server and kills it rather than only calling setOffline().
test('true offline reload: precached app shell renders and a saved plan reloads from its stored wind grid', async ({
  page,
  context,
}) => {
  const server = await startPreview();
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // Resolves once this origin has an active worker. workbox-precaching's
    // install-event handler (src/sw.ts) awaits the full precache download
    // (~33 MB, including the 27 MB basemap.pmtiles.png — fonts are runtime-
    // cached since #28) before the worker can reach 'installed'; since this
    // is a brand-new registration with no prior controller to conflict
    // with, it then auto-activates, and clientsClaim() (also sw.ts) hands
    // this already-open page control immediately — no reload needed to
    // reach this point.
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Create + auto-save a plan (mirrors plan.spec.ts's flow; this spec
    // only needs *a* saved plan to exist, not to re-verify rig/leg detail).
    await page.getByRole('region', { name: 'Start' }).getByRole('combobox').fill('Langballigau');
    await page.getByRole('region', { name: 'Start' }).getByRole('option').first().click();
    await page.getByRole('region', { name: 'Ziel' }).getByRole('combobox').fill('Sønderborg');
    await page.getByRole('region', { name: 'Ziel' }).getByRole('option').first().click();
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Wait for run() to fully settle *before* switching tabs — see
    // plan.spec.ts's comment at the equivalent point: PlansList only
    // fetches from IndexedDB once, on mount, and mounts fresh each time the
    // Routen tab is entered, so switching too early races the save.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('.plans-list-row')).toHaveCount(1);
    // Deliberately STAY on the Routen tab: the session snapshot (#113) now
    // holds {planId, tab:'routes'}, which is what the two restore assertions
    // below (online navigation, then the true-offline reload) replay against.

    // Research-verified constraint: context.setOffline(true) blocks new
    // browser-initiated connections but does NOT block a service worker's
    // own fetch handling of intercepted requests (Playwright #2311,
    // empirically confirmed) — a test that only calls setOffline() could
    // pass while the SW silently still reaches a live network. Killing the
    // actual preview server is the only honest way to prove the reload
    // below is served entirely from the SW's cache, with nothing left to
    // fall through to.
    // Navigate to the bare URL (no ?windFixture=) *before* going offline.
    // workbox's default precache route only strips search params matching
    // `ignoreURLParametersMatching` (default: utm_*/fbclid — windFixture
    // isn't one of them), so reloading the fixture URL after the server is
    // dead falls straight through the SW's cache match and hits real
    // (now-dead) network: net::ERR_INTERNET_DISCONNECTED, confirmed
    // empirically while developing this spec. Not needed anyway — the
    // saved plan's own windGrid is already stored, and nothing in this
    // offline phase re-fetches wind.
    await page.goto(server.url);

    // #113: that navigation was already a full boot — session restore must
    // bring back the saved plan and the Routen tab with zero interaction
    // (both locators auto-retry, gating on the restore's state signals).
    await expect(page.getByRole('tab', { name: 'Routen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible();

    // #28: font glyphs are runtime-cached, not precached — the offline
    // reload below can only render map labels from ranges that were already
    // in the runtime cache when the server died. Two deterministic signals,
    // never sleeps: the warm-up (src/services/glyphWarmup.ts) publishes its
    // terminal state on window.__sailGlyphWarmup for exactly this purpose
    // ('done' means every manifest range was fetched), and the cache itself
    // must then hold every range (the SW's CacheFirst route finishes its
    // cache.put moments after the warm-up's fetch resolves, hence the
    // second wait instead of a one-shot count assertion).
    await page.waitForFunction(
      () => (window as { __sailGlyphWarmup?: string }).__sailGlyphWarmup === 'done',
      undefined,
      { timeout: 90_000 },
    );
    const glyphManifest = JSON.parse(
      readFileSync(resolve(DIST_DIR, 'glyph-manifest.json'), 'utf8'),
    ) as string[];
    await page.waitForFunction(
      async ({ cacheName, expected }) => {
        const cache = await caches.open(cacheName);
        return (await cache.keys()).length >= expected;
      },
      // Cache name literal mirrors GLYPH_CACHE_NAME (src/lib/glyphs.ts) — this
      // tsconfig project can't import app source. #96: the name is now scoped
      // to the build's BASE_URL; the e2e build is the production build
      // (base `/sail_command/` — no SC_DEPLOY_ENV), whose slug is `sail_command`.
      { cacheName: 'sailcommand-glyphs-sail_command@v1', expected: glyphManifest.length },
      { timeout: 30_000 },
    );

    server.kill();
    await context.setOffline(true);

    // From here on the run must be console-error-free: with the server dead,
    // any un-cached resource (app shell, tiles, sprites, glyph ranges) fails
    // loudly — MapLibre errors land in the console via MapView's handler —
    // so an empty collection at the end of the test is the proof that the
    // offline reload rendered entirely from the SW's caches.
    const offlineConsoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') offlineConsoleErrors.push(msg.text());
    });

    // Empirically, in this same environment (task-F1-report.md's
    // offline-reload proof): Playwright/CDP's setOffline blocks the network
    // but does not reliably flip navigator.onLine or fire the DOM 'offline'
    // event — a known Playwright/CDP gap, not an app bug. The app's offline
    // banner deliberately reads real navigator.onLine + online/offline
    // listeners (src/state/AppState.tsx), which is the *right* design for
    // an actual disconnection — so rather than depend on the flaky CDP
    // signal, addInitScript forces the same real-world state on every
    // future navigation in this context (including the reload just below).
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
    });

    await page.reload();

    // The app shell (HTML/JS/CSS) rendering at all, with the real server
    // dead and setOffline blocking everything else, is only possible if the
    // SW served it from its precache.
    await expect(page.getByRole('heading', { name: 'SailCommand' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText('Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.'),
    ).toBeVisible();

    // #113 session restore, fully offline: the reload comes back where the
    // user left off — Routen tab selected and the saved plan re-activated by
    // pure local replay (localStorage snapshot → IndexedDB getPlan → its
    // STORED wind grid). The server is dead and setOffline blocks everything
    // else, so a restore that fetched ANYTHING would fail loudly here and
    // land in offlineConsoleErrors.
    await expect(page.getByRole('tab', { name: 'Routen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible({
      timeout: 30_000,
    });

    // Proves sw.ts's dedicated Range-request route for the basemap archive
    // (basemap.pmtiles.png since the #118 rename) is actually what's serving
    // it here, not just "some cached response that happens to render a
    // canvas" — workbox's *default* precache route would instead replay a
    // full 200 to a ranged request, which pmtiles' FetchSource rejects (see
    // sw.ts's own comment). This is the only place in the offline pass that
    // would catch that route silently regressing while the map still happens
    // to render via some other fallback.
    const rangeStatus = await page.evaluate(async () => {
      const res = await fetch('data/basemap.pmtiles.png', { headers: { range: 'bytes=0-99' } });
      return res.status;
    });
    expect(rangeStatus).toBe(206);

    // Same pattern for the glyph runtime cache (#28): a warmed range must be
    // served by sw.ts's CacheFirst route with the server dead — a cache miss
    // here would fall through to the killed network and reject the fetch.
    const glyphStatus = await page.evaluate(async () => {
      const res = await fetch('basemap-assets/fonts/Noto Sans Regular/0-255.pbf');
      return res.status;
    });
    expect(glyphStatus).toBe(200);

    // Picking origin/destination still works offline: data/harbors.json is
    // precached too (vite.config.ts's globPatterns includes json), served
    // straight from the SW's cache regardless of network state. With both
    // endpoints set, the only remaining reason canPlan (App.tsx) can be
    // false is the offline guard itself — a meaningfully offline-specific
    // assertion, not just "button disabled because nothing is picked yet".
    // (#113 restored the Routen tab above, so switch to Planen first.)
    await page.getByRole('tab', { name: 'Planen' }).click();
    await page.getByRole('region', { name: 'Start' }).getByRole('combobox').fill('Langballigau');
    await page.getByRole('region', { name: 'Start' }).getByRole('option').first().click();
    await page.getByRole('region', { name: 'Ziel' }).getByRole('combobox').fill('Sønderborg');
    await page.getByRole('region', { name: 'Ziel' }).getByRole('option').first().click();
    const offlinePlanButton = page.getByRole('button', { name: 'Route planen' });
    await expect(offlinePlanButton).toBeDisabled();
    await expect(
      page.getByText(
        'Windvorhersagedienst nicht erreichbar. Internetverbindung prüfen und erneut versuchen.',
      ),
    ).toBeVisible();

    // The plan saved before going offline is still there and still loads,
    // rendering against its own stored windGrid (never a re-fetch) with the
    // map (pmtiles served 206-from-SW, per F1's own offline-reload proof).
    await page.getByRole('tab', { name: 'Routen' }).click();
    const savedRow = page.locator('.plans-list-row');
    await expect(savedRow).toHaveCount(1);
    await savedRow.locator('.plans-list-load').click();

    await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible();
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();

    // See the collector's comment above — zero console errors across the
    // entire offline phase is the flagship claim of this spec.
    expect(offlineConsoleErrors).toEqual([]);
  } finally {
    await context.setOffline(false).catch(() => {});
    server.kill();
  }
});

// Static guards over the *built* output — deliberately fixture-less: no page /
// context, so this launches neither a browser nor a server (pree2e's
// `npm run build` already guarantees dist/ exists). These catch pipeline-output
// drift the runtime offline pass above cannot:
//  - index.html hardcodes an ABSOLUTE og:image URL to brand/social-card.png
//    (scrapers don't resolve relative paths), so a renamed/missing card would
//    ship a dead share image with nothing else failing; and
//  - the precache install budget (#28) relies on vite.config.ts's globIgnores
//    keeping brand/, test-fixtures/ and basemap-assets/fonts/ out of the SW
//    manifest — drop an ignore and every install silently bloats (the fonts
//    one alone re-adds 768 entries, the very regression #28 fixed).
test('built output guards: og:image card present, precache excludes brand/ + test-fixtures/ + fonts, glyph manifest complete, manifest icons resolve', () => {
  // og:image path coupling: index.html's absolute URL points at this exact file.
  expect(existsSync(resolve(DIST_DIR, 'brand/social-card.png'))).toBe(true);

  // Precache budget (#28): the built SW must list neither the og:image card nor
  // the e2e wind fixtures — both are excluded via vite.config.ts globIgnores.
  const sw = readFileSync(resolve(DIST_DIR, 'sw.js'), 'utf8');
  expect(sw).not.toContain('brand/');
  expect(sw).not.toContain('test-fixtures/');

  // Font glyphs are runtime-cached, never precached (#28). A raw substring
  // check would false-positive here — the runtime glyph route's own matcher
  // code legitimately mentions the fonts path — so parse the injected
  // {revision, url} manifest entries instead.
  const precacheUrls = [...sw.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
  expect(precacheUrls.length).toBeGreaterThan(0);
  expect(precacheUrls.filter((u) => u.includes('basemap-assets/fonts/'))).toEqual([]);
  // Sanity bound: excluding the 768 glyph files leaves ~24 entries; a glob
  // regression that re-adds them must fail loudly, well before this bound.
  expect(precacheUrls.length).toBeLessThan(400);

  // The glyph warm-up's build-time manifest (#28): emitted, itself precached
  // (it's how offline coverage converges), and complete — every listed path
  // must resolve to a real file, and every .pbf on disk must be listed, or
  // the warm-up would silently leave ranges un-warmable offline.
  expect(precacheUrls).toContain('glyph-manifest.json');
  const glyphManifest = JSON.parse(
    readFileSync(resolve(DIST_DIR, 'glyph-manifest.json'), 'utf8'),
  ) as string[];
  expect(glyphManifest.length).toBeGreaterThan(700);
  for (const path of glyphManifest) {
    expect(path).toMatch(/^basemap-assets\/fonts\/.+\.pbf$/);
    expect(existsSync(resolve(DIST_DIR, path)), `glyph range missing: ${path}`).toBe(true);
  }
  const pbfOnDisk = readdirSync(resolve(DIST_DIR, 'basemap-assets/fonts'), {
    recursive: true,
  }).filter((p) => String(p).endsWith('.pbf'));
  expect(glyphManifest.length).toBe(pbfOnDisk.length);

  // A renamed pipeline icon output would 404 the launcher icon silently: every
  // manifest-declared icon src must resolve to a real file under dist/.
  const manifest = JSON.parse(readFileSync(resolve(DIST_DIR, 'manifest.webmanifest'), 'utf8')) as {
    icons: { src: string }[];
  };
  for (const icon of manifest.icons) {
    expect(existsSync(resolve(DIST_DIR, icon.src)), `manifest icon missing: ${icon.src}`).toBe(
      true,
    );
  }
});
