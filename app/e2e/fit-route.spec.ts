import { test, expect, type Page } from '@playwright/test';
import { bannerHeightVar, startPreview, STANDARD_VIEWPORTS } from './helpers';

// #1102 (residual of #297/PR #1100): the "fit route to view" action
// (`route.fitToView`, `.route-layer-controls`) has three unit tests in
// RouteLayer.test.tsx — click wiring, an honest disabled state, and a
// null-render -> plan transition — all against `test/fakeMaplibre.ts`'s
// mocked `fitBounds`, which records a call but moves no real camera. This
// spec is the one that proves the camera on a REAL MapLibre map actually
// returns to the route's bounds when the button is clicked, the way
// `route-alt-rig.spec.ts` proves the alt-rig overlay actually paints.
//
// Determinism per house style: no fixed waitForTimeout, poll the ACTUAL
// camera VALUE (never a boolean — a Playwright timeout on a boolean
// predicate means both "too slow" and "never going to happen" and a CI
// failure would name neither the expected nor the actual coordinates).

interface CameraSnapshot {
  lng: number;
  lat: number;
  zoom: number;
}

// The subset of the MapLibre map API this spec calls through
// `window.__scMap` (RouteLayer.tsx's E2E handle). Types are erased before
// these closures reach the browser; this only satisfies tsc for the
// page.evaluate() source text (this project can't import app source).
interface ScTestMap {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  jumpTo(options: { center: [number, number]; zoom: number }): void;
}

// Rounded to 1e-7 (~1cm at this latitude, ~1e5x tighter than anything this
// assertion cares about): two separate `fitBounds` calls with byte-identical
// bounds/padding/bearing/container-size inputs are deterministic in theory,
// but MEASURED to differ in their last 1-2 significant digits (e.g.
// `11.81611674496952` vs `11.816116744969527`) — floating-point
// accumulation order inside MapLibre's own camera math, not a real
// difference in where the camera landed. An exact `toEqual` reds on that
// noise alone; this rounds it away while still comparing a real value, not
// a boolean.
function round(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

async function readCamera(page: Page): Promise<CameraSnapshot> {
  const camera = await page.evaluate(() => {
    const map = (window as unknown as { __scMap?: ScTestMap }).__scMap;
    if (!map) return null;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() };
  });
  if (camera === null) {
    throw new Error('window.__scMap is not set yet — RouteLayer has not mounted a map');
  }
  return { lng: round(camera.lng), lat: round(camera.lat), zoom: round(camera.zoom) };
}

/**
 * Waits for two consecutive identical camera reads. `fitToLegs` calls
 * `fitBounds(..., { duration: 0 })`, an instant jump with no animation — but
 * the auto-fit effect that runs when a plan first appears (`[map,
 * plan?.id]`) fires on React's own effect schedule, not synchronously with
 * whatever DOM signal we polled to detect the plan. Polling for stability
 * rather than trusting the first read is what makes this robust against
 * that scheduling gap without a fixed sleep. On timeout this throws with the
 * actual last readings, not a bare boolean — the E2E determinism rule this
 * suite documents under "A Playwright expect.poll predicate that returns a
 * BOOLEAN discards the diagnostic."
 */
async function waitForStableCamera(
  page: Page,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<CameraSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let previous: CameraSnapshot | null = null;
  const history: CameraSnapshot[] = [];
  while (Date.now() < deadline) {
    const current = await readCamera(page);
    history.push(current);
    if (
      previous !== null &&
      current.lng === previous.lng &&
      current.lat === previous.lat &&
      current.zoom === previous.zoom
    ) {
      return current;
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `camera never settled within ${timeoutMs}ms; last readings: ` +
      JSON.stringify(history.slice(-5)),
  );
}

/** Plans a route on the deterministic wind-sw12 fixture (default Langballigau -> Sønderborg). */
async function planRoute(
  page: Page,
  serverUrl: string,
  from = 'Langballigau',
  to = 'Sønderborg',
): Promise<void> {
  await page.goto(`${serverUrl}?windFixture=test-fixtures/wind-sw12.json`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill(from);
  await expect(origin.getByRole('option')).toHaveCount(1);
  await origin.getByRole('option').first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill(to);
  await expect(dest.getByRole('option')).toHaveCount(1);
  await dest.getByRole('option').first().click();
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 60_000 });
}

