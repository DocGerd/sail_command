import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #155 map orientation chrome: the north arrow / track-up toggle and the
// nautical scale bar, against the REAL MapLibre camera (jsdom has none, so
// the unit tests can only prove the state machine and the wiring).
//
// Track-up itself is exercised in the unit suite rather than here: engaging it
// needs a GPS fix under way, which live.spec.ts owns the fixture machinery
// for. What only a real browser can prove is the camera round trip — a hand
// rotation really reaching 'free', a tap really bringing the chart home, and
// the bar really measuring the rendered viewport.

// The app deliberately exposes no global map handle (there is no reason for
// production code to), so this test reads MapView's `map` state through the
// React fiber. Test-harness only. It is asserted to succeed rather than
// silently skipped: a fiber layout change must fail this spec loudly, not
// quietly delete its strongest assertions.
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

// `+ 0` for the same negative-zero reason as needleDeg below. Here the residual
// happens to land positive (`Math.round(0.048)` is `+0`), so this is latent
// rather than observed — but a rotation the other way would round to `-0` and
// `expect.poll(...).toBe(0)` would then spin until it timed out instead of
// failing fast, which is a far worse signal than a red assertion.
const bearing = (page: Page) =>
  page.evaluate(
    () =>
      Math.round(
        (window as unknown as Record<string, { getBearing: () => number }>).__scE2eMap.getBearing(),
      ) + 0,
  );

/**
 * The bearing the user can actually SEE, read back out of the needle's own
 * matrix, rounded to whole degrees.
 *
 * `+ 0` is NOT redundant — it normalises negative zero, and without it this
 * helper is intermittently unusable. After a drag-rotate gesture MapLibre's
 * camera does not settle on exactly 0: measured across 42 scripted
 * rotate-then-tap-home cycles in Chromium it lands 0.04-0.18 deg short about
 * half the time (identically before #203, on #203's first head, and on its
 * second — so this is MapLibre's end-of-gesture inertia/`bearingSnap`
 * behaviour, not the compass's). The camera assertions above survive that
 * because `Math.round(0.048)` is `+0`, but the needle counter-rotates, so it
 * paints `rotate(-0.11deg)` and `Math.round` yields `-0` — and `toBe` compares
 * with `Object.is`, where `Object.is(-0, 0)` is FALSE. The result was a
 * roughly 1-in-36 red CI run whose message (`Expected: 0, Received: -0`) reads
 * like the needle never got home when in fact it is a tenth of a degree out
 * and visually identical. `-0 + 0` is `+0`, while every other value is
 * unchanged, so the sign of zero stops mattering and a genuinely wrong bearing
 * still fails. Sub-degree residual: see #230.
 */
const needleDeg = (page: Page) =>
  page.evaluate(() => {
    const n = document.querySelector('.compass-needle');
    if (!n) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(n).transform);
    return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI) + 0;
  });

