import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  startPreview,
  mapReady,
  bannerHeightVar,
  assertCleanServiceWorkerState,
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
//
// No 3-CONSECUTIVE stability requirement (#412 fix-wave, PR #419 review,
// Minor 2 — considered and declined here, not silently skipped): a single
// satisfying poll tick wins, unlike `labels.spec.ts`'s three-consecutive-at-
// 400ms pattern. That pattern exists there to outlast MapLibre's placement
// throttle re-running the SAME query and producing a STALE match after a
// real change — a value that can regress AFTER first agreeing. The banner
// geometry these tests depend on has no equivalent regress-after-match path
// WITHIN A SINGLE TEST'S POLL WINDOW (#412 fix-wave, PR #419 review, Minor 7
// — INCOMPLETE, not false, in review round 3, Minor 9: the load-bearing
// claim below holds at every site checked; the wording just undercounted
// where dismissals live and over-generalised how they relate to a poll).
// This file dismisses a `.banner-area` banner at THREE source sites, not
// two: `Abbrechen` (tap-pick-cancel) in the file's first test at line ~173
// — a test with NO `settledHitDescription`/`overlapArea` poll at all, so
// this dismissal is simply outside any poll's existence, not merely before
// one starts — and the two `.reload-prompt .banner-dismiss` clicks below
// (line ~323, inside the `SINGLE_BANNER_VIEWPORTS` loop, which expands to 8
// separate tests — one dismissal per viewport, not one) and in the
// wrap-forcing test (line ~517). Ten of this file's thirteen tests dismiss
// a banner, not "two tests" — "every banner-area size change in this file
// only grows it" was FALSE as a whole-file claim. The scoping that actually
// holds: within any ONE test's poll window, the push only grows — the two
// `.reload-prompt` dismissals run as SETUP, before their own test's
// `setOffline(true)` and before the relevant poll ever starts, and the
// `Abbrechen` dismissal has no poll in its test to race at all. None of the
// three can ever shrink a push mid-poll. So once `--sc-banner-height`
// reflects a push large enough to clear the checkbox within one of those
// poll windows, there is no live producer left that could shrink it back
// over the target a tick later — matching `compass.spec.ts`'s twin comment,
// which was correctly scoped this way from the start. Reachability of a
// stale-LARGE-then-settles-lower transient (e.g. a future test that
// dismisses a banner INSIDE one of these polls' 10s budget, rather than
// before/outside it) is assessed LOW here, not proven impossible — revisit
// this comment if such a test is ever added.
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
  const server = await startPreview(page);
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
    const server = await startPreview(page);
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
  const server = await startPreview(page);
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
  const server = await startPreview(page);
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
  const server = await startPreview(page);
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

// #299: proves the FOUR-tab strip (Plan/Routes/Live/Boat, added for the
// dedicated Boat/skipper-settings tab) fits at the two narrowest
// EDGE_VIEWPORTS entries by MEASUREMENT, never by trusting character counts.
// "Boot"/"Boat" (4 chars, shorter than the existing "Routen"/"Routes") was
// chosen specifically to keep this margin, per the #299 design decision.
//
// FIXED (PR #486 review, Major 2 — the original version of this test was a
// THEOREM, not a guard): a per-tab `boundingBox()` read is STRUCTURALLY
// BLIND to a too-long label here. `.app-tabs button` is `flex: 1`, and
// app.css's global `button { min-width: 44px }` OVERRIDES flex's own
// default `min-width: auto` — so every button's BORDER BOX is forced to an
// EQUAL, viewport/4 width regardless of what its label actually needs, and
// with no `overflow: hidden` anywhere in that chain, a too-long label just
// spills silently past its own box edge (`overflow: visible`, the default)
// instead of growing the box, wrapping, or clipping. MEASURED directly
// (mutating `nav.boat` to `'Bootseinstellungen'`, 18 chars, then reverting):
// with the OLD version of this test's four `boundingBox()`-only checks
// (width>0, edge-to-edge tiling, height vs. the strip), all four still
// PASSED unchanged at both viewports while the real page silently
// overflowed. With THIS version's `scrollWidth - clientWidth` assertion,
// the same mutation reds both cases — `93` at wrapForcing280 (280px) and
// `83` at deepPortrait320 (320px), both `> 0`; reverting the label back to
// `'Boot'` returns both to `<= 0` (passing). `scrollWidth` does NOT share
// the boundingBox blindness — it reflects the element's actual laid-out
// content extent regardless of the `overflow` property's value — so
// `scrollWidth > clientWidth` on the STRIP itself is the one signal here
// that can actually distinguish "fits" from "silently overflows", and is
// now the test's primary assertion.
const FOUR_TAB_VIEWPORTS: Record<string, Viewport> = {
  wrapForcing280: EDGE_VIEWPORTS.wrapForcing280,
  deepPortrait320: EDGE_VIEWPORTS.deepPortrait320,
};
for (const [label, viewport] of Object.entries(FOUR_TAB_VIEWPORTS)) {
  test(`#299: the four-tab strip fits without horizontal overflow (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(server.url);
      await mapReady(page);

      const tablist = page.getByRole('tablist');
      await expect(tablist).toBeVisible();
      const tabs = page.getByRole('tab');
      await expect(tabs).toHaveCount(4);

      // THE discriminating assertion — see this block's own header comment
      // for why scrollWidth, not boundingBox(), is what can actually fail
      // here. Polls the OVERFLOW AMOUNT (scrollWidth - clientWidth), not a
      // boolean, so a CI failure names the actual px overrun instead of just
      // timing out (this repo's own "poll the value" rule). Polled (not a
      // one-shot read) purely as a settle margin for the page's own
      // first-paint layout, not because this value is expected to change
      // afterwards.
      await expect
        .poll(() => tablist.evaluate((el) => el.scrollWidth - el.clientWidth), { timeout: 5_000 })
        .toBeLessThanOrEqual(0);

      // Structural sanity below — real geometry, but NOT the overflow guard
      // (see header comment: these are unfalsifiable theorems for THIS
      // failure mode under this app's flexbox setup). Kept only to catch a
      // DIFFERENT regression — a tab collapsing to 0 width, or the strip
      // itself losing its own full-viewport width.
      const tabBoxes = await Promise.all([0, 1, 2, 3].map((i) => box(tabs.nth(i))));
      for (const b of tabBoxes) expect(b.width).toBeGreaterThan(0);
      const stripBox = await box(tablist);
      const lastTab = tabBoxes[tabBoxes.length - 1];
      expect(lastTab.x + lastTab.width).toBeCloseTo(stripBox.x + stripBox.width, 0);
    } finally {
      server.kill();
    }
  });
}

// #299 (PR #486 review, Minor 3): the #368 clearance MECHANISM (a
// ResizeObserver on `.banner-area`'s real rendered height, publishing
// `--sc-banner-height` — see lib/useBannerHeight.ts) is generic to whatever
// banner is present, but every #368 test above sources its banner from
// offline/mapError/the reload prompt, each running with NO plan loaded — so
// the #299 stale-route banner (App.tsx, gated on `settingsDirty`) never
// actually renders in any of them, and the PR's own report overstated what
// they covered. This test closes that specific evidence gap: it plans a
// real route, then dirties a ROUTING-RELEVANT setting from the Boat tab (the
// exact #299 scenario a solver-affecting change made off the Plan tab), and
// re-runs the SAME depth-checkbox hit test the #368 guards above pin — the
// new banner is now the one actually under test, not merely assumed to
// share its siblings' geometry.
test('#299: the stale-route banner (a Boat-tab settings change) does not intercept the depth checkbox at 320x568', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.setViewportSize(EDGE_VIEWPORTS.deepPortrait320);
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await mapReady(page);

    // Dismiss the incidental SW "offline ready" toast so the stale-route
    // banner below is the ONLY banner present — an attributable signal,
    // not "some banner-area content, mixed with an unrelated toast, didn't
    // intercept".
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

    await page.getByRole('tab', { name: 'Planen' }).click();
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Gate on run() settling (button re-enabled) rather than a fixed wait —
    // this is a readiness GATE, not the geometry assertion itself.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    // Dirty a routing-relevant setting from the Boat tab — the exact #299
    // scenario (a setting changed from a non-Plan surface).
    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByLabel('Motor aktiviert').click();

    const staleBanner = page.locator('.banner-message', {
      hasText: 'Zeigt die zuvor berechnete Route',
    });
    await expect(staleBanner).toBeVisible();
    // Pin WHICH case this is (mirrors the #368 tests' own comment on this):
    // exactly one banner, so the geometry below is attributable to the new
    // banner alone, not diluted by a stray second one.
    await expect(page.locator('.banner-area .banner')).toHaveCount(1);

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
  const server = await startPreview(page);
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

// #598/#813: RETIRED-AND-REPLACED, not merely edited — read this before
// touching either half again.
//
// #598 ORIGINALLY guarded: opening `.depth-legend` (DataLayers.tsx's
// free-floating hatch legend) while a plan is active must not silently
// overflow, nor collide with `.route-layer-controls` on the opposite side of
// the map. #813 (this consolidation) makes that SCENARIO structurally
// unreachable: DataLayers.tsx now renders `.depth-legend` ONLY while
// `useActivePlan()` reports `plan === null` (see that file's own #813
// comment) — so once a plan exists, as this test requires, `.depth-legend`
// is never mounted at all. There is nothing left to open, and no element on
// the map-stack-tl side that could extend far enough right to collide with
// `.route-layer-controls` any more (proven below by an explicit count-0
// assertion, not merely assumed from the DataLayers/RouteLegend unit tests).
//
// The RISK #598 was written to catch — a legend's copy silently overflowing
// its own narrow container — did not disappear with the old element; it
// MOVED. The #598 depth-hatch copy (hatch swatch, basis paragraph, #597
// caveat) now renders INSIDE `.route-legend` (RouteLegend.tsx's own #813
// comment), wrapped in a NEW class, `.route-legend-depth`, with its own
// `overflow-wrap: break-word` treatment (app.css) — different CSS than the
// old `.depth-legend-body` it used to share, because `.route-legend` sits in
// a wider, unconstrained panel rather than DataLayers' 104px/14rem
// free-floating column. That is a genuinely NEW narrow-width surface, so
// this test is REPOINTED at it rather than deleted outright, per the
// prefer-rewrite-over-delete guidance for a moved risk.
//
// VIEWPORT AND LANGUAGE, both re-derived by measurement, not assumed from
// #598's own original 320px/EN choice — the coordinate change alone made
// the ORIGINAL mutation zero-evidence and the fix needed BOTH axes:
//   - LANGUAGE: CLAUDE.md's established finding for the retired
//     `.depth-legend-body` is that the overflow risk in this exact copy is
//     GERMAN COMPOUND NOUNS ("Farbüberlagerung" etc.) — the English strings
//     are short enough to wrap at ordinary spaces regardless of
//     `overflow-wrap`. MEASURED: the mutation below reproduces nothing in
//     English at any of the viewports tried here.
//   - VIEWPORT: at 320px, `.route-legend`'s wider (unconstrained-panel)
//     column resolves to 152px here — MEASURED live, wide enough that even
//     German's longest word in this copy still fits with ZERO overflow with
//     `overflow-wrap: break-word` REMOVED, unlike the old 104px
//     `.depth-legend-body` column this copy used to occupy. So 320px is a
//     zero-evidence viewport for this specific mutation post-#813, exactly
//     the same trap the language axis produced. `EDGE_VIEWPORTS.wrapForcing280`
//     (280x568, named for exactly this purpose — helpers.ts's own comment)
//     narrows the column to 112px, where the SAME mutation reds with a real
//     +9px delta on the basis paragraph — MEASURED live before committing to
//     this shape, not assumed from the narrower number alone.
//
// MUTATION-CHECKED (2026-09-01, this session): commenting out
// `overflow-wrap: break-word` on `.route-legend-depth p` in app.css reds this
// test's overflow poll with a positive `scrollWidth - clientWidth` delta at
// `wrapForcing280`/DE; reverted immediately after, app.css unaffected in the
// shipped diff. So this guard has teeth at the viewport/language pair it
// actually runs at, not merely a shape that happens to pass.
test('#598/#813: the folded-in depth-hatch section inside .route-legend does not silently overflow (wrapForcing280, DE)', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.setViewportSize(EDGE_VIEWPORTS.wrapForcing280);
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    await page.getByRole('tab', { name: 'Planen' }).click();
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    const routeControls = page.locator('.route-layer-controls');
    await expect(routeControls).toBeVisible();

    // #813: the structural half of the "geometry is now unreachable" claim
    // above, proven here rather than only asserted from the unit suite —
    // with a plan active, DataLayers.tsx's `.depth-legend` must not exist at
    // all.
    await expect(page.locator('.depth-legend')).toHaveCount(0);

    // #598 review round 3: dismiss the incidental SW "offline ready" toast
    // before touching any collapsible — same idiom as this file's own #368
    // tests.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

    // Expand the #628 outer disclosure (collapsed by default at this narrow
    // viewport) — same evaluate()-based `.open` IDL-property read as
    // compass.spec.ts's own guard: `getAttribute('open')` returns the EMPTY
    // STRING when present, which is FALSY in JS, so `!getAttribute('open')`
    // cannot distinguish open from closed.
    const outerDisclosure = routeControls.locator('details.route-layer-controls-disclosure');
    const isOuterOpen = await outerDisclosure.evaluate((el) => (el as HTMLDetailsElement).open);
    if (!isOuterOpen) {
      await outerDisclosure.locator('> summary').click();
    }

    // Fix-wave MAJOR 1 (self-review): `.route-legend` now defaults OPEN at
    // narrow viewports (RouteLegend.tsx's own #813 fix-wave comment) — this
    // viewport (wrapForcing280) IS narrow, so an unconditional click would
    // TOGGLE IT CLOSED instead of opening it, same `.open` IDL-property
    // check as the outer disclosure above.
    const routeLegend = page.locator('details.route-legend');
    const isRouteLegendOpen = await routeLegend.evaluate((el) => (el as HTMLDetailsElement).open);
    if (!isRouteLegendOpen) {
      await routeLegend.locator('> summary').click();
    }
    await expect(routeLegend).toHaveJSProperty('open', true);

    // Silent-overflow check on the NEW folded-in depth section — the risk
    // #598 originally guarded, now at its moved location.
    const depthSection = page.locator('.route-legend-depth');
    await expect
      .poll(() => depthSection.evaluate((el) => el.scrollWidth - el.clientWidth), {
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(0);

    // Fix-wave MINOR 1 (self-review): the ORIGINAL `#598` test kept a
    // residual `.data-layer-controls`-vs-`.route-layer-controls` collision
    // poll here even though `.depth-legend` was its own actual subject —
    // "cheap to re-assert" per that test's own comment. This rewrite grows
    // `.route-layer-controls` (four new paragraphs plus a swatch row), so
    // the same cheap guard is worth keeping rather than dropping silently —
    // re-sampled inside the poll callback, same as the deleted version.
    const dataControls = page.locator('.data-layer-controls');
    await expect
      .poll(async () => overlapArea(await box(dataControls), await box(routeControls)), {
        timeout: 10_000,
      })
      .toBe(0);
  } finally {
    server.kill();
  }
});

