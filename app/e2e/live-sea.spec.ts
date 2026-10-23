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
  startTimeMs: number;
  endTimeMs: number;
}

/** The recommended rig's legs of the first stored plan (the rig the app shows first), read from IndexedDB. */
function readRecommendedLegs(page: Page): Promise<LegGeo[]> {
  return page.evaluate(
    () =>
      new Promise<LegGeo[]>((resolve, reject) => {
        const open = indexedDB.open('sailcommand');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction('plans', 'readonly').objectStore('plans').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            db.close();
            const plan = req.result[0] as {
              result: {
                recommended: string;
                sails: { sailId: string; result: { legs: LegGeo[] } | null }[];
              };
            };
            const legs = plan.result.sails.find((s) => s.sailId === plan.result.recommended)?.result
              ?.legs;
            if (!legs) {
              reject(new Error('recommended rig has no stored legs'));
              return;
            }
            resolve(
              legs.map((l) => ({
                start: l.start,
                end: l.end,
                startTimeMs: l.startTimeMs,
                endTimeMs: l.endTimeMs,
              })),
            );
          };
        };
      }),
  );
}

/**
 * Nearest leg by planar (equirectangular) point-to-segment distance, with the
 * clamped along-track fraction of the fix on it. Deliberately not the app's
 * great-circle projection, so the oracles below stay independent of it.
 */
function nearestLeg(
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
): { index: number; fraction: number } {
  const kx = Math.cos((fix.latitude * Math.PI) / 180);
  const toXY = (p: { lat: number; lon: number }) => ({
    x: (p.lon - fix.longitude) * kx,
    y: p.lat - fix.latitude,
  });
  let best = { index: 0, fraction: 0 };
  let bestDist = Number.POSITIVE_INFINITY;
  legs.forEach((leg, index) => {
    const a = toXY(leg.start);
    const b = toXY(leg.end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const fraction = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-a.x * dx - a.y * dy) / len2));
    const d = Math.hypot(a.x + fraction * dx, a.y + fraction * dy);
    if (d < bestDist) {
      bestDist = d;
      best = { index, fraction };
    }
  });
  return best;
}

/**
 * Independent oracle for the heading-to-steer readout: the initial
 * great-circle bearing from the fix to the nearest leg's end.
 */