test('compass: north-up cold start, hand rotation drops to free, tap brings the chart home', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    const compass = page.locator('.compass-btn');
    await expect(compass).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await installMapHandle(page)).toBe(true);

    // The round glass chip, and the >=44 px cockpit touch target the issue
    // asks for. toBeVisible() alone would pass in the broken state that
    // shipped mid-review — with .sc-btn-ghost winning at equal specificity the
    // button still had a box and no visibility:hidden, it was merely
    // transparent and unsized — so the regression needs computed style, not
    // visibility.
    const chrome = await compass.evaluate((el) => ({
      radius: getComputedStyle(el).borderRadius,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height,
    }));
    expect(chrome.width).toBeGreaterThanOrEqual(44);
    expect(chrome.height).toBeGreaterThanOrEqual(44);
    expect(chrome.radius).toBe('999px');

    // Cold start is deterministic north-up (issue #155 decision 3) — the
    // property every canvas-comparing spec in this suite depends on.
    await expect(compass).toHaveAttribute('data-orientation', 'north-up');
    await expect.poll(() => bearing(page), { message: 'map starts north-up' }).toBe(0);
    expect(await needleDeg(page)).toBe(0);
    // With no GPS fix the label must SAY course-up is unavailable, and the
    // button must still be enabled (never greyed — decision 4).
    await expect(compass).toHaveAttribute(
      'aria-label',
      'Kartenausrichtung: Norden oben. Kursorientierung ohne GPS-Kurs nicht verfügbar',
    );
    await expect(compass).toBeEnabled();

    // A tap that cannot engage course-up announces why instead of no-opping.
    await compass.click();
    await expect(page.locator('.compass-control [role="status"]')).toHaveText(
      'Kursorientierung nicht verfügbar – keine GPS-Position in Fahrt',
    );
    await expect(compass).toHaveAttribute('data-orientation', 'north-up');
    await expect.poll(() => bearing(page)).toBe(0);

    // --- hand rotation: MapLibre's DragRotate is a right-button drag ---
    const canvas = page.locator('canvas.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 200, cy, { steps: 20 });
    await page.mouse.up({ button: 'right' });

    // Gestures stay enabled in every mode, and a hand rotation hands the
    // bearing to the user (the chart-plotter 'free' convention).
    await expect(compass).toHaveAttribute('data-orientation', 'free');
    await expect(compass).toHaveAttribute(
      'aria-label',
      'Karte manuell gedreht. Auf Norden oben zurücksetzen',
    );
    await expect
      .poll(() => bearing(page), { message: 'the drag really rotated the camera' })
      .not.toBe(0);
    // The needle counter-rotates the camera, so north keeps pointing north.
    // Both sides are rounded independently (one from the camera, one from a
    // CSS matrix), so allow a degree of slack — anything larger would be a
    // real sign/normalisation error, which is what this guards.
    const rotated = await bearing(page);
    const norm180 = (d: number) => {
      const x = ((d % 360) + 360) % 360;
      return x > 180 ? x - 360 : x;
    };
    expect(Math.abs(norm180((await needleDeg(page))! - norm180(-rotated)))).toBeLessThanOrEqual(1);

    // --- tap resets to north-up ---
    await compass.click();
    await expect
      .poll(() => bearing(page), { message: 'tap eases the chart back to north' })
      .toBe(0);
    await expect(compass).toHaveAttribute('data-orientation', 'north-up');
    expect(await needleDeg(page)).toBe(0);
  } finally {
    server.kill();
  }
});

// --------------------------------------------------------------------- #230
//
// The bearing track-up is parked on for the #230 probe. It must sit strictly
// inside MapLibre's DEFAULT `bearingSnap` window (7) and outside the app's own
// FREE_SNAP_NORTH_DEG (1), so the only thing that can pull the chart to north
// here is MapLibre's end-of-gesture snap — which `bearingSnap: 0`
// (MapView.tsx) is what removes. It must also clear TRACK_DEADBAND_DEG (2) so
// the follow loop actually eases there from the north-up cold start.
const SNAP_WINDOW_BEARING = 3;
// 2 m/s = 3.89 kn, comfortably over OWNSHIP_VECTOR_MIN_SOG_KN (0.5) so
// `trackUpAvailable` is true and the compass tap engages course-up.
const TRACK_SPEED_MS = 2;

/**
 * Playwright's own `Geolocation` type carries latitude/longitude/accuracy
 * ONLY, so `context.setGeolocation` can never produce a fix with a course —
 * which is exactly why live.spec.ts documents cog/sog rendering as en-dashes.
 * Course-up needs one, so this drives Chromium's geolocation override through
 * CDP instead, which does accept `heading`/`speed`. The app still reads the
 * REAL `navigator.geolocation.watchPosition` (services/geolocation.ts) — only
 * the device behind it is emulated, same as live.spec.ts.
 */
async function setCourseFix(page: Page, context: BrowserContext, headingDeg: number) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setGeolocationOverride', {
    latitude: 54.8237,
    longitude: 9.6524,
    accuracy: 5,
    heading: headingDeg,
    speed: TRACK_SPEED_MS,
  });
}

/**
 * Zeroes the moveend counter `cameraState` reads; call immediately before each
 * gesture. IDEMPOTENT in the listener it installs — this is called again on
 * every `toPass` retry below, and re-subscribing each time would accumulate
 * handlers on the app's own live map for the whole retry budget.
 */