// #628 review Major 1: #277/#598 above now measure `.route-layer-controls`
// in its DEFAULT COLLAPSED state at 320px (Minor 5's comment on the
// assertion above has the re-measured numbers) — a lighter subject that
// passes MORE EASILY because it shrank, which silently dropped the "both
// collapsibles open at a narrow viewport" coverage those two tests used to
// provide. This restores it: the new outer Disclosure EXPANDED as well as
// `.depth-legend` — the two-collapsibles-open case #277/#598 always meant
// to cover, now re-exercised against the SHRUNK-then-EXPANDED subject
// rather than the always-open one.
//
// #628 review wave 3 Major B: run at 390px, deliberately NOT 320px like
// #277/#598 above. MEASURED at 320px (real Chromium, real `dist` confirmed
// rebuilt after the mutation): `.route-layer-controls`'s resolved
// `max-width: calc(100% - 9.5rem)` is 168.00px there, and the EXPANDED
// cluster clips to exactly that width whether the CSS override is present
// or deleted — 168.00px either way (DE natural width, 233.86px, is already
// well over 168px, so it was clipping at 320px regardless) — so a width pin
// at 320px cannot discriminate the override's presence at all; only the
// overflow check could there (0 vs 8).
//
// At 390px the cap resolves to 238.00px instead, which the override-PRESENT
// natural width (233.86px) sits under (unclipped) while the
// override-DELETED width clips TO exactly that cap. RE-MEASURED HERE
// (2026-08-25, mutation confirmed to actually rebuild: grepped the built
// `dist/assets/*.css` and confirmed all three `route-layer-controls-
// disclosure` rules were physically absent, not just a `tsc`-succeeded
// assumption): override present -> width 233.859375px, overflow 0;
// override deleted -> width 238px, overflow 0. The overflow check does
// NOT discriminate at this viewport (0 both ways — the earlier revision of
// this comment carried the 320px overflow figure, 8, into this 390px
// context, the exact citation-halo mistake Major B itself was filed to
// fix) — the WIDTH pin below is the SOLE keeper here, so its threshold
// must sit strictly BETWEEN 233.86 and 238.00, not merely under some round
// number: `236` is what the reviewer's own suggested fix used, and a wider
// margin (this file's earlier `240`) is provably vacuous — both 233.86 and
// 238.00 are under 240, so that threshold would have passed the mutation
// too, undetected, had this not been re-verified live rather than assumed
// from the 320px numbers. #277/#598's own (collapsed-state, 320px)
// assertions cannot, by construction, ever reach the override at all.
//
// #813 UPDATE: "the controls cluster and depth-hatch legend can BOTH be
// expanded" is no longer a reachable state — DataLayers.tsx's `.depth-legend`
// renders ONLY while no plan is active (see that file's own #813 comment),
// and this test requires a plan. The width-pin/overflow/collision
// assertions below are UNCHANGED and still fully valid: their SUBJECT is
// `.route-layer-controls-disclosure`'s own CSS override (border/padding
// strip), driven by the CHECKBOX ROW LABELS already visible once the outer
// disclosure alone is open — `.depth-legend` was never part of what these
// assertions measure (the comment above already says so: "#277/#598's own
// … assertions cannot, by construction, ever reach the override at all" —
// same is true in reverse, this test's own measurements never depended on
// `.depth-legend`). Only the now-impossible "also open `.depth-legend`" step
// is removed, replaced by an explicit proof that it is absent.
test('#628 review Major 1: the controls cluster can be expanded at 390px without overflow or collision, and #813 leaves .depth-legend absent (DE)', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    await page.getByRole('tab', { name: 'Planen' }).click();
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    const routeControls = page.locator('.route-layer-controls');
    await expect(routeControls).toBeVisible();

    // Expand the #628 outer disclosure — collapsed by default at this
    // narrow viewport.
    const disclosure = routeControls.locator('details.route-layer-controls-disclosure');
    await disclosure.locator('> summary').click();
    await expect(disclosure).toHaveJSProperty('open', true);

    // Dismiss the incidental SW toast — same idiom as #598/#813 above.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});
    // #813: DataLayers.tsx's `.depth-legend` must not exist at all with a
    // plan active — the structural claim the header comment above makes,
    // proven rather than assumed.
    await expect(page.locator('.depth-legend')).toHaveCount(0);

    // Fix-wave MAJOR 1 (self-review): `.route-legend` now defaults OPEN at
    // narrow viewports (RouteLegend.tsx's own #813 fix-wave comment), and
    // this viewport (390px) IS narrow. MEASURED: left open, its own body
    // content (the folded depth section plus the 8-item swatch list) pushes
    // `.route-layer-controls`'s natural width from 233.86px past the
    // 238px cap regardless of the CSS-override mutation below — the width
    // pin's whole discriminating power depended on the pre-#813-fix-wave
    // shape where `.route-legend` stayed closed here, driven only by the
    // checkbox row labels. Force it CLOSED to preserve that basis; this
    // test's own subject is the `.route-layer-controls-disclosure` CSS
    // override, never `.route-legend`'s own open state.
    const innerLegend = routeControls.locator('details.route-legend');
    const isInnerOpen = await innerLegend.evaluate((el) => (el as HTMLDetailsElement).open);
    if (isInnerOpen) {
      await innerLegend.locator('> summary').click();
    }
    await expect(innerLegend).toHaveJSProperty('open', false);

    // General safety check, but NOT the Major-2 keeper at this viewport
    // (MEASURED: 0 both with and without the override — see the comment
    // above the test).
    await expect
      .poll(async () => routeControls.evaluate((el) => el.scrollWidth - el.clientWidth), {
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(0);

    // THE Major-2 keeper at this viewport (the overflow check above is
    // not): MEASURED live with the override present, expanded width is
    // 233.859375px; with the three override rules deleted it clips to
    // 238px at this viewport's resolved `max-width` cap. `236` sits
    // strictly between the two and is re-sampled every poll tick, never a
    // frozen baseline.
    await expect
      .poll(async () => (await box(routeControls)).width, { timeout: 5_000 })
      .toBeLessThan(236);

    // The two clusters (`.data-layer-controls` top-left, `.route-layer-
    // controls` top-right) must not overlap even with BOTH collapsibles
    // open — the #277 pin's own scenario, re-exercised in the expanded
    // state rather than the now-default collapsed one.
    const dataControls = page.locator('.data-layer-controls');
    await expect
      .poll(async () => overlapArea(await box(dataControls), await box(routeControls)), {
        timeout: 10_000,
      })
      .toBe(0);
  } finally {
    server.kill();
  }
});

