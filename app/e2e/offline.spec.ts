import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

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
    // (~44 MB, including the 27 MB basemap.pmtiles) before the worker can
    // reach 'installed'; since this is a brand-new registration with no
    // prior controller to conflict with, it then auto-activates, and
    // clientsClaim() (also sw.ts) hands this already-open page control
    // immediately — no reload needed to reach this point.
    await page.evaluate(() => navigator.serviceWorker.ready);

    // Create + auto-save a plan (mirrors plan.spec.ts's flow; this spec
    // only needs *a* saved plan to exist, not to re-verify rig/leg detail).
    await page.getByRole('region', { name: 'Start' }).getByRole('searchbox').fill('Langballigau');
    await page.getByRole('region', { name: 'Start' }).locator('.harbor-picker li button').first().click();
    await page.getByRole('region', { name: 'Ziel' }).getByRole('searchbox').fill('Sønderborg');
    await page.getByRole('region', { name: 'Ziel' }).locator('.harbor-picker li button').first().click();
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Wait for run() to fully settle *before* switching tabs — see
    // plan.spec.ts's comment at the equivalent point: PlansList only
    // fetches from IndexedDB once, on mount, and mounts fresh each time the
    // Routen tab is entered, so switching too early races the save.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.plans-list-row')).toHaveCount(1);
    await page.getByRole('tab', { name: 'Planen' }).click();

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

    server.kill();
    await context.setOffline(true);

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
    await expect(page.getByRole('heading', { name: 'SailCommand' })).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText('Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.'),
    ).toBeVisible();

    // Proves sw.ts's dedicated Range-request route for .pmtiles is actually
    // what's serving the basemap here, not just "some cached response that
    // happens to render a canvas" — workbox's *default* precache route would
    // instead replay a full 200 to a ranged request, which pmtiles'
    // FetchSource rejects (see sw.ts's own comment). This is the only place
    // in the offline pass that would catch that route silently regressing
    // while the map still happens to render via some other fallback.
    const rangeStatus = await page.evaluate(async () => {
      const res = await fetch('data/basemap.pmtiles', { headers: { range: 'bytes=0-99' } });
      return res.status;
    });
    expect(rangeStatus).toBe(206);

    // Picking origin/destination still works offline: data/harbors.json is
    // precached too (vite.config.ts's globPatterns includes json), served
    // straight from the SW's cache regardless of network state. With both
    // endpoints set, the only remaining reason canPlan (App.tsx) can be
    // false is the offline guard itself — a meaningfully offline-specific
    // assertion, not just "button disabled because nothing is picked yet".
    await page.getByRole('region', { name: 'Start' }).getByRole('searchbox').fill('Langballigau');
    await page.getByRole('region', { name: 'Start' }).locator('.harbor-picker li button').first().click();
    await page.getByRole('region', { name: 'Ziel' }).getByRole('searchbox').fill('Sønderborg');
    await page.getByRole('region', { name: 'Ziel' }).locator('.harbor-picker li button').first().click();
    const offlinePlanButton = page.getByRole('button', { name: 'Route planen' });
    await expect(offlinePlanButton).toBeDisabled();
    await expect(
      page.getByText('Windvorhersagedienst nicht erreichbar. Internetverbindung prüfen und erneut versuchen.'),
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
  } finally {
    await context.setOffline(false).catch(() => {});
    server.kill();
  }
});