function armCameraRest(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __scE2eMap: { on: (t: string, cb: () => void) => void };
      __scMoveEnds: number;
      __scRestArmed?: boolean;
    };
    w.__scMoveEnds = 0;
    if (w.__scRestArmed) return;
    w.__scRestArmed = true;
    w.__scE2eMap.on('moveend', () => {
      w.__scMoveEnds += 1;
    });
  });
}

/**
 * A DESCRIPTIVE camera-rest state, not a boolean — a settle gate that times out
 * on a bare `false` names neither what the camera was doing nor whether the
 * gesture ever reached it (the #243/#252 lesson).
 *
 * "At rest" needs the moveend COUNT, not just `isMoving`/`isEasing`: a gesture's
 * end-of-gesture ease is started from a later render frame, so between
 * `mouse.up()` returning and that ease beginning the map is momentarily idle —
 * a poll on the flags alone would pass through that window and read a bearing
 * that is about to change.
 */
function cameraState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __scE2eMap: { isMoving: () => boolean; isEasing: () => boolean };
      __scMoveEnds: number;
    };
    const moving = w.__scE2eMap.isMoving();
    const easing = w.__scE2eMap.isEasing();
    if (w.__scMoveEnds > 0 && !moving && !easing) return 'at-rest';
    return `busy(moveends=${w.__scMoveEnds}, moving=${moving}, easing=${easing})`;
  });
}

