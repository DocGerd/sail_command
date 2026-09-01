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
    // an active plan). #681 gave the hatch its OWN opt-in (a checkbox inside
    // this legend's body, asserted separately below) — this line is still
    // about the BASE depth-ramp checkbox's own pre-plan reachability, not
    // about the hatch specifically, and is unaffected by that addition.
    await expect(page.getByRole('checkbox', { name: 'Wassertiefen' })).toBeVisible();
    await expect(page.locator('.route-layer-controls')).toHaveCount(0);
    // #813: the complementary half of the plan.spec.ts guard — with no plan,
    // RouteLegend.tsx's own `.route-legend` (which now folds THIS legend's
    // content in once a plan exists — see that component's own #813
    // comment) must not exist at all, so `getByText('Legende', {exact:true})`
    // below stays unambiguous by construction, not merely by accident of
    // this spec never planning a route.
    await expect(page.locator('details.route-legend')).toHaveCount(0);

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

// #681: independent hazard-hatch toggle. The whole reason this control lives
// INSIDE the legend's disclosure body rather than as a third
// `.data-layer-controls` checkbox row is that a third row measures +51.59px
// at 375x667 (EDGE_VIEWPORTS.partialPushBand375 — the exact viewport #681's
// own issue thread measured the hazard against — re-measured against a real
// DOM injection during review; an earlier +49px figure here was a stale
// citation) and drops `.depth-legend`'s reachability budget (62.556px ->
// 10.96px) under LEGEND_COLLAPSED_HEIGHT_PX (44), which hides the WHOLE
// legend — `#597` caveat included — behind the `hidden` attribute:
// `display: none`, out of the accessibility tree entirely.
//
// This test proves what placing the control HERE instead actually preserves,
// stated precisely rather than as "the caveat stays reachable": the binary
// `legendHidden` gate never fires (asserted below via the caveat paragraph
// staying `toBeVisible()`, i.e. present, non-empty and not inside a closed
// `<details>`) — it does NOT prove the caveat sits inside the legend body's
// own scrollport at this viewport. `.depth-legend-body` is a pre-existing
// 16px-tall scrollport over ~1150-1200px of content at 375x667 (present on
// `develop` before this PR), and review measured that this addition moves
// the caveat's own scroll offset by ~52px further from the top (709.8px ->
// 762.2px) — comparable to the +51.59px the rejected third-row alternative
// would have cost, just in a RECOVERABLE dimension (a scroll offset) rather
// than an UNRECOVERABLE one (`display: none`). `toBeVisible()` is the right
// instrument for the gate claim and the wrong one for an in-viewport claim;
// this test makes only the gate claim. It also proves the control has a
// REAL, independent pixel effect (a DOM-only assertion would pass a checkbox
// wired to nothing).
test('hazard-hatch toggle (#681) is independent of the base depth toggle, defaults ON, and never hides the #597 caveat at 375x667', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.setViewportSize(EDGE_VIEWPORTS.partialPushBand375);
    await page.goto(server.url);
    await mapReady(page);

    // Same idiom as the "#598 ... never overlaps the tab strip" test above:
    // a `preview` build's SW "offline ready" toast, if still up, pushes
    // `.map-stack-tl` down via `--sc-banner-clear-top` and can land the
    // COLLAPSED summary's click target behind the bottom sheet's own tab
    // strip at this exact narrow viewport — a real, previously-measured
    // defect class, not a flake to paper over with a longer timeout.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    await expect(depthToggle).toBeVisible();
    await expect(depthToggle).toBeChecked();

    // Same reachable-pre-plan, default-collapsed legend as the test above —
    // open it to reach the new control, which lives in its body.
    const summary = page.getByText('Legende', { exact: true });
    await expect(summary).toBeVisible();
    await summary.click();
    const hatchToggle = page.getByRole('checkbox', { name: 'Schraffur anzeigen' });
    await expect(hatchToggle).toBeVisible();
    // #455's disclosure basis: a fresh profile must see the hatch, the same
    // fail-open default as the base ramp's own #63 toggle.
    await expect(hatchToggle).toBeChecked();

    // The #597 caveat paragraph stays present (the `legendHidden` gate never
    // fires) with the new control also present — see this test's own header
    // comment for exactly what this assertion does and does not establish
    // about the caveat's position inside `.depth-legend-body`'s scrollport.
    await expect(
      page.getByText(
        'Unvermessenes und trockenfallendes Wasser trägt ebenfalls keine Schraffur und ist durch nichts gekennzeichnet, sieht also aus wie gewöhnliches Wasser.',
      ),
    ).toBeVisible();

    const canvas = page.locator('canvas.maplibregl-canvas');
    const bothOn = await settledCanvas(page, canvas);

    // Turning the hatch off must be a REAL pixel effect (not a no-op DOM
    // toggle wired to nothing), and must leave the base ramp checkbox alone.
    await hatchToggle.uncheck();
    await expect(hatchToggle).not.toBeChecked();
    await expect(depthToggle).toBeChecked();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(bothOn), {
        message: 'turning the hatch toggle OFF must change the rendered map',
        timeout: 30_000,
      })
      .toBe(false);
    const hatchOff = await settledCanvas(page, canvas);

    // Turning the base depth toggle off must ALSO remove the ramp (a second,
    // separately-observable pixel change), and disables the hatch checkbox
    // in the DOM — the #384 defect class (PR #384 review): gating only the
    // LAYER and not the CONTROL leaves a checkbox implying an effect it no
    // longer has.
    await depthToggle.uncheck();
    await expect(hatchToggle).toBeDisabled();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(hatchOff), {
        message: 'turning the base depth toggle OFF must remove the absolute ramp too',
        timeout: 30_000,
      })
      .toBe(false);

    // Restoring the base toggle re-enables the checkbox — the persisted
    // hatch flag was never touched again while depthVisible was off, so it
    // comes back UNCHECKED (the composite condition, not just `hatchVisible`
    // alone: turning depthVisible back on must not silently resurrect a
    // layer the user explicitly turned off before it was disabled).
    await depthToggle.check();
    await expect(hatchToggle).not.toBeDisabled();
    await expect(hatchToggle).not.toBeChecked();
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

            // #641: everything above reads `summary`'s OWN box, which is
            // structurally blind to anything `.depth-legend` adds around it.
            // The gate in DataLayers.tsx is sized from `> summary`'s 44px
            // `min-height` (twinned by `lib/depthLegendGate.test.ts`), so it
            // is only correct while the ANCESTOR's collapsed box is that same
            // 44px — #638's chrome padding is horizontal-only for exactly this
            // reason. Assert the consequence geometrically rather than
            // recomputing `budgetPx` here: re-deriving the gate's own formula
            // in the test would be a duplicated algorithm with a shared bug
            // and no differential check.
            //
            // #412: RE-SAMPLE both boxes inside the poll callback. A pair
            // captured once, before the `--sc-banner-height` ResizeObserver
            // write and the CSS push it drives have settled, produces a
            // byte-identical PASS whether or not the defect is live.
            await expect
              .poll(
                async () => {
                  const lb = await details.boundingBox();
                  const tbNow = await page.getByRole('tablist').boundingBox();
                  if (!lb) return 'legend has no box';
                  if (!tbNow) return 'ok'; // no tab strip at this layout
                  const ox = Math.max(
                    0,
                    Math.min(lb.x + lb.width, tbNow.x + tbNow.width) - Math.max(lb.x, tbNow.x),
                  );
                  const oy = Math.max(
                    0,
                    Math.min(lb.y + lb.height, tbNow.y + tbNow.height) - Math.max(lb.y, tbNow.y),
                  );
                  return ox * oy === 0
                    ? 'ok'
                    : `${ox * oy}px² overlap: legend ${JSON.stringify(lb)} vs tablist ${JSON.stringify(tbNow)}`;
                },
                { timeout: 10_000, message: `${label}: .depth-legend's own box vs the tab strip` },
              )
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