/** Opens the options cluster if closed; a fit closes it again at narrow widths (#1702). */
async function openOptionsCluster(page: Page): Promise<void> {
  // Deliberately reads the real `.open` IDL PROPERTY via evaluate(), never
  // `getAttribute('open')` — that returns the empty string when the
  // attribute IS present, which is falsy in JS, so `!getAttribute('open')`
  // fires unconditionally and would toggle an already-open cluster closed
  // (measured live against this exact disclosure in route-alt-rig.spec.ts).
  const disclosure = page.locator('details.route-layer-controls-disclosure');
  const isDisclosureOpen = await disclosure.evaluate((el) => (el as HTMLDetailsElement).open);
  if (!isDisclosureOpen) {
    await disclosure.locator('> summary').click();
  }
}

/**
 * Plans Langballigau -> Sønderborg on the deterministic wind-sw12 fixture —
 * the same route `route-alt-rig.spec.ts` and `annotations.spec.ts` use,
 * already known to produce a real multi-leg route on this wind. Opens
 * `.route-layer-controls-disclosure` if the current viewport starts it
 * collapsed (#628: narrow viewports default closed) and returns the "Route
 * einpassen" button once it is enabled.
 */
async function planAndGetFitButton(page: Page, serverUrl: string, from?: string, to?: string) {
  await planRoute(page, serverUrl, from, to);

  await openOptionsCluster(page);

  const fitButton = page.getByRole('button', { name: 'Route einpassen' });
  await expect(fitButton).toBeEnabled({ timeout: 60_000 });
  return fitButton;
}

