import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #38/#39 always-mounted map data layers. What this asserts (and why it's
// not theater): the depth toggle must exist BEFORE any plan (the whole point
// of the DataLayers host being a sibling of the plan-gated RouteLayer), and
// checking it must actually change the rendered map — a raster that never
// draws would pass any DOM-only assertion. Harbor markers/labels are canvas
// pixels with no DOM handle, so their look is covered by the manual
// real-browser pass instead of a brittle pixel-match here.

// Polls until the canvas stops changing frame-to-frame (two consecutive
// byte-equal screenshots), then returns that settled frame. This replaces
// fixed waitForTimeout()s that fail both ways: too short → false fail (compare
// before the frame finished), and fire mid-render → false pass (a still-
// settling baseline differs from itself). Adaptive — returns as soon as stable,
// so it's usually fast; the attempt cap only guards a genuinely stuck page.
// CI runners are 6-10x slower than dev machines, hence the generous cap.
async function settledCanvas(page: Page, canvas: Locator): Promise<Buffer> {
  let prev = await canvas.screenshot();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev; // best-effort: never stabilized within the cap
}

test('depth toggle is available pre-plan and flips the rendered map', async ({ page }) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);

    // Always-mounted cluster present with NO plan; the plan-gated
    // route-layer cluster (wind barbs) must not be.
    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await expect(depthToggle).not.toBeChecked(); // default OFF
    await expect(page.locator('.route-layer-controls')).toHaveCount(0);

    const canvas = page.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible();
    await page.waitForLoadState('networkidle');

    // Baseline: the settled pre-overlay frame. Because it's stable, a later
    // byte difference against it is a real rendering delta (the raster), not
    // transient tile/label noise — which is what lets the byte compares below
    // stand in for a pixel diff without a PNG decoder in the e2e deps.
    const baseline = await settledCanvas(page, canvas);

    // ON must change the rendered map. expect.poll (house style, cf.
    // layout.spec) waits for the raster to actually draw instead of racing it
    // with a one-shot compare.
    await depthToggle.check();
    await expect(depthToggle).toBeChecked();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(baseline), {
        message: 'toggling depth ON must change the rendered map',
        timeout: 30_000,
      })
      .toBe(false);

    // OFF must remove the raster. Compare against the settled OVERLAY frame
    // (not byte-equality with `baseline` — tile/label rendering isn't
    // guaranteed bit-stable across frames, so `off === baseline` is unsafe).
    const overlay = await settledCanvas(page, canvas);
    await depthToggle.uncheck();
    await expect(depthToggle).not.toBeChecked();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(overlay), {
        message: 'toggling depth OFF must remove the raster',
        timeout: 30_000,
      })
      .toBe(false);
  } finally {
    server.kill();
  }
});
