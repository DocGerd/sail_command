import { test, expect, type Page } from '@playwright/test';
import { STANDARD_VIEWPORTS, mapReady, startPreview } from './helpers';

// #1854: the Wetter tab on a real map. Fixtures keep every run off the live
// APIs; the wind fixture is served with a speed that alternates by hour, so
// stepping the hour is visible in the rendered barbs.

const WIND = 'test-fixtures/wind-sw12.json';
const WAVE = 'test-fixtures/wave-bands.json';
const FIXTURES = `windFixture=${WIND}&waveFixture=${WAVE}`;

interface ScTestMap {
  queryRenderedFeatures(
    geometry: unknown,
    opts: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
  getLayoutProperty(id: string, name: string): unknown;
  getLayer(id: string): unknown;
}
type MapWindow = { __scMap?: ScTestMap };

function wetterTab(page: Page) {
  return page.getByRole('tab', { name: 'Wetter', exact: true });
}

function featureCount(page: Page, layer: string): Promise<number> {
  return page.evaluate((id) => {
    const map = (window as MapWindow).__scMap;
    return map?.getLayer(id) ? map.queryRenderedFeatures(undefined, { layers: [id] }).length : -1;
  }, layer);
}

function barbSpeeds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const map = (window as MapWindow).__scMap;
    if (!map?.getLayer('sc-wind-barbs')) return [];
    const speeds = map
      .queryRenderedFeatures(undefined, { layers: ['sc-wind-barbs'] })
      .map((f) => Math.round(Number(f.properties.speedKn)));
    return [...new Set(speeds)].sort((a, b) => a - b);
  });
}

function visibility(page: Page, id: string): Promise<unknown> {
  return page.evaluate(
    (layer) => (window as MapWindow).__scMap?.getLayoutProperty(layer, 'visibility') ?? 'no-layer',
    id,
  );
}

// Alternates 6 and 24 kn by hour index, so neighbouring hours draw different barbs.
async function serveAlternatingWind(page: Page): Promise<void> {
  await page.route('**/test-fixtures/wind-sw12.json', async (route) => {
    const res = await route.fetch();
    const points = (await res.json()) as { hourly: { wind_speed_10m: number[] } }[];
    for (const p of points) {
      p.hourly.wind_speed_10m = p.hourly.wind_speed_10m.map((_, i) => (i % 2 === 0 ? 6 : 24));
    }
    await route.fulfill({ response: res, json: points });
  });
}

function watchOpenMeteo(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('open-meteo')) urls.push(req.url());
  });
  return urls;
}