// #628: the annotations/barb/alt-rig toggles, forecast-time slider and route
// legend now collapse behind ONE Disclosure (RouteLayer.tsx wrapping
// Disclosure.tsx), so the cluster stops obstructing the chart on mobile —
// the issue's own measured obstruction was 33.8%/35.4% of VIEWPORT HEIGHT at
// 390x844/375x667 respectively, both reused as viewport entries below
// (`phonePortrait`, `partialPushBand375`). Default-open state is
// layout-dependent (RouteLayer.tsx's own comment, not persisted): collapsed
// on narrow (<1024px — exactly where the obstruction was measured), open on
// wide (side-panel layouts have room to spare, matching the pre-#628
// behaviour there byte-for-byte).
//
// #628 review Minor 7: trimmed from 4 narrow / 2 wide entries. Each of
// these 6 tests boots its own preview server and runs a real route solve —
// this file's most expensive test shape — and `playwright.config.ts` runs
// `workers: 1, fullyParallel: false`, so they add their full wall time
// SERIALLY to the `e2e` job (capped at 30 min, #605). The default-open
// decision is a single `matchMedia` read at mount, so every narrow entry
// exercises the SAME branch, and both assertions below were MEASURED
// viewport-INVARIANT (collapsed height exactly 60.00px) at every one of the
// original four narrow entries plus both wide ones — `tabletPortrait` and
// `narrowPortrait360` bought no discriminating power over the two the issue
// itself measured, which are kept. Dropped from `WIDE_OPEN_VIEWPORTS`
// below, symmetrically: `tabletLandscape` (kept only in the separate Major
// 3 rotation test, which needs it specifically for straddling the
// breakpoint — this loop does not).
const NARROW_COLLAPSE_VIEWPORTS: Record<string, Viewport> = {
  phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
  partialPushBand375: EDGE_VIEWPORTS.partialPushBand375,
};
for (const [label, viewport] of Object.entries(NARROW_COLLAPSE_VIEWPORTS)) {
  test(`#628: the map-overlay controls cluster starts collapsed and recovers map area on narrow layouts (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

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
      await expect(planButton).toBeEnabled({ timeout: 60_000 });

      const disclosure = page.locator('details.route-layer-controls-disclosure');
      await expect(disclosure).toBeVisible();
      await expect(disclosure).toHaveJSProperty('open', false);

      const routeControls = page.locator('.route-layer-controls');
      // A generous ceiling, not a tight pixel pin (font metrics vary by
      // platform): just the summary row's >=44px touch target plus the
      // outer cluster's own 0.5rem top+bottom padding (16px).
      // #628 review Minor 8: POLL this, never a one-shot `boundingBox()`
      // read — a coordinate frozen before `--sc-banner-height`'s
      // ResizeObserver (and any SW-toast-driven push) has settled produces
      // a signature byte-identical to a real interception (CLAUDE.md's
      // #412 lesson, `layout.spec.ts`'s own `box()` helper comment above).
      // The baseline used by the `+100` comparison below is taken from a
      // SECOND live read, only after this poll confirms the geometry has
      // actually settled at a value satisfying the ceiling.
      await expect
        .poll(async () => (await box(routeControls)).height, { timeout: 5_000 })
        .toBeLessThanOrEqual(70);
      const collapsedHeight = (await box(routeControls)).height;

      // Expand and confirm the content is actually reachable underneath —
      // this is what proves the small measurement above was genuinely
      // COLLAPSED content, not an unrelated small cluster (`open: false`
      // alone can't tell those apart). Re-samples the box live inside the
      // poll rather than freezing a coordinate before the toggle settles
      // (#412's stale-geometry lesson).
      await disclosure.locator('> summary').click();
      await expect(disclosure).toHaveJSProperty('open', true);
      await expect(page.getByRole('checkbox', { name: 'Show wind barbs' })).toBeVisible();
      await expect
        .poll(async () => (await box(routeControls)).height, { timeout: 5_000 })
        .toBeGreaterThan(collapsedHeight + 100);
    } finally {
      server.kill();
    }
  });
}

const WIDE_OPEN_VIEWPORTS: Record<string, Viewport> = {
  desktopHd: STANDARD_VIEWPORTS.desktopHd,
};
for (const [label, viewport] of Object.entries(WIDE_OPEN_VIEWPORTS)) {
  test(`#628: the map-overlay controls cluster starts OPEN on wide (side-panel) layouts (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

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
      await expect(planButton).toBeEnabled({ timeout: 60_000 });

      const disclosure = page.locator('details.route-layer-controls-disclosure');
      await expect(disclosure).toBeVisible();
      await expect(disclosure).toHaveJSProperty('open', true);
      await expect(page.getByRole('checkbox', { name: 'Show wind barbs' })).toBeVisible();
    } finally {
      server.kill();
    }
  });
}

// #628 review Major 3: real-browser confirmation of the exact defect the
// review measured — `defaultOpen` alone is read ONCE via `useState`
// (`Disclosure.tsx`), so without RouteLayer.tsx's `key`+effect pair a
// tabletLandscape -> tabletPortrait rotation (wide -> narrow, no plan
// change, no unmount) would leave an already-OPEN cluster open on a narrow
// viewport, squarely in the obstruction band #628's own captures measured,
// reached with ZERO user interaction. `RouteLayer.test.tsx` already pins
// this at the unit level (mutation-checked: a static `key` reds it) — this
// is the same scenario end-to-end in a real browser, against a real plan
// and real CSS, rather than jsdom's `.open` PROPERTY tracking alone.
test('#628 review Major 3: rotating from a wide to a narrow layout auto-collapses the cluster with NO user interaction', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletLandscape); // wide -> auto-open
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

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
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    const disclosure = page.locator('details.route-layer-controls-disclosure');
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toHaveJSProperty('open', true);

    // The rotation: no click, no navigation, the plan object is untouched.
    await page.setViewportSize(STANDARD_VIEWPORTS.tabletPortrait);
    await expect(disclosure).toHaveJSProperty('open', false);
  } finally {
    server.kill();
  }
});

