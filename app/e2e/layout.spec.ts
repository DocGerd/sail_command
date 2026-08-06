import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  startPreview,
  mapReady,
  bannerHeightVar,
  STANDARD_VIEWPORTS,
  EDGE_VIEWPORTS,
  type Viewport,
} from './helpers';

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

type Box = { x: number; y: number; width: number; height: number };

/** Overlap AREA in px² between two boxes (0 when they don't intersect at all). */
function overlapArea(a: Box, b: Box): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

/** `TAGNAME.class.list` at a viewport point — describes WHAT got hit, not just whether. */
function elementDescriptionAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return '(none)';
      return `${el.tagName}.${Array.from(el.classList).join('.') || '(no class)'}`;
    },
    [x, y] as [number, number],
  );
}

// #412: `locator`'s bounding box is RE-READ every time this is called, never
// frozen once before a poll starts — a poll built on it re-samples the
// checkbox's actual position on every tick instead of hit-testing a single
// coordinate captured before the `--sc-banner-height` ResizeObserver write
// (and the CSS push it drives) has settled. Per the issue's own acceptance
// criteria, the returned string carries the hit element, the coordinate
// probed, AND the live banner-height custom property together — so a CI
// timeout on this poll names every value that could plausibly explain a
// miss, rather than collapsing "the banner still intercepts it" and "the
// geometry hadn't settled yet" into the same bare mismatch.
async function settledHitDescription(page: Page, locator: Locator): Promise<string> {
  const b = await locator.boundingBox();
  if (!b) return '(no box)';
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  const [hit, height] = await Promise.all([
    elementDescriptionAt(page, x, y),
    bannerHeightVar(page),
  ]);
  return `${hit} @ (${Math.round(x)},${Math.round(y)}) bannerHeight=${height || '(unset)'}`;
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
    // original #24 complaint. The harbor-search combobox caps at 22rem (+ slack).
    const searchBox = await box(page.getByRole('region', { name: 'Start' }).getByRole('combobox'));
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

// #368: at narrow widths `.banner-area` (Tier 3, app.css) used to physically
// overlap `.map-stack-tl` (Tier 2) in the SAME screen region — Tier 3
// correctly winning the paint ALSO meant it won the hit test, so the offline
// banner intercepted taps meant for the "Wassertiefen" depth checkbox
// underneath it (measured pre-fix: `elementFromPoint` over the checkbox
// resolved to `SPAN.banner-message`, not the control). The fix moves
// `.map-stack-tl` (and its mirrored `.route-layer-controls`) clear of a
// rendered banner's footprint by MEASURING `.banner-area`'s real rendered
// height (`lib/useBannerHeight.ts`) instead of estimating it from viewport
// height, rather than touching either element's z-index.
//
// Runs the SAME single-banner hit-test across BOTH the standard device
// matrix (helpers.ts's `STANDARD_VIEWPORTS` — maintainer requirement: every
// layout-sensitive spec covers desktop 4K/HD, tablet landscape/portrait, and
// phone portrait at minimum) and three of the narrow/short `EDGE_VIEWPORTS`
// entries — `deepPortrait320` and `wrapForcing280` are excluded here because
// they need a DIFFERENT test body (two stacked banners, and a forced wrap,
// both below), not the single-banner one this loop pins.
// `phonePortrait` (390x844, STANDARD) already covers what used to be this
// loop's own first entry — not duplicated into EDGE.
//
// `tabletLandscape` (1180 wide) and `tabletPortrait` (820 wide) straddle the
// 1024px wide/narrow breakpoint (`lib/useWideLayout.ts`) for the FIRST time
// in this test file: every viewport tested before this addition sat on one
// side of it. At >=1024px `.banner-area` becomes a `position: static` grid
// item (app.css's wide-layout override) and structurally cannot overlap the
// map chrome at all, so the wide-branch cases are expected to pass trivially
// — asserted explicitly here rather than assumed, since "structurally can't
// happen" has been wrong before in this file's own history (#208).
// `desktop4k` (3840px) is this file's widest-ever viewport, checked for the
// same reason: nothing in the wide-layout CSS is written against an assumed
// maximum width, and this is the test that would catch it if that stopped
// being true.
//
// Every check below polls or asserts on the VALUE (the resolved element
// description, the measured overlap area), never a bare boolean, so a CI
// failure names what actually got hit instead of just timing out.
const SINGLE_BANNER_VIEWPORTS: Record<string, Viewport> = {
  ...STANDARD_VIEWPORTS,
  narrowPortrait360: EDGE_VIEWPORTS.narrowPortrait360,
  shortLandscape844: EDGE_VIEWPORTS.shortLandscape844,
  shortLandscape740: EDGE_VIEWPORTS.shortLandscape740,
};
for (const [label, viewport] of Object.entries(SINGLE_BANNER_VIEWPORTS)) {
  test(`#368: offline banner no longer intercepts the depth checkbox (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview();
    try {
      await page.setViewportSize(viewport);
      await page.goto(server.url);

      const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
      await expect(depthToggle).toBeVisible();

      // Let the basemap finish loading BEFORE cutting the network: unlike
      // its browser-`navigator.onLine`-flip role below, `setOffline(true)`
      // ALSO blocks real in-flight fetches (measured — going offline mid-load
      // trips a genuine `mapError` banner, a second banner stacking on top of
      // the single one this test means to repro, defeating its clearance).
      await mapReady(page);

      // Dismiss the incidental SW "offline ready" toast so this actually IS
      // the single-banner repro the comment above claims, rather than
      // whichever of the one- or two-banner cases SW install timing happened
      // to produce (best-effort — `.click()`'s own auto-wait no-ops
      // harmlessly if it never appears).
      await page
        .locator('.reload-prompt .banner-dismiss')
        .click({ timeout: 5_000 })
        .catch(() => {});

      // `context.setOffline` flips `navigator.onLine`/fires the browser
      // 'offline' event, which is exactly what useOnline() tracks — it does
      // not need to (and per this repo's standing offline-testing lesson,
      // cannot be trusted to) block real network fetches for the ALREADY
      // loaded basemap above, only to flip that UI state, which is all a
      // single-banner repro needs from this point on.
      await page.context().setOffline(true);
      const banner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
      await expect(banner).toBeVisible();
      // Pin WHICH case this is, right at the moment of measurement — not at
      // the dismiss attempt above, whose own 5s timeout is swallowed, so a
      // late-mounting toast could still land between here and there on a
      // slow CI runner. See compass.spec.ts's #368 fix-wave test for the
      // full derivation of why this matters (the two-banner case pushes
      // `.map-stack-tl` by the SAME amount as one banner, so a stray second
      // banner would silently swap which case this test actually exercises).
      await expect(page.locator('.banner-area .banner')).toHaveCount(1);

      // The real defect, in one probe: what actually receives a tap aimed at
      // the checkbox. A `.toBe(true)` boolean here would collapse "hit the
      // banner" and "hit nothing at all" into the same failure — polling the
      // description instead names exactly which element is in the way.
      // Positive match, not just `.not.toMatch(/banner-message/)`: the
      // banner is `<div class="banner banner-warning"><span
      // class="banner-message">`, so a hit resolving to the flex CONTAINER
      // (e.g. after a padding/justification change, or a shorter dictionary
      // string leaving the checkbox's x under the container's free space)
      // would read as `DIV.banner.banner-warning` — matches neither
      // `/banner-message/` NOR the checkbox, but would pass the negative
      // form while the control stays intercepted.
      // #412: `settledHitDescription` re-reads `depthToggle`'s bounding box
      // on EVERY poll tick — the coordinate is never frozen from a single
      // read taken before the `--sc-banner-height` push settles.
      await expect
        .poll(() => settledHitDescription(page, depthToggle), { timeout: 10_000 })
        .toMatch(/^INPUT\b/);

      // DoD's own phrasing: measured overlap between the two clusters is 0.
      // A second, independent signal from the same fix (top offset moved,
      // not a z-index reorder) rather than a restatement of the hit test.
      await expect
        .poll(
          async () => overlapArea(await box(page.locator('.banner-area')), await box(depthToggle)),
          { timeout: 10_000 },
        )
        .toBe(0);
    } finally {
      await page
        .context()
        .setOffline(false)
        .catch(() => {});
      server.kill();
    }
  });
}