test('#230: a pan flick inside MapLibre’s default bearingSnap window keeps track-up, and a real hand rotation still drops to free', async ({
  page,
  context,
}) => {
  const server = await startPreview();
  try {
    // MapLibre's end-of-gesture branch is gated on `!browser.prefersReducedMotion`
    // (handler_manager.ts): a reduce preference would take the OTHER branch and
    // silently move this test off the code path it exists to cover.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await context.grantPermissions(['geolocation'], { origin: new URL(server.url).origin });
    await setCourseFix(page, context, SNAP_WINDOW_BEARING);

    await page.goto(server.url);
    await page.waitForLoadState('networkidle');
    expect(await installMapHandle(page)).toBe(true);

    // --- engage course-up: "show my position" is what feeds the compass a fix ---
    await page.getByRole('tab', { name: 'Planen' }).click();
    await page.getByText('Erweitert').click();
    await page.getByLabel('Meine Position anzeigen').check();

    const compass = page.locator('.compass-btn');
    // Wait for the fix to reach the compass: the aria-label is the app's own
    // statement that course-up is now available, so gating on it means the tap
    // below can never land while `nextOrientation` would still `reject`.
    await expect(compass).toHaveAttribute(
      'aria-label',
      'Kartenausrichtung: Norden oben. Kursorientierung aktivieren',
    );
    await compass.click();
    await expect(compass).toHaveAttribute('data-orientation', 'track-up');
    await expect
      .poll(() => bearing(page), { message: 'course-up eased the chart onto the emulated COG' })
      .toBe(SNAP_WINDOW_BEARING);

    // --- the bug: an ordinary LEFT-button pan flick, nothing to do with rotation ---
    await armCameraRest(page);
    const canvas = page.locator('canvas.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Spread across ANIMATION FRAMES, not wall-clock sleeps. HandlerInertia
    // records one buffer entry per applied frame and `_onMoveEnd` bails with
    // fewer than two inside its 160 ms window (handler_inertia.ts) — a burst of
    // moves inside a single frame produces one entry and no inertial ease at
    // all. Gating each batch on a real frame is the state signal that decides
    // which of the two branches below the release takes.
    for (const dx of [40, 80, 120, 160]) {
      await page.mouse.move(cx - dx, cy - dx / 3, { steps: 2 });
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    }
    await page.mouse.up();

    // Settle FIRST. Both assertions below are auto-retrying and both would
    // otherwise be satisfiable mid-flight — measured, not theorised: on the
    // unfixed build one run reds on the bearing (already snapped to 0) and
    // another on the attribute (bearing still passing through 3 while the mode
    // has already gone). Reading a settled camera makes the outcome the state
    // the USER is left in, which is what the issue is about.
    await expect
      .poll(() => cameraState(page), { message: 'camera settles after the pan flick' })
      .toBe('at-rest');

    // BOTH halves, because the two pre-fix paths fail differently and either
    // assertion alone is blind to one of them (handler_manager.ts):
    //   - inertial ease present -> `easeTo({bearing: 0}, {originalEvent})`, so
    //     the compass sees a hand rotation and demotes to `free`; its own 1°
    //     snap then pulls it on to `north-up`. The ATTRIBUTE catches this.
    //   - no inertia -> bare moveend then `map.resetNorth()`, which carries NO
    //     eventData: the mode stays `track-up` while the chart silently
    //     un-rotates, so only the BEARING catches it.
    expect(await bearing(page), 'a pan flick must not rotate the chart (#230)').toBe(
      SNAP_WINDOW_BEARING,
    );
    expect(
      await compass.getAttribute('data-orientation'),
      'a pan flick must not drop course-up (#230)',
    ).toBe('track-up');

    // --- the other direction: a genuine hand rotation MUST still demote ---
    // Over-correcting here (a compass gone deaf to a real gesture) would be a
    // worse bug than the one above, so it is asserted in the same test rather
    // than left to the #155 spec.
    const norm180 = (d: number) => {
      const x = ((d % 360) + 360) % 360;
      return x > 180 ? x - 360 : x;
    };
    // DELIBERATELY the #155 test's own burst form (one `mouse.move` with
    // `steps`), NOT the frame-spread form the pan above uses. Measured on a
    // scratch spec: a frame-spread right-drag rotates the camera by exactly 0°,
    // every time, in both motion modes — MapLibre's rotate handler does not
    // survive a gesture stretched across frames the way its pan handler does.
    // 300 px turns at LEAST 24° here (MapLibre's drag-rotate is far coarser
    // than 1°/px; inertia carried it to 72° and 120° on other runs), which is
    // the margin the 10° bound below is drawn against.
    //
    // The bounded retry is the same device, for the same reason, as
    // `rotateThenTapCompassHome` further down: a right-drag issued straight
    // after another gesture's mouseup is occasionally swallowed whole (measured
    // over 4 instrumented runs — one needed 3 attempts, the other three landed
    // first try). Each attempt is the same real drag and the inner assertion
    // still names the actual number, so a genuine over-correction regression
    // reds with `Received: 0` and not a bare timeout. The retry cannot inflate
    // a weak result into a pass: measured, an attempt either turns 0° (fully
    // swallowed) or >=24°, so accumulation never creeps past the bound in
    // small steps. The `data-orientation` assertion after the loop carries this
    // direction regardless, and is immune to accumulation entirely.
    await expect(async () => {
      await armCameraRest(page);
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(cx + 300, cy, { steps: 20 });
      await page.mouse.up({ button: 'right' });
      await expect
        .poll(() => cameraState(page), { message: 'camera settles after the hand rotation' })
        .toBe('at-rest');
      // Well clear of both the parked course AND FREE_SNAP_NORTH_DEG (1), so
      // the demotion below cannot be explained away by the chart barely having
      // moved.
      expect(
        Math.abs(norm180((await bearing(page)) - SNAP_WINDOW_BEARING)),
        'the right-drag really rotated the camera',
      ).toBeGreaterThan(10);
    }).toPass({ timeout: 30_000 });

    expect(
      await compass.getAttribute('data-orientation'),
      'a genuine hand rotation must still hand the bearing to the user (#230 over-correction guard)',
    ).toBe('free');
  } finally {
    server.kill();
  }
});

test('scale bar: labels the rendered viewport, never swallows a map tap, and clears the Live readout', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    const bar = page.locator('.scale-bar');
    await expect(bar).toBeVisible();
    await page.waitForLoadState('networkidle');

    // An integer magnitude and one of the three chart units — never a
    // decimal, and never an empty bar.
    await expect(page.locator('.scale-bar-label')).toHaveText(/^\d+ (sm|kbl|m)$/);
    await expect(bar).toHaveAttribute(
      'aria-label',
      /^Maßstab: \d+ (Seemeilen?|Kabellängen?|Meter)$/,
    );
    // The drawn bracket always reads as a bar: 40-100 px of the 100 px
    // reference span, by construction of the 1-2-5 rung ladder.
    const width = await page
      .locator('.scale-bar-bracket')
      .evaluate((el) => Number.parseFloat((el as HTMLElement).style.width));
    expect(width).toBeGreaterThanOrEqual(40);
    expect(width).toBeLessThanOrEqual(100);

    // pointer-events:none is load-bearing — arm tap-to-pick, click straight
    // ON the bar, and the pick must resolve from the map underneath it.
    await page
      .getByRole('region', { name: 'Start' })
      .getByRole('button', { name: 'Auf Karte wählen' })
      .click();
    const barBox = (await bar.boundingBox())!;
    await page.mouse.click(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await expect(page.getByRole('region', { name: 'Start' }).locator('.endpoint-name')).toHaveText(
      /°N\s.*°E/,
    );

    // --- narrow layout: the Live readout docks over this very corner ---
    await page.setViewportSize({ width: 375, height: 667 });
    await page.getByRole('tab', { name: 'Live' }).click();
    const card = page.locator('.map-area .live-view-no-plan');
    await expect(card).toBeVisible();
    // Poll the geometry rather than sleeping: the lift is applied from a
    // MutationObserver callback once the card commits.
    await expect
      .poll(
        async () => {
          const b = (await bar.boundingBox())!;
          const c = (await card.boundingBox())!;
          return Math.round(c.y - (b.y + b.height));
        },
        { message: 'scale bar sits clear above the docked Live readout' },
      )
      .toBeGreaterThanOrEqual(0);
  } finally {
    server.kill();
  }
});