test('a cold load fetches nothing; the tablist reads Planen, Wetter, Routen, Live, Boot', async ({
  page,
}) => {
  const server = await startPreview(page);
  const requests = watchOpenMeteo(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
    await expect(page.getByRole('tab')).toHaveText(['Planen', 'Wetter', 'Routen', 'Live', 'Boot']);
    await expect(page.getByRole('tab', { name: 'Planen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(requests).toEqual([]);

    // A failed fetch with nothing held is a typed message, never a blank card.
    await page.route(/open-meteo\.com/, (route) => route.abort());
    await wetterTab(page).click();
    await expect(page.locator('.conditions-card [role="alert"]')).toContainText(
      'Windvorhersagedienst nicht erreichbar',
      { timeout: 60_000 },
    );
    // Wind only (the client retries it); waves are never fetched after a wind failure.
    expect(requests.filter((u) => u.includes('api.open-meteo.com')).length).toBeGreaterThan(0);
    expect(requests.filter((u) => u.includes('marine-api'))).toHaveLength(0);
  } finally {
    server.kill();
  }
});

test('hour stepping moves barbs and sea state; depth is hidden until shown; the handoff fills the departure', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const server = await startPreview(page);
  const requests = watchOpenMeteo(page);
  await serveAlternatingWind(page);
  try {
    await page.goto(`${server.url}?${FIXTURES}`);
    await mapReady(page);
    const sizes = [
      STANDARD_VIEWPORTS.tabletPortrait,
      STANDARD_VIEWPORTS.tabletLandscape,
      STANDARD_VIEWPORTS.desktopHd,
      STANDARD_VIEWPORTS.desktop4k,
    ];
    for (const viewport of sizes) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await test.step(`${viewport.width}x${viewport.height} ${colorScheme}`, async () => {
          await page.setViewportSize(viewport);
          await page.emulateMedia({ colorScheme });
          await wetterTab(page).click();
          const value = page.locator('.conditions-hour-value');
          await expect(value).toBeVisible({ timeout: 15_000 });
          await expect
            .poll(() => featureCount(page, 'sc-wind-barbs'), { timeout: 15_000 })
            .toBeGreaterThan(0);
          await expect
            .poll(() => featureCount(page, 'sc-waves-arrows'), { timeout: 15_000 })
            .toBeGreaterThan(0);
          await expect.poll(() => visibility(page, 'sc-depth')).toBe('none');

          const before = await value.textContent();
          const speedsBefore = await barbSpeeds(page);
          expect(speedsBefore).toHaveLength(1);
          await page.getByRole('button', { name: 'Eine Stunde später' }).click();
          await expect(value).not.toHaveText(before ?? '');
          await expect.poll(() => barbSpeeds(page)).not.toEqual(speedsBefore);

          await page.getByRole('button', { name: 'Tiefen zeigen' }).click();
          await expect.poll(() => visibility(page, 'sc-depth')).toBe('visible');

          const hourText = (await value.textContent()) ?? '';
          await page.getByRole('button', { name: 'Als Abfahrt übernehmen' }).click();
          await expect(page.getByRole('tab', { name: 'Planen' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          const departure = await page.locator('#planner-departure').inputValue();
          expect(hourText).toContain(departure.slice(11, 16));
        });
      }
    }
    expect(requests, 'fixtures keep the run off the live APIs').toEqual([]);
  } finally {
    server.kill();
  }
});

test('the day strip is a list or grid by its own width, selects hours, and the ribbon shows sea state', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const server = await startPreview(page);
  const requests = watchOpenMeteo(page);
  try {
    await page.goto(`${server.url}?${FIXTURES}`);
    await mapReady(page);
    const sizes = [
      STANDARD_VIEWPORTS.tabletPortrait,
      STANDARD_VIEWPORTS.tabletLandscape,
      STANDARD_VIEWPORTS.desktopHd,
      STANDARD_VIEWPORTS.desktop4k,
    ];
    for (const viewport of sizes) {
      for (const colorScheme of ['light', 'dark'] as const) {
        await test.step(`${viewport.width}x${viewport.height} ${colorScheme}`, async () => {
          await page.setViewportSize(viewport);
          await page.emulateMedia({ colorScheme });
          await wetterTab(page).click();
          const strip = page.getByRole('group', { name: /^Übersicht .+, Revier$/ });
          await expect(strip).toBeVisible({ timeout: 15_000 });
          const cols = strip.getByRole('button');
          await expect.poll(() => cols.count()).toBeGreaterThan(1);

          const geo = await strip.evaluate((el) => {
            const body = el.querySelector('.conditions-strip-body')!;
            const boxes = Array.from(el.querySelectorAll('button')).map((b) =>
              b.getBoundingClientRect(),
            );
            return {
              stripPx: el.getBoundingClientRect().width,
              remPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
              overflow: body.scrollWidth - body.clientWidth,
              tops: boxes.map((b) => Math.round(b.top)),
              minW: Math.min(...boxes.map((b) => b.width)),
              minH: Math.min(...boxes.map((b) => b.height)),
            };
          });
          expect(geo.overflow).toBeLessThanOrEqual(0);
          if (geo.stripPx >= 46 * geo.remPx) {
            expect(new Set(geo.tops).size, 'grid: one row of columns').toBe(1);
            expect(geo.minW).toBeGreaterThanOrEqual(48);
            expect(geo.minH).toBeGreaterThanOrEqual(72);
          } else {
            expect(new Set(geo.tops).size, 'list: one row per window').toBe(geo.tops.length);
            expect(geo.minH).toBeGreaterThanOrEqual(44);
          }
          await expect(strip.locator('.conditions-col-sea').first()).toHaveText(/\d/);

          const second = cols.nth(1);
          const time = (await second.locator('.conditions-col-time').textContent()) ?? '';
          await second.click();
          await expect(second).toHaveAttribute('aria-current', 'true');
          await expect(page.locator('.conditions-hour-value')).toContainText(time);
          await expect(cols.first()).not.toHaveAttribute('aria-current', 'true');

          await expect
            .poll(() => page.locator('.conditions-ribbon rect').count())
            .toBeGreaterThan(0);

          if (viewport === STANDARD_VIEWPORTS.tabletPortrait) {
            const fits = await page.evaluate(() => {
              const panel = document.querySelector('.app-panel')!;
              const chip = document.querySelector('.chip.conditions-status')!;
              const actions = document.querySelector('.conditions-actions')!;
              return {
                scrollTop: panel.scrollTop,
                chipTop: chip.getBoundingClientRect().top,
                actionsBottom: actions.getBoundingClientRect().bottom,
                vh: window.innerHeight,
              };
            });
            expect(fits.scrollTop).toBe(0);
            expect(fits.chipTop).toBeGreaterThanOrEqual(0);
            expect(fits.actionsBottom).toBeLessThanOrEqual(fits.vh);
          }
          await page.getByRole('tab', { name: 'Planen' }).click();
        });
      }
    }
    expect(requests, 'fixtures keep the run off the live APIs').toEqual([]);
  } finally {
    server.kill();
  }
});

test('offline: nothing held says so; a held forecast shows with its age and the planning note', async ({
  page,
  context,
}) => {
  const server = await startPreview(page);
  const requests = watchOpenMeteo(page);
  try {
    await page.goto(`${server.url}?${FIXTURES}`);
    await mapReady(page);
    // setOffline only flips navigator.onLine here; the fixture would still load.
    await context.setOffline(true);
    await wetterTab(page).click();
    await expect(
      page.getByText('Es ist keine Vorhersage im Speicher.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Planen' }).click();

    await context.setOffline(false);
    await wetterTab(page).click();
    await expect(page.locator('.conditions-hour-value')).toBeVisible({ timeout: 15_000 });
    await context.setOffline(true);
    await expect(page.locator('.conditions-line-warn')).toContainText(
      /Offline – zeigt die Vorhersage, abgerufen \d\d:\d\d \(vor \d+ min\)/,
    );
    await expect(page.getByText('Offline – Planen braucht eine Verbindung.')).toBeVisible();
    await page.getByRole('button', { name: /Als Abfahrt übernehmen|Jetzt als Abfahrt/ }).click();
    await expect(page.getByRole('tab', { name: 'Planen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(requests).toEqual([]);
  } finally {
    await context.setOffline(false);
    server.kill();
  }
});
