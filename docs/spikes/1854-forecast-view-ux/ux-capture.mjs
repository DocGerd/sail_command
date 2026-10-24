// UX grounding capture for #1854 — screenshots of the CURRENT app (develop 7a08b939).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:4500/sail_command/';
const OUT = './ux-shots';
const QUERY = '?windFixture=test-fixtures/wind-sw12.json&waveFixture=test-fixtures/wave-bands.json';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '820x1180', width: 820, height: 1180 },
  { name: '1180x820', width: 1180, height: 820 },
  { name: '1920x1080', width: 1920, height: 1080 },
];
const PHONE = { name: '390x844', width: 390, height: 844 };
const log = [];
const note = (s) => {
  log.push(s);
  console.log(s);
};

function pad(n) {
  return String(n).padStart(2, '0');
}
function localDatetimeValue(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function nextFullHourPlus(h) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.getTime() + (h + 1) * 3600_000;
}

async function mapSettled(page, label) {
  try {
    await page.waitForFunction(
      () => {
        const m = window.__scMap;
        return Boolean(m && m.loaded() && m.areTilesLoaded());
      },
      undefined,
      { timeout: 45_000, polling: 250 },
    );
  } catch {
    note(`WARN ${label}: map did not report loaded within 45 s`);
  }
  // Paint settle for the screenshot only (not a test synchronisation gate).
  await page.waitForTimeout(800);
}

async function shot(page, file) {
  const path = `${OUT}/${file}.png`;
  await page.screenshot({ path, fullPage: true });
  note(`wrote ${path}`);
}

async function newContext(browser, vp, { dismissCaveat = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    locale: 'de-DE',
  });
  if (dismissCaveat) {
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('sc-caveat-banner-dismissed', '1');
      } catch {
        /* ignore */
      }
    });
  }
  return context;
}

async function bothSchemes(page, base, extra) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    if (extra) await extra();
    await mapSettled(page, `${base}-${scheme}`);
    await shot(page, `${base}-${scheme}`);
  }
}

async function openRouteControls(page) {
  const d = page.locator('details.route-layer-controls-disclosure');
  if ((await d.count()) === 0) return false;
  if (!(await d.evaluate((el) => el.open))) await d.locator('> summary').click();
  return true;
}

async function closeRouteControls(page) {
  const d = page.locator('details.route-layer-controls-disclosure');
  if ((await d.count()) === 0) return;
  if (await d.evaluate((el) => el.open)) await d.locator('> summary').click();
}

async function planFlensburgSonderborg(page) {
  await page.goto(BASE + QUERY);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill('Flensburg');
  await origin.getByRole('option', { name: /^Flensburg/ }).first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill('Sønderborg');
  await dest.getByRole('option', { name: /Sonderburg|Sønderborg/ }).first().click();
  await page.getByLabel('Abfahrt').fill(localDatetimeValue(nextFullHourPlus(2)));
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await page.waitForFunction(() => Boolean(window.__scMap?.getLayer('sc-route-shallow')), undefined, {
    timeout: 300_000,
    polling: 500,
  });
  await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Route planen');
      return Boolean(b && !b.disabled);
    },
    undefined,
    { timeout: 300_000, polling: 500 },
  );
  // Make sure the sea-state toggle is ON.
  await openRouteControls(page);
  const waves = page.getByRole('checkbox', { name: 'Seegang anzeigen', exact: true });
  if ((await waves.count()) > 0 && !(await waves.isChecked()) && (await waves.isEnabled())) {
    await waves.check();
  }
  const fills = await page.evaluate(() => {
    const m = window.__scMap;
    return m ? m.queryRenderedFeatures(undefined, { layers: ['sc-waves-fill'] }).length : -1;
  });
  note(`plan ready; sc-waves-fill rendered features = ${fills}`);
}

async function regionView(page) {
  await page.evaluate(() => {
    window.__scMap?.jumpTo({ center: [10.5, 54.95], zoom: 7.6 });
  });
}

async function run() {
  const browser = await chromium.launch();
  try {
    const SKIP_COLD = process.env.SKIP_COLD === '1';
    // First-run banner, once.
    if (!SKIP_COLD) {
      const ctx = await newContext(browser, VIEWPORTS[0], { dismissCaveat: false });
      const page = await ctx.newPage();
      await page.goto(BASE);
      await mapSettled(page, 'firstrun');
      await shot(page, 'a-coldload-firstrun-banner-plan-820x1180-light');
      await ctx.close();
    }

    for (const vp of [...VIEWPORTS, PHONE]) {
      const isPhone = vp === PHONE;
      // (a) cold load, no plan, Plan tab
      if (!SKIP_COLD) {
        const ctx = await newContext(browser, vp);
        const page = await ctx.newPage();
        await page.goto(BASE);
        await page.getByRole('tab', { name: 'Planen' }).click();
        if (isPhone) {
          await page.emulateMedia({ colorScheme: 'light' });
          await mapSettled(page, 'phone-cold');
          await shot(page, `a-coldload-noplan-plan-${vp.name}-light`);
        } else {
          await bothSchemes(page, `a-coldload-noplan-plan-${vp.name}`);
          // Live tab, no plan
          await page.getByRole('tab', { name: 'Live' }).click();
          await page.emulateMedia({ colorScheme: 'light' });
          await mapSettled(page, 'live-noplan');
          await shot(page, `c-live-noplan-${vp.name}-light`);
        }
        await ctx.close();
      }

      // (b) planned route with sea state, then (c) Live tab with plan
      {
        const ctx = await newContext(browser, vp);
        const page = await ctx.newPage();
        try {
          await page.emulateMedia({ colorScheme: 'light' });
          await planFlensburgSonderborg(page);
          if (isPhone) {
            await mapSettled(page, 'phone-plan');
            await shot(page, `b-plan-flensburg-sonderborg-seastate-controls-open-${vp.name}-light`);
          } else {
            await bothSchemes(page, `b-plan-flensburg-sonderborg-seastate-controls-open-${vp.name}`);
            await closeRouteControls(page);
            await page.emulateMedia({ colorScheme: 'light' });
            await mapSettled(page, 'plan-closed');
            await shot(page, `b-plan-flensburg-sonderborg-seastate-controls-closed-${vp.name}-light`);
            // Region-wide zoom with the plan's wave grid: shows cell rectangles over land.
            await regionView(page);
            await bothSchemes(page, `b-plan-seastate-region-zoom7.6-${vp.name}`);
            // Live tab with a plan loaded
            await page.getByRole('tab', { name: 'Live' }).click();
            await bothSchemes(page, `c-live-withplan-${vp.name}`);
          }
        } catch (err) {
          note(`ERROR plan flow at ${vp.name}: ${String(err).slice(0, 300)}`);
          await shot(page, `ERROR-plan-${vp.name}`).catch(() => {});
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    writeFileSync(`${OUT}/capture-log.txt`, log.join('\n') + '\n');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
