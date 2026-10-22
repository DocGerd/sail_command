import { test, expect, type Page } from '@playwright/test';
import {
  STANDARD_VIEWPORTS,
  localDatetimeValue,
  nextFullHourPlus,
  startPreview,
  type PreviewServer,
} from './helpers';

// #1699: the plan-bound sea-state overlay (WaveLayer.tsx) on a real map, fed
// by the gitignored `wave-bands.json` fixture (scripts/wave-fixture.mjs, built
// by `pree2e`): Hs cycles through all five WMO bands by latitude row, five
// points are all-null, and every series is constant over time. Waits on map
// state poll VALUES (feature counts, band sets, layer ids) and re-sample the
// map on every call.

const WIND = 'test-fixtures/wind-sw12.json';
const WAVE = 'test-fixtures/wave-bands.json';
const FILL = 'sc-waves-fill';
const ARROWS = 'sc-waves-arrows';
const EDGE = 'sc-waves-edge';
// wave-fixture.mjs's E2E_NULL_POINT [1, 20]: an all-null point that, with its
// four neighbours, is water in the mask (waveFixtureMask.test.ts), so land
// culling cannot stand in for its null-ness.
const NULL_CELL = { lng: 11.4, lat: 54.4 };
const STEP_DEG = 0.1;

test.use({ viewport: STANDARD_VIEWPORTS.desktopHd });

interface ScTestMap {
  queryRenderedFeatures(
    geometry: unknown,
    opts: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
  project(lngLat: [number, number]): unknown;
  jumpTo(opts: { center: [number, number]; zoom: number }): void;
  getLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  getStyle(): { layers: Array<{ id: string }> };
}
type MapWindow = { __scMap?: ScTestMap };

async function planRoute(page: Page, server: PreviewServer, query: string): Promise<void> {
  await page.goto(`${server.url}?${query}`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill('Langballigau');
  await expect(origin.getByRole('option')).toHaveCount(1);
  await origin.getByRole('option').first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill('Sønderborg');
  await expect(dest.getByRole('option')).toHaveCount(1);
  await dest.getByRole('option').first().click();
  // Explicit departure (#1731): the form default can fall into the past.
  await page.getByLabel('Abfahrt').fill(localDatetimeValue(nextFullHourPlus(2)));
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 120_000 });
  await page.waitForFunction(() =>
    Boolean((window as MapWindow).__scMap?.getLayer('sc-route-shallow')),
  );
}

async function openControls(page: Page): Promise<void> {
  const disclosure = page.locator('details.route-layer-controls-disclosure');
  // IDL `open`, never getAttribute (boolean attribute, CLAUDE.md).
  if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await disclosure.locator('> summary').click();
  }
}

function waveToggle(page: Page) {
  return page.getByRole('checkbox', { name: 'Seegang anzeigen', exact: true });
}

function layerVisibility(page: Page, id: string): Promise<unknown> {
  return page.evaluate(
    (layer) => (window as MapWindow).__scMap?.getLayoutProperty(layer, 'visibility') ?? 'no-layer',
    id,
  );
}

function featureCount(page: Page, layer: string): Promise<number> {
  return page.evaluate((id) => {
    const map = (window as MapWindow).__scMap;
    return map ? map.queryRenderedFeatures(undefined, { layers: [id] }).length : -1;
  }, layer);
}

/** Distinct `band` values of the fill features currently rendered. */
function renderedBands(page: Page): Promise<string[]> {
  return page.evaluate((id) => {
    const map = (window as MapWindow).__scMap;
    if (!map) return ['no-map'];
    const bands = map.queryRenderedFeatures(undefined, { layers: [id] }).map((f) => {
      const b = f.properties.band;
      return typeof b === 'string' ? b : '?';
    });
    return [...new Set(bands)].sort();
  }, FILL);
}

/** Fill features under the pixel of each lng/lat. */
function fillHitsAt(page: Page, points: Record<string, [number, number]>) {
  return page.evaluate(
    ([id, pts]) => {
      const map = (window as MapWindow).__scMap;
      const out: Record<string, number> = {};
      for (const [name, lngLat] of Object.entries(pts)) {
        out[name] = map
          ? map.queryRenderedFeatures(map.project(lngLat), { layers: [id] }).length
          : -1;
      }
      return out;
    },
    [FILL, points] as const,
  );
}