// #368 residual: two STACKED banners (the SW's one-shot "offline ready"
// toast plus the offline warning — both dismissible/self-clearing, neither
// forced) at 320x568, the exact configuration measured broken under the old
// viewport-height clamp heuristic (push resolved to 107.6px there, clearing
// neither the 146px two-banner bottom edge nor the checkbox). A measured
// push (app.css, `--sc-banner-height`) always leaves a fixed ~8px margin
// below whatever `.banner-area` actually renders, regardless of how many
// banners are stacked — see that rule's own derivation comment.
test('#368: two stacked banners at 320x568 (previously measured broken) no longer intercept the depth checkbox', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize(EDGE_VIEWPORTS.deepPortrait320);
    await page.goto(server.url);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await mapReady(page);

    // Deliberately NOT dismissing the SW toast here — this test is ABOUT the
    // two-banner case, so the toast staying up is the point, not something to
    // clear out of the way like the single-banner tests above.
    await page.context().setOffline(true);
    const offlineBanner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
    await expect(offlineBanner).toBeVisible();
    // The toast's own install completion is independent of the offline flip
    // above and not on any fixed clock this test controls — poll for it
    // rather than assuming a fixed delay ever settles it.
    await expect
      .poll(() => page.locator('.banner-area .banner').count(), { timeout: 15_000 })
      .toBe(2);

    // #412: re-reads `depthToggle`'s bounding box on every poll tick — never
    // a coordinate frozen from a single read taken before the
    // `--sc-banner-height` push settles.
    await expect
      .poll(() => settledHitDescription(page, depthToggle), { timeout: 10_000 })
      .toMatch(/^INPUT\b/);

    await expect
      .poll(
        async () => overlapArea(await box(page.locator('.banner-area')), await box(depthToggle)),
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    server.kill();
  }
});

