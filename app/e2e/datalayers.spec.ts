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

// Polls until the canvas stops changing frame-to-frame (`consecutive`
// byte-equal screenshots in a row — default 1, i.e. two reads agreeing),
// then returns that settled frame. This replaces fixed waitForTimeout()s
// that fail both ways: too short → false fail (compare before the frame
// finished), and fire mid-render → false pass (a still-settling baseline
// differs from itself). Adaptive — returns as soon as stable, so it's
// usually fast; the attempt cap only guards a genuinely stuck page.
// CI is measurably slower than dev machines (CLAUDE.md: ~2.1x/~2.5x for the
// vitest unit suite, no equivalent Playwright/e2e figure measured), hence
// the generous cap — adaptive polling means it only costs real time when a
// page is genuinely slow, never on a normal run.
//
// #492 review m7: `consecutive` exists because a single "two frames agree"
// read can settle on a frame taken BEFORE an async change has landed, not
// only before a genuinely-idle one — e.g. DataLayers.tsx's
// DEPTH_HATCH_DEBOUNCE_MS (300ms) can straddle this function's 250ms poll
// interval, so the DEFAULT `consecutive=1` two-frame read can plateau on a
// PRE-rebuild pair. A caller that needs to prove "no change occurred, even
// accounting for a known async delay of D ms" should pass `consecutive`
// large enough that `consecutive * 250 > D` with margin — same technique
// `labels.spec.ts` already uses for a different async settle (three
// consecutive matches at 400ms there, to exceed a maplibre placement
// throttle).
async function settledCanvas(page: Page, canvas: Locator, consecutive = 1): Promise<Buffer> {
  let prev = await canvas.screenshot();
  let runs = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(prev)) {
      if (++runs >= consecutive) return next;
    } else {
      runs = 0;
    }
    prev = next;
  }
  return prev; // best-effort: never stabilized within the cap
}

// #492 review M2: decode the canvas screenshot (a PNG) IN-PAGE — no PNG
// decoder in this project's dependency tree — and count HATCHED pixels
// directly, rather than merely diffing whole frames. A frame-diff alone
// does NOT discriminate DIRECTION: a fully-INVERTED marginal-cell test
// (hatch deep water, leave shallow water clear) still changes the frame
// just as much as the correct implementation does — MEASURED during
// review, the frame-diff form of this spec stayed green under that
// mutation. HATCH_RGBA's low channel values ([0,0,0,190], depthColor.ts)
// make a <60,<60,<60 near-black test a safe discriminator against every
// STOPS ramp colour (all far brighter) and against the basemap.
//
// CORRECTION to the reviewer-supplied form: the review's own code used
// `fetch(\`data:...\`)`, reasoning "img-src already allows data:, so the
// in-page decode is not blocked" — MEASURED WRONG against this app's real
// CSP (vite.config.ts): a data: fetch is gated by `connect-src` (`'self'
// https://api.open-meteo.com wss://stream.aisstream.io`, no `data:`), not
// `img-src`, and reds with `TypeError: Failed to fetch` under the real
// policy. `img-src` DOES allow `data:` (CLAUDE.md's own CSP bullet), but
// only for an actual IMAGE load — an `<img>` element's `src`, not `fetch`.
// Decoding via `new Image()` + `.decode()` stays on the `img-src` path and
// needs no CSP change (`vite.config.ts` is outside this task's allowlist
// regardless).
async function hatchedPixels(page: Page, shot: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) n++;
    return n;
  }, shot.toString('base64'));
}

// #492 review M8: measures the documented zoom-dependent DEGRADATION
// directly (depthColor.ts's HATCH_PERIOD_CELLS comment carries the full
// table) rather than asserting it only in prose — returns the FRACTION of
// canvas pixels that read as hatched, so a "wide band" reading is a large
// fraction, not merely a nonzero one. Same img-src-not-fetch decode as
// hatchedPixels above (see its comment); kept as a separate function
// rather than refactored into it so that helper's own body, once corrected
// for the CSP issue, stays a single self-contained unit.
async function hatchedFraction(page: Page, shot: Buffer): Promise<number> {
  const [hatched, total] = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) n++;
    return [n, img.naturalWidth * img.naturalHeight];
  }, shot.toString('base64'));
  return hatched / total;
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