// #231: on a SHORT LANDSCAPE narrow viewport, the base COLUMN layout for
// `.map-stack-tl` (DataLayers' two toggles stacked, then the compass) was
// measured (#231's own issue text) to occupy ~46% of a 360px-tall viewport,
// leaving ScaleBar.tsx's own geometric suppression rule (#208/#228) no clear
// position on ANY tab at 740x360, and on the Plan tab at 844x390/932x430.
// The fix (app.css, `@media (max-width: 1023.98px) and (max-height: 500px)
// and (orientation: landscape)`) flips both `.map-stack-tl` and
// `.data-layer-controls` to a ROW, spending width a landscape phone has
// plenty of to buy back the height ScaleBar needs.
//
// Deliberately only the three LANDSCAPE entries of EDGE_VIEWPORTS, not the
// whole matrix: the PORTRAIT entries (`narrowPortrait360`, `deepPortrait320`,
// `partialPushBand375`, `wrapForcing280`) are untouched by this fix — their
// `.map-stack-tl` stays the base COLUMN layout, which is the space-efficient
// choice for a tall-narrow viewport (see the media query's own comment) —
// and two of them (`deepPortrait320`, `wrapForcing280`) suppress ScaleBar for
// an unrelated, PRE-EXISTING reason confirmed live on this fix's own dev
// server before this test was written (a narrow-but-tall viewport's sheet
// content alone reaches the same #208 suppression ceiling `.map-stack-tl`
// does here). Asserting non-suppression there would be a false claim about
// unrelated, out-of-scope layout, not a regression pin for #231.
const SHORT_LANDSCAPE_VIEWPORTS: Record<string, Viewport> = {
  shortLandscape844: EDGE_VIEWPORTS.shortLandscape844,
  shortLandscape740: EDGE_VIEWPORTS.shortLandscape740,
  shortLandscape932: EDGE_VIEWPORTS.shortLandscape932,
};
for (const [label, viewport] of Object.entries(SHORT_LANDSCAPE_VIEWPORTS)) {
  test(`#231: ScaleBar is not suppressed and .map-stack-tl stays reachable on short landscape (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(server.url);
      await mapReady(page);

      // Dismiss the incidental SW "offline ready" toast (a `.banner-area`
      // banner in its own right — MEASURED: without this the test's own
      // first run failed here, `.map-stack-tl` pushed down by the toast's
      // height on top of #231's own compaction, re-exhausting the margin
      // this fix bought back). Best-effort like the #368 tests above: a
      // no-op if it never appears.
      await page
        .locator('.reload-prompt .banner-dismiss')
        .click({ timeout: 5_000 })
        .catch(() => {});

      const scaleBar = page.locator('.scale-bar');
      const mapStack = page.locator('.map-stack-tl');
      const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
      const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
      const compassBtn = page.locator('.compass-btn');

      await expect(depthToggle).toBeVisible();
      await expect(seamarksToggle).toBeVisible();
      await expect(compassBtn).toBeVisible();

      // The compaction reflows `.map-stack-tl` into a single short row; the
      // suppression state itself settles asynchronously (ScaleBar.tsx's
      // ResizeObservers on the sheet/bar/live card, see that file's own
      // comment) — poll the CLASS rather than reading it once.
      await expect
        .poll(async () => (await scaleBar.getAttribute('class')) ?? '', { timeout: 10_000 })
        .not.toMatch(/scale-bar-suppressed/);

      // #412: re-derive both boxes on every poll tick, never a coordinate
      // frozen from a single read taken before layout has settled.
      await expect
        .poll(async () => overlapArea(await box(scaleBar), await box(mapStack)), {
          timeout: 10_000,
        })
        .toBe(0);

      // DoD's own named concern: the compass in particular stays reachable
      // and FUNCTIONAL, not merely present. With no GPS fix the tap is
      // rejected (track-up unavailable), which is itself a real, observable
      // side effect of the click actually landing on the button rather than
      // on something painted over it — Playwright's own `.click()` already
      // fails loudly if an overlay intercepts the point, but polling the
      // live-region text is a second, independent signal that the CORRECT
      // element received it.
      const compassStatus = page.locator('.compass-control [role="status"]');
      await expect(compassStatus).toHaveText('');
      await compassBtn.click();
      await expect
        .poll(async () => (await compassStatus.textContent())?.trim() ?? '', {
          timeout: 5_000,
        })
        .not.toBe('');

      // Both toggles remain real, tappable checkboxes, not just visible —
      // the compaction touches this row's own layout (row instead of
      // column, a trimmed padding, a smaller `min-height` on the checkbox
      // itself), so a regression here would be a control rendered but
      // unclickable.
      const before = await depthToggle.isChecked();
      await depthToggle.click();
      await expect(depthToggle).toBeChecked({ checked: !before });
      await depthToggle.click();
      await expect(depthToggle).toBeChecked({ checked: before });
    } finally {
      server.kill();
    }
  });
}

// #441: the #231 loop above closes the NO-banner case; this closes the case
// #231's own comment left open — the fix's own residual note said the
// margin #231 reclaimed (~16-18px at 740x360) was SMALLER than one line of
// `.banner-area` (~32px+), so ANY rendered banner re-exhausted it and
// re-suppressed ScaleBar, `needRefresh` (no dismiss at the time) included.
// Exercised here via the OFFLINE banner (`Planung deaktiviert`), not
// `needRefresh` itself: mechanistically identical for this purpose —
// ScaleBar's suppression ceiling reads `.banner-area`'s REAL rendered
// height via `--sc-banner-height` (lib/useBannerHeight.ts), regardless of
// WHICH banner produced it — and the offline banner is the one this e2e
// suite can reliably force (`context.setOffline(true)`, the same
// substitution the #368 tests above already make) without faking a genuine
// waiting-SW registration inside a single Playwright preview build.
// `needRefresh`'s own NEW dismiss control (ReloadPrompt.tsx) is covered
// separately in ReloadPrompt.test.tsx (a unit test, since forcing a real
// `needRefresh` here isn't practical) — not re-covered by this test.
//
// WHICH ROW ACTUALLY PINS THE FIX (review round 2, m4) — say plainly rather
// than imply all three carry equal evidence, since they measurably don't.
// Reverting app.css's #441 fix to a flat, unconditional `55vh` sheet cap
// (i.e. #231's pre-fix shape) and re-running this loop against a REAL BUILD
// (`npm run e2e`, never `vite dev` — see below for why that distinction is
// load-bearing here) gives THREE DIFFERENT signatures, not one:
//   - shortLandscape740: the RELIABLE regression pin, confirmed in TWO
//     independent measurements (a `--repeat-each=5` run here, and the
//     reviewer's own `--repeat-each=8`): reliably RED under the reverted
//     CSS (this repo's own 8/8 and a matching majority here), reliably
//     GREEN with the shipped fix. This is the row to trust if this test
//     ever regresses silently.
//   - shortLandscape844: NEVER suppressed under the reverted CSS either,
//     in a REAL BUILD — 8/8 GREEN (reviewer's measurement) even at #231's
//     pre-#441 flat `55vh` cap. This row does not discriminate #441's fix
//     at all; it stays in the loop for its own regression value (ScaleBar
//     must never suppress here with the SHIPPED fix), not as evidence the
//     fix is causal. An EARLIER revision of this comment claimed a
//     knife-edge here (a ~2.9px deficit under the reverted CSS) — that
//     figure was measured against `vite dev`, not a real build, and does
//     NOT reproduce in production: `vite dev` and `vite build` render
//     ScaleBar's own text/bracket at a very slightly different size,
//     enough to move an already-marginal case across zero. Read a dev-server
//     margin as a hypothesis to re-verify against a real `npm run e2e`
//     build, never as the shipped number — this is the second time in this
//     file's own history that distinction mattered (#412's stale-geometry
//     class is the first).
//   - shortLandscape932: never suppressed even under the reverted CSS
//     either — this viewport was never broken by #441's own bug and this
//     row is the same "unrelated, out-of-scope layout" case the #231
//     loop's own comment above already describes for the portrait entries;
//     it stays in the loop as a plain non-regression check, not as #441
//     evidence.
// The shipped fix (`calc(55vh - var(--sc-banner-height, 176px))`, app.css's
// own #441 comment has the full derivation) gives a comfortably positive,
// REAL-BUILD-measured margin at all three (740x360 16px, 844x390 29.5px,
// 932x430 47.5px — all three re-derived from the ACTUAL `.app-bottom-sheet`
// rendered height in a real `npm run e2e` build, not `vite dev`), so all
// three pass reliably going FORWARD even though only shortLandscape740
// carries regression-pin evidence for the specific bug #441 fixes.
for (const [label, viewport] of Object.entries(SHORT_LANDSCAPE_VIEWPORTS)) {
  test(`#441: ScaleBar survives one banner line on short landscape (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(server.url);
      await mapReady(page);

      // Clear the incidental SW "offline ready" toast first (best-effort,
      // same as the #231 loop above) so the ONLY banner up for the
      // assertion below is the offline one this test forces — never two
      // banners stacked at once, which would exercise #441's own accepted
      // residual (see app.css's #441 comment), not its guaranteed scope.
      await page
        .locator('.reload-prompt .banner-dismiss')
        .click({ timeout: 5_000 })
        .catch(() => {});

      await page.context().setOffline(true);
      const offlineBanner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
      await expect(offlineBanner).toBeVisible();
      // Confirms exactly ONE banner is up (not the two-banner residual case)
      // before trusting the suppression assertion below.
      await expect(page.locator('.banner-area .banner')).toHaveCount(1);

      const scaleBar = page.locator('.scale-bar');
      // #412: poll the CLASS, re-read every tick — never a value frozen
      // before the `--sc-banner-height` ResizeObserver write (and the CSS
      // push it drives) has settled.
      await expect
        .poll(async () => (await scaleBar.getAttribute('class')) ?? '', { timeout: 10_000 })
        .not.toMatch(/scale-bar-suppressed/);
    } finally {
      await page
        .context()
        .setOffline(false)
        .catch(() => {});
      server.kill();
    }
  });
}

