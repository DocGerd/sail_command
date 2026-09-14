import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STANDARD_VIEWPORTS, mapReady, startPreview, type PreviewServer } from './helpers';

// #1164 T6: real-browser proof of the lazy basemap region path. `pree2e` builds
// with SC_E2E_REGION_FIXTURE=1, which adds e2e/fixtures/region-e2e.pmtiles.png
// to dist/data/ and to dist/basemap-regions.json (vite.config.ts's
// regionManifest()); production builds carry neither.
//
// Geometry the spec depends on: the composite protocol serves CORE for any tile
// overlapping the core bbox (9.4-11.0 E), so a region is only ever read where it
// lies OUTSIDE the core. The fixture covers 9.200-9.315 E / 54.74-54.86 N,
// z11-12, west of Flensburg: every z>=11 tile there ends at or before 9.3164 E,
// so none overlaps the core. No route can leave the core, but the plan's 5 nm
// pin corridor (routeCorridorBoxes) does reach 9.29 E from Flensburg.
//
// Offline is made honest by killing the preview server: setOffline() does not
// block service-worker fetches (see offline.spec.ts).

const DIST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const REGION_PATH = 'data/region-e2e.pmtiles.png';
// Mirrors basemapRegions.ts's regionCacheName('/sail_command/') — this
// tsconfig project cannot import app source (same as offline.spec.ts's glyph literal).
const REGION_CACHE = 'sailcommand-regions-sail_command@v1';
const GERMAN_MAP_ERROR_BANNER =
  'Kartendaten konnten nicht geladen werden — Anzeige evtl. unvollständig.';

// Camera: zoom 12.2 renders z12 tiles. Region box stays ~0.016 deg clear of
// the 9.3164 tile seam; the core box sits in core-served tile x=2154.
const CAMERA = { center: [9.3, 54.8] as [number, number], zoom: 12.2 };
const REGION_BOX: [[number, number], [number, number]] = [
  [9.21, 54.78],
  [9.3, 54.82],
];
const CORE_BOX: [[number, number], [number, number]] = [
  [9.33, 54.78],
  [9.39, 54.82],
];

interface RegionEntry {
  id: string;
  path: string;
  bytes: number;
  bbox: [number, number, number, number];
}

function fixtureEntry(): RegionEntry {
  const manifest = JSON.parse(readFileSync(resolve(DIST_DIR, 'basemap-regions.json'), 'utf8')) as {
    core: RegionEntry;
    regions: RegionEntry[];
  };
  const entry = manifest.regions.find((r) => r.path === REGION_PATH);
  if (!entry) {
    throw new Error(
      `dist/basemap-regions.json has no ${REGION_PATH} entry — was dist built by pree2e ` +
        `(SC_E2E_REGION_FIXTURE=1)? regions: ${JSON.stringify(manifest.regions)}`,
    );
  }
  return entry;
}

/** Plans Flensburg -> Glücksburg online with the SW controlling, then waits
 * for the post-save pin to store the fixture archive. */
async function planAndPin(page: Page, server: PreviewServer, bytes: number): Promise<void> {
  await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
  await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await page.getByRole('region', { name: 'Start' }).getByRole('combobox').fill('Flensburg');
  await page.getByRole('region', { name: 'Start' }).getByRole('option').first().click();
  await page.getByRole('region', { name: 'Ziel' }).getByRole('combobox').fill('Glücksburg');
  await page.getByRole('region', { name: 'Ziel' }).getByRole('option').first().click();
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 60_000 });
  // The rig comparison renders on the Routen tab once the plan is saved (offline.spec.ts pattern).
  await page.getByRole('tab', { name: 'Routen' }).click();
  await expect(page.getByRole('tablist', { name: 'Riggvergleich' })).toBeVisible({
    timeout: 60_000,
  });

  // The stored archive's body size, not a boolean: a short or missing pin
  // reports its actual size (or null) in the failure.
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ cacheName, path }) => {
            const hit = await (await caches.open(cacheName)).match(path);
            return hit ? (await hit.blob()).size : null;
          },
          { cacheName: REGION_CACHE, path: REGION_PATH },
        ),
      { timeout: 60_000 },
    )
    .toBe(bytes);
}

/** Kills the server and reloads the bare URL with the SW as the only source. */
async function goOfflineAndReload(page: Page, server: PreviewServer): Promise<void> {
  // Bare URL first: the precache route does not strip ?windFixture=.
  await page.goto(server.url);
  server.kill();
  await page.context().setOffline(true);
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'onLine', { value: false, configurable: true });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'SailCommand' })).toBeVisible({
    timeout: 30_000,
  });
  await mapReady(page);
}