// #208: `.app-bottom-sheet` is opaque and paints AFTER the map (App.tsx), so
// `toBeVisible()` on the compass/scale bar — which only checks that an
// element HAS a box and isn't `display:none`/`visibility:hidden` — passes
// even when the sheet fully covers it. These tests hit-test the real pixel
// stack (`document.elementsFromPoint`) and drive a REAL click, at the exact
// viewports the issue measured, on the two tabs a fresh narrow user actually
// lands on (Plan is the first-load tab).
// `neverSuppress: true` marks the two ordinary PORTRAIT phone sizes the issue
// itself measured (#208 review "Minor 5") — the exact case the first
// (40%-of-viewport heuristic) suppression design broke by over-suppressing.
// There, unlike the three landscape sizes above, suppression is a HARD
// FAILURE below, not an accepted branch: this is what pins the lift
// arithmetic end-to-end and would have caught that first design.
const OCCLUSION_VIEWPORTS = [
  { width: 844, height: 390, neverSuppress: false },
  { width: 740, height: 360, neverSuppress: false },
  { width: 667, height: 375, neverSuppress: false },
  { width: 375, height: 667, neverSuppress: true },
  { width: 390, height: 844, neverSuppress: true },
];
const OCCLUSION_TABS = ['Planen', 'Routen'] as const;

/** Every element (tag+class) at a point, front-to-back — used only for the
 * diagnostic dump attached to a failing assertion below. */
function elementsAt(page: Page, x: number, y: number): Promise<{ tag: string; cls: string }[]> {
  return page.evaluate(
    ([px, py]) =>
      document.elementsFromPoint(px, py).map((e) => ({
        tag: e.tagName,
        cls: typeof e.className === 'string' ? e.className : '',
      })),
    [x, y],
  );
}

/** True iff the TOPMOST element at (x, y) is `container` itself or one of its
 * descendants (e.g. the compass button or its needle/ring SVG parts). */
function topmostIsWithin(
  page: Page,
  x: number,
  y: number,
  containerSelector: string,
): Promise<boolean> {
  const arg: [number, number, string] = [x, y, containerSelector];
  return page.evaluate(([px, py, sel]) => {
    const container = document.querySelector(sel);
    const top = document.elementsFromPoint(px, py)[0];
    return container != null && top != null && container.contains(top);
  }, arg);
}

/** Hand-rotates the chart (right-drag well clear of the bottom sheet/header
 * at every tested viewport), then clicks the compass at its EXACT rendered
 * coordinates with a raw `page.mouse.click` — bypassing Playwright's own
 * actionability pre-check, so a build where the sheet actually intercepts
 * the click fails on the `data-orientation` assertion below, not on a
 * generic "element not clickable" timeout. */
