import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #38/#39 always-mounted map data layers. What this asserts (and why it's
// not theater): the depth toggle must exist BEFORE any plan (the whole point
// of the DataLayers host being a sibling of the plan-gated RouteLayer), and
// checking it must actually change the rendered map — a raster that never
// draws would pass any DOM-only assertion. Harbor markers/labels are canvas
// pixels with no DOM handle, so their look is covered by the manual
// real-browser pass instead of a brittle pixel-match here.

// #253 fix-up: this spec's `networkidle` wait was deleted with no
// replacement when maplibre-gl 6 stopped producing a `requestfinished` Playwright
// counts for its module-worker fetch. Without SOME readiness gate,
// `settledCanvas` below can settle on a PRE-TILE blank baseline (two
// byte-equal blank frames 250ms apart is MORE likely, not less, on a slow CI
// runner) — after which every `.equals(baseline)).toBe(false)` assertion
// would pass on the first late tile paint, never on the raster actually
// toggling. `compass.spec.ts` hit the identical problem and replaced
// `networkidle` with `mapReady()`, gating on `map.loaded()` via a
// React-fiber-read map handle (this spec runs BEFORE any plan exists, so
// RouteLayer's `window.__scMap` test hook isn't set yet — the fiber read is
// the only handle available pre-plan). Duplicated here rather than imported:
// `compass.spec.ts` doesn't export it and helpers.ts was out of this
// change's file scope, so this is a copy, not a shared helper — worth
// promoting to `helpers.ts` in a follow-up so the two copies can't drift.
async function installMapHandle(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('.maplibregl-map');
    if (!el) return false;
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    if (!key) return false;
    let f = (el as unknown as Record<string, { memoizedState?: unknown; return?: unknown }>)[key];
    while (f) {
      let h = f.memoizedState as { memoizedState?: unknown; next?: unknown } | undefined;
      let guard = 0;
      while (h && guard++ < 60) {
        const v = h.memoizedState as { getBearing?: unknown; project?: unknown } | undefined;
        if (v && typeof v.getBearing === 'function' && typeof v.project === 'function') {
          (window as unknown as Record<string, unknown>).__scE2eMap = v;
          return true;
        }
        h = h.next as typeof h;
      }
      f = f.return as typeof f;
    }
    return false;
  });
}

type ReadyMap = {
  loaded: () => boolean;
  getStyle: () => { sources: Record<string, unknown> };
  isSourceLoaded: (id: string) => boolean;
};

async function mapReadyState(page: Page): Promise<string> {
  if (!(await installMapHandle(page))) return 'no-map-handle';
  return page.evaluate(() => {
    const map = (window as unknown as { __scE2eMap?: ReadyMap }).__scE2eMap;
    if (!map) return 'handle-lost';
    if (!map.loaded()) {
      const pending = Object.keys(map.getStyle().sources).filter((id) => !map.isSourceLoaded(id));
      return `not-loaded (pending sources: ${pending.join(', ') || 'none — style still parsing'})`;
    }
    return 'loaded';
  });
}

/** Gate a spec on a map that has actually rendered, reporting WHY if it hasn't. */
async function mapReady(page: Page): Promise<void> {
  await expect.poll(() => mapReadyState(page), { timeout: 60_000 }).toBe('loaded');
}

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

test('depth toggle is available pre-plan, defaults ON (#63), flips the rendered map, and an explicit off persists across reload', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);

    // Always-mounted cluster present with NO plan; the plan-gated
    // route-layer cluster (wind barbs) must not be.
    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    // #63: a fresh profile (Playwright context = clean localStorage) sees the
    // depth overlay with zero clicks.
    await expect(depthToggle).toBeChecked();
    await expect(page.locator('.route-layer-controls')).toHaveCount(0);

    const canvas = page.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible();
    await mapReady(page);

    // Baseline: the settled default frame (overlay ON). Because it's stable,
    // a later byte difference against it is a real rendering delta (the
    // raster going away), not transient tile/label noise — which is what lets
    // the byte compares below stand in for a pixel diff without a PNG decoder
    // in the e2e deps.
    const overlayOn = await settledCanvas(page, canvas);

    // OFF must remove the raster. expect.poll (house style, cf. layout.spec)
    // waits for the redraw instead of racing it with a one-shot compare.
    await depthToggle.uncheck();
    await expect(depthToggle).not.toBeChecked();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(overlayOn), {
        message: 'toggling depth OFF must remove the raster',
        timeout: 30_000,
      })
      .toBe(false);

    // #63 persistence: the explicit OFF must survive a reload (same origin,
    // same localStorage). Reload rather than a new context — a new context
    // would be a fresh profile and legitimately reset to ON.
    await page.reload();
    await expect(depthToggle).toBeVisible();
    await expect(depthToggle).not.toBeChecked();
    await mapReady(page);

    // ON must draw the raster again. Compare against the settled OFF frame
    // (not byte-equality with `overlayOn` — tile/label rendering isn't
    // guaranteed bit-stable across frames, so `on === overlayOn` is unsafe).
    const overlayOff = await settledCanvas(page, canvas);
    await depthToggle.check();
    await expect(depthToggle).toBeChecked();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(overlayOff), {
        message: 'toggling depth ON must change the rendered map',
        timeout: 30_000,
      })
      .toBe(false);
  } finally {
    server.kill();
  }
});