type ProbeMap = {
  getStyle: () => { layers: Array<{ id: string; type: string; source?: string }> };
  getCenter: () => { lng: number; lat: number };
  getZoom: () => number;
  jumpTo: (o: { center: [number, number]; zoom: number }) => void;
  loaded: () => boolean;
  project: (p: [number, number]) => { x: number; y: number };
  queryRenderedFeatures: (
    box: [[number, number], [number, number]],
    opts: { layers: string[] },
  ) => unknown[];
};

/** Holds the camera on CAMERA (re-applying it if a restore moved it) and
 * reports basemap fill/line feature counts in both boxes once tiles settled. */
function probe(page: Page): Promise<string> {
  return page.evaluate(
    ({ camera, regionBox, coreBox }) => {
      const map = (window as unknown as { __scE2eMap?: ProbeMap }).__scE2eMap;
      if (!map) return 'no-map-handle';
      const c = map.getCenter();
      if (
        Math.abs(c.lng - camera.center[0]) > 1e-6 ||
        Math.abs(c.lat - camera.center[1]) > 1e-6 ||
        Math.abs(map.getZoom() - camera.zoom) > 1e-6
      ) {
        map.jumpTo(camera);
        return 'camera-moved';
      }
      if (!map.loaded()) return 'not-loaded';
      const layers = map
        .getStyle()
        .layers.filter((l) => l.source === 'protomaps' && (l.type === 'fill' || l.type === 'line'))
        .map((l) => l.id);
      const count = (box: [[number, number], [number, number]]) => {
        const a = map.project(box[0]);
        const b = map.project(box[1]);
        return map.queryRenderedFeatures(
          [
            [Math.min(a.x, b.x), Math.min(a.y, b.y)],
            [Math.max(a.x, b.x), Math.max(a.y, b.y)],
          ],
          { layers },
        ).length;
      };
      return `region=${count(regionBox)} core=${count(coreBox)}`;
    },
    { camera: CAMERA, regionBox: REGION_BOX, coreBox: CORE_BOX },
  );
}

function parseCounts(s: string): { region: number; core: number } | null {
  const m = /^region=(\d+) core=(\d+)$/.exec(s);
  return m ? { region: Number(m[1]), core: Number(m[2]) } : null;
}

test('build guard: the fixture region is in the manifest, outside the core bbox, and not precached', () => {
  const entry = fixtureEntry();
  const manifest = JSON.parse(readFileSync(resolve(DIST_DIR, 'basemap-regions.json'), 'utf8')) as {
    core: RegionEntry;
  };
  // Disjoint from the core on the west side — the precondition for the
  // composite protocol ever reading this archive.
  expect(entry.bbox[2]).toBeLessThan(manifest.core.bbox[0]);
  const sw = readFileSync(resolve(DIST_DIR, 'sw.js'), 'utf8');
  const precacheUrls = [...sw.matchAll(/"url":"([^"]+)"/g)].map((m) => m[1]);
  expect(precacheUrls).toContain('basemap-regions.json');
  expect(precacheUrls.filter((u) => u.includes('region-'))).toEqual([]);
});

test('(a) a pinned region renders offline from the region cache, with no map-error banner', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { bytes } = fixtureEntry();
  const server = await startPreview(page);
  try {
    await planAndPin(page, server, bytes);
    await goOfflineAndReload(page, server);

    await expect
      .poll(
        async () => {
          const s = await probe(page);
          const c = parseCounts(s);
          return c && c.region > 0 && c.core > 0 ? 'both-rendered' : s;
        },
        { timeout: 60_000 },
      )
      .toBe('both-rendered');
    await expect(page.getByText(GERMAN_MAP_ERROR_BANNER)).toHaveCount(0);
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    server.kill();
  }
});

test('(b) an unpinned region renders blank offline, core still renders, no map-error banner', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { bytes } = fixtureEntry();
  const server = await startPreview(page);
  try {
    await planAndPin(page, server, bytes);
    // Identical to (a) except the pin is gone.
    expect(await page.evaluate((name) => caches.delete(name), REGION_CACHE)).toBe(true);
    await goOfflineAndReload(page, server);

    // Core rendering at the settled camera proves the map drew this view; the
    // region box, read in the same tick, must then be empty.
    await expect
      .poll(
        async () => {
          const s = await probe(page);
          const c = parseCounts(s);
          return c && c.core > 0 ? `region=${c.region}` : s;
        },
        { timeout: 60_000 },
      )
      .toBe('region=0');
    await expect(page.getByText(GERMAN_MAP_ERROR_BANNER)).toHaveCount(0);
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    server.kill();
  }
});