async function rotateThenTapCompassHome(page: Page, compass: ReturnType<Page['locator']>) {
  const canvas = page.locator('canvas.maplibregl-canvas');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  // 100px down clears the header above and every measured viewport's sheet
  // top below (162-176px) — a point the drag can rely on reaching the map.
  const ry = box.y + 100;
  await page.mouse.move(cx, ry);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(cx + 150, ry, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  await expect(compass).toHaveAttribute('data-orientation', 'free');

  // Bounded retry, not a fixed wait: under full-suite load a single raw
  // click can occasionally land a frame before the browser has settled the
  // preceding right-button-up (observed once in a 15-spec full run, never in
  // isolation) — re-reads the box and re-clicks rather than falling back to
  // Playwright's own soft `.click()`, which would defeat the point of a raw
  // coordinate click (see the comment above). Each attempt is still the
  // exact same real click; only the OUTER wait is a retry, not a sleep.
  await expect(async () => {
    const cbox = (await compass.boundingBox())!;
    await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
    await expect(compass).toHaveAttribute('data-orientation', 'north-up', { timeout: 500 });
  }).toPass({ timeout: 5_000 });
}

test('#208: compass stays tappable and the scale bar never sits under .app-bottom-sheet, at every measured narrow/landscape viewport', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    await page.waitForLoadState('networkidle');
    expect(await installMapHandle(page)).toBe(true);

    const compass = page.locator('.compass-btn');
    const bar = page.locator('.scale-bar');

    for (const viewport of OCCLUSION_VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const tabName of OCCLUSION_TABS) {
        await test.step(`${viewport.width}x${viewport.height} / ${tabName}`, async () => {
          await page.getByRole('tab', { name: tabName }).click();

          // --- compass: real occlusion + real interaction ---
          const cbox = (await compass.boundingBox())!;
          // Not pushed off-screen or under other chrome (the issue's own
          // "don't make it worse" bar): fully inside the viewport.
          expect(cbox.x).toBeGreaterThanOrEqual(0);
          expect(cbox.y).toBeGreaterThanOrEqual(0);
          expect(cbox.x + cbox.width).toBeLessThanOrEqual(viewport.width);
          expect(cbox.y + cbox.height).toBeLessThanOrEqual(viewport.height);

          // The topmost hit at the compass's own centre must be the button
          // or one of its own icon parts (needle/ring/ticks) — never the tab
          // strip or the sheet the #208 bug reports showed instead.
          const compassCx = cbox.x + cbox.width / 2;
          const compassCy = cbox.y + cbox.height / 2;
          const compassOnTop = await topmostIsWithin(page, compassCx, compassCy, '.compass-btn');
          if (!compassOnTop) {
            const hitStack = await elementsAt(page, compassCx, compassCy);
            throw new Error(
              `compass is not the topmost hit at its centre: ${JSON.stringify(hitStack)}`,
            );
          }

          await rotateThenTapCompassHome(page, compass);

          // --- scale bar: real occlusion, or an honest, recorded suppression ---
          const barClass = await bar.getAttribute('class');
          if (barClass?.includes('scale-bar-suppressed')) {
            if (viewport.neverSuppress) {
              // #208 review "Minor 5": this is an ordinary portrait phone
              // with real headroom between .map-stack-tl and the sheet —
              // suppressing here is exactly the over-suppression bug the
              // first (40%-heuristic) design had, not an honest trade.
              throw new Error(
                `scale bar unexpectedly suppressed at ${viewport.width}x${viewport.height}/${tabName} — this viewport has real headroom and must show the lifted bar (#208 review "Minor 5")`,
              );
            }
            // #208 acceptance: suppression is an accepted, HONEST outcome —
            // proven honest here by also asserting it, not just assumed.
            await expect(bar).toBeHidden();
          } else {
            const bbox = (await bar.boundingBox())!;
            expect(bbox.x).toBeGreaterThanOrEqual(0);
            expect(bbox.y).toBeGreaterThanOrEqual(0);
            expect(bbox.x + bbox.width).toBeLessThanOrEqual(viewport.width);
            expect(bbox.y + bbox.height).toBeLessThanOrEqual(viewport.height);
            const barHit = await elementsAt(
              page,
              bbox.x + bbox.width / 2,
              bbox.y + bbox.height / 2,
            );
            expect(
              barHit.some((e) => e.cls.includes('app-bottom-sheet')),
              `elements under the scale bar's centre: ${JSON.stringify(barHit)}`,
            ).toBe(false);
          }
        });
      }
    }
  } finally {
    server.kill();
  }
});