// #648: on-screen width of ONE mask cell at the map's current zoom, measured
// in the real browser via map.project() rather than derived from production
// TypeScript — deriving the yardstick from depthColor.ts's own
// hatchScreenPxPerCell would make needle and haystack the same source (this
// repo's #388 tautology). The cell's longitude width is read from the SHIPPED
// mask metadata ((east - west) / cols), fetched same-origin so
// `connect-src 'self'` permits it, and the lookup FAILS CLOSED: metadata that
// stops parsing throws here instead of yielding a plausible number.
async function maskCellScreenPx(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const map = (
      window as unknown as {
        __scE2eMap: {
          getCenter(): { lng: number; lat: number };
          project(p: [number, number]): { x: number; y: number };
        };
      }
    ).__scE2eMap;
    const res = await fetch(new URL('data/mask.meta.json', location.href).toString());
    if (!res.ok) throw new Error(`mask metadata: HTTP ${res.status}`);
    const meta = (await res.json()) as { west: number; east: number; cols: number };
    if (!(meta.cols > 0) || !(meta.east > meta.west))
      throw new Error(`mask metadata: unusable bbox ${JSON.stringify(meta)}`);
    const dLng = (meta.east - meta.west) / meta.cols;
    const c = map.getCenter();
    const a = map.project([c.lng, c.lat]);
    const b = map.project([c.lng + dLng, c.lat]);
    return Math.abs(b.x - a.x);
  });
}

