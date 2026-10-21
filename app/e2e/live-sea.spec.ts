import { test, expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import {
  STANDARD_VIEWPORTS,
  localDatetimeValue,
  nextFullHourPlus,
  startPreview,
  type PreviewServer,
} from './helpers';

// #1805 part 1: Live under sea conditions that exist on develop today — a
// moving boat with heading/speed, a reroute with the network gone, and the
// tablet pair. Fixes go through the real navigator.geolocation watch; CDP
// `Emulation.setGeolocationOverride` is the only way to give a fix a heading
// and speed (Playwright's `setGeolocation` carries neither).
//
// Every `setGeolocation` / override is preceded by a transient
// POSITION_UNAVAILABLE, so assertions here read settled VALUES through
// auto-retrying locators or `expect.poll`, never an individual callback.

const FIX_ORIGIN = { latitude: 54.8237, longitude: 9.6524, accuracy: 5 };
// Same hand-picked, mask-verified points as live.spec.ts; its comments carry
// the measurement and the rule for relocating them.
const FIX_FJORD_MOUTH = { latitude: 54.83, longitude: 9.9, accuracy: 5 };
const FIX_OFF_SOENDERBORG = { latitude: 54.889, longitude: 9.791, accuracy: 5 };

interface MovingFix {
  latitude: number;
  longitude: number;
  accuracy: number;
  heading: number;
  speed: number;
}

test.use({
  permissions: ['geolocation'],
  geolocation: FIX_ORIGIN,
});

async function planLangballigauSonderborg(page: Page, server: PreviewServer): Promise<void> {
  await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
  await page.getByRole('tab', { name: 'Planen' }).click();

  const originSection = page.getByRole('region', { name: 'Start' });
  await originSection.getByRole('combobox').fill('Langballigau');
  await expect(originSection.getByRole('option')).toHaveCount(1);
  await originSection.getByRole('option').first().click();

  const destSection = page.getByRole('region', { name: 'Ziel' });
  await destSection.getByRole('combobox').fill('Sønderborg');
  await expect(destSection.getByRole('option')).toHaveCount(1);
  await destSection.getByRole('option').first().click();

  await page.getByLabel('Abfahrt').fill(localDatetimeValue(nextFullHourPlus(2)));

  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 120_000 });
}

async function setMovingFix(cdp: CDPSession, fix: MovingFix): Promise<void> {
  await cdp.send('Emulation.setGeolocationOverride', fix);
}

interface LegGeo {
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
}

/** Every solved rig's legs of the first stored plan, read straight from IndexedDB. */
function readStoredLegsBySail(page: Page): Promise<LegGeo[][]> {
  return page.evaluate(
    () =>
      new Promise<LegGeo[][]>((resolve, reject) => {
        const open = indexedDB.open('sailcommand');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('plans', 'readonly').objectStore('plans').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            db.close();
            const plan = req.result[0] as {
              result: { sails: { result: { legs: LegGeo[] } | null }[] };
            };
            resolve(
              plan.result.sails.flatMap((s) =>
                s.result ? [s.result.legs.map((l) => ({ start: l.start, end: l.end }))] : [],
              ),
            );
          };
        };
      }),
  );
}

/**
 * Independent oracle for the heading-to-steer readout: nearest leg by planar
 * (equirectangular) point-to-segment distance, then the initial great-circle
 * bearing from the fix to that leg's end.
 */