test('#208 review "Major 2": the offline banner stays on top of the map-chrome tier, not covered by it', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    await page.waitForLoadState('networkidle');
    await page.setViewportSize({ width: 375, height: 667 });

    // `context.setOffline` flips `navigator.onLine`/fires the browser
    // 'offline' event, which is exactly what the app's own online/offline
    // state tracks — it does not need to (and per this repo's standing
    // offline-testing lesson, cannot be trusted to) block real network
    // fetches, only to flip that UI state, which is all this probe needs.
    await page.context().setOffline(true);
    // `hasText: 'Offline'` alone also matches the PWA's unrelated
    // `ReloadPrompt` "App & Karten offline verfügbar" ready-banner (a
    // `service worker installed` notice, not this online/offline state) —
    // 'Planung deaktiviert' ("planning disabled") is unique to this one.
    const banner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
    await expect(banner).toBeVisible();

    const bannerBox = (await banner.boundingBox())!;
    const stackBox = (await page.locator('.map-stack-tl').boundingBox())!;
    // Sanity: `.banner-area` (top: 3rem) and `.map-stack-tl` (top: 3.5rem)
    // overlap BY DESIGN (app.css) — if a layout change ever separates them,
    // this probe stops meaning anything, so fail loudly instead of silently
    // passing on an empty overlap.
    const overlapX = Math.max(bannerBox.x, stackBox.x) + 4;
    const overlapY = Math.max(bannerBox.y, stackBox.y) + 4;
    expect(
      overlapX,
      'banner and map-stack-tl no longer overlap horizontally — this probe needs updating',
    ).toBeLessThan(Math.min(bannerBox.x + bannerBox.width, stackBox.x + stackBox.width));
    expect(
      overlapY,
      'banner and map-stack-tl no longer overlap vertically — this probe needs updating',
    ).toBeLessThan(Math.min(bannerBox.y + bannerBox.height, stackBox.y + stackBox.height));

    const onTop = await topmostIsWithin(page, overlapX, overlapY, '.banner-area');
    if (!onTop) {
      const hitStack = await elementsAt(page, overlapX, overlapY);
      throw new Error(
        `offline banner text is covered at the overlap point: ${JSON.stringify(hitStack)}`,
      );
    }
  } finally {
    await page.context().setOffline(false);
    server.kill();
  }
});

test('#208 review "Minor 7": the scale bar does not cover the expanded attribution (no z-index on .scale-bar)', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    await page.waitForLoadState('networkidle');
    // The reviewer's own reproduction viewport — wide enough that the
    // expanded attribution's left edge reaches the bottom-left scale bar.
    await page.setViewportSize({ width: 1024, height: 600 });

    await page.locator('.maplibregl-ctrl-attrib-button').click();
    const attribution = page.locator('details.maplibregl-ctrl-attrib');
    await expect(attribution).toHaveClass(/maplibregl-compact-show/);

    const bar = page.locator('.scale-bar');
    const barBox = (await bar.boundingBox())!;
    const attribBox = (await attribution.boundingBox())!;
    const overlapX = Math.max(barBox.x, attribBox.x) + 2;
    const overlapY = Math.max(barBox.y, attribBox.y) + 2;
    expect(
      overlapX,
      'scale bar and the expanded attribution no longer overlap horizontally at this viewport',
    ).toBeLessThan(Math.min(barBox.x + barBox.width, attribBox.x + attribBox.width));
    expect(
      overlapY,
      'scale bar and the expanded attribution no longer overlap vertically at this viewport',
    ).toBeLessThan(Math.min(barBox.y + barBox.height, attribBox.y + attribBox.height));

    // `.scale-bar` is `pointer-events: none`, so it never appears in a hit
    // test on its own — temporarily re-enable it (the review's own isolation
    // technique) so paint order becomes hit-test order for this one probe.
    await page.evaluate(() => {
      (document.querySelector('.scale-bar') as HTMLElement).style.pointerEvents = 'auto';
    });
    const onTop = await topmostIsWithin(page, overlapX, overlapY, 'details.maplibregl-ctrl-attrib');
    if (!onTop) {
      const hitStack = await elementsAt(page, overlapX, overlapY);
      throw new Error(
        `attribution is covered by the scale bar at the overlap point: ${JSON.stringify(hitStack)}`,
      );
    }
  } finally {
    server.kill();
  }
});

