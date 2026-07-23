import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #118: GitHub Pages/Fastly gzip-compresses application/octet-stream and
// answers Range requests with 206 slices OF THE COMPRESSED stream — the
// browser cannot inflate them, so first-load/no-SW visitors got a blank
// basemap. The fix ships the archive as `data/basemap.pmtiles.png`
// (gzip-exempt, Range-clean content type) plus an uncontrolled-page runtime
// net (src/services/basemapSource.ts): a Range preflight and, on failure, a
// full-body fetch into a Blob-backed pmtiles source.
//
// These specs run in a context with `serviceWorkers: 'block'` — the honest
// no-SW cohort #118 breaks for. The preview server (fixed port 4173,
// helpers.ts — serialize with the other e2e specs) serves real identity 206s,
// so the CDN's gzip-of-range corruption does NOT reproduce locally; the first
// spec simulates it exactly via page.route, fulfilling ranged requests with a
// 206 whose body starts with the gzip magic the live probe captured, while
// passing full-body GETs through to the real server. Without that simulation
// the fallback path would never fire in any environment while the CDN
// behaves — this spec is what keeps it from rotting.

const GERMAN_MAP_ERROR_BANNER =
  'Kartendaten konnten nicht geladen werden — Anzeige evtl. unvollständig.';

const ARCHIVE_GLOB = '**/data/basemap.pmtiles.png';

// Same settle idiom as datalayers.spec.ts: polls until the canvas stops
// changing frame-to-frame (two consecutive byte-equal screenshots), then
// returns that settled frame — adaptive, no fixed-sleep synchronization.
// CI runners are 6-10x slower than dev machines, hence the generous cap.
async function settledCanvas(page: Page, canvas: Locator): Promise<Buffer> {
  let prev = await canvas.screenshot();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev; // best-effort: never stabilized within the cap
}

test('forced CDN corruption (#118 signature): preflight fails, exactly one full-body fetch, Blob-backed map paints real tiles', async ({
  browser,
}) => {
  const server = await startPreview();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const canvas = page.locator('canvas.maplibregl-canvas');

    // ---- Phase 1: deterministic NO-TILES baseline. ----------------------
    // MapLibre shows a canvas even with zero tiles (background layer only),
    // so "canvas visible" alone proves nothing — capture what a tiles-less
    // settled frame looks like at this exact viewport, to compare against.
    // The preflight (bytes=0-15) passes through honestly so the map
    // constructs on the 'range-ok' path; every OTHER archive read (pmtiles'
    // header/directory/tile fetches) is aborted, so no tile can ever render.
    // Console errors and the map-error banner are EXPECTED in this phase and
    // deliberately not asserted on; the banner lives outside the canvas.
    await page.route(ARCHIVE_GLOB, async (route) => {
      if (route.request().headers()['range'] === 'bytes=0-15') {
        await route.continue();
        return;
      }
      await route.abort();
    });
    await page.goto(server.url);
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const blankBaseline = await settledCanvas(page, canvas);
    await page.unroute(ARCHIVE_GLOB);

    // ---- Phase 2: the #118 corruption — fallback must paint real tiles. --
    const consoleMessages: string[] = [];
    page.on('console', (msg) => consoleMessages.push(msg.text()));

    let corruptedRangeRequests = 0;
    let fullBodyRequests = 0;
    await page.route(ARCHIVE_GLOB, async (route) => {
      if (route.request().headers()['range'] !== undefined) {
        // Simulate the live CDN failure: a "206" whose bytes are a slice of
        // the COMPRESSED stream — gzip magic where 'PMTiles' should be. The
        // total in content-range is the live probe's compressed length.
        corruptedRangeRequests += 1;
        await route.fulfill({
          status: 206,
          headers: { 'content-range': 'bytes 0-15/27192908' },
          body: Buffer.from([
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0xec, 0x9d, 0x07, 0x60,
            0x1c, 0x55,
          ]),
        });
        return;
      }
      // The fallback's full-body GET: pass through to the real server (a
      // COMPLETE body decodes fine — only ranged slices are broken).
      fullBodyRequests += 1;
      await route.continue();
    });

    await page.goto(server.url);

    // The fallback full-body GET fired...
    await expect.poll(() => fullBodyRequests, { timeout: 60_000 }).toBe(1);

    // ...and the map paints REAL tiles from the Blob-backed source: the
    // settled frame must differ from the tiles-less baseline of phase 1
    // (byte-compare of settled frames, the datalayers.spec.ts idiom —
    // canvas visibility alone would pass with zero tiles).
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    const fallbackFrame = await settledCanvas(page, canvas);
    expect(fallbackFrame.equals(blankBaseline)).toBe(false);

    // Exact end-of-spec totals (pinned AFTER the paint proof): the preflight
    // is the ONLY ranged request — a Protocol key drift would silently
    // auto-create a lazy FetchSource whose reads show up as EXTRA ranged
    // requests here — and the 27 MB full-body fetch ran exactly once.
    expect(corruptedRangeRequests).toBe(1);
    expect(fullBodyRequests).toBe(1);

    // The one-line breadcrumb names #118; the decoding failure never happens
    // (the whole point — the browser only ever decodes a COMPLETE stream).
    expect(consoleMessages.some((m) => m.includes('[#118]'))).toBe(true);
    expect(consoleMessages.filter((m) => m.includes('ERR_CONTENT_DECODING_FAILED'))).toEqual([]);

    // The fallback is silent by design — the map-error banner must NOT show.
    await expect(page.getByText(GERMAN_MAP_ERROR_BANNER)).toHaveCount(0);
  } finally {
    await context.close();
    server.kill();
  }
});

test('honest origin: preflight passes, ranged fast path stays, no full-body archive download', async ({
  browser,
}) => {
  const server = await startPreview();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();

    const ranged206Responses: string[] = [];
    const fullBodyRequests: string[] = [];
    page.on('response', (res) => {
      if (!res.url().includes('data/basemap.pmtiles.png')) return;
      if (res.request().headers()['range'] === undefined) fullBodyRequests.push(res.url());
      else if (res.status() === 206) ranged206Responses.push(res.url());
    });

    await page.goto(server.url);
    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible({ timeout: 60_000 });

    // The preflight (and pmtiles' FetchSource after it) got true 206s...
    await expect
      .poll(() => ranged206Responses.length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    // ...and the passing preflight means the 27 MB full-body fetch NEVER ran.
    expect(fullBodyRequests).toEqual([]);
  } finally {
    await context.close();
    server.kill();
  }
});