function expectedHeadingToSteerDeg(
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const end = legs[nearestLeg(legs, fix).index].end;
  const phi1 = fix.latitude * rad;
  const phi2 = end.lat * rad;
  const dLon = (end.lon - fix.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Angular distance (degrees) between the shown heading and the oracle's. */
function headingError(
  shown: string,
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
): number {
  const deg = Number.parseInt(shown, 10);
  if (Number.isNaN(deg)) return Number.POSITIVE_INFINITY;
  const d = Math.abs(deg - expectedHeadingToSteerDeg(legs, fix)) % 360;
  return Math.min(d, 360 - d);
}

/**
 * Independent oracle for the projected ETA: the plan's arrival shifted by how
 * far the fix time is from the plan's own time at the fix's position, which
 * is the plan's stored leg times interpolated along the nearest leg. The fix
 * time is not observable from outside, so it is bracketed by page clock reads
 * taken before the fix and after the readout settled.
 */
function expectedEta(
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
  fixAtMs: number,
): { etaMs: number; driftMs: number } {
  const { index, fraction } = nearestLeg(legs, fix);
  const leg = legs[index];
  const plannedAtFixMs = leg.startTimeMs + fraction * (leg.endTimeMs - leg.startTimeMs);
  const driftMs = fixAtMs - plannedAtFixMs;
  return { etaMs: legs[legs.length - 1].endTimeMs + driftMs, driftMs };
}

/** Distance in whole minutes from `value` to the closed range [lo, hi] on a circle of `period`. */
function circularRangeGap(value: number, lo: number, hi: number, period: number): number {
  const mod = (n: number) => ((n % period) + period) % period;
  const v = mod(value - lo);
  const width = hi - lo;
  if (v <= width) return 0;
  return Math.min(v - width, period - v);
}

/**
 * Compares the shown "HH:MM (±N min)" ETA to the oracle over the fix-time
 * bracket. Returns 'ok' or a description naming the shown and expected values.
 * Tolerance is the readout's one-minute rounding.
 */
async function etaVerdict(
  page: Page,
  eta: Locator,
  legs: LegGeo[],
  fix: { latitude: number; longitude: number },
  fixBeforeMs: number,
): Promise<string> {
  const text = (await eta.textContent()) ?? '';
  const match = /(\d{2}):(\d{2}) \(([+-]?\d+) min\)/.exec(text);
  if (!match) return `unparseable ETA readout "${text}"`;
  const shownMinuteOfDay = Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
  const shownDriftMin = Number.parseInt(match[3], 10);

  const fixLatestMs = await page.evaluate(() => Date.now());
  const early = expectedEta(legs, fix, fixBeforeMs);
  const late = expectedEta(legs, fix, fixLatestMs);
  const minuteOfDay = (ms: number): Promise<number> =>
    page.evaluate((t) => {
      const d = new Date(t);
      return d.getHours() * 60 + d.getMinutes();
    }, ms);
  const loMinute = await minuteOfDay(early.etaMs);
  const etaGap = circularRangeGap(
    shownMinuteOfDay,
    loMinute,
    loMinute + (late.etaMs - early.etaMs) / 60_000,
    1440,
  );
  const driftGap = Math.max(
    0,
    early.driftMs / 60_000 - shownDriftMin,
    shownDriftMin - late.driftMs / 60_000,
  );
  if (etaGap <= 1 && driftGap <= 1) return 'ok';
  return `shown "${text.trim()}"; expected ETA minute-of-day from ${loMinute} (gap ${etaGap}), drift ${(early.driftMs / 60_000).toFixed(1)}..${(late.driftMs / 60_000).toFixed(1)} min (gap ${driftGap.toFixed(1)})`;
}

/**
 * Re-samples geometry on every call (callers poll it): reports whether the
 * element itself is topmost at its centre and four inset points. Returns a
 * description of the first blocked point, never a bare boolean.
 */
function topmostVerdict(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    // Scrolls first, so this is a reachable-by-scrolling verdict, not an at-rest one.
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
    const fixBeforeMs = () => page.evaluate(() => Date.now());
    let fixSentAtMs = await fixBeforeMs();
    await setMovingFix(cdp, { ...FIX_ORIGIN, heading: 90, speed: 3 });
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

    const hts = page.locator('.live-view-hts-value');
    const cog = page.locator('.live-view-cogsog dd').nth(0);
    const sog = page.locator('.live-view-cogsog dd').nth(1);
    const eta = page.locator('.live-view-eta');

    const legs = await readRecommendedLegs(page);
    expect(legs.length).toBeGreaterThan(0);
    // The readout shows whole degrees, so allow the rounding.
    const expectHeadingToSteer = (fix: { latitude: number; longitude: number }) =>
      expect
        .poll(async () => headingError((await hts.textContent()) ?? '', legs, fix), {
          timeout: 30_000,
        })
        .toBeLessThanOrEqual(1);

    // 3 m/s = 5.83 kn.
    await expect(cog).toHaveText('090°T', { timeout: 30_000 });
    await expect(sog).toHaveText('5,8 kn');
    await expect(hts).toHaveText(/^\d{3}°T$/);
    await expectHeadingToSteer(FIX_ORIGIN);
    const htsAtOrigin = await hts.textContent();
    await expect(eta).toContainText('Voraussichtliche Ankunft');
    await expect(eta).not.toContainText('—');
    const expectEta = (fix: { latitude: number; longitude: number }, sentAtMs: number) =>
      expect
        .poll(() => etaVerdict(page, eta, legs, fix, sentAtMs), {
          message: 'ETA readout vs plan-time oracle',
          timeout: 30_000,
        })
        .toBe('ok');
    await expectEta(FIX_ORIGIN, fixSentAtMs);

    // 2.5 m/s = 4.86 kn.
    fixSentAtMs = await fixBeforeMs();
    await setMovingFix(cdp, { ...FIX_FJORD_MOUTH, heading: 45, speed: 2.5 });
    await expect(cog).toHaveText('045°T', { timeout: 30_000 });
    await expect(sog).toHaveText('4,9 kn');
    await expect.poll(async () => hts.textContent(), { timeout: 30_000 }).not.toBe(htsAtOrigin);
    await expectHeadingToSteer(FIX_FJORD_MOUTH);
    await expectEta(FIX_FJORD_MOUTH, fixSentAtMs);

    // 4.1 m/s = 7.97 kn; heading wraps through north (355).
    fixSentAtMs = await fixBeforeMs();
    await setMovingFix(cdp, { ...FIX_OFF_SOENDERBORG, heading: 355, speed: 4.1 });
    await expect(cog).toHaveText('355°T', { timeout: 30_000 });
    await expect(sog).toHaveText('8,0 kn');
    await expectHeadingToSteer(FIX_OFF_SOENDERBORG);
    await expectEta(FIX_OFF_SOENDERBORG, fixSentAtMs);

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
      await expect(page.locator('.live-view-cogsog dd').nth(0)).toHaveText('045°T', {
        timeout: 30_000,
      });

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

// #1805 part 2: the Live GPS states (#1800/#1802). A state is a function of
// fix age plus a denied flag, so these specs assert settled VALUES after the
// state has been reached, never the transient POSITION_UNAVAILABLE that
// precedes every emulated fix. Fix age runs on `performance.now`, which
// `page.clock` fakes together with `Date.now` and `setInterval`; the clock is
// advanced in one jump, so no spec waits real seconds for a threshold.

const STATE_VIEWPORTS = [
  { label: 'default viewport', viewport: null },
  {
    label: `tabletPortrait ${STANDARD_VIEWPORTS.tabletPortrait.width}x${STANDARD_VIEWPORTS.tabletPortrait.height}`,
    viewport: STANDARD_VIEWPORTS.tabletPortrait,
  },
];

async function startLive(
  page: Page,
  cdp: CDPSession,
  fix: MovingFix,
): Promise<{ liveToggle: Locator; rerouteButton: Locator }> {
  await page.getByRole('tab', { name: 'Live' }).click();
  const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
  await setMovingFix(cdp, fix);
  await liveToggle.click();
  await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');
  return {
    liveToggle,
    rerouteButton: page.getByRole('button', {
      name: 'Route ab hier neu planen',
    }),
  };
}

async function expectTopmost(label: string, locator: Locator): Promise<void> {
  await expect(locator, label).toBeVisible();
  await expect
    .poll(() => topmostVerdict(locator), {
      message: `${label} occluded`,
      timeout: 10_000,
    })
    .toBe('ok');
}

/** The N of the stale chip's "Veraltet, N s alt". */
async function staleAgeS(page: Page): Promise<number> {
  const text = (await page.locator('.live-view-gps-stale').textContent()) ?? '';
  const match = /Veraltet, (\d+) s alt/.exec(text);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

const GPS_WATCH_COUNTER = '__scGeoWatches';

for (const { label, viewport } of STATE_VIEWPORTS) {
  test.describe(`#1805 GPS states — ${label}`, () => {
    test('stale, then lost, then a new fix recovers', async ({ page, context }) => {
      test.setTimeout(360_000);
      await page.clock.install();
      if (viewport) await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        await planLangballigauSonderborg(page, server);
        const cdp = await context.newCDPSession(page);
        const { rerouteButton } = await startLive(page, cdp, {
          ...FIX_ORIGIN,
          heading: 90,
          speed: 3,
        });

        const data = page.locator('.live-view-data');
        const hts = page.locator('.live-view-hts-value');
        const cog = page.locator('.live-view-cogsog dd').nth(0);
        const sog = page.locator('.live-view-cogsog dd').nth(1);
        const eta = page.locator('.live-view-eta');
        const staleChip = page.locator('.live-view-gps-stale');
        const lostBlock = page.locator('.live-view-gps--lost');
        const rerouteHint = page.locator('.live-view-reroute-hint');

        // Fresh.
        await expect(cog).toHaveText('090°T', { timeout: 30_000 });
        await expect(page.locator('.live-view-progress')).toBeVisible();
        await expect(sog).toHaveText('5,8 kn');
        await expect(staleChip).toHaveCount(0);
        await expect(lostBlock).toHaveCount(0);
        await expect(data).toHaveCSS('opacity', '1');
        await expect(rerouteButton).toBeEnabled();

        // Stale: past 10 s without a new fix. Values stay, dimmed.
        await page.clock.fastForward(12_000);
        await expect(staleChip).toContainText(/Veraltet, \d+ s alt/);
        await expect
          .poll(() => staleAgeS(page), { message: 'stale age in seconds' })
          .toBeGreaterThanOrEqual(10);
        expect(await staleAgeS(page)).toBeLessThan(30);
        await expect(data).toHaveCSS('opacity', '0.6');
        await expect(cog).toHaveText('090°T');
        await expect(sog).toHaveText('5,8 kn');
        await expect(hts).toHaveText(/^\d{3}°T$/);
        await expect(lostBlock).toHaveCount(0);
        await expectTopmost('stale badge', staleChip);

        // Lost: past 30 s. Steering, COG, SOG and ETA are gone, reroute is
        // blocked with its reason, and the last fix is named.
        await page.clock.fastForward(25_000);
        await expect(lostBlock).toBeVisible();
        await expect(lostBlock).toContainText('GPS-Signal verloren');
        await expect(lostBlock).toContainText(/Letzte Position \d{1,2}:\d{2}/);
        await expect(staleChip).toHaveCount(0);
        await expect(hts).toHaveCount(0);
        await expect(page.locator('.live-view-cogsog')).toHaveCount(0);
        await expect(eta).toHaveCount(0);
        await expect(page.locator('.live-view-progress')).toHaveCount(0);
        await expect(rerouteButton).toBeDisabled();
        await expect(rerouteHint).toContainText('Kein GPS-Signal');
        await expect(page.locator('.live-view-gps--denied')).toHaveCount(0);
        await expectTopmost('lost block', lostBlock);
        await expectTopmost('reroute hint', rerouteHint);

        // Recovery: a new fix restores everything.
        await setMovingFix(cdp, {
          ...FIX_FJORD_MOUTH,
          heading: 45,
          speed: 2.5,
        });
        await expect(cog).toHaveText('045°T', { timeout: 30_000 });
        await expect(sog).toHaveText('4,9 kn');
        await expect(lostBlock).toHaveCount(0);
        await expect(staleChip).toHaveCount(0);
        await expect(data).toHaveCSS('opacity', '1');
        await expect(hts).toHaveText(/^\d{3}°T$/);
        await expect(eta).toContainText('Voraussichtliche Ankunft');
        await expect(rerouteButton).toBeEnabled();
        await expect(rerouteHint).not.toContainText('Kein GPS-Signal');
      } finally {
        server.kill();
      }
    });

    test.describe('permission denied', () => {
      test.use({ permissions: [] });

      test('the denied state has its own recovery copy and blocks reroute', async ({ page }) => {
        test.setTimeout(360_000);
        if (viewport) await page.setViewportSize(viewport);
        const server = await startPreview(page);
        try {
          await planLangballigauSonderborg(page, server);
          await page.getByRole('tab', { name: 'Live' }).click();
          const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
          await liveToggle.click();
          await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

          const denied = page.locator('.live-view-gps--denied');
          await expect(denied).toBeVisible({ timeout: 30_000 });
          await expect(denied).toContainText('Standortzugriff ist gesperrt');
          await expect(denied).toContainText('Browser- oder Geräteeinstellungen');
          await expect(page.locator('.live-view-gps--lost')).toHaveCount(0);
          await expect(page.locator('.live-view-gps--waiting')).toHaveCount(0);
          await expect(page.locator('.live-view-hts-value')).toHaveCount(0);
          await expect(page.locator('.live-view-progress')).toHaveCount(0);

          const rerouteButton = page.getByRole('button', {
            name: 'Route ab hier neu planen',
          });
          await expect(rerouteButton).toBeDisabled();
          await expect(page.locator('.live-view-reroute-hint')).toContainText(
            'Standortzugriff gesperrt — Neuplanung nicht möglich.',
          );
          await expectTopmost('denied block', denied);
          await expectTopmost('reroute hint', page.locator('.live-view-reroute-hint'));
        } finally {
          server.kill();
        }
      });
    });

    test('resume: a reload leaves GPS off until Fortsetzen is tapped', async ({
      page,
      context,
    }) => {
      test.setTimeout(360_000);
      if (viewport) await page.setViewportSize(viewport);
      await page.addInitScript((counter) => {
        const w = window as unknown as Record<string, number>;
        w[counter] = 0;
        const geo = navigator.geolocation;
        const original = geo.watchPosition.bind(geo);
        geo.watchPosition = (...args: Parameters<typeof original>) => {
          w[counter] += 1;
          return original(...args);
        };
      }, GPS_WATCH_COUNTER);
      const watchCount = () =>
        page.evaluate(
          (counter) => (window as unknown as Record<string, number>)[counter],
          GPS_WATCH_COUNTER,
        );

      const server = await startPreview(page);
      try {
        await planLangballigauSonderborg(page, server);
        const cdp = await context.newCDPSession(page);
        const { liveToggle, rerouteButton } = await startLive(page, cdp, {
          ...FIX_ORIGIN,
          heading: 90,
          speed: 3,
        });
        const cog = page.locator('.live-view-cogsog dd').nth(0);
        await expect(cog).toHaveText('090°T', { timeout: 30_000 });
        await expect(rerouteButton).toBeEnabled();
        expect(await watchCount()).toBeGreaterThan(0);

        await page.reload();
        // Tracking state does not survive the reload; the saved plan does.
        await page.getByRole('tab', { name: 'Routen' }).click();
        await page.locator('.plans-list-row .plans-list-load').first().click();
        await page.getByRole('tab', { name: 'Live' }).click();

        const resume = page.locator('.live-view-resume');
        await expect(resume).toBeVisible({ timeout: 30_000 });
        await expect(resume).toContainText('Verfolgung angehalten');
        await expect(liveToggle).toHaveAttribute('aria-pressed', 'false');
        await expectTopmost('resume banner', resume);
        const resumeButton = resume.getByRole('button', { name: 'Fortsetzen' });
        await expectTopmost('resume button', resumeButton);
        // The banner is rendered by the mounted Live view, so its effects have run.
        expect(await watchCount()).toBe(0);
        await expect(page.locator('.live-view-gps--waiting')).toHaveCount(0);
        await expect(page.locator('.live-view-hts-value')).toHaveCount(0);

        await setMovingFix(cdp, {
          ...FIX_FJORD_MOUTH,
          heading: 45,
          speed: 2.5,
        });
        await resumeButton.click();
        await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');
        await expect(resume).toHaveCount(0);
        await expect(cog).toHaveText('045°T', { timeout: 30_000 });
        await expect(rerouteButton).toBeEnabled();
        expect(await watchCount()).toBeGreaterThan(0);
      } finally {
        server.kill();
      }
    });
  });
}

test('permission revoked mid-watch flips fresh to denied, and re-granting recovers', async ({
  page,
  context,
}) => {
  test.setTimeout(360_000);
  const server = await startPreview(page);
  try {
    await planLangballigauSonderborg(page, server);
    const cdp = await context.newCDPSession(page);
    const { rerouteButton } = await startLive(page, cdp, {
      ...FIX_ORIGIN,
      heading: 90,
      speed: 3,
    });
    const cog = page.locator('.live-view-cogsog dd').nth(0);
    const denied = page.locator('.live-view-gps--denied');
    await expect(cog).toHaveText('090°T', { timeout: 30_000 });

    await context.clearPermissions();
    await expect(denied).toBeVisible({ timeout: 30_000 });
    await expect(denied).toContainText('Standortzugriff ist gesperrt');
    await expect(page.locator('.live-view-gps--lost')).toHaveCount(0);
    await expect(page.locator('.live-view-cogsog')).toHaveCount(0);
    await expect(rerouteButton).toBeDisabled();

    await context.grantPermissions(['geolocation']);
    await setMovingFix(cdp, { ...FIX_FJORD_MOUTH, heading: 45, speed: 2.5 });
    await expect(cog).toHaveText('045°T', { timeout: 30_000 });
    await expect(denied).toHaveCount(0);
    await expect(rerouteButton).toBeEnabled();
  } finally {
    server.kill();
  }
});