// #638: the depth-hatch legend rendered with NO panel background at all, and
// with a 104px text column at EVERY viewport including 3840x2160 — so its
// longest German compounds broke mid-word on desktop.
//
// This guard exists because of HOW #638 shipped, not only because of what it
// was. Its two pre-existing guards were both green and both correct:
// `datalayers.spec.ts` swept `EDGE_VIEWPORTS` for reachability, and this
// file's own `#598` test measured overflow and collision at 320px ONLY —
// where a 104px column is as-designed. Neither measures paint, and neither
// looks at a wide viewport, so the defect sat orthogonal to both (CLAUDE.md's
// JOINT BLINDNESS entry names this as its worked example). The two halves
// below are therefore deliberately different in scope:
//
//   (A) CHROME — the full `STANDARD_VIEWPORTS` matrix x both colour schemes.
//       Asserts the RESOLVED `background` SHORTHAND, never `backgroundColor`:
//       both the broken and the fixed state read `rgba(0, 0, 0, 0)` for
//       `backgroundColor` under jsdom, so only the shorthand discriminates
//       (the #493/#506 chip lesson). Equality against `.data-layer-controls`'s
//       own pill alone would be VACUOUS — two transparent boxes are equal —
//       so it additionally requires the resolved value NOT to be the
//       transparent default. Neither half is sufficient on its own.
//       Runs whether or not the legend is `hidden`: `display: none` still
//       resolves a background, so this half stays non-vacuous at the narrow
//       viewports where DataLayers.tsx's reachability gate may hide it.
//
//   (B) MID-WORD BREAK — WIDE entries only, SELECTED BY WIDTH against the
//       >=1024px breakpoint rather than by a hand-written name list, so a
//       future STANDARD_VIEWPORTS entry on the wide side is covered
//       automatically. Sweeping this across the whole matrix would RED a
//       CORRECT fix: at `tabletPortrait`/`phonePortrait` the narrow 104px
//       bound is the shipped design, and the wide override is scoped
//       `@media (min-width: 1024px)` precisely because an unscoped width
//       change reopens the #598 collision at 320px (measured there at
//       4940px²). Longest HYPHEN-FREE token, because a break at a real
//       hyphen is a legitimate line-break opportunity and only an
//       opportunity-free token can expose `overflow-wrap: break-word`
//       actually firing.
//
// Both halves poll a DESCRIPTIVE STRING and re-read the DOM inside the poll
// callback — no value is captured before the layout settles (#412), and a
// failure names the measured value rather than reporting `false` (the
// boolean-predicate lesson).
//
// The colour-scheme axis adds no discriminating power for (A): the chrome is
// one `color-mix(in srgb, var(--sc-bg) 90%, transparent)` token and the
// pre-fix state was transparent in both themes. It is swept anyway because
// the issue title says "illegible in dark mode", so a light-only pass would
// not close it — but it is NOT what makes this test fail before the fix.
// Derived from the breakpoint rather than enumerated: `lib/useWideLayout.ts`'s
// WIDE_LAYOUT_QUERY is `min-width: 1024px`, and the wide override half (B)
// tests is scoped to that same query — so a future STANDARD_VIEWPORTS entry on
// the wide side is picked up automatically instead of silently skipped.
const WIDE_LAYOUT_MIN_WIDTH_PX = 1024;

/** `ok`, or a string naming both resolved backgrounds. */
function probeLegendChrome(page: Page): Promise<string> {
  return page.evaluate(() => {
    const legend = document.querySelector('details.depth-legend');
    const pill = document.querySelector('.data-layer-controls');
    if (!legend) return 'no .depth-legend in the DOM at all';
    if (!pill) return 'no .data-layer-controls in the DOM at all';
    const legendBg = getComputedStyle(legend).background;
    const pillBg = getComputedStyle(pill).background;
    // The transparent default, in the exact spelling Chromium resolves it to.
    if (/^rgba\(0, *0, *0, *0\)/.test(legendBg))
      return `.depth-legend has no panel background: ${legendBg}`;
    if (legendBg !== pillBg)
      return `.depth-legend background ${legendBg} != .data-layer-controls ${pillBg}`;
    return 'ok';
  });
}

/** `ok`, or a string naming the split token, its rect count and the column width. */
function probeLegendWordBreak(page: Page): Promise<string> {
  return page.evaluate(() => {
    const body = document.querySelector('.depth-legend-body');
    if (!body) return 'no .depth-legend-body in the DOM at all';
    const bodyEl = body as HTMLElement;
    // `boundingBox()` cannot see silent overflow (#299) — assert it here.
    if (bodyEl.scrollWidth > bodyEl.clientWidth)
      return `.depth-legend-body overflows: scrollWidth ${bodyEl.scrollWidth} > clientWidth ${bodyEl.clientWidth}`;
    // WIDEST BY MEASURED PIXELS, not longest by character count. The two are
    // different tokens and the difference is LIVE, not hypothetical (measured
    // at 1920x1080 on this branch): in EN the widest run is `Unsurveyed`
    // (81.31px, 10 chars) while the longest is `deliberate,` (73.48px, 11
    // chars); in DE three runs tie at 16 chars and span 106.00-120.88px, so a
    // character-count pick is decided by DOM order. Since the ratio floor
    // below is a statement about PIXELS, selecting by characters can only ever
    // OVERSTATE the margin — the fail-open direction.
    let widest: { word: string; rects: number; width: number } | null = null;
    for (const p of Array.from(body.querySelectorAll('p'))) {
      for (const node of Array.from(p.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = node.textContent ?? '';
        // Hyphen-free runs only: a break AT a hyphen is a legitimate
        // line-break opportunity, so a hyphenated token cannot evidence a
        // mid-word break.
        const re = /[^\s-]+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const range = document.createRange();
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          const rects = Array.from(range.getClientRects());
          // Summed, not max: a token split across line boxes has its width
          // split too, so the total is the width it WOULD need unbroken.
          const width = rects.reduce((a, r) => a + r.width, 0);
          if (widest && width <= widest.width) continue;
          widest = { word: m[0], rects: rects.length, width };
        }
      }
    }
    if (!widest) return '.depth-legend-body rendered no text at all';
    if (widest.rects !== 1)
      return `"${widest.word}" broke across ${widest.rects} line boxes in a ${bodyEl.clientWidth}px column`;
    // MARGIN, not just absence-of-break — and this row is here because the
    // obvious weaker guard was MEASURED to pass through the wrong fix.
    // Dropping the wide `width` while keeping `max-width: none` re-hands
    // sizing to `.map-stack-tl`'s shrink-to-fit ceiling, which settles at
    // exactly `widest token + this element's own horizontal chrome` — the
    // column then equals the token to the pixel, one unbroken rect, and a
    // break/no-break assertion alone reports GREEN (measured: 1 passed).
    // That is the hairline regime #638's brief warned about: correct today
    // by luck, and one font-metric or copy change away from breaking again
    // with no test able to see it coming. 1.2x is a floor, not the design
    // point (the shipped 14rem measures 1.72x at 1024x900), chosen well
    // above the 1.00x the hairline produces and well below what ships, so
    // it discriminates the two regimes without pinning the exact width.
    const ratio = bodyEl.clientWidth / widest.width;
    if (ratio < 1.2)
      return `"${widest.word}" fits only at ${ratio.toFixed(2)}x: ${widest.width.toFixed(2)}px token in a ${bodyEl.clientWidth}px column — sized by the shrink-to-fit ceiling, not by the wide-layout width`;
    return 'ok';
  });
}

test('#638: the depth-hatch legend has panel chrome at every STANDARD_VIEWPORTS entry in both themes, and no mid-word break on wide layouts', async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    for (const lang of ['de', 'en'] as const) {
      const context = await browser.newContext();
      await context.addInitScript((l) => {
        window.localStorage.setItem('sc-lang', l);
      }, lang);
      const page = await context.newPage();
      try {
        await page.setViewportSize(STANDARD_VIEWPORTS.desktopHd);
        await page.goto(server.url);
        await mapReady(page);
        // Same idiom as this file's #598 test: the SW "offline ready" toast
        // fires on every fresh browser context and moves DataLayers.tsx's
        // reachability budget, which would hide the legend at the narrow
        // entries below. Dismissing it keeps this test measuring chrome and
        // wrapping rather than re-measuring the #598 gate.
        await page
          .locator('.reload-prompt .banner-dismiss')
          .click({ timeout: 5_000 })
          .catch(() => {});

        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const [name, vp] of Object.entries(STANDARD_VIEWPORTS)) {
            await page.setViewportSize(vp);
            const label = `${name} (${vp.width}x${vp.height}) / ${lang} / ${scheme}`;

            await expect
              .poll(() => probeLegendChrome(page), { timeout: 10_000, message: label })
              .toBe('ok');

            if (vp.width < WIDE_LAYOUT_MIN_WIDTH_PX) continue;

            const details = page.locator('details.depth-legend');
            // Wide layout takes DataLayers.tsx's "always reachable" early
            // return, so this branch is never `hidden` — assert that rather
            // than assume it, or half B could silently measure nothing.
            expect(
              await details.evaluate((el) => (el as HTMLDetailsElement).hidden),
              `${label}: wide layout must never hide the legend`,
            ).toBe(false);
            await details.evaluate((el) => {
              (el as HTMLDetailsElement).open = true;
            });
            await expect
              .poll(() => probeLegendWordBreak(page), { timeout: 10_000, message: label })
              .toBe('ok');
          }
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});

// ---------------------------------------------------------------------------
// #774 (WCAG 2.1.1 Keyboard): the legs table is a horizontal scroll container
// (`.route-legs` is `display: block; overflow-x: auto` in app.css) that a
// keyboard-only user could not reach or operate — it had no `tabIndex`, no
// role and no focusable descendant. The fix makes the scroll container itself
// the tab stop.
//
// This lives HERE rather than in plan.spec.ts because it is a keyboard/layout
// contract, and it deliberately does NOT duplicate panel-resize.spec.ts's
// #355/#698 geometry guards on the same element — those measure whether the
// table overflows; this measures whether the overflow can be OPERATED.
//
// Blind spots stated rather than left implicit:
//   - It runs in German only (the app default). The one #774 string a user
//     reads is the `aria-describedby` hint, and BOTH its translations are
//     pinned in RouteSummary.test.tsx, which is the level at which language
//     actually varies here — a second full planning run per language would
//     cost ~60 s to re-assert geometry that cannot depend on the dictionary.
//   - It asserts nothing about how the focus ring LOOKS. `.route-legs:focus-
//     visible` exists (app.css) and the tab stop is real; whether a 2px inset
//     accent ring is discoverable enough is a design judgement no bounding
//     box can settle.
const KEYBOARD_SCROLL_VIEWPORTS: Record<string, Viewport> = {
  desktopHd: STANDARD_VIEWPORTS.desktopHd,
  phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
};

