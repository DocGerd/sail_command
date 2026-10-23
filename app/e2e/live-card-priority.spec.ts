import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import {
  STANDARD_VIEWPORTS,
  localDatetimeValue,
  nextFullHourPlus,
  seedFreshProfileDefaults,
  startPreview,
} from './helpers';

// #1822: with a long, expanded AIS list the Live card keeps priority over the
// bottom sheet. From the 820px design floor up its reroute control and reason
// stay on screen without the card scrolling; at narrow widths the list scrolls
// inside the sheet. At every width the card's top stays clear of the Tier 2 map
// chrome, with the AIS list empty and capped. Fake aisstream via
// routeWebSocket; no socket leaves the box.
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const VESSELS = 40;

function classBPosition(mmsi: number, lat: number, lon: number, name: string): string {
  return JSON.stringify({
    MessageType: 'StandardClassBPositionReport',
    MetaData: { MMSI: mmsi, ShipName: name },
    Message: {
      StandardClassBPositionReport: {
        Latitude: lat,
        Longitude: lon,
        Sog: 5.2,
        Cog: 120,
        TrueHeading: 511,
      },
    },
  });
}

test.use({
  permissions: ['geolocation'],
  geolocation: { latitude: 54.8237, longitude: 9.6524, accuracy: 5 },
});

test.beforeEach(async ({ page }) => {
  await seedFreshProfileDefaults(page);
});

interface Sample {
  cardScrollOverflow: number;
  controlsBelowFold: number;
}

// Re-sampled inside every poll attempt (#412/#422): a box read once before the
// layout settles proves nothing.
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.live-view');
    const button = document.querySelector('.live-view-reroute button');
    const reason = document.querySelector('#live-reroute-reason');
    if (!card || !button || !reason) {
      return { cardScrollOverflow: 1e6, controlsBelowFold: 1e6 };
    }
    const c = card.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const r = reason.getBoundingClientRect();
    const visibleBottom = Math.min(window.innerHeight, c.bottom);
    return {
      cardScrollOverflow: card.scrollHeight - card.clientHeight,
      controlsBelowFold: Math.round(Math.max(b.bottom, r.bottom) - visibleBottom),
    };
  });
}

const TIER2_CHROME = ['.map-stack-tl', '.route-layer-controls', '.ais-status'] as const;

interface TopClearance {
  // Tier-2 chrome boxes intersecting the card, as `selector:areaPx`.
  overlaps: string[];
  // Topmost non-card elements over the card's top content band.
  occluders: string[];
  scaleBarSuppressed: boolean | null;
}

// Re-sampled inside every poll attempt (#412/#422). The hit-test sees what the
// rect test cannot: anything else painted over the card's top.
async function topClearance(page: Page): Promise<TopClearance> {
  return page.evaluate((chrome) => {
    const card = document.querySelector<HTMLElement>('.live-view');
    if (!card) return { overlaps: ['no .live-view'], occluders: [], scaleBarSuppressed: null };
    const c = card.getBoundingClientRect();
    const overlaps: string[] = [];
    for (const sel of chrome) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const r = el.getBoundingClientRect();
        const w = Math.min(r.right, c.right) - Math.max(r.left, c.left);
        const h = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
        if (w > 0 && h > 0 && r.width > 0 && r.height > 0) {
          overlaps.push(`${sel}:${Math.round(w * h)}`);
        }
      }
    }
    const occluders = new Set<string>();
    for (const dy of [4, 20]) {
      for (let x = c.left + 4; x <= c.right - 4; x += 24) {
        const hit = document.elementFromPoint(x, c.top + dy);
        if (hit && !card.contains(hit)) {
          occluders.add(`${hit.tagName.toLowerCase()}.${String(hit.className)}`);
        }
      }
    }
    const bar = document.querySelector('.scale-bar');
    return {
      overlaps,
      occluders: [...occluders],
      scaleBarSuppressed: bar ? bar.classList.contains('scale-bar-suppressed') : null,
    };
  }, TIER2_CHROME);
}

async function expectTopClear(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await topClearance(page);
        console.log(`[1822 probe] ${label} ${JSON.stringify(t)}`);
        return [...t.overlaps, ...t.occluders];
      },
      {
        message: `${label}: tier-2 chrome or another element over the card's top`,
        timeout: 30_000,
      },
    )
    .toEqual([]);
}

async function openAisList(page: Page): Promise<void> {
  const disclosure = page.locator('details.ais-in-view');
  await expect(disclosure).toBeVisible();
  // Read the IDL property: getAttribute('open') is '' when present, which is falsy.
  if (!(await disclosure.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await disclosure.locator('> summary').click();
  }
  await expect(disclosure.locator('.ais-in-view-row').first()).toBeVisible();
}

test('#1822: the Live card keeps its reroute control on screen under a long AIS list', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
  const server = await startPreview(page);
  try {
    const sockets: WebSocketRoute[] = [];
    await page.routeWebSocket(/.*/, (ws) => {
      if (ws.url() === AIS_URL) sockets.push(ws);
    });
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await page.getByRole('tab', { name: 'Planen' }).click();
    const origin = page.getByRole('region', { name: 'Start' });
    await origin.getByRole('combobox').fill('Langballigau');
    await origin.getByRole('option').first().click();
    const dest = page.getByRole('region', { name: 'Ziel' });
    await dest.getByRole('combobox').fill('Sønderborg');
    await dest.getByRole('option').first().click();
    await page.getByLabel('Abfahrt').fill(localDatetimeValue(nextFullHourPlus(2)));
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 120_000 });

    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByLabel('AIS-API-Schlüssel (aisstream.io)').fill('FAKE-KEY');
    await page.getByRole('tab', { name: 'Live' }).click();
    await page.getByRole('button', { name: 'Live-Ansicht' }).click();
    await expect(page.locator('.live-view-data')).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => sockets.length).toBe(1);
    for (const [name, viewport] of Object.entries(STANDARD_VIEWPORTS)) {
      await page.setViewportSize(viewport);
      await expectTopClear(page, `empty AIS ${name} ${viewport.width}x${viewport.height}`);
    }
    for (let i = 0; i < VESSELS; i++) {
      sockets[0]!.send(classBPosition(211000100 + i, 54.84 + i * 0.001, 9.66 + i * 0.002, `V${i}`));
    }

    for (const [name, viewport] of Object.entries(STANDARD_VIEWPORTS)) {
      await page.setViewportSize(viewport);
      await openAisList(page);

      const label = `${name} ${viewport.width}x${viewport.height}`;
      await expectTopClear(page, `capped AIS ${label}`);

      // Narrow only: on wide the list sits in the side panel, which the cap does not touch.
      if (viewport.width < 1024) {
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const panel = document.querySelector('.app-panel');
                return panel ? panel.scrollHeight - panel.clientHeight : -1;
              }),
            {
              message: `${label}: sheet panel px of AIS list beyond its scrollport`,
              timeout: 30_000,
            },
          )
          .toBeGreaterThan(0);
      }

      // 820 CSS px is the design floor and spans both layouts. Below it the card
      // cannot both clear the map chrome and fit its controls, so it scrolls.
      if (viewport.width >= 820) {
        await expect
          .poll(async () => (await sample(page)).controlsBelowFold, {
            message: `${label}: reroute button/reason px below the visible card`,
            timeout: 30_000,
          })
          .toBeLessThanOrEqual(0);
        await expect
          .poll(async () => (await sample(page)).cardScrollOverflow, {
            message: `${label}: card content px beyond its scrollport`,
            timeout: 30_000,
          })
          .toBeLessThanOrEqual(1);
      }
    }
  } finally {
    server.kill();
  }
});
