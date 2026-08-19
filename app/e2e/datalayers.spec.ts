import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

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
// toggling. `mapReady` (`./helpers`, promoted from three independent copies
// of this gate — see that file's own comment) replaces it, gating on
// `map.loaded()` via a React-fiber-read map handle (this spec runs BEFORE
// any plan exists, so RouteLayer's `window.__scMap` test hook isn't set yet
// — the fiber read is the only handle available pre-plan).

// Polls until the canvas stops changing frame-to-frame (two consecutive
// byte-equal screenshots), then returns that settled frame. This replaces
// fixed waitForTimeout()s that fail both ways: too short → false fail (compare
// before the frame finished), and fire mid-render → false pass (a still-
// settling baseline differs from itself). Adaptive — returns as soon as stable,
// so it's usually fast; the attempt cap only guards a genuinely stuck page.
// CI is measurably slower than dev machines (CLAUDE.md: ~2.1x/~2.5x for the
// vitest unit suite, no equivalent Playwright/e2e figure measured), hence
// the generous cap — adaptive polling means it only costs real time when a
// page is genuinely slow, never on a normal run.
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

// #492: the sparse hazard-hatch overlay (depthColor.ts's
// buildNavigabilityHatchImageData, DataLayers.tsx's DEPTH_HATCH_LAYER) has
// no real DOM handle either — same rationale as the depth-toggle test above,
// a pixel-readback via whole-canvas byte comparison against the technique
// #492's own issue report used. Two real coordinates (a "near-gate" cell and
// a "comfortably-clear" one) aren't picked here — that would need decoding
// the real committed mask independently in this spec (a duplicated-algorithm
// hazard CLAUDE.md warns against). Instead the GATE itself is varied at ONE
// fixed viewport: 2.2 m (the Salona 45's own minSafetyDepthM — most of the
// visible fjord reads comfortably clear at the CONSERVATIVE basis too) vs
// 10 m (SAFETY_DEPTH_FIELD.max — deep enough that most of this shallow
// coastal fjord reads marginal at that same basis). Because
// depthByteToRgba/buildDepthImageData never depend on safetyDepthM
// (depthColor.ts's HARD DOMAIN RULE, structurally pinned in
// depthColor.test.ts), any frame difference between the two gates is
// attributable to the hatch layer alone, never the absolute ramp
// repainting under it.
test('navigability hatch (#492) reacts to safetyDepthM only while the depth overlay is visible', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await expect(depthToggle).toBeChecked(); // default ON (#63)

    const canvas = page.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible();
    await mapReady(page);

    const safetyDepth = page.getByLabel('Sicherheitstiefe (m)');
    await expect(safetyDepth).toBeVisible();

    // Settle at the boat's own minimum gate first.
    await safetyDepth.fill('2.2');
    await safetyDepth.blur();
    const lowGate = await settledCanvas(page, canvas);

    // POSITIVE (appears): raise the gate to the UI's own maximum. expect.poll
    // against a KNOWN baseline (not settledCanvas's own "two-frames-agree"
    // check) — a debounced rebuild (DataLayers.tsx's
    // DEPTH_HATCH_DEBOUNCE_MS) can plateau at a PRE-rebuild frame for one
    // settledCanvas poll cycle, which a stability check alone could mistake
    // for "settled"; polling against the pre-edit baseline instead cannot
    // false-positive early, since it requires an ACTUAL difference to appear.
    await safetyDepth.fill('10');
    await safetyDepth.blur();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(lowGate), {
        message: 'raising safetyDepthM to the UI max must change the hatch overlay',
        timeout: 30_000,
      })
      .toBe(false);

    // ABSENT (discriminating control): with the depth overlay HIDDEN, the
    // identical gate swing must draw NOTHING — proving the positive result
    // above is specifically the hatch reacting, not some unrelated redraw
    // (tile loading, label placement) merely correlated with editing the
    // field. No expect.poll early-stabilization risk here: with nothing
    // expected to change at all, settledCanvas's "two consecutive frames
    // agree" reading is exactly the right signal in the negative case, since
    // there is no real in-flight change to race against.
    await depthToggle.uncheck();
    await expect(depthToggle).not.toBeChecked();
    const hiddenBaseline = await settledCanvas(page, canvas);
    await safetyDepth.fill('2.2');
    await safetyDepth.blur();
    const hiddenAfterChange = await settledCanvas(page, canvas);
    expect(hiddenAfterChange.equals(hiddenBaseline)).toBe(true);
  } finally {
    server.kill();
  }
});
