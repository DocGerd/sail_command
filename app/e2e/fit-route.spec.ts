import { test, expect, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS } from './helpers';

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

/**
 * Plans Langballigau -> Sønderborg on the deterministic wind-sw12 fixture —
 * the same route `route-alt-rig.spec.ts` and `annotations.spec.ts` use,
 * already known to produce a real multi-leg route on this wind. Opens
 * `.route-layer-controls-disclosure` if the current viewport starts it
 * collapsed (#628: narrow viewports default closed) and returns the "Route
 * einpassen" button once it is enabled.
 */
async function planAndGetFitButton(page: Page, serverUrl: string) {
  await page.goto(`${serverUrl}?windFixture=test-fixtures/wind-sw12.json`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill('Langballigau');
  await expect(origin.getByRole('option')).toHaveCount(1);
  await origin.getByRole('option').first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill('Sønderborg');
  await expect(dest.getByRole('option')).toHaveCount(1);
  await dest.getByRole('option').first().click();
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 60_000 });

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

        // The state the auto-fit effect reached when the plan first
        // appeared — this is the target the button's OWN fit must reproduce.
        const fitted = await waitForStableCamera(page);

        // Pan/zoom the real camera away — Null Island, a location and zoom
        // nothing about the Flensburg Fjord region could produce.
        await page.evaluate(() => {
          (window as unknown as { __scMap?: ScTestMap }).__scMap?.jumpTo({
            center: [0, 0],
            zoom: 2,
          });
        });
        const panned = await readCamera(page);
        expect(panned.lng, 'sanity: the pan actually moved the camera').not.toBeCloseTo(
          fitted.lng,
          1,
        );

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