// #368 residual: THREE simultaneous banners (the SW toast, the offline
// warning, and the tap-pick info banner from clicking "Auf Karte wählen") —
// a count the old `:has(.banner-area .banner)` gate treated identically to
// one banner (a binary "any banner at all", not banner-COUNT-based), so a
// third banner stacking on top never widened the push at all. A measured
// `--sc-banner-height` has no such blind spot: it is `.banner-area`'s real
// rendered height regardless of how many children produced it.
test('#368: three simultaneous banners at 390x844 do not intercept the depth checkbox', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize(STANDARD_VIEWPORTS.phonePortrait);
    await page.goto(server.url);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await mapReady(page);

    // Banner 1: the SW's one-shot toast — deliberately not dismissed.
    // Banner 2: the offline warning.
    await page.context().setOffline(true);
    await expect(page.locator('.banner-message', { hasText: 'Planung deaktiviert' })).toBeVisible();
    await expect
      .poll(() => page.locator('.banner-area .banner').count(), { timeout: 15_000 })
      .toBe(2);

    // Banner 3: the tap-pick info banner, from "Pick on map" on the Origin
    // field (default-active Plan tab, so no tab switch is needed first).
    await page
      .getByRole('region', { name: 'Start' })
      .getByRole('button', { name: 'Auf Karte wählen' })
      .click();
    await expect(page.locator('.banner-message', { hasText: 'Auf Karte tippen' })).toBeVisible();
    await expect(page.locator('.banner-area .banner')).toHaveCount(3);

    // #412: re-reads `depthToggle`'s bounding box on every poll tick — never
    // a coordinate frozen from a single read taken before the
    // `--sc-banner-height` push settles.
    await expect
      .poll(() => settledHitDescription(page, depthToggle), { timeout: 10_000 })
      .toMatch(/^INPUT\b/);

    await expect
      .poll(
        async () => overlapArea(await box(page.locator('.banner-area')), await box(depthToggle)),
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    server.kill();
  }
});

