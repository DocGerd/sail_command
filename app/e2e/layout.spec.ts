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

    // #31: on wide the Live readout renders INSIDE the left panel column (so
    // the panel content area is no longer empty under the Live tab), not as a
    // floating card over the map. A fresh e2e context has no active plan/GPS
    // fix, so LiveView renders its no-plan card (`.live-view-no-plan`) — enough
    // to assert placement. Scope the locator to the bottom-sheet panel to prove
    // DOM containment (the portal target lives there), then confirm it sits
    // within the panel column's horizontal bounds, not right of it over the map.
    await page.getByRole('tab', { name: 'Live' }).click();
    const liveCard = page.locator('.app-bottom-sheet .live-view-no-plan');
    await expect(liveCard).toBeVisible();
    const liveBox = await box(liveCard);
    expect(liveBox.x).toBeGreaterThanOrEqual(widePanel.x - 2);
    expect(liveBox.x + liveBox.width).toBeLessThanOrEqual(widePanel.x + widePanel.width + 2);
    // And NOT also rendered inline over the map — a dual-render regression
    // (portaled AND inline) would leave a second copy in .map-area.
    await expect(page.locator('.map-area .live-view-no-plan')).toHaveCount(0);
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

    // #31: narrow layout is unchanged — the readout stays a bottom-docked card
    // in MapView's subtree (inside .map-area), NOT portaled into the bottom-
    // sheet panel. This pins the split direction so a future refactor can't
    // quietly move the narrow readout into the panel. Stay on the Live tab: the
    // resize crossing below is asserted while Live is active.
    await page.getByRole('tab', { name: 'Live' }).click();
    await expect(page.locator('.map-area .live-view-no-plan')).toBeVisible();
    await expect(page.locator('.app-bottom-sheet .live-view-no-plan')).toHaveCount(0);

    // --- Back to wide, WHILE STILL ON LIVE: the #31 breakpoint crossing ---
    // The one runtime path where useWideLayout's change listener, the slot's
    // callback-ref, and the portal<->inline relocation interact end to end (the
    // unit test uses a static slot; App.test is always narrow). The readout must
    // relocate from the map corner (.map-area) into the panel column
    // (.app-bottom-sheet) — auto-retrying locators, no fixed waits.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.app-bottom-sheet .live-view-no-plan')).toBeVisible();
    await expect(page.locator('.map-area .live-view-no-plan')).toHaveCount(0);
    // The canvas must also resize with its container.
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
    // #31: guard the JS (matchMedia) side of the duplicated 1024px breakpoint,
    // not just the CSS @media geometry below — at exactly 1024 the Live readout
    // (still selected from the crossing above) must be in the panel column. A
    // JS-only drift (e.g. WIDE_LAYOUT_QUERY bumped to 1025) would leave the
    // panel empty under Live here while the CSS grid still switched.
    await expect(page.locator('.app-bottom-sheet .live-view-no-plan')).toBeVisible();
    await expect(page.locator('.map-area .live-view-no-plan')).toHaveCount(0);
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