test('#208 review "Major 3": .route-layer-controls (interactive) stays clear of .app-bottom-sheet with a real plan loaded', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    // Deterministic wind (E3 escape hatch, mirrors plan.spec.ts) — the wind
    // grid itself is irrelevant here, only that a real plan/route exists so
    // RouteLayer actually renders `.route-layer-controls` (plan-gated).
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('tab', { name: 'Planen' }).click();

    // Same harbor pair the review's own reproduction used.
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

    const controls = page.locator('.route-layer-controls');
    await expect(controls).toBeVisible();
    const liveTab = page.getByRole('tab', { name: 'Live' });
    const planTab = page.getByRole('tab', { name: 'Planen' });

    // #208's original pass ran WITHOUT a plan, so this cluster was empty —
    // 390x844 is the review's own negative control (it does not reach the
    // sheet, or the tab strip, even unfixed); the other three are the exact
    // set the round-2 review measured as broken.
    const viewports = [
      { width: 844, height: 390 },
      { width: 740, height: 360 },
      { width: 667, height: 375 },
      { width: 390, height: 844 },
    ];
    for (const vp of viewports) {
      await test.step(`${vp.width}x${vp.height}`, async () => {
        await page.setViewportSize(vp);
        const box = (await controls.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
        expect(box.y + box.height).toBeLessThanOrEqual(vp.height);

        // The cluster's LOWER edge is the row most likely to reach into the
        // sheet — the review's own finding was that its lower rows, not its
        // top, hit-tested to the tab-strip button.
        const lowerX = box.x + box.width / 2;
        const lowerY = box.y + box.height - 4;
        const onTop = await topmostIsWithin(page, lowerX, lowerY, '.route-layer-controls');
        if (!onTop) {
          const hitStack = await elementsAt(page, lowerX, lowerY);
          throw new Error(
            `.route-layer-controls is not the topmost hit at its lower edge (${vp.width}x${vp.height}): ${JSON.stringify(hitStack)}`,
          );
        }

        // #208 round-2 "R2-1" (the actual Blocker): the cluster being on
        // top of itself proves nothing about the TAB STRIP surviving next
        // to it — a real click, not a hit-test, because a timeout (the
        // strip receiving no events at all) is how this bug actually
        // surfaced, and `elementsFromPoint` alone would not have caught it.
        // #208 review "R3-3": an explicit, short timeout — without one, a
        // future regression here burns the full default budget (measured:
        // 2.4 min vs ~25s green) and reds with a bare `locator.click: Test
        // timeout` naming neither the viewport nor the cause.
        await liveTab.click({ timeout: 5_000 });
        await expect(liveTab).toHaveAttribute('aria-selected', 'true');
        // RouteLayer (and so .route-layer-controls) is NOT tab-gated —
        // reset to Planen so the next iteration's geometry reads are
        // against the same tab every time, matching how the cluster is
        // actually reached in the app.
        await planTab.click();
        await expect(planTab).toHaveAttribute('aria-selected', 'true');
      });
    }

    // #208 review "R2-3": the only real (non-hit-test) interaction proof in
    // this spec must run at a viewport where the bug actually existed, not
    // the 390x844 negative control it originally ran at (which would have
    // passed identically on the unfixed build — proving nothing). 740x360
    // is where the review measured the cluster's lower rows landing squarely
    // in the tab-strip's band pre-fix.
    await page.setViewportSize({ width: 740, height: 360 });
    const legend = controls.getByText('Legende');
    await expect(legend).toBeVisible();
    const legendDetails = controls.locator('details');
    await expect(legendDetails).not.toHaveAttribute('open');
    await legend.click();
    await expect(legendDetails).toHaveAttribute('open', '');
  } finally {
    server.kill();
  }
});
