import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS } from './helpers';

// #1707: seed the next passage from a planned route, and plan it offline from
// that route's stored forecast. Deterministic wind via the `?windFixture=`
// escape hatch, as plan.spec.ts does.
const NEXT = 'Nächste Passage planen';
const SOURCE_NAME = 'Langballigau → Sonderburg';

async function planSource(page: Page, url: string): Promise<void> {
  await page.goto(`${url}?windFixture=test-fixtures/wind-sw12.json`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const start = page.getByRole('region', { name: 'Start' });
  await start.getByRole('combobox').fill('Langballigau');
  await start.getByRole('option').first().click();
  const ziel = page.getByRole('region', { name: 'Ziel' });
  await ziel.getByRole('combobox').fill('Sønderborg');
  await ziel.getByRole('option').first().click();
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  // Settle before any tab switch: PlansList reads IndexedDB once, on mount.
  await expect(planButton).toBeEnabled({ timeout: 60_000 });
}

// setOffline alone does not reach a service worker's own fetches, and a
// reload would drop the ephemeral seed, so the page is told directly.
async function goOffline(
  page: Page,
  context: BrowserContext,
): Promise<{ windRequests: () => number }> {
  let windRequests = 0;
  page.on('request', (req) => {
    if (req.url().includes('wind-sw12.json')) windRequests++;
  });
  await context.setOffline(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true });
    window.dispatchEvent(new Event('offline'));
  });
  return { windRequests: () => windRequests };
}

for (const name of ['tabletPortrait', 'desktopHd'] as const) {
  test(`#1707 seeds the next passage from both cards at ${name}`, async ({ page }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS[name]);
    const server = await startPreview(page);
    try {
      await planSource(page, server.url);
      const start = page.getByRole('region', { name: 'Start' });
      const ziel = page.getByRole('region', { name: 'Ziel' });

      await page.getByRole('button', { name: NEXT }).click();
      await expect(start.locator('.endpoint-name')).toHaveText('Sonderburg');
      await expect(ziel.getByRole('combobox')).toBeFocused();
      await expect(page.getByLabel('Abfahrt')).toHaveValue(/T10:00$/);
      await expect(page.getByRole('button', { name: 'Route planen' })).toBeDisabled();
      await expect(page.getByText('Start und Ziel wählen.', { exact: true })).toBeVisible();

      await page.getByRole('tab', { name: 'Routen' }).click();
      await page.getByRole('button', { name: NEXT }).click();
      await expect(page.getByRole('tab', { name: 'Planen' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(ziel.getByRole('combobox')).toBeFocused();
    } finally {
      server.kill();
    }
  });
}

test('#1707 offline: plans the next passage from the stored forecast', async ({
  page,
  context,
}) => {
  await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
  const server = await startPreview(page);
  try {
    await planSource(page, server.url);
    await page.getByRole('button', { name: NEXT }).click();
    const offline = await goOffline(page, context);

    await expect(
      page.getByText('Offline — nur die nächste Passage mit gespeicherter Vorhersage planbar'),
    ).toBeVisible();
    await expect(
      page.getByText(
        new RegExp(`^Offline — nutzt die gespeicherte Vorhersage von „${SOURCE_NAME}“`),
      ),
    ).toBeVisible();

    const ziel = page.getByRole('region', { name: 'Ziel' });
    await ziel.getByRole('combobox').fill('Langballigau');
    await ziel.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Route planen' }).click();

    // The seed ends with the new active plan, so the plain banner returns once the run is done.
    // Wait for it before switching tabs: PlansList reads IndexedDB once, on mount.
    await expect(
      page.getByText('Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.'),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.locator('.plans-list-row')).toHaveCount(2, { timeout: 60_000 });
    expect(offline.windRequests()).toBe(0);
  } finally {
    server.kill();
  }
});

test('#1707 offline: a stored forecast too short for the departure keeps planning disabled', async ({
  page,
  context,
}) => {
  await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
  const server = await startPreview(page);
  try {
    await planSource(page, server.url);
    await page.getByRole('button', { name: NEXT }).click();
    await goOffline(page, context);

    const ziel = page.getByRole('region', { name: 'Ziel' });
    await ziel.getByRole('combobox').fill('Langballigau');
    await ziel.getByRole('option').first().click();

    // The input's own max lies past the fixture's last hour.
    const departure = page.getByLabel('Abfahrt');
    const max = await departure.getAttribute('max');
    if (max === null) throw new Error('expected the departure input to carry a max');
    await departure.fill(max);

    await expect(
      page.getByText(/^Offline — die gespeicherte Vorhersage reicht nur bis /),
    ).toBeVisible();
    await expect(
      page.getByText('Offline — Planung deaktiviert. Gespeicherte Routen bleiben verfügbar.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Route planen' })).toBeDisabled();
    await expect(
      page.getByText(
        'Windvorhersagedienst nicht erreichbar. Internetverbindung prüfen und erneut versuchen.',
      ),
    ).toBeVisible();
  } finally {
    server.kill();
  }
});
