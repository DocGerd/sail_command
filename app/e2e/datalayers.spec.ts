import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// #38/#39 always-mounted map data layers. What this asserts (and why it's
// not theater): the depth toggle must exist BEFORE any plan (the whole point
// of the DataLayers host being a sibling of the plan-gated RouteLayer), and
// checking it must actually change the rendered map — a raster that never
// draws would pass any DOM-only assertion. Harbor markers/labels are canvas
// pixels with no DOM handle, so their look is covered by the manual
// real-browser pass instead of a brittle pixel-match here.
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
    // Let basemap tiles/glyphs finish streaming so the toggle is the only
    // expected delta between the screenshots below. The settle waits are
    // deliberately generous — CI runners are 6-10x slower than dev machines.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    const before = await canvas.screenshot();
    await depthToggle.check();
    await expect(depthToggle).toBeChecked();
    await page.waitForTimeout(3000);
    const withOverlay = await canvas.screenshot();
    expect(withOverlay.equals(before), 'toggling depth ON must change the rendered map').toBe(
      false,
    );

    // OFF again removes the raster (compare against the overlay frame, not
    // byte-equality with `before` — tile/label rendering isn't guaranteed
    // bit-stable across frames).
    await depthToggle.uncheck();
    await page.waitForTimeout(3000);
    const off = await canvas.screenshot();
    expect(off.equals(withOverlay), 'toggling depth OFF must remove the raster').toBe(false);
  } finally {
    server.kill();
  }
});