function expectedHeadingToSteerDeg(
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const kx = Math.cos(fix.latitude * rad);
  const toXY = (p: { lat: number; lon: number }) => ({
    x: (p.lon - fix.longitude) * kx,
    y: p.lat - fix.latitude,
  });
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  legs.forEach((leg, i) => {
    const a = toXY(leg.start);
    const b = toXY(leg.end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-a.x * dx - a.y * dy) / len2));
    const d = Math.hypot(a.x + t * dx, a.y + t * dy);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  });
  const end = legs[bestIdx].end;
  const phi1 = fix.latitude * rad;
  const phi2 = end.lat * rad;
  const dLon = (end.lon - fix.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Smallest angular distance (degrees) between the shown heading and any rig's expected one. */
function headingError(
  shown: string,
  legsBySail: LegGeo[][],
  fix: { latitude: number; longitude: number },
): number {
  const deg = Number.parseInt(shown, 10);
  if (Number.isNaN(deg)) return Number.POSITIVE_INFINITY;
  return Math.min(
    ...legsBySail.map((legs) => {
      const d = Math.abs(deg - expectedHeadingToSteerDeg(legs, fix)) % 360;
      return Math.min(d, 360 - d);
    }),
  );
}

/**
 * Re-samples geometry on every call (callers poll it): reports whether the
 * element itself is topmost at its centre and four inset points. Returns a
 * description of the first blocked point, never a bare boolean.
 */
function topmostVerdict(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 'zero-size box';
    // Inset past rounded corners: a pill button's bounding-box corner is not
    // part of its hit area.
    const insetX = r.width * 0.2;
    const insetY = r.height * 0.2;
    const points: [string, number, number][] = [
      ['centre', r.left + r.width / 2, r.top + r.height / 2],
      ['top-left', r.left + insetX, r.top + insetY],
      ['top-right', r.right - insetX, r.top + insetY],
      ['bottom-left', r.left + insetX, r.bottom - insetY],
      ['bottom-right', r.right - insetX, r.bottom - insetY],
    ];
    for (const [name, x, y] of points) {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
        return `${name} (${x.toFixed(1)},${y.toFixed(1)}) outside viewport ${window.innerWidth}x${window.innerHeight}`;
      }
      const top = document.elementFromPoint(x, y);
      if (!top || !el.contains(top)) {
        const hit = top ? `${top.tagName.toLowerCase()}.${top.className}` : 'null';
        return `${name} (${x.toFixed(1)},${y.toFixed(1)}) hit ${hit}`;
      }
    }
    return 'ok';
  });
}

test('motion: a moving fix drives COG, SOG, heading-to-steer and ETA', async ({
  page,
  context,
}) => {
  test.setTimeout(360_000);
  const server = await startPreview(page);
  try {
    await planLangballigauSonderborg(page, server);
    const cdp = await context.newCDPSession(page);

    await page.getByRole('tab', { name: 'Live' }).click();
    const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
    await setMovingFix(cdp, { ...FIX_ORIGIN, heading: 90, speed: 3 });
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

    const hts = page.locator('.live-view-hts-value');
    const cog = page.locator('.live-view-cogsog dd').nth(0);
    const sog = page.locator('.live-view-cogsog dd').nth(1);
    const eta = page.locator('.live-view-eta');

    const legsBySail = await readStoredLegsBySail(page);
    expect(legsBySail.length).toBeGreaterThan(0);
    // The readout shows whole degrees, so allow the rounding.
    const expectHeadingToSteer = (fix: { latitude: number; longitude: number }) =>
      expect
        .poll(async () => headingError((await hts.textContent()) ?? '', legsBySail, fix), {
          timeout: 30_000,
        })
        .toBeLessThanOrEqual(1);

    // 3 m/s = 5.83 kn.
    await expect(cog).toHaveText('090°', { timeout: 30_000 });
    await expect(sog).toHaveText('5,8 kn');
    await expect(hts).toHaveText(/^\d{3}°$/);
    await expectHeadingToSteer(FIX_ORIGIN);
    const htsAtOrigin = await hts.textContent();
    await expect(eta).toContainText('Voraussichtliche Ankunft');
    await expect(eta).not.toContainText('—');
    const etaAtOrigin = await eta.textContent();

    // 2.5 m/s = 4.86 kn.
    await setMovingFix(cdp, { ...FIX_FJORD_MOUTH, heading: 45, speed: 2.5 });
    await expect(cog).toHaveText('045°', { timeout: 30_000 });
    await expect(sog).toHaveText('4,9 kn');
    await expect.poll(async () => hts.textContent(), { timeout: 30_000 }).not.toBe(htsAtOrigin);
    await expect.poll(async () => eta.textContent(), { timeout: 30_000 }).not.toBe(etaAtOrigin);
    await expectHeadingToSteer(FIX_FJORD_MOUTH);

    // 4.1 m/s = 7.97 kn; heading wraps through north (355).
    await setMovingFix(cdp, { ...FIX_OFF_SOENDERBORG, heading: 355, speed: 4.1 });
    await expect(cog).toHaveText('355°', { timeout: 30_000 });
    await expect(sog).toHaveText('8,0 kn');
    await expectHeadingToSteer(FIX_OFF_SOENDERBORG);

    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  } finally {
    server.kill();
  }
});