// #368 residual: a banner that WRAPS to a second line — no banner-count
// change at all (a `MutationObserver({childList: true})`, this fix's own
// earlier mechanism, cannot see this; see ScaleBar.tsx's comment on why it
// was replaced with a `ResizeObserver`). Forced with a genuinely narrow
// viewport (280px — narrower than this repo's 320px minimum-supported
// width) rather than faking the DOM shape: the offline banner's own DE copy
// is long enough to wrap for real at that width, confirmed below by
// asserting the banner's OWN rendered height, not just the fix's outcome.
test('#368: a banner that wraps to two lines (280px width) does not intercept the depth checkbox', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize(EDGE_VIEWPORTS.wrapForcing280);
    await page.goto(server.url);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await mapReady(page);

    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

    await page.context().setOffline(true);
    const offlineBanner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
    await expect(offlineBanner).toBeVisible();
    await expect(page.locator('.banner-area .banner')).toHaveCount(1);

    // Proves the wrap actually happened, in the browser, rather than
    // assuming it from the viewport width alone: this banner's copy
    // measures a TRUE single line at 32px tall (only reached at a
    // comfortably wide viewport — see app.css's `.data-layer-controls`
    // `min-height` comment for that measurement); each wrapped line adds
    // roughly another line-height on top of that, and 64px was measured live
    // at this exact 280px width during this fix's development. 55px sits
    // comfortably between the true single-line height and that measured
    // wrapped one, so this fails loudly if a font/padding change ever makes
    // the string fit on one line at this width again.
    await expect
      .poll(async () => (await box(page.locator('.banner-area .banner'))).height, {
        timeout: 10_000,
      })
      .toBeGreaterThan(55);

    // #412: re-reads `depthToggle`'s bounding box on every poll tick — never
    // a coordinate frozen from a single read taken before the
    // `--sc-banner-height` push settles.
    await expect
      .poll(() => settledHitDescription(page, depthToggle), { timeout: 10_000 })
      .toMatch(/^INPUT\b/);

    await expect
      .poll(
        async () => overlapArea(await box(page.locator('.banner-area')), await box(depthToggle)),
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => {});
    server.kill();
  }
});

// #277: pins #276's fix for #205 (the narrow-width overlap between
// `.data-layer-controls`, top-left, and `.route-layer-controls`, top-right)
// against regression. That fix is a `max-width: calc(100% - 9.5rem)` bound on
// `.route-layer-controls` derived from TODAY's measured DE/EN toggle-label
// widths (app.css's own comment on that rule) — content-and-locale dependent,
// not a structural guarantee, so a longer label in either dictionary (or a
// new DataLayers toggle) could silently reopen the exact collision this test
// exists to catch. jsdom stubs layout, so this is real-browser-only (per
// PR #276's review, CLAUDE.md's blindness-class lesson).
// EN is the DOCUMENTED tighter case (8.8px margin vs. DE's 11.7px at 320px,
// per the `max-width` rule's own derivation comment) — tested here as the
// binding constraint; DE is the looser case and not separately asserted.
test('#277: .data-layer-controls and .route-layer-controls never intersect at 320px with a plan loaded (EN, #205 regression pin)', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // Switch to English BEFORE picking harbors. The visible glyph is just
    // 'EN', but that's a substring of several unrelated German accessible
    // names (e.g. "Route plan**en**") under Playwright's default
    // case-insensitive substring match — the button's `aria-label` (its real
    // accessible name) is the full 'English anzeigen' (App.tsx: `aria-label=
    // {t('nav.langToggle')}`, shown while lang==='de'), which is unique.
    await page.getByRole('button', { name: 'English anzeigen' }).click();

    await page.getByRole('tab', { name: 'Plan' }).click();
    const originSection = page.getByRole('region', { name: 'Origin' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();

    const destSection = page.getByRole('region', { name: 'Destination' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();

    const planButton = page.getByRole('button', { name: 'Plan route' });
    await planButton.click();
    // Gate on run() settling (button re-enabled) rather than a fixed wait —
    // this is a readiness GATE, not the geometry assertion itself.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    const routeControls = page.locator('.route-layer-controls');
    await expect(routeControls).toBeVisible();

    // Poll the measured overlap AREA (not a boolean) so a regression names
    // the actual px² of intersection instead of just timing out.
    await expect
      .poll(
        async () =>
          overlapArea(await box(page.locator('.data-layer-controls')), await box(routeControls)),
        { timeout: 10_000 },
      )
      .toBe(0);
  } finally {
    server.kill();
  }
});