test.describe('#1102: fit-route-to-view against a real MapLibre camera', () => {
  // Both the wide (disclosure open by default) and narrow (disclosure
  // closed by default, #628) code paths — the two viewports the #1100
  // review manually verified against, made durable.
  const viewports = {
    tabletLandscape: STANDARD_VIEWPORTS.tabletLandscape,
    phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
  };

  for (const [name, viewport] of Object.entries(viewports)) {
    test(`clicking "Route einpassen" returns the camera to the route bounds (${name})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        const fitButton = await planAndGetFitButton(page, server.url);

        const fitted = await waitForStableCamera(page);

        // Move the camera away. MAX_BOUNDS (MapView.tsx) clamps this request
        // back into the region at the bounds' minimum zoom, so where it lands
        // depends on the bounds and the viewport aspect — at phonePortrait
        // since #295 the clamped centre is 0.026 deg of longitude from the
        // fitted one, at zoom 7.34 against 10.61. So the sanity check is the
        // negation of the poll's own success predicate below, not a distance:
        // if it failed, that poll would pass without the button doing anything.
        await page.evaluate(() => {
          (window as unknown as { __scMap?: ScTestMap }).__scMap?.jumpTo({
            center: [0, 0],
            zoom: 2,
          });
        });
        const panned = await readCamera(page);
        expect(panned, 'sanity: the jump must leave the fitted camera').not.toEqual(fitted);

        await openOptionsCluster(page);
        await fitButton.click();

        // Poll the ACTUAL camera, not a boolean — a CI failure here names
        // the real coordinates the camera settled on.
        await expect
          .poll(() => readCamera(page), { timeout: 30_000, intervals: [200] })
          .toEqual(fitted);
      } finally {
        server.kill();
      }
    });
  }
});

// #1626: the fit must keep the route's endpoints visible and out from under
// the map chrome. Overlap alone also holds for a marker pushed off the map.
interface EndpointState {
  overlapPx: number;
  insideMap: boolean;
}

async function endpointState(page: Page, role: 'origin' | 'destination'): Promise<EndpointState> {
  return page.evaluate((r) => {
    const marker = document.querySelector(`.sc-endpoint-marker-${r}`);
    const canvas = document.querySelector('.maplibregl-canvas');
    if (!marker || !canvas) return { overlapPx: -1, insideMap: false };
    const m = marker.getBoundingClientRect();
    const map = canvas.getBoundingClientRect();
    let worst = 0;
    const chrome = document.querySelectorAll(
      '.route-layer-controls, .map-stack-tl, .app-bottom-sheet',
    );
    for (let i = 0; i < chrome.length; i++) {
      const c = chrome[i]!.getBoundingClientRect();
      const w = Math.min(m.right, c.right) - Math.max(m.left, c.left);
      const h = Math.min(m.bottom, c.bottom) - Math.max(m.top, c.top);
      if (w > 0 && h > 0) worst = Math.max(worst, w * h);
    }
    const insideMap =
      m.left >= map.left && m.right <= map.right && m.top >= map.top && m.bottom <= map.bottom;
    return { overlapPx: Math.round(worst), insideMap };
  }, role);
}

async function expectEndpointsClearOfChrome(page: Page): Promise<void> {
  for (const role of ['destination', 'origin'] as const) {
    await expect
      .poll(() => endpointState(page, role), { timeout: 30_000 })
      .toEqual({ overlapPx: 0, insideMap: true });
  }
}

test.describe('#1626: fit pads for map chrome', () => {
  // Controls start expanded here, so both the auto-fit and the button fit run
  // against the full-size cluster.
  const wide = {
    desktopHd: STANDARD_VIEWPORTS.desktopHd,
    tabletLandscape: STANDARD_VIEWPORTS.tabletLandscape,
  };

  for (const [name, viewport] of Object.entries(wide)) {
    test(`endpoints stay clear of the chrome after the auto-fit and "Route einpassen" (${name})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        await planRoute(page, server.url);
        await waitForStableCamera(page);
        await expectEndpointsClearOfChrome(page);

        await page.getByRole('button', { name: 'Route einpassen' }).click();
        await waitForStableCamera(page);
        await expectEndpointsClearOfChrome(page);
      } finally {
        server.kill();
      }
    });
  }

  // Controls start collapsed at narrow widths (#628), so the auto-fit is
  // measured against the collapsed cluster and the bottom sheet.
  const narrow = {
    tabletPortrait: STANDARD_VIEWPORTS.tabletPortrait,
    phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
  };

  for (const [name, viewport] of Object.entries(narrow)) {
    test(`endpoints stay clear of the chrome after the auto-fit (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        await planRoute(page, server.url);
        await waitForStableCamera(page);
        await expectEndpointsClearOfChrome(page);
      } finally {
        server.kill();
      }
    });

    // Reaching the button opens the disclosure; the fit closes it again (#1702).
    test(`endpoints stay clear of the chrome after "Route einpassen" (${name})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        const fitButton = await planAndGetFitButton(page, server.url);
        await fitButton.click();
        await waitForStableCamera(page);
        await expectEndpointsClearOfChrome(page);
      } finally {
        server.kill();
      }
    });
  }
});

// #1639: chrome that resizes after the auto-fit must re-pad it. The offline-ready
// toast closing grows both the map and the bottom sheet at tabletPortrait.
async function startMarkerGapToSheet(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const marker = document.querySelector('.sc-endpoint-marker-origin');
    const sheet = document.querySelector('.app-bottom-sheet');
    if (!marker || !sheet) return null;
    return Math.round(sheet.getBoundingClientRect().top - marker.getBoundingClientRect().bottom);
  });
}