test('offline: with the server gone, reroute from here yields a new plan from the stored wind grid', async ({
  page,
  context,
}) => {
  test.setTimeout(360_000);
  const server = await startPreview(page);
  try {
    const forecastRequests: string[] = [];
    page.on('request', (req) => {
      if (/open-meteo/i.test(req.url())) forecastRequests.push(req.url());
    });

    await planLangballigauSonderborg(page, server);
    // The precache must be complete, or "offline" would only prove the page
    // had not needed the network yet.
    await page.evaluate(() => navigator.serviceWorker.ready);

    const cdp = await context.newCDPSession(page);
    await page.getByRole('tab', { name: 'Live' }).click();
    const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
    await setMovingFix(cdp, { ...FIX_FJORD_MOUTH, heading: 45, speed: 2.5 });
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

    const rerouteButton = page.getByRole('button', { name: 'Route ab hier neu planen' });
    await expect(rerouteButton).toBeEnabled({ timeout: 30_000 });

    // Positive control for the probe below: while the server lives, the same
    // request resolves.
    const reachable = () =>
      page.evaluate(
        (url) =>
          fetch(url, { cache: 'no-store' }).then(
            () => 'reachable',
            () => 'unreachable',
          ),
        `${server.url}network-probe-1805`,
      );
    await expect.poll(reachable).toBe('reachable');

    server.kill();
    await context.setOffline(true);
    await expect.poll(reachable, { timeout: 30_000 }).toBe('unreachable');

    await rerouteButton.click();
    await expect(
      page.getByRole('button', { name: 'Route wird ab aktueller Position neu geplant…' }),
    ).toBeDisabled({ timeout: 30_000 });
    await expect(rerouteButton).toBeEnabled({ timeout: 120_000 });
    // The app's own offline banner is expected; anything else is a failure.
    const alerts = await page.locator('[role="alert"]').allTextContents();
    expect(alerts.filter((text) => !text.startsWith('Offline'))).toEqual([]);

    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.locator('.plans-list-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(
      page.locator('.plans-list-row', { hasText: '(ab Position neu geplant)' }),
    ).toHaveCount(1);
    expect(forecastRequests).toEqual([]);
  } finally {
    await context.setOffline(false).catch(() => {});
    server.kill();
  }
});

const TABLET_VIEWPORTS = {
  tabletPortrait: STANDARD_VIEWPORTS.tabletPortrait,
  tabletLandscape: STANDARD_VIEWPORTS.tabletLandscape,
};

for (const [name, viewport] of Object.entries(TABLET_VIEWPORTS)) {
  test(`tablet ${name} ${viewport.width}x${viewport.height}: the Live card's controls are visible and not occluded`, async ({
    page,
    context,
  }) => {
    // Expected failure until #1802 lands: the sheet's tab strip covers the reroute button and hint.
    test.fail(name === 'tabletPortrait', '#1802');
    test.setTimeout(360_000);
    await page.setViewportSize(viewport);
    const server = await startPreview(page);
    try {
      await planLangballigauSonderborg(page, server);
      const cdp = await context.newCDPSession(page);

      await page.getByRole('tab', { name: 'Live' }).click();
      const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
      await setMovingFix(cdp, { ...FIX_FJORD_MOUTH, heading: 45, speed: 2.5 });
      await liveToggle.click();
      await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

      const rerouteButton = page.getByRole('button', { name: 'Route ab hier neu planen' });
      await expect(rerouteButton).toBeEnabled({ timeout: 30_000 });
      await expect(page.locator('.live-view-cogsog dd').nth(0)).toHaveText('045°');

      const clear: [string, Locator][] = [
        ['live toggle', liveToggle],
        ['heading to steer', page.locator('.live-view-hts-value')],
        ['COG', page.locator('.live-view-cogsog dd').nth(0)],
        ['SOG', page.locator('.live-view-cogsog dd').nth(1)],
        ['ETA', page.locator('.live-view-eta')],
      ];
      const bottomEdge: [string, Locator][] = [
        ['reroute button', rerouteButton],
        ['reroute hint', page.locator('.live-view-reroute-hint')],
      ];
      for (const [label, locator] of clear) {
        await expect(locator, label).toBeVisible();
        await expect
          .poll(() => topmostVerdict(locator), { message: `${label} occluded`, timeout: 10_000 })
          .toBe('ok');
      }
      for (const [label, locator] of bottomEdge) {
        await expect
          .poll(() => topmostVerdict(locator), { message: `${label} occluded`, timeout: 10_000 })
          .toBe('ok');
      }

      // A click at the centre of each button still lands on it.
      await liveToggle.click({ trial: true });
      await rerouteButton.click({ trial: true });
    } finally {
      server.kill();
    }
  });
}