// #648: how often a newly-hatched pixel's neighbour ONE MASK CELL to the
// right is also newly hatched. Same two-gate differencing as
// hatchRunLengthsPx above, so basemap and ramp cancel exactly and only hatch
// is measured.
//
// WHY THIS IS THE RIGHT INSTRUMENT, and why its threshold is derived rather
// than picked. The painted predicate is `(outRow + col) % period < stripe`.
// Under every striped band reachable at z13 and above, stripe is 1, so for a
// FIXED row two horizontally ADJACENT cells give consecutive residues and at
// most one of them can be painted — adjacent-cell continuity is EXACTLY ZERO
// by the pattern's own algebra, not merely small. Under #648's
// HATCH_WASH_BAND (period 1) every marginal cell is painted, so continuity is
// 1 everywhere except at the marginal region's own boundary. A threshold of
// 0.5 therefore sits between a structural 0 and a data-limited ~1.
//
// It is also immune to the two things that defeat the alternatives here: it
// needs no absolute dark-pixel budget (so a frame whose LOW gate is already
// heavily hatched cannot swamp it), and it never discards a run for touching
// a row edge (so a row hatched edge-to-edge, exactly what the wash produces,
// is measured rather than thrown away).
async function hatchCellContinuity(
  page: Page,
  low: Buffer,
  high: Buffer,
  cellPx: number,
): Promise<{ continuous: number; total: number; fraction: number }> {
  return page.evaluate(
    async (args: { a64: string; b64: string; step: number }) => {
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
      const A = await decode(args.a64);
      const B = await decode(args.b64);
      if (A.w !== B.w || A.h !== B.h) throw new Error('frame size changed between gates');
      const lum = (d: Uint8ClampedArray, i: number) =>
        0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const DROP = 40; // same discriminator as hatchRunLengthsPx — see its comment
      const newlyHatched = (x: number, y: number) => {
        const i = (y * A.w + x) * 4;
        return lum(A.d, i) - lum(B.d, i) > DROP;
      };
      const step = Math.max(1, Math.round(args.step));
      let continuous = 0;
      let total = 0;
      for (let y = 0; y < A.h; y++) {
        for (let x = 0; x + step < A.w; x++) {
          if (!newlyHatched(x, y)) continue;
          total++;
          if (newlyHatched(x + step, y)) continuous++;
        }
      }
      return { continuous, total, fraction: total === 0 ? 0 : continuous / total };
    },
    { a64: low.toString('base64'), b64: high.toString('base64'), step: cellPx },
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
// apart): 0.5296 screen px per mask cell at z9, 8.4738 at z13, 67.7867 at z16.
//   z9  band (27,15): stripe 15 cells -> ~7.9 px   (old fixed pair: ~1.06 px)
//   z13 band  (4, 1): stripe  1 cell  -> ~8.5 px   (old fixed pair: ~16.9 px)
// The z9 threshold below sits between the two, so reverting hatchBandForZoom
// to the old fixed (8, 2) reds it — verified by running exactly that
// mutation, not assumed.
//
// #648 REPLACED the z16 half of this. From z14 up the band degrades to
// HATCH_WASH_BAND (period 1, stripe 1), so there is no stripe to measure
// there and no on-screen stripe width to tabulate — the z16 phase now
// measures the DUTY CYCLE instead, and the reasoning for its threshold lives
// at that phase rather than here so the derivation sits beside the numbers.
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
test('navigability hatch (#599/#648): the stripe stays legible at overview zoom, and past z13 degrades to a full-coverage wash instead of hard-edged blocks', async ({
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
        )
          // wackerballig's own snap point — no animation. mapReady() has
          // already installed window.__scE2eMap as a side effect.
          .__scE2eMap.jumpTo({ zoom: z, center: [9.872, 54.7604] });
      }, zoom);

    // Two frames per zoom, differing ONLY in safetyDepthM, so the difference
    // between them is pure hatch (the ramp is gate-blind).
    // `minFraction` is PER ZOOM on purpose. A single shared floor would have
    // to sit below the smaller of the two measurements, which would have
    // silently WEAKENED the z16 coverage assertion this test already
    // shipped (> 0.15) down to the z9-compatible value — a weakened check
    // hiding inside a rewrite is exactly the shape this repo has been bitten
    // by before. z16 keeps its original 0.15 unchanged.
    const framesAt = async (zoom: number, minFraction: number) => {
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
        // PRIMARY job is licensing — establishing the hatch really renders,
        // so the stripe-width numbers below measure a pattern rather than
        // noise. MEASURED: 0.045 at z9 (most of an overview frame is land)
        // against its 0.02 floor, and 0.25 at z16 against the 0.15 floor
        // this test already shipped.
        //
        // The z9 floor turns out to carry real detection power too, which is
        // worth stating rather than leaving to be rediscovered: reverting to
        // the pre-#599 fixed band drops that figure to 0.0057, an 8x
        // collapse. That IS the wash-out, quantified — at ~1px wide the
        // stripes are minified and mipmap-averaged, so almost no pixel still
        // reads as near-black even though the same 25% of cells are painted.
        // So this gate reds under the mutation BEFORE the z9 stripe
        // assertion is reached; both were separately confirmed load-bearing
        // by relaxing this floor and re-running (z9 measured 2px against its
        // >=4 bound).
        .toBeGreaterThan(minFraction);
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
    const z9 = await framesAt(9, 0.02);
    const z9Runs = await hatchRunLengthsPx(page, z9.low, z9.high);
    const z9Stripe = percentile(z9Runs, 90);
    expect(
      z9Stripe,
      `overview zoom: hatch stripes measured ${z9Stripe}px wide (p90 of ${z9Runs.length} runs) — the pre-#599 fixed band rendered ~1px here and washed out`,
    ).toBeGreaterThanOrEqual(4);

    // ---- harbour-approach zoom (z16): the #648 degradation ----
    //
    // WHAT WAS HERE BEFORE, AND WHY IT IS GONE RATHER THAN INVERTED. This
    // block used to assert TWO things, and BOTH were removed — naming only
    // the first would understate the deletion:
    //
    //   (1) `z16Stripe <= 100`, with a comment calling 100 px "the accepted
    //       limit of the per-cell-raster approach, not a fix". That threshold
    //       was chosen to TOLERATE the 67.8 px squares #648 reports, so it
    //       could never fire on them — its continuing to pass would prove
    //       nothing about this change, and it is cited as evidence nowhere.
    //   (2) `z16Stripe / z9Stripe < 32`, "stripe growth across z9..z16 must
    //       stay bounded". Its removal is forced rather than chosen: with no
    //       z16 stripe there is no ratio to form. What holds the BLOW-UP
    //       direction it was aimed at is depthColor.test.ts's `holds the
    //       on-screen stripe within 7.9-17 px across z9..z13`, whose
    //       `expect(Math.max(...widths)).toBeLessThanOrEqual(17)` is a real
    //       UPPER bound over every striped band, sampled at each band's TOP
    //       with an explicit `> 16` non-vacuity row proving those tops are
    //       reached — strictly stronger than the deleted ratio, which only
    //       ever sampled z9 and z16. Do not delete that bound believing the
    //       e2e assertions cover it. The z13 `c13.fraction < 0.25` control
    //       below adds a cell-space bound at the one zoom that still keeps a
    //       stripe: continuity for a band (p, s) sampled one cell apart is
    //       (s - 1) / s, so any s >= 2 at z13 reads >= 0.5 and reds it.
    //       NOT `z9Stripe >= 4`, and NOT the z10.9 `> 12` assertion — both
    //       are LOWER bounds, covering the WASH-OUT direction (#599's actual
    //       defect), and quantisation only makes the stripe BIGGER, so
    //       neither can catch blow-up. An earlier revision of this comment
    //       named those two as the keepers; that was the wrong direction.
    //
    // It is DELETED rather than flipped to `> 100`, because the instrument
    // itself stops applying: hatchRunLengthsPx DISCARDS runs touching either
    // row edge (they are truncated by the viewport, not by the pattern), and
    // under a 100%-duty wash a row inside a contiguous marginal area is
    // hatched edge to edge, so nearly every run is discarded and the p90
    // collapses toward 0. An inverted `> 100` would therefore be measuring
    // the discard rule, not the hatch. The z9 and z10.9 phases keep using
    // that instrument, where stripes still exist and it is still valid.
    //
    // THE REPLACEMENT is hatchCellContinuity above — adjacent-cell continuity
    // within the newly-hatched footprint. Its derivation lives in that
    // helper's own comment. A plain hatched-FRACTION bound was tried first
    // and REJECTED on measurement, not on reasoning: `highFraction <= duty +
    // lowFraction` is a sound ceiling, but at gate 2.2 the LOW frame already
    // carries wash hatch of its own, so the bound sits ABOVE what the high
    // frame can reach — measured at z14, highFraction 0.4806 against a 0.5119
    // ceiling. A sound bound is not automatically a usable threshold.
    const measureContinuity = async (frames: { low: Buffer; high: Buffer }, label: string) => {
      const cellPx = await maskCellScreenPx(page);
      const c = await hatchCellContinuity(page, frames.low, frames.high, cellPx);
      // NON-VACUITY: continuity over zero samples is 0/0 -> 0, which would
      // sail through the `< 0.25` control below while proving nothing.
      expect(
        c.total,
        `${label}: too few newly-hatched pixels to measure (cell ${cellPx.toFixed(2)}px) — the differencing found essentially no hatch`,
      ).toBeGreaterThan(1000);
      return { ...c, cellPx };
    };

    const z16 = await framesAt(16, 0.15);
    const c16 = await measureContinuity(z16, 'z16');
    expect(
      c16.fraction,
      `#648: at z16 the hatch must be a full-coverage wash — adjacent-cell continuity measured ${c16.fraction.toFixed(4)} over ${c16.total} samples at a ${c16.cellPx.toFixed(2)}px cell. A stripe=1 band makes this EXACTLY 0 (adjacent cells give consecutive residues, at most one painted); the wash makes it ~1.`,
    ).toBeGreaterThan(0.5);

    // ---- the degradation BOUNDARY itself (z13 vs z14) ----
    // Nothing above can see WHERE the degradation starts: z9/z10.9/z16 all
    // read the same if the threshold moves by a level. z13 and z14 are the
    // tightest reachable pair and, before #648, selected the IDENTICAL (4, 1)
    // band — so this pair is what no pre-#648 build can satisfy.
    //
    // The z13 half is a CONTROL, not a mutation detector: it passes with and
    // without #648, and exists to catch degrading TOO EARLY, which would cost
    // the mid-zoom hatch the readable stripes #599 exists to give it.
    const z13 = await framesAt(13, 0.05);
    const c13 = await measureContinuity(z13, 'z13');
    expect(
      c13.fraction,
      `#648 control: z13 must KEEP the striped (4, 1) band — adjacent-cell continuity measured ${c13.fraction.toFixed(4)} over ${c13.total} samples at a ${c13.cellPx.toFixed(2)}px cell; a stripe pattern reads ~0 here, a wash ~1.`,
    ).toBeLessThan(0.25);

    const z14 = await framesAt(14, 0.05);
    const c14 = await measureContinuity(z14, 'z14');
    expect(
      c14.fraction,
      `#648: z14 is the FIRST washed band — round(8/px) reaches 0 at px=16, i.e. z=13.917, and Math.floor puts the first integer band at 14. Adjacent-cell continuity measured ${c14.fraction.toFixed(4)} over ${c14.total} samples at a ${c14.cellPx.toFixed(2)}px cell.`,
    ).toBeGreaterThan(0.5);

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

    // ---- FRACTIONAL zoom: the quantisation itself ----
    // Every phase above uses an INTEGER jumpTo, and hatchBandForZoom only
    // differs between continuous and Math.floor selection at FRACTIONAL
    // zooms — so nothing above can observe the #599 fix-wave quantisation
    // that closed the band-blanking residual, and a revert of the floor
    // would leave the whole suite green. z10.9 is chosen because the two
    // schemes are furthest apart there: quantised uses the z10 band
    // (stripe 8 cells -> ~15.8 px), continuous would pick stripe 4
    // (-> ~7.9 px). 12 px sits between them, nearer neither.
    await jumpTo(10.9);
    const atFractional = await settledCanvas(page, canvas, 3);
    const fracRuns = await hatchRunLengthsPx(page, z9.low, atFractional);
    const fracStripe = percentile(fracRuns, 90);
    expect(
      fracStripe,
      `a fractional zoom must use the band of the whole zoom below it (#599 quantisation): measured ${fracStripe}px (p90 of ${fracRuns.length} runs). Quantised z10.9 predicts ~15.8px; continuous selection would predict ~7.9px.`,
    ).toBeGreaterThan(12);
  } finally {
    server.kill();
  }
});