test.describe('sea-state overlay (#1699)', () => {
  test('the wave fixture is actually served', async ({ page }) => {
    const server = await startPreview(page);
    try {
      // The preview server answers a missing file with the SPA shell (200), and
      // the app swallows a failed wave fetch into "no sea state", so reachability
      // alone proves nothing: parse the body.
      const res = await page.request.get(new URL(WAVE, server.url).toString());
      expect(res.status()).toBe(200);
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`wave fixture is not JSON (run pree2e): ${text.slice(0, 80)}`);
      }
      expect(Array.isArray(parsed) ? parsed.length : -1, 'one entry per lattice point').toBe(
        14 * 23,
      );
    } finally {
      server.kill();
    }
  });

  test('renders shading and arrows; a null point is no data, never calm', async ({ page }) => {
    const server = await startPreview(page);
    const openMeteoRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);

      await expect.poll(() => layerVisibility(page, FILL), { timeout: 30_000 }).toBe('visible');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('visible');
      await expect.poll(() => featureCount(page, FILL), { timeout: 30_000 }).toBeGreaterThan(0);

      // Centre the map on the null point: its four water neighbours (S is a
      // real calm cell) each have a feature, the null point itself has none.
      await page.evaluate(
        ({ lng, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lng, lat], zoom: 9 }),
        NULL_CELL,
      );
      const hits = () =>
        fillHitsAt(page, {
          nullCell: [NULL_CELL.lng, NULL_CELL.lat],
          north: [NULL_CELL.lng, NULL_CELL.lat + STEP_DEG],
          south: [NULL_CELL.lng, NULL_CELL.lat - STEP_DEG],
          east: [NULL_CELL.lng + STEP_DEG, NULL_CELL.lat],
          west: [NULL_CELL.lng - STEP_DEG, NULL_CELL.lat],
        });
      await expect
        .poll(
          async () => {
            const h = await hits();
            return { ...h, neighbours: [h.north, h.south, h.east, h.west].every((n) => n > 0) };
          },
          { timeout: 30_000 },
        )
        .toMatchObject({ nullCell: 0, neighbours: true });
      // Arrows checked here, not at the route fit: land culling leaves that
      // close-in view with no lattice point, so no arrow anchor, in it.
      await expect.poll(() => featureCount(page, ARROWS), { timeout: 30_000 }).toBeGreaterThan(0);

      expect(openMeteoRequests, 'fixtures must keep the run off the live APIs').toEqual([]);
    } finally {
      server.kill();
    }
  });

  test('the toggle hides the overlay layers and persists across a reload', async ({ page }) => {
    const server = await startPreview(page);
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      await openControls(page);
      const toggle = waveToggle(page);
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await expect.poll(() => featureCount(page, FILL), { timeout: 30_000 }).toBeGreaterThan(0);

      await toggle.uncheck();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('none');
      await expect.poll(() => layerVisibility(page, EDGE)).toBe('none');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('none');
      await expect.poll(() => featureCount(page, FILL)).toBe(0);
      await expect.poll(() => featureCount(page, ARROWS)).toBe(0);

      // The reload restores the saved plan (with its stored wave grid), so
      // the preference is read back without planning again.
      await page.reload();
      await page.waitForFunction(
        (id) => Boolean((window as MapWindow).__scMap?.getLayer(id)),
        FILL,
      );
      await openControls(page);
      await expect(waveToggle(page)).not.toBeChecked();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('none');
      await expect.poll(() => layerVisibility(page, ARROWS)).toBe('none');

      await waveToggle(page).check();
      await expect.poll(() => layerVisibility(page, FILL)).toBe('visible');
      await expect.poll(() => featureCount(page, FILL), { timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      server.kill();
    }
  });

  test('layer order: above the depth ramp, below points and the route', async ({ page }) => {
    const server = await startPreview(page);
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      const below = ['sc-depth', 'sc-depth-hatch'];
      const above = [
        'sc-saved-waypoints',
        'sc-harbor-points',
        'sc-seamarks',
        'sc-seamarks-hazard',
        'sc-ais-vessels',
        'sc-route-shallow',
        'sc-route-sail',
      ];
      // Layers a fresh profile always has; the rest are checked when present.
      const required = ['sc-depth', 'sc-harbor-points', 'sc-seamarks', 'sc-route-shallow'];
      await expect
        .poll(
          async () => {
            const ids = await page.evaluate(
              () => (window as MapWindow).__scMap?.getStyle().layers.map((l) => l.id) ?? [],
            );
            const at = (id: string) => ids.indexOf(id);
            const problems: string[] = [];
            for (const id of [FILL, ARROWS, ...required]) {
              if (at(id) < 0) problems.push(`missing ${id}`);
            }
            if (at(FILL) >= at(ARROWS)) problems.push(`${FILL} not below ${ARROWS}`);
            for (const id of below) {
              if (at(id) >= 0 && at(id) > at(FILL)) problems.push(`${id} above ${FILL}`);
            }
            for (const id of above) {
              if (at(id) >= 0 && at(id) < at(ARROWS)) problems.push(`${id} below ${ARROWS}`);
            }
            return problems;
          },
          { timeout: 30_000 },
        )
        .toEqual([]);
    } finally {
      server.kill();
    }
  });

  test('without a wave fixture: toggle disabled, muted note, no banner, no live request', async ({
    page,
  }) => {
    const server = await startPreview(page);
    const openMeteoRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}`);
      await openControls(page);

      const toggle = waveToggle(page);
      await expect(toggle).toBeVisible();
      await expect(toggle).toBeDisabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.locator('#route-waves-note')).toHaveText(
        'Für diesen Plan sind keine Seegangsdaten verfügbar.',
      );
      await expect(toggle).toHaveAttribute('aria-describedby', 'route-waves-note');

      // No wave layers at all: the stack is exactly the no-overlay stack.
      const waveLayerIds = await page.evaluate(
        () =>
          (window as MapWindow).__scMap
            ?.getStyle()
            .layers.map((l) => l.id)
            .filter((id) => id.startsWith('sc-waves')) ?? ['no-map'],
      );
      expect(waveLayerIds).toEqual([]);

      // Display-only data must not raise a banner: nothing in the banner area
      // mentions sea state. (Other banners, e.g. the SW toast, may come and go.)
      await expect(
        page.locator('.banner-area .banner').filter({ hasText: /Seegang|Wellen/i }),
      ).toHaveCount(0);
      expect(openMeteoRequests, 'wind fixture alone must not reach any live API').toEqual([]);
    } finally {
      server.kill();
    }
  });
});

// The fixture is time-invariant, so the slider cannot change anything by
// itself. This describe serves a variant instead (odd hours all rough, even
// hours the stock bands) through page.route, with the service worker blocked.
test.describe('sea-state overlay follows the slider (#1699)', () => {
  test.use({ serviceWorkers: 'block' });

  test('moving the time slider re-samples the wave grid', async ({ page }) => {
    const server = await startPreview(page);
    let served = 0;
    await page.route('**/test-fixtures/wave-bands.json', async (route) => {
      served += 1;
      const res = await route.fetch();
      const points = (await res.json()) as Array<{ hourly: { wave_height: Array<number | null> } }>;
      for (const p of points) {
        p.hourly.wave_height = p.hourly.wave_height.map((h, i) =>
          h !== null && i % 2 === 1 ? 3.2 : h,
        );
      }
      await route.fulfill({ response: res, json: points });
    });
    try {
      await planRoute(page, server, `windFixture=${WIND}&waveFixture=${WAVE}`);
      expect(served, 'the variant fixture was served').toBeGreaterThan(0);
      await page.evaluate(
        ({ lng, lat }) => (window as MapWindow).__scMap?.jumpTo({ center: [lng, lat], zoom: 8 }),
        NULL_CELL,
      );
      await expect.poll(() => featureCount(page, FILL), { timeout: 30_000 }).toBeGreaterThan(0);

      const slider = page.getByRole('slider', { name: 'Vorhersagezeitpunkt' });
      await expect(slider).toBeVisible();
      await slider.focus();
      await page.keyboard.press('Home');
      await expect(slider).toHaveValue('0');
      await expect
        .poll(async () => (await renderedBands(page)).length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      const first = await renderedBands(page);

      await page.keyboard.press('ArrowRight');
      await expect(slider).toHaveValue('1');
      await expect.poll(() => renderedBands(page), { timeout: 30_000 }).not.toEqual(first);
      const second = await renderedBands(page);

      // Adjacent hours have opposite parity: one is all rough, the other the
      // stock mix of bands.
      const [uniform, mixed] = first.length < second.length ? [first, second] : [second, first];
      expect(uniform).toEqual(['rough']);
      expect(mixed.length).toBeGreaterThan(1);

      await page.keyboard.press('ArrowLeft');
      await expect(slider).toHaveValue('0');
      await expect.poll(() => renderedBands(page), { timeout: 30_000 }).toEqual(first);
    } finally {
      server.kill();
    }
  });
});