// #598: the hazard-hatch legend — reachable with NO plan (same
// always-mounted cluster as the depth toggle above), default-collapsed, and
// carries the #597 caveat once opened. `<details>` HAS a real DOM handle
// (unlike the canvas raster the toggle test above verifies), so this is a
// plain accessibility-tree/text assertion, not a pixel readback.
test('depth-hatch legend (#598) is reachable pre-plan, default-collapsed, and carries the #597 caveat once opened', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);

    // Present with no plan, alongside the depth toggle — same always-mounted
    // cluster, same reason (#598's own maintainer ruling: reachable without
    // an active plan, since the hatch itself has no other opt-in).
    await expect(page.getByRole('checkbox', { name: 'Wassertiefen' })).toBeVisible();
    await expect(page.locator('.route-layer-controls')).toHaveCount(0);

    const summary = page.getByText('Legende', { exact: true });
    await expect(summary).toBeVisible();
    // #598 review follow-up (touch-target round): a control meant to be
    // tapped on a boat, one-handed, in motion. A prior draft shrank this to
    // a 20px row to buy back `.map-stack-tl` height for ScaleBar — MEASURED
    // sub-minimum (WCAG 2.5.8 Target Size, Minimum, requires >=24x24 CSS
    // px) and rejected before shipping. Guard both dimensions explicitly so
    // a future height-budget fix can't silently reintroduce the same
    // trade-off unnoticed.
    await expect
      .poll(async () => {
        const box = await summary.boundingBox();
        return box ? Math.min(box.width, box.height) : 0;
      })
      .toBeGreaterThanOrEqual(24);
    const details = page.locator('details.depth-legend');
    // Default-collapsed per the maintainer ruling — `open` is a real DOM
    // attribute on a native <details>, so this is a structural check, not a
    // CSS-visibility inference.
    await expect(details).not.toHaveAttribute('open');
    await expect(details).toHaveJSProperty('open', false);

    await summary.click();
    await expect(details).toHaveJSProperty('open', true);
    await expect(page.getByText('Schraffur: vorsichtige Lesart')).toBeVisible();
    // The #597 caveat this legend was created to carry — absence of hatching
    // must never read as "clear". PR #625 self-review Major 1: the copy this
    // quotes was corrected (byte 0 renders as ordinary water, never anything
    // land-coloured) — this quote must move in lockstep with dict.de.ts's
    // `map.depth.legend.caveat` or it reds on the very defect it exists to
    // catch (a stale quote can never fail).
    await expect(
      page.getByText(
        'Unvermessenes und trockenfallendes Wasser trägt ebenfalls keine Schraffur und ist durch nichts gekennzeichnet, sieht also aus wie gewöhnliches Wasser.',
      ),
    ).toBeVisible();
    // #598 maintainer ruling: never "shallow water" / "flaches Wasser" — the
    // hatch is a cautious-reading indicator, not a shallow-water one. Scoped
    // to the legend's own container so this can't be tripped by an unrelated
    // occurrence elsewhere on the page (e.g. the no-route error copy).
    await expect(details).not.toContainText('flaches Wasser');
    await expect(details).not.toContainText('Flachwasser');
  } finally {
    server.kill();
  }
});