// #682: hazard-family seamarks (isolatedDanger, cardinal) must paint ABOVE
// routine ones where they overlap at z>=12, and must keep their z<12
// collision-survival priority — see seamarkGeoJson.ts's SEAMARKS_LAYOUT doc
// comment (b) for the full mechanism this test exercises: `sc-seamarks` was
// split into a routine layer and a `sc-seamarks-hazard` overlay, added AFTER
// (and therefore painted above) it with the SAME beforeId anchor.
//
// DoD (issue #682): "Measured BASE vs HEAD with an `idle`-gated
// `queryRenderedFeatures` over a FIXED geographic box built with
// `map.project()` — never a whole-viewport comparison across zooms... Counts
// are order-independent... the assertion must read ORDER." This test reads
// ORDER, not counts: `queryRenderedFeatures` merges results from MULTIPLE
// layers by LAYER STACKING, never per-feature depth — maplibre-gl's own
// `Style._flattenAndSortRenderedFeatures` (`style/style.ts`, re-derived
// against the installed 6.5.0, matched to `app/package-lock.json`'s pin via
// `npm ci` — #392's documented trap) iterates the style's layer order
// top-to-bottom and, for ordinary 2D layers (both of these are plain symbol
// layers, not fill-extrusion), appends ALL of one layer's matched features
// before moving to the next layer down: "The order between features in two
// 2D layers is always determined by layer order" (that method's own
// comment). So querying BOTH `sc-seamarks*` layers together at once, EVERY
// `sc-seamarks-hazard` feature must appear before EVERY `sc-seamarks`
// feature in the combined result — a stronger, and easier to state,
// guarantee than "any one overlapping pair is ordered correctly": it holds
// for the whole box at once, and fails loudly (not silently) if the layer
// stacking is ever inverted.
//
// Reuses the SAME dense cluster `seamarks.spec.ts` already measured (one of
// the two joint-densest cells in the committed `app/public/data/seamarks.json`,
// 43 marks within +/-0.015 deg) — duplicated locally rather than imported,
// matching this repo's own stated per-spec-file self-containment convention
// (every `page.evaluate()` callback below is re-parsed and run inside the
// BROWSER realm, sharing no closure with this module or any other spec).
interface Sc682TestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  getLayer(id: string): unknown;
  project(lngLat: [number, number]): { x: number; y: number };
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
}

