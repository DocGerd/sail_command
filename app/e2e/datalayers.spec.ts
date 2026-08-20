import { test, expect, type Locator, type Page } from '@playwright/test';
import { startPreview, mapReady, EDGE_VIEWPORTS } from './helpers';

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

// Returns the FRACTION of canvas pixels that read as hatched.
//
// #599 CORRECTION: this was introduced (as #492 review M8) claiming to
// measure "the documented zoom-dependent DEGRADATION directly", so that a
// "wide band" reading would be a large fraction. It never could: the
// coverage fraction is invariant to the stripe period — the duty cycle is
// what sets it, and that was constant across zoom — so this number cannot
// discriminate a fine hatch from a wide band. The stripe-width measurement
// that CAN is hatchRunLengthsPx below; this one's real job is establishing
// that the hatch renders at all over a marginal area. Same img-src-not-fetch decode as
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
    // trade-off unnoticed. At THIS viewport (standard default, plenty of
    // room, no banner) the legend is always reachable, so a plain
    // `boundingBox()` poll is sufficient here — the EDGE_VIEWPORTS x
    // language sweep below is what has to distinguish "properly hidden"
    // from "clipped but still occupying space", since only the narrow/short
    // edge cases can produce that state.
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

// #598 review round 3, Major 2 + Minor 1: the touch-target poll above only
// exercises ONE viewport, where the legend is always reachable — it cannot
// see the class of bug round 3 actually found (a CSS clip that fires on the
// COLLAPSED row too, with no banner, at exactly the short-landscape edge
// viewports). Asserting on `.map-stack-tl`'s or ScaleBar's geometry (what
// #231/#441 already cover) is structurally blind to this: those pass
// whenever the legend contributes zero measured height to the cluster,
// which is true BOTH when it is correctly hidden AND when it is clipped to
// zero height while still occupying a DOM slot — a 28/28 green run on the
// round-2 code proved exactly that (see this file's own history). This test
// asserts on the LEGEND ITSELF, across every EDGE_VIEWPORTS entry and both
// languages, and requires one of exactly two valid states — never a third:
//
//   (a) PROPERLY UNREACHABLE — the native `hidden` attribute is set, so the
//       element is invisible per Playwright's actionability check AND
//       structurally refuses focus (browsers do not focus a descendant of a
//       `display: none` subtree). This is what closes Minor 1: a clipped
//       `overflow: hidden` `<summary>` at 0 height stayed FOCUSABLE
//       (`document.activeElement === summary` measured `true` after
//       `.focus()`), a genuine keyboard trap `hidden` cannot reproduce.
//   (b) REACHABLE — the real box is >=24 CSS px on both axes (WCAG 2.5.8)
//       and does not overlap the tab strip, the one chrome element every
//       one of these short/narrow viewports sits closest to.
//
// MUTATION-CHECKED both ways against the current code (not merely a
// hypothetical): forcing `.depth-legend > summary { min-height: 20px }`
// reds this test at every reachable viewport (20 < 24); forcing
// `legendHidden` to stay `false` unconditionally (simulating round-2's
// shipped bug, where nothing ever hid the control) reds it at
// `shortLandscape740`/`shortLandscape844`/`shortLandscape932` with a
// clipped, still-technically-visible-but-sub-24px box — both probes run and
// reverted before landing this test; see the PR self-review thread for the
// raw numbers.
test('depth-hatch legend (#598) is either reachable or properly unreachable, never a third state, across EDGE_VIEWPORTS x language', async ({
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
        for (const [name, vp] of Object.entries(EDGE_VIEWPORTS)) {
          await page.setViewportSize(vp);
          await page.goto(server.url);
          await mapReady(page);

          const details = page.locator('details.depth-legend');
          const summary = details.locator('summary');
          const isHiddenAttr = await details.evaluate((el) => (el as HTMLDetailsElement).hidden);
          const label = `${name} (${vp.width}x${vp.height}) / ${lang}`;

          if (isHiddenAttr) {
            await expect(summary, `${label}: hidden legend must not be visible`).toBeHidden();
            await summary.evaluate((el) => (el as HTMLElement).focus());
            const focused = await summary.evaluate((el) => document.activeElement === el);
            expect(focused, `${label}: hidden legend must refuse focus (Minor 1)`).toBe(false);
          } else {
            const box = await summary.boundingBox();
            expect(box, `${label}: not hidden but has no box at all`).not.toBeNull();
            if (!box) continue; // unreachable after the assertion above; narrows the type
            expect(
              Math.min(box.width, box.height),
              `${label}: sub-target box ${JSON.stringify(box)} (Major 2)`,
            ).toBeGreaterThanOrEqual(24);

            const tablist = page.getByRole('tablist');
            const tb = await tablist.boundingBox();
            if (tb) {
              const overlapX = Math.max(
                0,
                Math.min(box.x + box.width, tb.x + tb.width) - Math.max(box.x, tb.x),
              );
              const overlapY = Math.max(
                0,
                Math.min(box.y + box.height, tb.y + tb.height) - Math.max(box.y, tb.y),
              );
              expect(overlapX * overlapY, `${label}: legend overlaps tab strip`).toBe(0);
            }
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
// where the available room is smallest. STILL the mechanism for the OPEN
// body specifically — round 3 (Major 1) removed only `.depth-legend`'s OWN
// outer clip, replacing it with the JS reachability gate that decides
// whether the COLLAPSED control is offered at all; see this test's own
// banner-dismiss step for why that gate is exercised here too.
test('depth-hatch legend (#598), once opened, never overlaps the tab strip at the narrowest tested viewport', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(server.url);
    await mapReady(page);

    // #598 review round 3: dismiss the incidental SW "offline ready" toast
    // BEFORE asserting reachability — same idiom as layout.spec.ts's own
    // `.reload-prompt .banner-dismiss` clicks. Not incidental here the way
    // it is there: with a real banner up, the JS reachability gate this
    // round shipped (DataLayers.tsx's `useLayoutEffect`) correctly computes
    // a sub-44px budget at this exact viewport (375x667, banner ~48px tall)
    // and HIDES the control outright — MEASURED live, `legendHidden` true,
    // `.depth-legend` carries `hidden`, and the click below would time out
    // waiting on an invisible element. That is the control doing its job,
    // not a bug; this test's own purpose is narrower — proving the OPEN
    // body stays bounded once the control IS reachable, so it needs the
    // steady-state (no banner) case, the same way the test would look on
    // any load past the toast's lifetime.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

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

// Measures the on-screen width of individual hatch STRIPES, isolating them
// from everything else on the canvas by DIFFERENCING TWO GATES: the absolute
// depth ramp is gate-blind by depthColor.ts's HARD DOMAIN RULE, so every
// pixel that darkens between a low and a high safetyDepthM is hatch and only
// hatch. Basemap, labels and chrome cancel exactly.
//
// Returns the run lengths (in screen px) of horizontally-consecutive
// newly-hatched pixels. Runs touching a row edge are DISCARDED — they are
// truncated by the viewport, not by the pattern. Reported as a HIGH
// PERCENTILE rather than a mean or median: a run can be cut short where a
// marginal region ends, but it can never exceed the stripe width (gaps
// separate stripes by construction), so the upper tail estimates the true
// on-screen stripe width from BELOW and never overestimates it.
//
// Horizontal scanning is the right axis even though the stripes run at 45deg:
// the pattern is `(outRow + col) % period < stripe`, so at a FIXED row it has
// period `period` and on-run `stripe` in COLUMNS exactly — the diagonal
// costs nothing here.
async function hatchRunLengthsPx(page: Page, low: Buffer, high: Buffer): Promise<number[]> {
  return page.evaluate(
    async ([a64, b64]) => {
      const decode = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0);
        return {
          d: g.getImageData(0, 0, img.naturalWidth, img.naturalHeight).data,
          w: img.naturalWidth,
          h: img.naturalHeight,
        };
      };
      const A = await decode(a64);
      const B = await decode(b64);
      if (A.w !== B.w || A.h !== B.h) throw new Error('frame size changed between gates');
      const lum = (d: Uint8ClampedArray, i: number) =>
        0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // 40: HATCH_RGBA is [0,0,0,190], so a fully-covered pixel drops
      // luminance by >100 even over the darkest STOPS colour; 40 keeps
      // partially-covered edge pixels and minified (mipmapped) overview-zoom
      // pixels while staying far above frame noise.
      const DROP = 40;
      const runs: number[] = [];
      for (let y = 0; y < A.h; y++) {
        let run = 0;
        for (let x = 0; x < A.w; x++) {
          const i = (y * A.w + x) * 4;
          if (lum(A.d, i) - lum(B.d, i) > DROP) {
            run++;
            if (x === A.w - 1 && run > 0) run = 0; // touches the right edge
          } else {
            // a run starting at x===0 touched the left edge: drop it
            if (run > 0 && x - run > 0) runs.push(run);
            run = 0;
          }
        }
      }
      return runs;
    },
    [low.toString('base64'), high.toString('base64')] as const,
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// #599 (was #492 review M8, INVERTED): this test used to DOCUMENT the
// zoom-scaling degradation — the hatch's period was expressed in mask cells
// with one fixed pair applied at every zoom, so it washed out to a sub-pixel
// speckle at the app's own initial z9 and coarsened into individually huge
// bands close in. depthColor.ts's hatchBandForZoom now picks the pair per
// zoom, and this test guards that the degradation does not come back.
//
// It measures the on-screen STRIPE WIDTH at both ends of the range, which is
// the quantity that was broken. Note what the ORIGINAL M8 assertion could
// not see: it asserted a COVERAGE FRACTION, and the coverage fraction is
// invariant to the period (25% duty at any band) — that test's own comment
// says so. So the fraction half was never able to discriminate a fine hatch
// from a wide band, despite the title claiming to measure exactly that. The
// fraction assertions are KEPT below, in the role they can actually play:
// establishing that the hatch is rendering at all over a marginal area,
// which is what LICENSES reading the stripe-width numbers as measurements of
// a real pattern rather than of noise.
//
// MEASURED expectations (Chromium, map.project() on two points one mask cell
// apart): 0.5296 screen px per mask cell at z9, 67.7867 at z16.
//   z9  band (27,15): stripe 15 cells -> ~7.9 px   (old fixed pair: ~1.06 px)
//   z16 band  (4, 1): stripe  1 cell  -> ~67.8 px  (old fixed pair: ~135.6 px)
// The thresholds below sit between the two in each case, so reverting
// hatchBandForZoom to the old fixed (8, 2) reds both — verified by running
// exactly that mutation, not assumed.
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
test('navigability hatch (#599): the on-screen stripe stays legible at overview zoom and does not become a wide band close in', async ({
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
    const jumpTo = (zoom: number) =>
      page.evaluate((z) => {
        (
          window as unknown as {
            __scE2eMap: { jumpTo: (o: { zoom: number; center: [number, number] }) => void };
          }
        ).__scE2eMap // already installed window.__scE2eMap as a side effect. // wackerballig's own snap point — no animation. mapReady() has
          .jumpTo({ zoom: z, center: [9.872, 54.7604] });
      }, zoom);

    // Two frames per zoom, differing ONLY in safetyDepthM, so the difference
    // between them is pure hatch (the ramp is gate-blind).
    const framesAt = async (zoom: number) => {
      await safetyDepth.fill('2.2');
      await safetyDepth.blur();
      await jumpTo(zoom);
      const low = await settledCanvas(page, canvas);
      const lowFraction = await hatchedFraction(page, low);
      await safetyDepth.fill('10');
      await safetyDepth.blur();
      // Poll the VALUE, not a boolean: on failure the message carries the
      // fraction that was actually reached. This also LICENSES the stripe
      // measurement below — an absence of wide stripes means nothing until
      // the hatch is established to be rendering at all.
      await expect
        .poll(async () => hatchedFraction(page, await canvas.screenshot()), {
          message: `raising safetyDepthM at z${zoom} must hatch a measurable fraction of the canvas`,
          timeout: 30_000,
        })
        // 0.02's PRIMARY job is licensing — establishing the hatch really
        // renders, so the stripe-width numbers below measure a pattern
        // rather than noise. MEASURED at 0.045 at z9 (most of an overview
        // frame is land) and 0.25 at z16.
        //
        // It turns out to carry real detection power too, which is worth
        // stating rather than leaving to be rediscovered: reverting to the
        // pre-#599 fixed band drops the z9 figure to 0.0057, an 8x collapse.
        // That IS the wash-out, quantified — at ~1px wide the stripes are
        // minified and mipmap-averaged, so almost no pixel still reads as
        // near-black even though the same 25% of cells are painted. So this
        // gate reds under the mutation BEFORE the z9 stripe assertion is
        // reached; both were separately confirmed load-bearing by relaxing
        // this floor and re-running (z9 measured 2px against its >=4 bound).
        .toBeGreaterThan(0.02);
      const high = await settledCanvas(page, canvas);
      const highFraction = await hatchedFraction(page, high);
      expect(highFraction, `z${zoom}: raising the gate must hatch MORE, not less`).toBeGreaterThan(
        lowFraction,
      );
      return { low, high };
    };

    // ---- overview zoom (z9, the app's own initial ZOOM, MapView.tsx) ----
    // The defect: the fixed 2-cell stripe rendered ~1.06 px wide here and
    // washed out. The z9 band is (27, 15) -> ~7.9 px. 4 px sits between the
    // two; the old constants cannot reach it at any sub-pixel-per-cell zoom.
    const z9 = await framesAt(9);
    const z9Runs = await hatchRunLengthsPx(page, z9.low, z9.high);
    const z9Stripe = percentile(z9Runs, 90);
    expect(
      z9Stripe,
      `overview zoom: hatch stripes measured ${z9Stripe}px wide (p90 of ${z9Runs.length} runs) — the pre-#599 fixed band rendered ~1px here and washed out`,
    ).toBeGreaterThanOrEqual(4);

    // ---- harbour-approach zoom (z16) ----
    // One mask cell is already ~67.8 px here, so the raster cannot draw a
    // stripe finer than that — the band clamps to 1 cell, HALVING the old
    // 2-cell (~135.6 px) band. 100 px sits between the two. This is the
    // accepted limit of the per-cell-raster approach, not a fix: see
    // depthColor.ts's "WHAT THIS DOES NOT ACHIEVE" note.
    const z16 = await framesAt(16);
    const z16Runs = await hatchRunLengthsPx(page, z16.low, z16.high);
    const z16Stripe = percentile(z16Runs, 90);
    expect(
      z16Stripe,
      `close zoom: hatch stripes measured ${z16Stripe}px wide (p90 of ${z16Runs.length} runs) — the pre-#599 fixed band rendered ~136px bands here`,
    ).toBeLessThanOrEqual(100);
    // Both ends measured, so the ratio is the real thing #599 bounded: a
    // fixed cell-space band would put ~128x between these two numbers.
    expect(z16Stripe / z9Stripe, 'stripe growth across z9..z16 must stay bounded').toBeLessThan(32);

    // ---- the zoomend REBUILD, isolated ----
    // Neither measurement above can see whether the `zoomend` trigger works:
    // both changed the gate AND the zoom together, so the safetyDepthM effect
    // would have rebuilt the raster even with the zoom listener removed —
    // and a user who merely zooms, without touching the gate, is the common
    // case the whole feature is for. So: jump back to z9 leaving
    // safetyDepthM at 10, which makes the zoom listener the ONLY thing that
    // can rebuild. The gate-2.2 frame from the z9 phase is still a valid
    // reference — same zoom, same centre, gate differs — so the hatch stays
    // isolated the same way.
    await jumpTo(9);
    const backAtZ9 = await settledCanvas(page, canvas, 3); // outlast DEPTH_HATCH_DEBOUNCE_MS
    const rebuiltRuns = await hatchRunLengthsPx(page, z9.low, backAtZ9);
    const rebuiltStripe = percentile(rebuiltRuns, 90);
    expect(
      rebuiltStripe,
      `zooming out with the gate untouched must rebuild the raster into the z9 band: measured ${rebuiltStripe}px (p90 of ${rebuiltRuns.length} runs). A stuck z16 band paints a 1-cell stripe, which is ~0.5px at z9.`,
    ).toBeGreaterThanOrEqual(4);
  } finally {
    server.kill();
  }
});