// #598 review follow-up (touch-target round): a SEPARATE defect from the
// one this whole round set out to fix, found by measuring rather than
// assuming the fix was complete. `.depth-legend` deliberately sets no
// `overflow` on itself so it can extend past `.map-stack-tl`'s own computed
// height unclipped, same as the compass already can (app.css's own
// comment) — harmless for the compass (a small fixed-size control) but this
// copy's full basis paragraph is ~450 characters, which at the legend's
// narrow width wraps into ~30 lines. UNBOUNDED, that measured live at
// ~1150px tall and spilled through the tab strip into the bottom sheet
// (`legend.bottom` 1431px against a 667px viewport) — `.map-stack-tl` is
// Tier 2, that content is lower in the same stacking lineage, so it painted
// OVER it rather than staying behind it. Fixed with a bounded, scrollable
// `max-height` on `.depth-legend-body` (app.css, whose own comment carries
// the full derivation); this pins the fix at the TIGHTEST tested viewport,
// where the available room is smallest.
test('depth-hatch legend (#598), once opened, never overlaps the tab strip at the narrowest tested viewport', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(server.url);
    await mapReady(page);

    await page.getByText('Legende', { exact: true }).click();
    const legend = page.locator('.depth-legend');
    await expect(legend).toHaveJSProperty('open', true);

    const tablist = page.getByRole('tablist');
    await expect(tablist).toBeVisible();

    // Poll the actual overlap AREA (both axes), not a boolean or a
    // Y-axis-only comparison — the latter false-positived at wide layout,
    // where the tab strip lives in a different horizontal column entirely
    // and a Y-only check would wrongly flag it.
    await expect
      .poll(async () => {
        const lb = await legend.boundingBox();
        const tb = await tablist.boundingBox();
        if (!lb || !tb) return -1;
        const overlapX = Math.max(
          0,
          Math.min(lb.x + lb.width, tb.x + tb.width) - Math.max(lb.x, tb.x),
        );
        const overlapY = Math.max(
          0,
          Math.min(lb.y + lb.height, tb.y + tb.height) - Math.max(lb.y, tb.y),
        );
        return overlapX * overlapY;
      })
      .toBe(0);
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
    const lowGateHatched = await hatchedPixels(page, lowGate);

    // POSITIVE (appears), asserting DIRECTION, not just difference (#492
    // review M2): raise the gate to the UI's own maximum and require the
    // HATCHED PIXEL COUNT to strictly increase. A whole-frame diff against
    // `lowGate` would pass under an INVERTED marginal test (hatch deep
    // water, leave shallow water clear) just as readily as under the
    // correct one — MEASURED, see hatchedPixels's own comment — so only a
    // count comparison distinguishes "changed" from "changed correctly".
    // expect.poll against the pixel COUNT (not settledCanvas's own
    // "two-frames-agree" check) for the same reason as before: the 300ms
    // debounce can straddle one settle-poll cycle, and a stability check
    // alone could mistake a pre-rebuild plateau for "settled" — polling the
    // count directly cannot false-positive early, since it requires the
    // count to actually exceed the baseline.
    await safetyDepth.fill('10');
    await safetyDepth.blur();
    await expect
      .poll(async () => hatchedPixels(page, await canvas.screenshot()), {
        message:
          'raising safetyDepthM to the UI max must hatch MORE pixels, not merely change the frame',
        timeout: 30_000,
      })
      .toBeGreaterThan(lowGateHatched);

    // ABSENT (discriminating control): with the depth overlay HIDDEN, the
    // identical gate swing must draw NOTHING — proving the positive result
    // above is specifically the hatch reacting, not some unrelated redraw
    // (tile loading, label placement) merely correlated with editing the
    // field. #492 review m7: the debounced rebuild is STILL scheduled while
    // hidden (DataLayers.tsx never gates the rebuild effect on
    // depthVisible, only the layer's own visibility), so a plain
    // settledCanvas(page, canvas) read here can settle on a frame taken
    // BEFORE that invisible rebuild lands — a real "nothing changed (yet)"
    // and a "nothing changed because the mechanism is broken" would look
    // identical at that sample point. `consecutive=3` (>=750ms > the
    // 300ms debounce, same margin as labels.spec.ts's own async-settle
    // technique) is what actually rules that out.
    await depthToggle.uncheck();
    await expect(depthToggle).not.toBeChecked();
    const hiddenBaseline = await settledCanvas(page, canvas, 3);
    await safetyDepth.fill('2.2');
    await safetyDepth.blur();
    const hiddenAfterChange = await settledCanvas(page, canvas, 3);
    expect(hiddenAfterChange.equals(hiddenBaseline)).toBe(true);
  } finally {
    server.kill();
  }
});