const HAZARD_CLUSTER_CENTER: [number, number] = [10.515, 54.855];
const HAZARD_CLUSTER_HALF_DEGREES = 0.015;
// #484 F2 (seamarks.spec.ts): 13, well above the z12 icon-overlap threshold
// where routine marks can paint over hazard ones absent the #682 fix.
const HAZARD_ZOOM = 13;

// #682 review MINOR 2: poll the VALUE (which layer id is still missing),
// not a boolean — a boolean `expect.poll` can only ever report
// `Expected: true / Received: false` plus a timeout, which means both "too
// slow" and "never going to happen" and cannot name WHICH layer never
// appeared (CLAUDE.md's e2e-assert-the-value-not-a-boolean lesson).
async function waitForBothSeamarkLayers(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const map = (window as unknown as { __scE2eMap: Sc682TestMap }).__scE2eMap;
          return ['sc-seamarks', 'sc-seamarks-hazard'].filter((id) => !map.getLayer(id));
        }),
      { timeout: 30_000 },
    )
    .toEqual([]);
}

async function jumpToHazardCluster(page: Page, zoom: number): Promise<void> {
  await page.evaluate(
    ({ center, zoom }) =>
      (window as unknown as { __scE2eMap: Sc682TestMap }).__scE2eMap.jumpTo({ center, zoom }),
    { center: HAZARD_CLUSTER_CENTER, zoom },
  );
}