for (const [label, viewport] of Object.entries(KEYBOARD_SCROLL_VIEWPORTS)) {
  test(`#774: the legs scroll region is keyboard-reachable and arrow-scrollable (${label}, ${viewport.width}x${viewport.height})`, async ({
    page,
  }) => {
    const server = await startPreview(page);
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
      await mapReady(page);

      const originSection = page.getByRole('region', { name: 'Start' });
      await originSection.getByRole('combobox').fill('Langballigau');
      await expect(originSection.getByRole('option')).toHaveCount(1);
      await originSection.getByRole('option').first().click();

      const destSection = page.getByRole('region', { name: 'Ziel' });
      await destSection.getByRole('combobox').fill('Sønderborg');
      await expect(destSection.getByRole('option')).toHaveCount(1);
      await destSection.getByRole('option').first().click();

      const planButton = page.getByRole('button', { name: 'Route planen' });
      await planButton.click();
      await expect(planButton).toBeEnabled({ timeout: 60_000 });

      await page.getByRole('tab', { name: 'Routen' }).click();
      const summary = page.locator('.route-legs-disclosure > summary');
      await summary.click();

      // The <details> open state is read through the `open` IDL PROPERTY, never
      // `getAttribute('open')` — that returns "" when set and null when not,
      // and BOTH are falsy (CLAUDE.md, measured in PR #688). Polled as a
      // DESCRIPTIVE STRING carrying the row count too, so a CI failure names
      // which half went wrong instead of reporting a bare `false`.
      const disclosureState = () =>
        page.evaluate(() => {
          const d = document.querySelector(
            'details.route-legs-disclosure',
          ) as HTMLDetailsElement | null;
          if (!d) return 'no-disclosure';
          return `open=${d.open} rows=${d.querySelectorAll('.route-legs tbody tr').length}`;
        });
      await expect.poll(disclosureState, { timeout: 60_000 }).toMatch(/^open=true rows=[1-9]/);

      // PRECONDITION, asserted rather than assumed: with no overflow there is
      // nothing to scroll and every assertion below would pass vacuously.
      // Re-sampled inside the poll callback (#412/#422) — never a box frozen
      // before layout settled.
      const overflowPx = () =>
        page
          .locator('table.route-legs')
          .evaluate((el) => Math.round(el.scrollWidth - el.clientWidth));
      await expect.poll(overflowPx).toBeGreaterThan(0);

      // The tab stop. Focus the disclosure summary explicitly (a click may or
      // may not leave focus there across engines) and Tab once: the very next
      // stop must be the scroll container. That is BOTH halves of the DoD at
      // once — it is reachable, and nothing else was inserted ahead of it.
      await summary.focus();
      await page.keyboard.press('Tab');
      const activeDescription = () =>
        page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return '(none)';
          const described = el.getAttribute('aria-describedby');
          const hint = described ? document.getElementById(described) : null;
          return `${el.tagName}.${Array.from(el.classList).join('.') || '(no class)'} tabIndex=${
            (el as HTMLElement).tabIndex
          } desc=${hint ? JSON.stringify(hint.textContent) : '(none)'}`;
        });
      // Names the element, its EXPLICIT tab index, and the description it
      // announces — so a CI failure says what actually got focus rather than
      // just "not the table".
      //
      // `tabIndex=0` is pinned deliberately, and this is the one place the
      // guard would otherwise have been weaker than it looks. MEASURED here
      // 2026-08-31 by deleting `tabIndex={0}` from RouteSummary.tsx: this
      // bundled Chromium STILL focused the table
      // (`TABLE.route-legs desc=(none)`), because Chrome ships
      // keyboard-focusable scrollers — a scroll container with no focusable
      // descendant is made focusable by the engine. So a focus-only assertion
      // passes in Chromium whether or not the fix is present, and would have
      // been a green that proved nothing. Reading the `tabIndex` IDL property
      // discriminates: it is 0 only when the attribute is really there, and
      // -1 for a bare <table>.
      //
      // NOT PROVEN BY THIS SPEC, stated rather than implied: Playwright runs
      // Chromium only here, so nothing below is evidence about engines that
      // do NOT auto-focus scrollers — which is precisely the population the
      // explicit tab stop exists for. The attribute is what makes the fix
      // cross-browser; this asserts the attribute, not the other engines.
      await expect.poll(activeDescription).toMatch(/^TABLE\.route-legs tabIndex=0 desc="[^"]+"$/);

      // The actual WCAG 2.1.1 behaviour: arrow keys move the focused scroll
      // container. Poll the VALUE (px scrolled), never a collapsed boolean —
      // a CI failure then carries the distance actually travelled.
      const scrollLeftPx = () =>
        page.locator('table.route-legs').evaluate((el) => Math.round(el.scrollLeft));
      // SAME CAVEAT AS THE tabIndex PIN ABOVE, and it applies to this block too:
      // Chromium's keyboard-focusable-scrollers feature makes a scroller both
      // focusable AND arrow-scrollable, so these three assertions are green in
      // this engine whether or not `tabIndex={0}` is present (MEASURED against
      // THIS spec and the built app on 2026-08-31, by deleting `tabIndex={0}`
      // and relaxing the pin above so execution reached here: scrollLeft still
      // moved to 370 px at desktopHd and 480 px at phonePortrait, Chromium
      // 151.0.7922.34 via the pinned @playwright/test 1.62.1). They
      // document the behaviour and would fire if the overflow ever moved off
      // `.route-legs`; the only assertion in this spec that discriminates the fix
      // is the `tabIndex=0` IDL pin above.
      expect(await scrollLeftPx()).toBe(0);
      for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
      await expect.poll(scrollLeftPx).toBeGreaterThan(0);

      // ...and back, so the guard covers the reverse direction too rather than
      // proving only that SOMETHING moved.
      for (let i = 0; i < 24; i++) await page.keyboard.press('ArrowLeft');
      await expect.poll(scrollLeftPx).toBe(0);

      // The new tab stop must not have moved the page itself: wide content
      // scrolls inside its own container, the body never scrolls horizontally.
      await expect
        .poll(() =>
          page.evaluate(() =>
            Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
          ),
        )
        .toBeLessThanOrEqual(0);

      // DoD 3: #704's roving-tabindex contract on the rig tabs is undisturbed
      // — exactly one tab at 0, the rest at -1. Polled as a JSON string so a
      // failure prints the whole array; an EMPTY array (no tabs rendered at
      // all) fails this match rather than passing vacuously.
      await expect
        .poll(() =>
          page.evaluate(() =>
            JSON.stringify(
              Array.from(document.querySelectorAll('.rig-tabs [role="tab"]')).map((b) =>
                b.getAttribute('tabindex'),
              ),
            ),
          ),
        )
        .toMatch(/^\[("-1",)*"0"(,"-1")*\]$/);
    } finally {
      server.kill();
    }
  });
}

// #762 (PR #798 review, Minor 1): the safety-depth field's label has no
// natural break point in German ("Sicherheitstiefe") and silently
// OVERFLOWED the narrow `.planner-safety-depth` column at tablet-landscape
// width instead of wrapping — `boundingBox()` cannot see this (#299's
// lesson: it returns the border box, never overflow), so the assertion has
// to be `scrollWidth <= clientWidth` on the label itself, exactly as #299's
// tab-strip guard above does for the same reason. Fixed with
// `overflow-wrap: break-word` on `.sc-field label` (app.css), mirroring
// `.depth-legend-body p`'s own German-compound-noun fix in this same file.
// tabletLandscape (1180x820) is the one STANDARD_VIEWPORTS entry that
// reaches the narrow ~112.8px `.planner-safety-depth` column
// (`.planner-compact-row`'s `minmax(7rem, 10rem)` second track) — the issue's
// own measurement notes 390x844 (phonePortrait) is STILL two-column here and
// lands in a wider ~160px regime instead, so this guard is scoped to the one
// viewport that actually reaches the failure, not swept across all of them.
function probeSafetyDepthLabelOverflow(page: Page): Promise<string> {
  return page.evaluate(() => {
    const field = document.querySelector('.planner-safety-depth');
    if (!field) return 'no .planner-safety-depth in the DOM at all';
    const label = field.querySelector('label');
    if (!label) return '.planner-safety-depth has no <label>';
    const el = label as HTMLElement;
    if (el.scrollWidth > el.clientWidth) {
      return (
        `.planner-safety-depth label overflows: scrollWidth ${el.scrollWidth} > ` +
        `clientWidth ${el.clientWidth} (text: "${el.textContent}")`
      );
    }
    return 'ok';
  });
}

