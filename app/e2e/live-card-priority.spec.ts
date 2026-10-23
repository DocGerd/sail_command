import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import {
  STANDARD_VIEWPORTS,
  localDatetimeValue,
  nextFullHourPlus,
  seedFreshProfileDefaults,
  startPreview,
} from './helpers';

// #1822: with a long, expanded AIS list the Live card keeps priority over the
// bottom sheet: the list scrolls inside the sheet at narrow widths. #1843: the
// reroute control precedes the readouts and the card is capped like the sheet, so with a
// fresh GPS fix the control and its reason stay on screen from the 820px design
// floor up, and the card's top stays clear of the Tier 2 map chrome (route cluster expanded, its
// worst case). Fake aisstream via routeWebSocket; no socket
// leaves the box.
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const VESSELS = 40;
const FIX = { latitude: 54.8237, longitude: 9.6524, accuracy: 5 };
// Well under GPS_STALE_AFTER_MS, so the card never drops its readouts.
const FIX_REFRESH_MS = 2_000;

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
  geolocation: FIX,
});

test.beforeEach(async ({ page }) => {
  await seedFreshProfileDefaults(page);
});

// Offenders, re-sampled inside every poll attempt (#412/#422): a box read once
// before the layout settles proves nothing. The GPS check shares the sample, so
// the geometry is always the readouts-shown card a skipper sees while tracking.
// The card may scroll (its readouts do); the reroute control must sit inside its
// visible band, unscrolled.
async function controlsOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    if (!document.querySelector('.live-view-data:not(.live-view-data--stale)')) {
      out.push('no fresh .live-view-data');
    }
    if (document.querySelector('.live-view-gps--lost')) out.push('GPS lost block shown');
    if (document.querySelector('.live-view-gps-stale')) out.push('GPS stale chip shown');
    const card = document.querySelector<HTMLElement>('.live-view');
    const button = document.querySelector('.live-view-reroute button');
    const reason = document.querySelector('#live-reroute-reason');
    if (!card || !button || !reason) return [...out, 'card, reroute button or reason missing'];
    const c = card.getBoundingClientRect();
    const visibleTop = Math.max(0, c.top);
    const visibleBottom = Math.min(window.innerHeight, c.bottom);
    for (const [name, el] of [
      ['button', button],
      ['reason', reason],
    ] as const) {
      const r = el.getBoundingClientRect();
      const below = Math.round(r.bottom - visibleBottom);
      const above = Math.round(visibleTop - r.top);
      if (below > 0) out.push(`${name}BelowFold:${below}`);
      if (above > 0) out.push(`${name}AboveCard:${above}`);
    }
    if (card.scrollTop !== 0) out.push(`cardScrolled:${card.scrollTop}`);
    return out;
  });
}

const TIER2_CHROME = ['.map-stack-tl', '.route-layer-controls', '.ais-status'] as const;

interface TopClearance {
  // Tier-2 chrome boxes intersecting the card, as `selector:areaPx`.
  overlaps: string[];
  // Topmost non-card elements over the card's top content band.
  occluders: string[];
}

// Re-sampled inside every poll attempt (#412/#422). The hit-test sees what the
// rect test cannot: anything else painted over the card's top.
async function topClearance(page: Page): Promise<TopClearance> {
  return page.evaluate((chrome) => {
    const card = document.querySelector<HTMLElement>('.live-view');
    if (!card) return { overlaps: ['no .live-view'], occluders: [] };
    const c = card.getBoundingClientRect();
    const overlaps: string[] = [];
    // The probe below assumes the toast is gone.
    if (document.querySelector('.reload-prompt')) overlaps.push('toast up');
    // elementFromPoint is null off-viewport, which would report a hidden band as clear.
    if (c.top < 0 || c.top + 20 > window.innerHeight) overlaps.push(`card top off-screen:${c.top}`);
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
    return { overlaps, occluders: [...occluders] };
  }, TIER2_CHROME);
}

async function expectTopClear(page: Page, label: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const t = await topClearance(page);
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

// The route cluster is collapsed by default at narrow widths; expanded is its
// worst case for the card's top. Read the IDL property, never getAttribute('open').
async function expandRouteChrome(page: Page): Promise<void> {
  for (const sel of ['details.route-layer-controls-disclosure', 'details.route-legend']) {
    const details = page.locator(sel);
    if ((await details.count()) === 0) continue;
    if (!(await details.first().evaluate((el) => (el as HTMLDetailsElement).open))) {
      await details.first().locator('> summary').click();
    }
  }
}

test('#1822/#1843: the Live card keeps its reroute control on screen and its top clear under a long AIS list', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
  const server = await startPreview(page);
  let keepFresh: ReturnType<typeof setInterval> | undefined;
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
    // The SW's one-shot "offline ready" toast has long appeared by now (planning
    // took seconds).
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});
    await expect(page.locator('.reload-prompt')).toHaveCount(0);

    // A single static fix ages past GPS_LOST_AFTER_MS mid-test and hides the
    // readouts, which shortens the card the rows measure.
    keepFresh = setInterval(() => {
      void page
        .context()
        .setGeolocation(FIX)
        .catch(() => {});
    }, FIX_REFRESH_MS);

    await page.getByRole('tab', { name: 'Live' }).click();
    await page.getByRole('button', { name: 'Live-Ansicht' }).click();
    await expect(page.locator('.live-view-data')).toBeVisible({ timeout: 30_000 });

    await expect.poll(() => sockets.length).toBe(1);
    for (const [name, viewport] of Object.entries(STANDARD_VIEWPORTS)) {
      if (viewport.width < 820) continue;
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

      // Narrow only: on wide the list sits in the side panel, which the cap does not touch.
      if (viewport.width < 1024) {
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const panel = document.querySelector<HTMLElement>('.app-panel:has(.app-panel-ais)');
                if (!panel) return 'no AIS panel';
                const { overflowY } = getComputedStyle(panel);
                if (overflowY !== 'auto' && overflowY !== 'scroll')
                  return `overflow-y:${overflowY}`;
                if (panel.scrollHeight - panel.clientHeight <= 0)
                  return 'list fits, nothing to scroll';
                const before = panel.scrollTop;
                panel.scrollTo({ top: before + 50, behavior: 'instant' });
                const moved = panel.scrollTop !== before;
                panel.scrollTo({ top: before, behavior: 'instant' });
                return moved ? 'scrolls' : 'scrollTop did not move';
              }),
            {
              message: `${label}: the AIS list scrolls inside the sheet panel`,
              timeout: 30_000,
            },
          )
          .toBe('scrolls');
      }

      // 820 CSS px is the design floor and spans both layouts; below it is nice-to-have.
      if (viewport.width >= 820) {
        // Worst case for the card's top: the Tier 2 route cluster expanded.
        await expandRouteChrome(page);
        await expectTopClear(page, `capped AIS ${label}`);
        await expect
          .poll(() => controlsOffenders(page), {
            message: `${label}: fresh fix, reroute control and reason on screen at the card's top`,
            timeout: 30_000,
          })
          .toEqual([]);
      }
    }
  } finally {
    clearInterval(keepFresh);
    server.kill();
  }
});