// Reads the ORDERED `hazard` booleans of every seamark feature — across
// BOTH layers, queried TOGETHER in one call so maplibre's own cross-layer
// z-order merge is what produces the ordering, not two separate queries
// concatenated by this function — rendered inside the fixed geographic box.
// `hazard` is stamped per feature at data-build time
// (seamarkFeatureCollectionWithIcons, seamarkGeoJson.ts) and survives onto
// the GeoJSON source, so it's readable straight off `properties` with no
// re-derivation here.
async function readOrderedHazardFlagsInCluster(page: Page): Promise<boolean[]> {
  return page.evaluate(
    ({ center, half }) => {
      const map = (window as unknown as { __scE2eMap: Sc682TestMap }).__scE2eMap;
      const nw = map.project([center[0] - half, center[1] + half]);
      const se = map.project([center[0] + half, center[1] - half]);
      return map
        .queryRenderedFeatures(
          [
            [nw.x, nw.y],
            [se.x, se.y],
          ],
          { layers: ['sc-seamarks', 'sc-seamarks-hazard'] },
        )
        .map((f) => f.properties.hazard === true);
    },
    { center: HAZARD_CLUSTER_CENTER, half: HAZARD_CLUSTER_HALF_DEGREES },
  );
}

// Same idle-unreachable rationale and settle shape as seamarks.spec.ts's own
// `settledSeamarkIconIds` (labels.spec.ts's `Placement.stillRecent` /
// `fadeDuration` derivation) — three consecutive byte-identical reads at
// 400ms, comparing the FULL ordered array (not a count, which is blind to
// an order swap at a fixed total), failing CLOSED with the read history.
const HAZARD_SETTLE_POLL_INTERVAL_MS = 400;
const HAZARD_SETTLE_STABLE_READS_REQUIRED = 3;
const HAZARD_SETTLE_MAX_READS = 27;

