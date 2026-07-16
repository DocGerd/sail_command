import { test, expect, type Locator } from '@playwright/test';
import { startPreview } from './helpers';

// Responsive shell layout (#24). Below 1024px the panel is a bottom-sheet
// overlay on a full-viewport map; at >=1024px it becomes a ~1/3-width side
// column on the LEFT with the map filling the remaining ~2/3 at full height.
// jsdom can't exercise real CSS grid, so the geometry is asserted here against
// a real browser via bounding boxes rather than computed CSS internals.
//
// This also covers the resize requirement: crossing the breakpoint must keep
// the MapLibre canvas sized to its container (no stale/letterboxed canvas) —
// handled by MapLibre v5's built-in container ResizeObserver (trackResize),
// which the round-trip back to the wide layout at the end verifies.

async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('expected element to have a bounding box (is it visible?)');
  return b;
}

test('responsive layout: side panel on wide screens, bottom sheet on narrow', async ({ page }) => {
  const server = await startPreview();
  try {
    const panel = page.locator('.app-bottom-sheet');
    const mapArea = page.locator('.map-area');
    const canvas = page.locator('canvas.maplibregl-canvas');

    // --- Wide: 1280x800, side-panel layout ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(server.url);
    await expect(panel).toBeVisible();
    await expect(canvas).toBeVisible();

    const widePanel = await box(panel);
    const wideMap = await box(mapArea);
    // Panel is the left column: flush left, ~1/3 width (not full width).
    expect(widePanel.x).toBeLessThan(2);
    expect(widePanel.width).toBeGreaterThanOrEqual(320);
    expect(widePanel.width).toBeLessThan(1280 * 0.5);
    // Map sits beside the panel (to its right, no overlap) and fills the rest.
    expect(wideMap.x).toBeGreaterThanOrEqual(widePanel.x + widePanel.width - 2);
    expect(wideMap.width).toBeGreaterThan(1280 * 0.5);
    // Panel is bottom-flush: its column spans all three grid rows down to the
    // viewport bottom. Assert the bottom edge rather than a height fraction —
    // the panel's height legitimately varies with the header/banner row sizes,
    // so a `height > 90%` bound would be brittle; a bottom-flush edge is the
    // real contract. The map column still runs (near) full viewport height.
    expect(widePanel.y + widePanel.height).toBeGreaterThanOrEqual(798);
    expect(wideMap.height).toBeGreaterThan(800 * 0.9);
    // Canvas fills the map column, not a stale full-width or letterboxed box.
    const wideCanvas = await box(canvas);
    expect(wideCanvas.width).toBeGreaterThan(1280 * 0.5);
    expect(wideCanvas.width).toBeLessThan(1280 * 0.75);

    // Live readout floats as a compact card in the MAP column, not stretched
    // across the panel. A fresh e2e context has no active plan/GPS fix, so
    // LiveView renders its no-plan card (`.live-view-no-plan`) — enough to
    // assert placement. It must sit right of the panel (in the map column) and
    // stay capped to a card width (22rem + slack), not fill the map.
    await page.getByRole('tab', { name: 'Live' }).click();
    const liveCard = page.locator('.live-view-no-plan');
    await expect(liveCard).toBeVisible();
    const liveBox = await box(liveCard);
    expect(liveBox.x).toBeGreaterThan(widePanel.x + widePanel.width);
    expect(liveBox.width).toBeLessThanOrEqual(356);
    // Switch back so the banner/form-control assertions below see the planner.
    await page.getByRole('tab', { name: 'Planen' }).click();

    // Tap-pick banner renders inside the left panel column (not over the map).
    // plan.spec now runs at a narrow viewport, so this is the sole wide-layout
    // banner check. Arm pick-on-map exactly as plan.spec does, then disarm.
    await page
      .getByRole('region', { name: 'Wegpunkte' })
      .getByRole('button', { name: 'Wegpunkt hinzufügen' })
      .click();
    const tapPickBanner = page.getByText('Auf Karte tippen für Wegpunkte.');
    await expect(tapPickBanner).toBeVisible();
    const bannerBox = await box(tapPickBanner);
    expect(bannerBox.x).toBeGreaterThanOrEqual(widePanel.x - 2);
    expect(bannerBox.x + bannerBox.width).toBeLessThanOrEqual(widePanel.x + widePanel.width + 2);
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(tapPickBanner).not.toBeVisible();

    // Form controls are capped, not stretched across the ~1/3 panel — the
    // original #24 complaint. The harbor-search input caps at 22rem (+ slack).
    const searchBox = await box(page.getByRole('region', { name: 'Start' }).getByRole('searchbox'));
    expect(searchBox.width).toBeLessThanOrEqual(356);

    // --- Narrow: 375x667, bottom-sheet overlay (unchanged base layout) ---
    await page.setViewportSize({ width: 375, height: 667 });
    // Wait for the media query + MapLibre resize to settle. Poll panel.y:
    // only the bottom-sheet layout docks the panel low (y > 100) — the wide
    // panel's width already exceeds the narrow threshold, so width cannot
    // distinguish the two states.
    await expect.poll(async () => (await panel.boundingBox())?.y ?? 0).toBeGreaterThan(100);
    // Also confirm the canvas actually shrank to the narrow width. Without
    // this the round-trip has a blind spot: a dead resize path leaves the
    // canvas ~853px wide and the final return-to-wide poll (> 640) would pass
    // on that stale value, silently masking a broken resize.
    await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeLessThan(376);
    const narrowPanel = await box(panel);
    const narrowMap = await box(mapArea);
    // Panel spans the full width and is docked at the bottom (not the top).
    expect(narrowPanel.width).toBeGreaterThan(375 * 0.9);
    expect(narrowPanel.y).toBeGreaterThan(100);
    expect(narrowPanel.y + narrowPanel.height).toBeGreaterThan(667 * 0.9);
    // Map is the full-viewport base layer underneath the sheet.
    expect(narrowMap.x).toBeLessThan(2);
    expect(narrowMap.width).toBeGreaterThan(375 * 0.95);
    expect(narrowMap.height).toBeGreaterThan(667 * 0.95);

    // --- Back to wide: the canvas must resize with its container ---
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect
      .poll(async () => Math.round((await canvas.boundingBox())?.width ?? 0))
      .toBeGreaterThan(1280 * 0.5);
    const reWideCanvas = await box(canvas);
    expect(reWideCanvas.width).toBeLessThan(1280 * 0.75);

    // --- Boundary: exactly 1024x768, the media-query switch-on point ---
    // Guards off-by-one / unit rewrites of `min-width: 1024px`: at exactly
    // 1024px the side-panel layout must be active. Poll the panel width down
    // to the 1024 grid geometry (~341px, vs ~427px at 1280) before asserting.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThan(400);
    const edgePanel = await box(panel);
    const edgeMap = await box(mapArea);
    // Panel is the flush-left column, well under half the viewport.
    expect(edgePanel.x).toBeLessThan(2);
    expect(edgePanel.width).toBeLessThan(512);
    // Map sits beside it (to its right, no overlap) and fills the rest.
    expect(edgeMap.x).toBeGreaterThanOrEqual(edgePanel.x + edgePanel.width - 2);
    expect(edgeMap.width).toBeGreaterThan(1024 * 0.5);
  } finally {
    server.kill();
  }
});
