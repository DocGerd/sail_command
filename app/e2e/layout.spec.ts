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
    // Both columns run (near) full viewport height.
    expect(widePanel.height).toBeGreaterThan(800 * 0.9);
    expect(wideMap.height).toBeGreaterThan(800 * 0.9);
    // Canvas fills the map column, not a stale full-width or letterboxed box.
    const wideCanvas = await box(canvas);
    expect(wideCanvas.width).toBeGreaterThan(1280 * 0.5);
    expect(wideCanvas.width).toBeLessThan(1280 * 0.75);

    // --- Narrow: 375x667, bottom-sheet overlay (unchanged base layout) ---
    await page.setViewportSize({ width: 375, height: 667 });
    // Wait for the media query + MapLibre resize to settle.
    await expect
      .poll(async () => (await panel.boundingBox())?.width ?? 0)
      .toBeGreaterThan(375 * 0.9);
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
  } finally {
    server.kill();
  }
});