test('#762: the safety-depth field label does not overflow its column at tablet landscape, in either language', async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    for (const lang of ['de', 'en'] as const) {
      const context = await browser.newContext();
      await context.addInitScript((l) => {
        window.localStorage.setItem('sc-lang', l);
      }, lang);
      const page = await context.newPage();
      try {
        await page.setViewportSize(STANDARD_VIEWPORTS.tabletLandscape);
        await page.goto(server.url);
        await mapReady(page);
        await expect
          .poll(() => probeSafetyDepthLabelOverflow(page), {
            timeout: 10_000,
            message: `tabletLandscape (${STANDARD_VIEWPORTS.tabletLandscape.width}x${STANDARD_VIEWPORTS.tabletLandscape.height}) / ${lang}`,
          })
          .toBe('ok');
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});

// #871: the SW-ready/update toast (`.reload-prompt`, ReloadPrompt.tsx) is
// TRANSIENT chrome — but before this fix, its height counted toward the SAME
// `.banner-area` measurement `DataLayers.tsx`'s depth-legend reachability
// gate and this file's own narrow-layout banner-clearance rule both derive
// from, so the toast ALONE (no other banner, zero user action) could push
// the collapsed-legend budget under `LEGEND_COLLAPSED_HEIGHT_PX` and set
// `hidden` on the whole `<details class="depth-legend">` — #597's safety
// caveat included — taking it out of the accessibility tree entirely on a
// routine cold load. #909 (four failed static-placement attempts, retained
// on branch `fix/toast-hides-depth-caveat`) is why this guard exercises the
// FULL shared viewport matrix rather than one repro viewport: no fixed
// `top`/`bottom` value clears every viewport, so a narrower guard could pass
// while a regression reopens the defect at a viewport it does not cover.
//
// TWO measurement traps this guard is built to avoid (both cost real #908/
// #909 attempts, per that issue's own writeup): (1) the toast is ONE-SHOT
// per service-worker registration, so a `page`/context REUSED across rows
// shows it only on the first row and every later row would silently read as
// "passing" with nothing under test — hence a fresh `browser.newContext()`
// per row, never the shared per-test `page` fixture. (2) `.focus()`/
// `document.activeElement` proves only keyboard reachability, never pointer
// hit-testing — this guard reads the `hidden` IDL property directly instead
// (the exact mechanism `DataLayers.tsx` sets), which is what actually
// controls accessibility-tree membership.
// `DataLayers.tsx`'s reachability gate recomputes on a `ResizeObserver`
// callback (async, one or more frames after `.banner-area`'s box changes) —
// a single read taken right after the toast becomes DOM-visible can win
// the race and read the PRE-recompute value, exactly the "frozen geometry"
// class CLAUDE.md's E2E-determinism rule warns about, just in the opposite
// direction from the usual case (a too-EARLY read here, not a stale one).
// Poll until three consecutive reads agree, mirroring `labels.spec.ts`'s
// own settle pattern for a MapLibre placement throttle — a different
// producer, the same "async recompute after a resize" shape.
async function settledLegendHidden(
  page: Page,
  legend: Locator,
): Promise<boolean> {
  let last: boolean | null = null;
  let streak = 0;
  for (let i = 0; i < 30; i += 1) {
    const current = await legend.evaluate(
      (el) => (el as HTMLDetailsElement).hidden,
    );
    if (current === last) {
      streak += 1;
      if (streak >= 3) return current;
    } else {
      streak = 1;
      last = current;
    }
    await page.waitForTimeout(100);
  }
  if (last === null) throw new Error("settledLegendHidden: never read a value");
  return last;
}

test("#871: the SW toast alone never hides the depth legend, across the shared viewport matrix (no plan)", async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    const viewports: Record<string, Viewport> = {
      ...STANDARD_VIEWPORTS,
      ...EDGE_VIEWPORTS,
    };
    for (const [label, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        // #832: this test creates its OWN page via browser.newContext()/
        // context.newPage() AFTER startPreview() has already returned, so
        // the shared path inside startPreview(page) never reaches it —
        // required here specifically, per helpers.ts's own doc comment,
        // because the surface under test is EXACTLY a stale-SW hazard: the
        // toast is one-shot per service-worker registration, so a foreign
        // or stale registration on this origin is the one thing that could
        // make a fresh-context sweep report a false OK.
        await assertCleanServiceWorkerState(page);
        await page.goto(server.url);
        await mapReady(page);

        const legend = page.locator("details.depth-legend");
        await page
          .locator(".reload-prompt")
          .waitFor({ state: "visible", timeout: 15_000 });
        const hiddenWithToast = await settledLegendHidden(page, legend);

        await page
          .locator(".reload-prompt .banner-dismiss")
          .click({ timeout: 5_000 });
        await expect(page.locator(".banner-area .banner")).toHaveCount(0);
        const hiddenWithoutToast = await settledLegendHidden(page, legend);

        // The load-bearing claim: the toast ALONE must never flip `hidden`
        // from reachable (false, no banner at all) to removed-from-the-
        // accessibility-tree (true) — #871's own repro. A viewport that is
        // ALREADY hidden with no banner (the unrelated short-landscape/
        // short-viewport gate, #598) stays out of scope for this assertion
        // either way — this only forbids the toast being what FLIPS it.
        expect(
          hiddenWithToast === true && hiddenWithoutToast === false,
          `${label} (${viewport.width}x${viewport.height}): hidden flipped true only because the toast was ` +
            `up (withToast=${hiddenWithToast}, withoutToast=${hiddenWithoutToast})`,
        ).toBe(false);
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});

// #871 residual guard (#909's "fourth victim"): with a PLAN loaded,
// `.depth-legend` itself is unmounted (#813 — folded into `.route-legend`
// instead), so the no-plan guard above is structurally blind to this whole
// state — #909's own writeup found the fourth victim, `.route-layer-controls`
// at 740x360, only because a REVIEW happened to cover that one size; the
// issue's own eight-viewport table never included a plan-loaded row at all.
// Excludes STANDARD_VIEWPORTS' desktop4k/desktopHd/tabletLandscape: at
// >=1024px `.banner-area` becomes a `position: static` grid item (this
// file's own SINGLE_BANNER_VIEWPORTS comment) and cannot overlap map chrome
// by construction. `tabletPortrait` sits on the narrow side of that
// breakpoint and is included.
test("#871: the SW toast does not intercept .route-layer-controls with a plan loaded", async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    const viewports: Record<string, Viewport> = {
      tabletPortrait: STANDARD_VIEWPORTS.tabletPortrait,
      phonePortrait: STANDARD_VIEWPORTS.phonePortrait,
      ...EDGE_VIEWPORTS,
    };
    for (const [label, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        // #832: see the twin comment in the no-plan guard above — this
        // test creates its own page after startPreview() returned, so it
        // is not reached by that function's own `page` parameter.
        await assertCleanServiceWorkerState(page);
        await page.goto(
          `${server.url}?windFixture=test-fixtures/wind-sw12.json`,
        );
        await mapReady(page);
        await page
          .locator(".reload-prompt")
          .waitFor({ state: "visible", timeout: 15_000 });

        await page.getByRole("tab", { name: "Planen" }).click();
        const originSection = page.getByRole("region", { name: "Start" });
        await originSection.getByRole("combobox").fill("Langballigau");
        await expect(originSection.getByRole("option")).toHaveCount(1);
        await originSection.getByRole("option").first().click();

        const destSection = page.getByRole("region", { name: "Ziel" });
        await destSection.getByRole("combobox").fill("Sønderborg");
        await expect(destSection.getByRole("option")).toHaveCount(1);
        await destSection.getByRole("option").first().click();

        const planButton = page.getByRole("button", { name: "Route planen" });
        await planButton.click();
        await expect(planButton).toBeEnabled({ timeout: 60_000 });

        const controls = page.locator(".route-layer-controls");
        await expect(controls).toBeVisible();

        // The toast is dismissable and one-shot; if it self-cleared before
        // planning finished (slow CI, or a rare early SW timing), there is
        // nothing left to probe for this row — that is a pass by vacuity,
        // not a claim this row was exercised, so it is logged rather than
        // silently treated the same as a genuine clear result.
        if (!(await page.locator(".reload-prompt").isVisible())) {
          console.log(
            `${label}: SW toast already dismissed before planning finished — row not exercised`,
          );
          continue;
        }

        // #909's own finding: the toast's overlap band can land on any PART
        // of a cluster depending on viewport — sample the top/middle/bottom
        // of the box, not just its centre (CLAUDE.md's "match the probe's
        // geometry to the defect's" rule). Asserts OCCLUDER IDENTITY, not a
        // bare negative — per the #871 brief, a residual here must name
        // WHICH element intercepted, never collapse to `.not.toBe('ok')`.
        //
        // No known residual here, at ANY viewport in this matrix — unlike
        // the vertical `--sc-toast-top` anchor, which DOES have one (the
        // compass button, MEASURED and pinned by this file's own `#909`
        // guard below, not this one). The toast's `--sc-toast-right`
        // clears `.route-layer-controls` HORIZONTALLY
        // whenever it exists, which removes the 2-D overlap outright rather
        // than trading it off against something else. Confirmed empirically
        // at shortLandscape844 (844x390) and shortLandscape740 (740x360) —
        // #909's own "fourth victim" repro sizes, and the two rows that DID
        // fail here before the horizontal clearance was added — via
        // `compass.spec.ts`'s pre-existing `#208 "Major 3"` guard, which
        // checks the identical cluster/viewport combination independently.
        await expect
          .poll(
            async () => {
              const b = await controls.boundingBox();
              if (!b) return "no box";
              const ys = [b.y + 4, b.y + b.height / 2, b.y + b.height - 4];
              for (const y of ys) {
                const hit = await elementDescriptionAt(
                  page,
                  b.x + b.width / 2,
                  y,
                );
                if (hit.includes("reload-prompt")) {
                  return `blocked by toast at (${Math.round(b.x + b.width / 2)},${Math.round(y)}): ${hit}`;
                }
              }
              return "clear";
            },
            {
              timeout: 10_000,
              message: `${label} (${viewport.width}x${viewport.height})`,
            },
          )
          .toBe("clear");
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});

// #909 (#871's own "residual, not eliminated" line, ReloadPrompt.tsx's
// `useToastAnchor` comment): the guard above covers `.route-layer-controls`
// (cleared HORIZONTALLY, a DIFFERENT cluster, top-RIGHT, plan-gated) — it
// says nothing about `.map-stack-tl` (top-LEFT, no plan required) or its two
// interactive members, the compass button and the depth-ramp checkbox
// ("Wassertiefen"). `compass.spec.ts` and `datalayers.spec.ts` both DISMISS
// `.reload-prompt` (`.reload-prompt .banner-dismiss`) before every hit-test
// they run, so the toast-up scenario for THESE two controls was excluded
// from coverage by construction — until now.
//
// MEASURED live (real Chromium, standalone `vite preview`, 2026-09-04, no
// plan) at BOTH viewports below — the two `EDGE_VIEWPORTS` members #909's
// own table already names as compass-blocked, `deepPortrait320` (320x568)
// and `wrapForcing280` (280x568): with the toast up, the depth checkbox
// stays fully CLEAR — box `{x:20,y:67,w:13,h:40}` sits entirely above the
// toast's own top edge (`y≈187.6`), 0px² overlap, and a genuine
// `locator.click({trial:true})` succeeds. The compass button's BOTTOM ~34
// of its 44px height is covered instead — box
// `{x:8,y:177.6,w:44,h:44}` vs. toast box `{x:0,y:187.6,w:<viewport>,h:60}`,
// overlap 44×33.98≈1495px² — and a real `locator.click({trial:true})` at
// the button's own default (centre) point TIMES OUT: a genuine interactive
// block, not just a passive visual overlap. Identical at both viewports
// (only viewport WIDTH differs between them; this occlusion is purely
// vertical, since the compass sits well inside both toast widths) — this
// guard still runs both, matching #909's own multi-viewport method and this
// file's own #412 rule (no viewport-narrowed guard here either).
//
// Mutation-checked (2026-09-04): disabling `useToastAnchor`'s live
// measurement (forcing the CSS `var(--sc-toast-top, 3rem)` fallback) FLIPS
// which control is hit — compass becomes fully CLEAR (0px² overlap) while
// the depth checkbox becomes FULLY blocked (520px², its whole box) — so
// this guard reds on EITHER assertion below if the live anchor regresses,
// not just one; a static top value cannot satisfy both at once (#909's own
// finding, one level lower).
//
// Asserts OCCLUDER IDENTITY, never a bare negative or boolean predicate
// (CLAUDE.md's own rule, and this file's `#871` guard above): `hitState`
// reports 'clear' when the hit lands inside the target's own subtree,
// `blocked by toast: ...` naming the actual occluding element when it
// lands inside `.reload-prompt`'s subtree (tolerant of which exact child —
// `.banner`/`.banner-message` — the point happens to land on, since that
// sub-element boundary is a copy-length/flex-layout detail, not the thing
// under test), and `blocked by UNEXPECTED occluder: ...` for anything else
// — so a regression that swaps in some other blocker entirely (e.g. a
// future `.app-tabs` collision, #909's own "fifth victim" shape) is named
// rather than silently misread as "clear".
function hitState(target: Locator, toastSelector: string): Promise<string> {
  return target.evaluate((el, sel) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const top = document.elementFromPoint(x, y);
    const describe = (e: Element) =>
      `${e.tagName}.${Array.from(e.classList).join(".") || "(no class)"}`;
    if (!top) return "(none)";
    if (el === top || el.contains(top)) return "clear";
    const toast = document.querySelector(sel);
    if (toast && (toast === top || toast.contains(top))) {
      return `blocked by toast: ${describe(top)}`;
    }
    return `blocked by UNEXPECTED occluder: ${describe(top)}`;
  }, toastSelector);
}

test("#909: with the SW toast up, .map-stack-tl's depth checkbox stays clear and its compass stays known-blocked", async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    const viewports: Record<string, Viewport> = {
      deepPortrait320: EDGE_VIEWPORTS.deepPortrait320,
      wrapForcing280: EDGE_VIEWPORTS.wrapForcing280,
    };
    for (const [label, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        // #832: fresh context/page created AFTER startPreview() returned —
        // same reason as the `#871` guards above (a stale/foreign SW
        // registration on this origin is exactly the hazard under test:
        // the toast is one-shot per registration).
        await assertCleanServiceWorkerState(page);
        await page.goto(server.url);
        await mapReady(page);
        await page
          .locator(".reload-prompt")
          .waitFor({ state: "visible", timeout: 15_000 });

        const compass = page.locator(".compass-btn");
        const depthCheckbox = page.getByRole("checkbox", {
          name: "Wassertiefen",
        });
        const msg = `${label} (${viewport.width}x${viewport.height})`;

        // Geometry is RE-READ inside `hitState` on every poll tick (never
        // frozen from a single pre-settle read) — this file's own #412 rule.
        await expect
          .poll(() => hitState(depthCheckbox, ".reload-prompt"), {
            timeout: 10_000,
            message: `${msg}: depth checkbox`,
          })
          .toBe("clear");

        // KNOWN residual — pinned, not silently accepted. A future change
        // that makes this WORSE (the checkbox above also stops being
        // 'clear') or BETTER (this stops matching) must touch this
        // assertion deliberately, never slip past a guard that only ever
        // checked "not visible".
        await expect
          .poll(() => hitState(compass, ".reload-prompt"), {
            timeout: 10_000,
            message: `${msg}: compass`,
          })
          .toMatch(/^blocked by toast: /);
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});

// #807: `.ais-status` (the AIS connection chip, Live tab only, Tier 2 — see
// the tier-order comment above .app-header) had NO `max-width`, so PR #806's
// longer `ais.status.off` EN string (43 chars, up from 30) wrapped to a
// THIRD line at <=320px — deepening its already-documented #208 "R2-2"/
// "R3-2" same-tier collision with `.map-stack-tl`/`.route-layer-controls`.
// Fixed in app.css with `width: max-content` + a `max-width` cap (that
// rule's own #807 comment carries the mechanism and why the cap value is
// safe at wide viewports too). This is NEW coverage, not a strengthened
// existing guard — `grep -rn 'ais-status|aisStatus' app/e2e/*.spec.ts`
// returned nothing before this test (see the PR's own report).
//
// Geometry is RE-SAMPLED inside each poll callback (never captured once and
// asserted against a frozen value — the #412/#422 stale-geometry class this
// repo has already paid for twice), and every assertion is on a NUMERIC
// VALUE, never a collapsed boolean, so a CI failure reports the actual
// received height/overflow rather than an inscrutable timeout.
const AIS_CHIP_VIEWPORTS = {
  wrapForcing280: EDGE_VIEWPORTS.wrapForcing280,
  deepPortrait320: EDGE_VIEWPORTS.deepPortrait320,
} as const;

// Measured live (#807 PR report, real Chromium): a genuinely two-line chip
// renders ~34.6px tall at both 280/320px in both languages; the pre-fix
// THREE-line wrap measured ~48.2px (issue #807's own table). 42px sits
// strictly between the two — the two-vs-three-line discriminator, not an
// arbitrary round number. 15px sits strictly below the one-line height
// (~19.6px) so a hidden/missing chip (height 0, or -1 from a failed probe)
// cannot silently satisfy the upper bound alone.
const AIS_CHIP_MAX_TWO_LINE_HEIGHT_PX = 42;
const AIS_CHIP_MIN_RENDERED_HEIGHT_PX = 15;

function probeAisChipGeometry(
  page: Page,
): Promise<{
  height: number;
  left: number;
  right: number;
  viewportWidth: number;
} | null> {
  return page.evaluate(() => {
    const el = document.querySelector(".ais-status");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      height: r.height,
      left: r.left,
      right: r.right,
      viewportWidth: window.innerWidth,
    };
  });
}

test("#807: the AIS status chip never wraps past two lines at 280/320px, in either language, and never crosses the viewport edge", async ({
  browser,
}) => {
  const server = await startPreview();
  try {
    for (const lang of ["de", "en"] as const) {
      const context = await browser.newContext();
      await context.addInitScript((l) => {
        window.localStorage.setItem("sc-lang", l);
      }, lang);
      const page = await context.newPage();
      try {
        for (const [name, vp] of Object.entries(AIS_CHIP_VIEWPORTS)) {
          await page.setViewportSize(vp);
          await page.goto(server.url);
          await mapReady(page);
          await page.getByRole("tab", { name: "Live" }).click();
          const label = `${name} (${vp.width}x${vp.height}) / ${lang}`;

          await expect
            .poll(
              async () => (await probeAisChipGeometry(page))?.height ?? -1,
              {
                message: `${label}: .ais-status height (px) must exceed a one-line render`,
              },
            )
            .toBeGreaterThan(AIS_CHIP_MIN_RENDERED_HEIGHT_PX);

          await expect
            .poll(
              async () =>
                (await probeAisChipGeometry(page))?.height ??
                Number.POSITIVE_INFINITY,
              {
                message: `${label}: .ais-status height (px) must not exceed a two-line render`,
              },
            )
            .toBeLessThan(AIS_CHIP_MAX_TWO_LINE_HEIGHT_PX);

          await expect
            .poll(
              async () => {
                const g = await probeAisChipGeometry(page);
                if (!g) return Number.POSITIVE_INFINITY;
                return (
                  Math.max(0, -g.left) + Math.max(0, g.right - g.viewportWidth)
                );
              },
              {
                message: `${label}: .ais-status overflow beyond the viewport edge (px)`,
              },
            )
            .toBe(0);
        }
      } finally {
        await context.close();
      }
    }
  } finally {
    server.kill();
  }
});