test.describe('#1639: start marker clear of the bottom sheet (tabletPortrait)', () => {
  // Control, green without the re-fit: the first fit is already right when the toast stays up.
  test('control: auto-fit on a height-limited route, toast still showing', async ({ page }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    const server = await startPreview(page);
    try {
      await planRoute(page, server.url, 'Flensburg', 'Sønderborg');
      await waitForStableCamera(page);
      await expect
        .poll(() => startMarkerGapToSheet(page), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(0);
      await expectEndpointsClearOfChrome(page);
    } finally {
      server.kill();
    }
  });

  test('after the offline-ready toast is dismissed following the plan', async ({ page }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    const server = await startPreview(page);
    try {
      await planRoute(page, server.url, 'Flensburg', 'Sønderborg');
      await waitForStableCamera(page);
      await page.locator('.banner-area').getByRole('button', { name: 'Schließen' }).click();
      await expect(page.locator('.banner-area .banner')).toHaveCount(0);
      await expect.poll(() => bannerHeightVar(page), { timeout: 30_000 }).toBe('0px');
      await waitForStableCamera(page);
      await expect
        .poll(() => startMarkerGapToSheet(page), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(0);
    } finally {
      server.kill();
    }
  });
});

// Switching to the Live tab shrinks the sheet while the docked readout takes its place.
test.describe('#1639: start marker clear of the Live readout (tabletPortrait)', () => {
  test.use({
    permissions: ['geolocation'],
    geolocation: { latitude: 54.8237, longitude: 9.6524, accuracy: 5 },
  });

  test('after starting the Live view', async ({ page }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    const server = await startPreview(page);
    try {
      await planRoute(page, server.url, 'Flensburg', 'Sønderborg');
      await waitForStableCamera(page);
      await page.getByRole('tab', { name: 'Live' }).click();
      await page.getByRole('button', { name: 'Live-Ansicht' }).click();
      await expect(page.locator('.live-view-data')).toBeVisible({ timeout: 30_000 });
      await waitForStableCamera(page);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const marker = document.querySelector('.sc-endpoint-marker-origin');
              const live = document.querySelector('.live-view');
              if (!marker || !live) return null;
              const m = marker.getBoundingClientRect();
              const l = live.getBoundingClientRect();
              const w = Math.min(m.right, l.right) - Math.max(m.left, l.left);
              const h = Math.min(m.bottom, l.bottom) - Math.max(m.top, l.top);
              return w > 0 && h > 0 ? Math.round(w * h) : 0;
            }),
          { timeout: 30_000 },
        )
        .toBe(0);
    } finally {
      server.kill();
    }
  });
});
// #1641: the DOM endpoint labels hang off the markers and must clear the chrome too.
interface LabelState {
  overlapPx: number;
  insideMap: boolean;
}

async function labelState(page: Page, role: 'origin' | 'destination'): Promise<LabelState> {
  return page.evaluate((r) => {
    const label = document.querySelector(`.sc-endpoint-marker-${r} .sc-endpoint-marker-label`);
    const canvas = document.querySelector('.maplibregl-canvas');
    if (!label || !canvas) return { overlapPx: -1, insideMap: false };
    const l = label.getBoundingClientRect();
    const map = canvas.getBoundingClientRect();
    let worst = 0;
    const chrome = document.querySelectorAll(
      '.route-layer-controls, .map-stack-tl, .app-bottom-sheet, .live-view',
    );
    for (let i = 0; i < chrome.length; i++) {
      const c = chrome[i]!.getBoundingClientRect();
      const w = Math.min(l.right, c.right) - Math.max(l.left, c.left);
      const h = Math.min(l.bottom, c.bottom) - Math.max(l.top, c.top);
      if (w > 0 && h > 0) worst = Math.max(worst, w * h);
    }
    const insideMap =
      l.left >= map.left && l.right <= map.right && l.top >= map.top && l.bottom <= map.bottom;
    return { overlapPx: Math.round(worst), insideMap };
  }, role);
}

async function expectLabelsClear(page: Page): Promise<void> {
  for (const role of ['destination', 'origin'] as const) {
    await expect
      .poll(() => labelState(page, role), { timeout: 30_000 })
      .toEqual({ overlapPx: 0, insideMap: true });
  }
}