// #492 review M8: at overview zoom (z9, the app's own initial ZOOM —
// MapView.tsx:62) the hatch's on-screen period is sub-pixel (~2.1px, see
// depthColor.ts's HATCH_PERIOD_CELLS comment for the full table) and reads
// as a sparse, high-contrast SPECKLE rather than a visible hatch — MEASURED
// (PR #591 re-review) as a mean 62/max 160 luminance drop on touched
// pixels, not a flat/uniform tint; at close zoom the SAME mask-cell-sized
// period is hundreds of screen pixels, so "sparse hatch" degrades into a
// wide, near-opaque BAND. This measures that degradation directly — at z16 a high
// gate should hatch a LARGE, easily-measurable fraction of the canvas, not
// a sparse pattern — rather than asserting it only in prose. Tracked as
// #599 (screen-space rendering, e.g. a fill-pattern layer, would make the
// on-screen period zoom-invariant) rather than fixed in this change.
//
// LOCATION: the app's own default map centre ([9.9, 54.85], MapView.tsx's
// CENTER) sits over the fjord's main channel, MEASURED against the real
// mask to be mostly >=20 m deep even at the UI's own maximum safetyDepthM
// (10 m) — the first version of this test jumped there and observed a
// hatched fraction of ~0.1%, UNCHANGED between a 2.2 m and a 10 m gate.
// `wackerballig` (public/data/harbors.json) is used instead: its own
// approachNote already documents it as marginal ("Einfahrt versandet...
// für 2,1 m Tiefgang als grenzwertig einstufen" / "treat as marginal for
// 2.1 m"), and a direct sample of the real mask in a ~1.3km box around its
// snap point gives 41% of cells marginal at a 2.2 m gate vs 97% at 10 m —
// a location chosen from MEASUREMENT, not assumed from the harbor's prose
// alone.
test('navigability hatch (#492): at close zoom the pattern degrades to a wide band, not a sparse hatch (M8, tracked as #599)', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeChecked();
    const canvas = page.locator('canvas.maplibregl-canvas');
    await expect(canvas).toBeVisible();
    await mapReady(page);

    const safetyDepth = page.getByLabel('Sicherheitstiefe (m)');
    await safetyDepth.fill('2.2');
    await safetyDepth.blur();

    // Jump straight to z16, centred on wackerballig's own snap point (no
    // animation) via the real map instance — mapReady() has already
    // installed window.__scE2eMap as a side effect.
    await page.evaluate(() => {
      (
        window as unknown as {
          __scE2eMap: { jumpTo: (o: { zoom: number; center: [number, number] }) => void };
        }
      ).__scE2eMap.jumpTo({ zoom: 16, center: [9.872, 54.7604] });
    });
    const lowGate = await settledCanvas(page, canvas);
    const lowFraction = await hatchedFraction(page, lowGate);

    // Threshold (0.15) is MEASURED, not guessed: an earlier draft asserted
    // > 0.5 from the raw mask sample's ~97% marginal-cell estimate at this
    // gate, and the REAL rendered fraction came back 0.254 — because the
    // hatch's 25% stripe/gap DENSITY (HATCH_STRIPE_WIDTH_CELLS /
    // HATCH_PERIOD_CELLS, depthColor.ts) scales UNIFORMLY with zoom, so the
    // COVERAGE FRACTION of a marginal area stays ~constant at any zoom —
    // only the per-stripe on-screen SIZE changes (sub-pixel at z9, hundreds
    // of px at z16). 0.15 leaves margin below the measured 0.254 for
    // land/basemap chrome/run-to-run variance while staying well above
    // anything a near-zero, still-broken mechanism could produce (compare
    // the ~0.001 this test measured at the app's default centre, over the
    // fjord's deep channel, before this location was corrected).
    await safetyDepth.fill('10');
    await safetyDepth.blur();
    await expect
      .poll(async () => hatchedFraction(page, await canvas.screenshot()), {
        message:
          'raising safetyDepthM at close zoom must hatch a LARGE, measurable fraction of the canvas',
        timeout: 30_000,
      })
      .toBeGreaterThan(0.15);
    const highGate = await settledCanvas(page, canvas);
    const highFraction = await hatchedFraction(page, highGate);
    expect(highFraction).toBeGreaterThan(lowFraction);
  } finally {
    server.kill();
  }
});