async function settledOrderedHazardFlags(page: Page, label: string): Promise<boolean[]> {
  const history: boolean[][] = [];
  const recent: boolean[][] = [];
  const first = await readOrderedHazardFlagsInCluster(page);
  history.push(first);
  recent.push(first);
  for (let extra = 1; extra <= HAZARD_SETTLE_MAX_READS; extra++) {
    await page.waitForTimeout(HAZARD_SETTLE_POLL_INTERVAL_MS);
    const next = await readOrderedHazardFlagsInCluster(page);
    history.push(next);
    recent.push(next);
    if (recent.length > HAZARD_SETTLE_STABLE_READS_REQUIRED) recent.shift();
    const stable =
      recent.length === HAZARD_SETTLE_STABLE_READS_REQUIRED &&
      recent.every((r) => JSON.stringify(r) === JSON.stringify(recent[0]));
    if (stable) return next;
  }
  throw new Error(
    `[${label}] hazard/routine order in the cluster box never stabilized across ${history.length} reads ` +
      `(${HAZARD_SETTLE_POLL_INTERVAL_MS}ms apart, ${HAZARD_SETTLE_STABLE_READS_REQUIRED} consecutive matches required); ` +
      `reads seen: ${JSON.stringify(history)}`,
  );
}

test('#682: hazard seamarks (cardinal/isolated-danger) paint above routine ones at z>=12, by ORDER not count', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    await mapReady(page);
    await waitForBothSeamarkLayers(page);

    // #7: seamarks default OFF (opt-in specialist layer).
    const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
    await expect(seamarksToggle).toBeVisible();
    await seamarksToggle.check();
    await expect(seamarksToggle).toBeChecked();

    await jumpToHazardCluster(page, HAZARD_ZOOM);
    const order = await settledOrderedHazardFlags(page, `z${HAZARD_ZOOM} hazard/routine order`);
    console.log(
      `[#682 datalayers.spec.ts] z${HAZARD_ZOOM} cluster box: ${order.length} seamarks, ` +
        `ordered hazard flags (topmost first): ${JSON.stringify(order)}`,
    );

    const hazardIndices = order.flatMap((h, i) => (h ? [i] : []));
    const routineIndices = order.flatMap((h, i) => (h ? [] : [i]));
    // Non-vacuity (CLAUDE.md's "give any probe whose emptiness you intend to
    // interpret a positive control" lesson): this dense, joint-densest
    // cluster (measured in seamarks.spec.ts at 43-44 marks) must actually
    // contain BOTH a hazard mark and a routine one, or the ordering
    // assertion below would pass trivially over an empty side.
    expect(
      hazardIndices.length,
      `expected at least one hazard-family (cardinal/isolatedDanger) mark in the cluster box; got 0 of ${order.length}`,
    ).toBeGreaterThan(0);
    expect(
      routineIndices.length,
      `expected at least one routine-family mark in the cluster box; got 0 of ${order.length}`,
    ).toBeGreaterThan(0);

    // The property #682 exists to establish: querying the two seamark
    // layers TOGETHER, every hazard feature's position precedes every
    // routine feature's — i.e. the ordered array is a block of hazard
    // features (however many) followed by a block of routine ones, with no
    // interleaving. `Math.max` over hazard indices finds the LAST hazard
    // feature; `Math.min` over routine indices the FIRST routine one — if
    // the layer split were reverted (hazard added/painted BELOW routine,
    // or merged back into one layer with only symbol-sort-key deciding
    // paint order), at least one routine mark in this cluster would paint
    // above at least one hazard mark and this comparison would fail,
    // naming the actual observed order via the message below.
    const lastHazardIndex = Math.max(...hazardIndices);
    const firstRoutineIndex = Math.min(...routineIndices);
    expect(
      lastHazardIndex,
      `every hazard mark must paint above every routine mark in this box at z>=12 — ` +
        `last hazard index ${lastHazardIndex}, first routine index ${firstRoutineIndex}, ` +
        `full ordered hazard-flag array (topmost first): ${JSON.stringify(order)}`,
    ).toBeLessThan(firstRoutineIndex);
  } finally {
    server.kill();
  }
});