test.describe('#1641: endpoint labels clear of the chrome after the auto-fit', () => {
  const viewports = {
    tabletPortrait: STANDARD_VIEWPORTS.tabletPortrait,
    desktopHd: STANDARD_VIEWPORTS.desktopHd,
  };

  for (const [name, viewport] of Object.entries(viewports)) {
    test(`labels of both endpoints stay clear of the chrome (${name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const server = await startPreview(page);
      try {
        await planRoute(page, server.url);
        await waitForStableCamera(page);
        await expectLabelsClear(page);
      } finally {
        server.kill();
      }
    });

    // The restored plan arrives before its endpoint markers are rebuilt. The second
    // route pins the release-gate route of #1717; it is green on base and did not
    // reproduce that issue.
    const routes: Array<[string, string?, string?]> = [['default route']];
    if (name === 'tabletPortrait')
      routes.push(['Flensburg -> Sønderborg', 'Flensburg', 'Sønderborg']);
    for (const [routeName, from, to] of routes) {
      test(`labels stay clear after a session restore (${name}, ${routeName})`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const server = await startPreview(page);
        try {
          await planRoute(page, server.url, from, to);
          // PlansList reads IndexedDB once, on mount: let the save settle first.
          await page.getByRole('tab', { name: 'Routen' }).click();
          await expect(page.locator('.plans-list-row')).toHaveCount(1);
          await page.goto(server.url);
          await expect(page.getByRole('tab', { name: 'Routen' })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expect(page.locator('.sc-endpoint-marker-label')).toHaveCount(2, {
            timeout: 60_000,
          });
          await waitForStableCamera(page);
          await expectLabelsClear(page);
        } finally {
          server.kill();
        }
      });
    }
  }
});

test.describe('#1702: "Route einpassen" with the options cluster open (tabletPortrait)', () => {
  test('closes the cluster and leaves both endpoints and labels uncovered', async ({ page }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    const server = await startPreview(page);
    try {
      const fitButton = await planAndGetFitButton(page, server.url, 'Flensburg', 'Sønderborg');
      await fitButton.click();
      await waitForStableCamera(page);
      await expectEndpointsClearOfChrome(page);
      await expectLabelsClear(page);
      await expect
        .poll(() =>
          page
            .locator('details.route-layer-controls-disclosure')
            .evaluate((el) => (el as HTMLDetailsElement).open),
        )
        .toBe(false);
    } finally {
      server.kill();
    }
  });
});

// #1710: the chart is fitted once on entering Live and never while it is active.
test.describe('#1710: no re-fit while Live is active (tabletPortrait)', () => {
  test.use({
    permissions: ['geolocation'],
    geolocation: { latitude: 54.8237, longitude: 9.6524, accuracy: 5 },
  });

  test('"Route einpassen" after a user move before Live does not arm another entry fit', async ({
    page,
  }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    const server = await startPreview(page);
    try {
      const fitButton = await planAndGetFitButton(page, server.url, 'Flensburg', 'Sønderborg');
      // The open cluster covers the drag point.
      await page.locator('details.route-layer-controls-disclosure > summary').click();
      const fitted = await waitForStableCamera(page);

      // A real drag on empty water: only a user gesture releases the auto-fit.
      const dragFrom = { x: 700, y: 520 };
      await page.mouse.move(dragFrom.x, dragFrom.y);
      await page.mouse.down();
      await page.mouse.move(dragFrom.x - 60, dragFrom.y + 20, { steps: 6 });
      await page.mouse.up();
      const moved = await waitForStableCamera(page);
      expect(moved, 'sanity: the drag must leave the fitted camera').not.toEqual(fitted);

      await page.getByRole('tab', { name: 'Live' }).click();
      await page.getByRole('button', { name: 'Live-Ansicht' }).click();
      await expect(page.locator('.live-view-data')).toBeVisible({
        timeout: 30_000,
      });
      await waitForStableCamera(page);

      await page.evaluate(() => {
        const w = window as unknown as {
          __scMap?: { fitBounds: (...args: unknown[]) => unknown };
          __fitCalls?: number;
        };
        const map = w.__scMap;
        if (!map) throw new Error('window.__scMap is not set');
        w.__fitCalls = 0;
        const original = map.fitBounds.bind(map);
        map.fitBounds = (...args: unknown[]) => {
          w.__fitCalls = (w.__fitCalls ?? 0) + 1;
          return original(...args);
        };
      });

      // The click and the toast closing land in one task, so the next observer
      // callback after the re-arm is the resize and not a layout-neutral one.
      await openOptionsCluster(page);
      await expect(page.locator('.reload-prompt')).toBeVisible();
      const counts = await fitButton.evaluate(async (button) => {
        const w = window as unknown as { __fitCalls?: number };
        const close = document.querySelector<HTMLElement>('.reload-prompt .banner-dismiss');
        if (!close) throw new Error('no toast to dismiss');
        (button as HTMLButtonElement).click();
        const atClick = w.__fitCalls ?? -1;
        close.click();
        // Observer callback, then the frame it schedules the re-fit on.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        );
        return { atClick, after: w.__fitCalls ?? -1 };
      });
      expect(counts.atClick, 'positive control: the counter sees the button fit').toBeGreaterThan(
        0,
      );
      expect(counts.after).toBe(counts.atClick);
    } finally {
      server.kill();
    }
  });
});
