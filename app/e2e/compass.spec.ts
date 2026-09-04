import { test, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { startPreview, mapReady, bannerHeightVar } from './helpers';

// #155 map orientation chrome: the north arrow / track-up toggle and the
// nautical scale bar, against the REAL MapLibre camera (jsdom has none, so
// the unit tests can only prove the state machine and the wiring).
//
// Track-up itself is exercised in the unit suite rather than here: engaging it
// needs a GPS fix under way, which live.spec.ts owns the fixture machinery
// for. What only a real browser can prove is the camera round trip — a hand
// rotation really reaching 'free', a tap really bringing the chart home, and
// the bar really measuring the rendered viewport.

// `mapReady` (map-handle-via-React-fiber readiness gate, #253) now lives in
// `./helpers` — promoted from three independent copies of this exact block
// (see that file's own comment for the full history/rationale).

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
 * second — so this is MapLibre's own end-of-gesture behaviour, not the
 * compass's). The camera assertions above survive that
 * because `Math.round(0.048)` is `+0`, but the needle counter-rotates, so it
 * paints `rotate(-0.11deg)` and `Math.round` yields `-0` — and `toBe` compares
 * with `Object.is`, where `Object.is(-0, 0)` is FALSE. The result was a
 * roughly 1-in-36 red CI run whose message (`Expected: 0, Received: -0`) reads
 * like the needle never got home when in fact it is a tenth of a degree out
 * and visually identical. `-0 + 0` is `+0`, while every other value is
 * unchanged, so the sign of zero stops mattering and a genuinely wrong bearing
 * still fails.
 *
 * The residual's cause is ROTATE INERTIA, and only that. Those 42 cycles were
 * measured while MapLibre's `bearingSnap` was still at its default 7, so the
 * snap was a candidate explanation at the time; #230 set `bearingSnap: 0`
 * (MapView.tsx), which removes that candidate outright and leaves the flick's
 * own inertia carrying the camera a fraction of a degree past its target.
 * The normalisation below is unaffected either way — it is about the sign of
 * zero, not about where the residual comes from.
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
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    const compass = page.locator('.compass-btn');
    await expect(compass).toBeVisible();
    await mapReady(page);

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
 *
 * REPEAT-CALLABLE, because `newCDPSession` allocates a NEW session on every
 * call and a second course-up probe added to this file later would otherwise
 * stack sessions silently on the same page. The session is therefore created
 * once per page and REUSED.
 *
 * It is deliberately NOT detached. Measured: `cdp.detach()` after the send
 * tears the override down with the session, the app's `watchPosition` never
 * receives a fix carrying a course, and the compass sits on
 * "Kursorientierung ohne GPS-Kurs nicht verfügbar" until the test times out.
 * The session is left attached and dies with the per-test `context` fixture
 * (`workers: 1`, `fullyParallel: false`), so nothing leaks across tests.
 *
 * ORDERING IS LOAD-BEARING at the call site: `grantPermissions` first, then
 * this override, and both BEFORE `page.goto` — Playwright clears the override
 * during page initialisation when the context carries no geolocation of its
 * own. Do not reshuffle.
 */
const courseFixSessions = new WeakMap<Page, CDPSession>();

async function setCourseFix(page: Page, context: BrowserContext, headingDeg: number) {
  let cdp = courseFixSessions.get(page);
  if (!cdp) {
    cdp = await context.newCDPSession(page);
    courseFixSessions.set(page, cdp);
  }
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
// `map._camera.isEasing()` below (here and in `releaseBranch`) reaches for
// the PRIVATE field, not a public API call.
//
// maplibre-gl 6 removed `Map#isEasing()`: `Map` no longer extends `Camera`, it
// now HOLDS one (the `_camera: Camera;` field, `ui/map.ts` ~:594, re-derived
// against maplibre-gl@6.5.0, 2026-08-28), and `isEasing()` lives only on
// that `Camera` (`ui/camera.ts:1189-1191`). CompassControl.tsx's production
// guard was rewritten to avoid this private field entirely (#253) — this e2e
// harness is the ONE deliberate exception, and the asymmetry is intentional:
// this is test-only instrumentation that needs the camera's true animation
// state (not merely a proxy for it) to tell "the gesture's end-of-gesture
// ease has not started yet" apart from "there is nothing left to settle" (see
// the comment above `cameraState`), and shipping code has no such need — it
// only ever has to judge ITS OWN commanded eases, which `commandedBearingRef`
// already tracks without touching `_camera`.
//
// Both call sites below guard the read rather than trust it blindly: if a
// future maplibre-gl release drops `_camera` too (or renames it), the probe
// throws a clear, named error instead of silently reading
// `undefined.isEasing` as falsy and reporting "at rest"/"non-inertial"
// forever — exactly the kind of structurally-invisible false green this
// repo's CLAUDE.md warns against. The check is duplicated (not shared via an
// outer helper) because `page.evaluate` serialises its callback by source
// text alone — it cannot close over a Node-side function.
type E2eMapWithCamera = { isMoving: () => boolean; _camera?: { isEasing?: () => boolean } };

function cameraState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as unknown as { __scE2eMap: E2eMapWithCamera; __scMoveEnds: number };
    const moving = w.__scE2eMap.isMoving();
    const camera = w.__scE2eMap._camera;
    if (!camera || typeof camera.isEasing !== 'function') {
      throw new Error(
        'maplibre-gl Map no longer exposes a working _camera.isEasing() — update this e2e probe for the new internal shape',
      );
    }
    const easing = camera.isEasing();
    if (w.__scMoveEnds > 0 && !moving && !easing) return 'at-rest';
    return `busy(moveends=${w.__scMoveEnds}, moving=${moving}, easing=${easing})`;
  });
}

/**
 * WHICH end-of-gesture branch `handler_manager` took on the release, sampled
 * two animation frames after the mouse-up — before the settle poll, which would
 * consume the evidence.
 *
 * `_onMoveEnd` prunes inertia-buffer entries older than 160 ms and bails below
 * two of them (handler_inertia.ts), so a runner that stalls frames under the
 * concurrent preview-server build can drop the release onto the `else` branch
 * (bare `moveend`, then `resetNorth`) instead of the inertial one. The test
 * still passes there — pre-fix the `else` branch snapped to north too, so both
 * arms of `shouldSnapToNorth` are genuinely covered by the assertions below —
 * but it has quietly stopped exercising the branch the bug was REPORTED on, and
 * nothing said so.
 *
 * This is a NUDGE, not a gate, and is therefore deliberately not asserted: the
 * degradation is a coverage gap, not a false pass, and turning a rare stalled
 * frame into a red run on a `retries: 0` suite would cost more than it buys.
 * Instead the branch is recorded as a test annotation (visible in the HTML
 * report on a GREEN run) and named in every failure message below, so it can
 * never again be invisible.
 *
 * Discriminator: only the inertial branch starts an `easeTo`, so only it leaves
 * the camera easing after the release.
 */
function releaseBranch(page: Page): Promise<'inertial' | 'non-inertial'> {
  return page.evaluate(
    () =>
      new Promise<'inertial' | 'non-inertial'>((resolve, reject) => {
        // See the comment above `cameraState` for why `_camera.isEasing()`
        // (private field) is used here and nowhere in production code.
        const w = window as unknown as { __scE2eMap: E2eMapWithCamera };
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const camera = w.__scE2eMap._camera;
            if (!camera || typeof camera.isEasing !== 'function') {
              reject(
                new Error(
                  'maplibre-gl Map no longer exposes a working _camera.isEasing() — update this e2e probe for the new internal shape',
                ),
              );
              return;
            }
            resolve(camera.isEasing() ? 'inertial' : 'non-inertial');
          }),
        );
      }),
  );
}

test('#230: a pan flick inside MapLibre’s default bearingSnap window keeps track-up, and a real hand rotation still drops to free', async ({
  page,
  context,
}) => {
  const server = await startPreview(page);
  try {
    // MapLibre's end-of-gesture branch is gated on `!browser.prefersReducedMotion`
    // (handler_manager.ts): a reduce preference would take the OTHER branch and
    // silently move this test off the code path it exists to cover.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await context.grantPermissions(['geolocation'], { origin: new URL(server.url).origin });
    await setCourseFix(page, context, SNAP_WINDOW_BEARING);

    await page.goto(server.url);
    await mapReady(page);

    // --- engage course-up: "show my position" is what feeds the compass a fix ---
    // #299: "Meine Position anzeigen" moved off the Plan tab's "Erweitert"
    // disclosure onto the dedicated Boot tab (SettingsPanel) — no Plan-tab
    // detour needed first, the control is reachable directly.
    await page.getByRole('tab', { name: 'Boot' }).click();
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

    // Sampled BEFORE the settle poll, which would consume the evidence. Not
    // asserted on purpose — see `releaseBranch`: a stalled runner degrading to
    // the `else` branch is a coverage gap, not a false pass, so it is made
    // legible (report annotation + every failure message below) rather than
    // turned into a red run.
    const branch = await releaseBranch(page);
    test.info().annotations.push({
      type: '#230 pan-flick release branch',
      description: `${branch} (handler_manager end-of-gesture; 'inertial' is the branch the bug was reported on)`,
    });

    // Settle FIRST. Both assertions below are auto-retrying and both would
    // otherwise be satisfiable mid-flight — measured, not theorised: on the
    // unfixed build one run reds on the bearing (already snapped to 0) and
    // another on the attribute (bearing still passing through 3 while the mode
    // has already gone). Reading a settled camera makes the outcome the state
    // the USER is left in, which is what the issue is about.
    await expect
      .poll(() => cameraState(page), {
        message: `camera settles after the pan flick (${branch} release)`,
      })
      .toBe('at-rest');

    // BOTH halves, because the two pre-fix paths fail differently and either
    // assertion alone is blind to one of them (handler_manager.ts):
    //   - inertial ease present -> `easeTo({bearing: 0}, {originalEvent})`, so
    //     the compass sees a hand rotation and demotes to `free`; its own 1°
    //     snap then pulls it on to `north-up`. The ATTRIBUTE catches this.
    //   - no inertia -> bare moveend then `map.resetNorth()`, which carries NO
    //     eventData: the mode stays `track-up` while the chart silently
    //     un-rotates, so only the BEARING catches it.
    expect(
      await bearing(page),
      `a pan flick must not rotate the chart (#230; ${branch} release)`,
    ).toBe(SNAP_WINDOW_BEARING);
    expect(
      await compass.getAttribute('data-orientation'),
      // ONE-SHOT ON PURPOSE, unlike the `free` assertion at the end of this
      // test: this asserts a state that must be UNCHANGED, and `toHaveAttribute`
      // would pass on its first poll and be blind to a demotion arriving a
      // moment later. The explicit settle above is what makes the one-shot the
      // stronger instrument here.
      `a pan flick must not drop course-up (#230; ${branch} release)`,
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
    //
    // 60 s, not 30: the measured worst case was 3 attempts on a DEV machine,
    // and CI is slower — by how much for PLAYWRIGHT is unmeasured here
    // (CLAUDE.md's ~2.1x plain / ~2.5x coverage figures are the vitest unit
    // suite, not this runner), so this budget is sized for headroom, not
    // derived from a ratio. This suite is `retries: 0`, so an exhausted
    // budget is a red run with no second chance. Each attempt can
    // additionally burn the full default 5 s `expect` timeout inside the settle
    // poll before `toPass` even retries. The headroom is free — everything else
    // in this test (preview start, goto, tab clicks, one tap, one flick) is far
    // inside `playwright.config.ts`'s 120 s per-test budget — and this is a
    // retry budget, not a per-test timeout tightened below the file config.
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
    }).toPass({ timeout: 60_000 });

    // RETRYING form, unlike the one-shot `track-up` read above, and the
    // asymmetry is deliberate: that one asserts a state which must be
    // UNCHANGED (where a first-poll pass would be blind to a later demotion),
    // this one asserts a state which must have ARRIVED. `dropToFree()` is
    // written from a `rotate` handler mid-gesture, so React has near-certainly
    // flushed by now — but on a slower CI runner with `retries: 0` the
    // retrying form is strictly cheaper, it is what the #155 test uses for this
    // identical assertion, and `toHaveAttribute` still reports the actual
    // attribute value on timeout, so the 3am diagnostic is unchanged.
    await expect(
      compass,
      'a genuine hand rotation must still hand the bearing to the user (#230 over-correction guard)',
    ).toHaveAttribute('data-orientation', 'free');
  } finally {
    server.kill();
  }
});

test('scale bar: labels the rendered viewport, never swallows a map tap, and clears the Live readout', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    const bar = page.locator('.scale-bar');
    await expect(bar).toBeVisible();
    await mapReady(page);

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

// #412 fix-wave (PR #419 review, Minor 1): formats an overlap tracker that
// was initialised to `null` (never `0` — see the two `#368` overlap guards
// below) so a failure message can say "unmeasured" instead of fabricating a
// "0" that reads as a genuine clean measurement.
function fmtOverlap(v: number | null): string {
  return v === null ? 'unmeasured' : String(v);
}

// No 3-CONSECUTIVE stability requirement on the overlap polls below or on
// the Major-1 hit-test poll in the `"Major 3"` test further down this file
// (#412 fix-wave, PR #419 review, Minor 2 — considered and declined here,
// not silently skipped). See `layout.spec.ts`'s `settledHitDescription`
// comment for the full argument: `labels.spec.ts`'s three-consecutive-at-
// 400ms pattern exists to outlast a value that can go stale AFTER first
// matching (MapLibre's placement throttle re-running a query); the
// `--sc-banner-height` push these polls depend on only GROWS within any one
// test's poll window here, so a single satisfying tick has no live producer
// left that could shrink the clearance back a tick later. Reachability of a
// stale-LARGE-then-settles-lower transient is assessed LOW, not proven
// impossible.

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
 * generic "element not clickable" timeout.
 *
 * PRE/POSTCONDITION (#383): the camera must be AT REST when this is called,
 * and it is at rest again when it returns — a right-drag begun while a camera
 * animation is still running is discarded by MapLibre without a trace (full
 * mechanism at the closing gate). The caller's loop repeats this ten times,
 * so the postcondition below is what establishes the precondition for every
 * call after the first; the first is covered by the cold-start camera
 * (north-up at bearing 0, and nothing between `mapReady()` and it — the
 * `.reload-prompt` dismissal, `setViewportSize`, the tab click — commands a
 * camera animation). */
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
  // #383: assert the CAMERA first, so a swallowed gesture reports the bearing
  // it never left instead of only the attribute that consequently never
  // changed. `data-orientation` staying `north-up` is the SYMPTOM of both a
  // gesture that never reached MapLibre and a demotion that failed to fire;
  // the bearing is what tells them apart, and a run that reds at 3am has to
  // carry that number itself (the #243/#252 rule). Kept BEFORE the attribute
  // assertion, which still runs and still catches the rotated-but-not-demoted
  // direction on its own.
  //
  // This assertion is only MEANINGFUL because the closing gate below ran on
  // the previous call: it is the gate that guarantees the camera enters this
  // drag at rest on bearing 0, so any non-zero reading here can only have
  // come from the drag. Measured while mutation-checking that gate (#383):
  // with the gate removed, three of four reproduced failures passed THIS
  // assertion and failed the attribute one instead — the poll was reading
  // the PREVIOUS ease's residual bearing on its way down to 0, not a
  // rotation this drag caused. Do not read that as the compass failing to
  // demote a genuinely rotated camera; `onMoveEnd` demotes on exactly that
  // condition, and the instrumented traces put max |bearing| across the
  // whole gesture at 0.
  await expect
    .poll(() => bearing(page), { message: 'the right-drag really rotated the camera (#383)' })
    .not.toBe(0);
  await expect(compass).toHaveAttribute('data-orientation', 'free');

  // Zeroed HERE, before the tap that starts the ease this helper's closing
  // gate waits out — see that gate for why the ease, not the tap, is what the
  // next caller has to be protected from.
  await armCameraRest(page);

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

  // #383, the whole fix — an ADDED gate, not a weakened one, and a state
  // signal rather than a sleep.
  //
  // The tap above is satisfied SYNCHRONOUSLY: `handleTap` calls `applyMode`
  // and only then `easeBearing(0, EASE_NORTH_MS)`, so `data-orientation`
  // reads `north-up` at t=0 of a 600 ms ease. Nothing used to wait for that
  // ease, and this helper is called ten times in a row (5 viewports x 2
  // tabs), so the NEXT call's right-drag routinely landed inside the
  // PREVIOUS call's still-running ease — and a drag that starts there is
  // swallowed whole:
  //
  //   MapLibre arms `mouseRotate` on the `mousedown` (measured: `_lastPoint`
  //   set, `_moveStateManager._eventButton = 2`). One frame later the ease
  //   reaches t=1 and `_renderFrameCallback` calls a BARE `this.stop()`
  //   (`camera.ts:1246`) — no `allowGestures` — which runs `_stopHandlers()`
  //   (`camera.ts:1213` -> `map.ts:771`, where `Map` supplies it to `Camera`
  //   as a constructor callback) -> `HandlerManager.stop(false)`, which calls
  //   `reset()` on EVERY handler (`handler_manager.ts:342-349`; its
  //   `_updatingCamera` early return at `:344` does not apply on a rAF,
  //   which is why it fires here). `mouseRotate` is disarmed back to
  //   `_lastPoint = undefined` mid-gesture, so all ten subsequent
  //   `mousemove`s with `buttons: 2` produce a bearing delta of exactly
  //   zero, no `rotate`/`rotatestart` event ever fires, and the compass
  //   correctly stays `north-up` — the camera genuinely never moved. That is
  //   MapLibre's own behaviour for any drag begun during any camera
  //   animation; CompassControl is not involved, and neither is the readiness
  //   wait (raising the assertion timeout cannot help a bearing that is
  //   never going to change).
  //
  // Every maplibre line number in this block was read off the PINNED install
  // (`app/node_modules/maplibre-gl`, **6.1.0** — `app/package.json` carries
  // `^6.1.0`), and the version is named because these DO move between
  // releases: at 6.0.0 the `map.ts` site sits ~13 lines earlier, which is
  // exactly the kind of near-miss that reads as a verified citation. Re-read
  // them, and re-state the version, after any maplibre-gl upgrade.
  //
  // So the helper now leaves the camera where its own name promises: home
  // AND stopped. `cameraState` needs the moveend COUNT as well as the flags,
  // which is what the `armCameraRest` call above is positioned for.
  await expect
    .poll(() => cameraState(page), { message: 'the tap-home ease finishes before the next drag' })
    .toBe('at-rest');
  expect(await bearing(page), 'the tap really brought the chart home').toBe(0);
}

test('#208: compass stays tappable and the scale bar never sits under .app-bottom-sheet, at every measured narrow/landscape viewport', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);

    // The PWA's SW registration finishes at roughly the same time as
    // mapReady() above and shows a ONE-SHOT "offline ready" toast
    // (ReloadPrompt, present in every fresh e2e context/profile — see
    // #368's app.css comment). Left up, it is a rendered `.banner-area`
    // banner, which #368's narrow-layout clearance rule pushes
    // `.map-stack-tl`/`.route-layer-controls` down to avoid — that push
    // eats into ScaleBar's own measured clearance at 375x667 enough to
    // suppress it, and this sweep's `neverSuppress: true` was tuned against
    // the BASELINE (no-banner) geometry. Dismiss it up front (best-effort —
    // `.click()`'s own auto-wait no-ops harmlessly if it never appears) so
    // the rest of this test, which is not itself about banners, runs
    // against that same baseline.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});
    // Assert the INTENT, not just that the click no-op'd harmlessly: a
    // `.catch(() => {})` alone swallows a genuine selector drift (e.g.
    // `.reload-prompt`/`.banner-dismiss` renamed) exactly as silently as it
    // swallows an absent toast, leaving this sweep back on the banner-
    // present geometry it exists to avoid, with no signal that happened.
    await expect(page.locator('.reload-prompt')).toHaveCount(0);

    const compass = page.locator('.compass-btn');
    const bar = page.locator('.scale-bar');

    for (const viewport of OCCLUSION_VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const tabName of OCCLUSION_TABS) {
        await test.step(`${viewport.width}x${viewport.height} / ${tabName}`, async () => {
          await page.getByRole('tab', { name: tabName }).click();

          // --- compass: real occlusion + real interaction ---
          // #422 (residual of #412): geometry is RE-SAMPLED on every poll
          // tick below, never frozen before the hit-test that consumes it —
          // a `boundingBox()` read followed by a hit-test at a coordinate
          // frozen from that read is exactly the #412 race (a real
          // interception and a stale-coordinate read are byte-identical), so
          // the bounds check AND the hit-test now live inside one poll
          // callback that re-reads `compass.boundingBox()` every tick, the
          // same pattern already used at this file's #412-fixed sites
          // (e.g. the `#208: … at every measured narrow/landscape viewport`
          // tab-strip poll above). Polls the VALUE, never a collapsed
          // boolean, so a failure names exactly which check failed and with
          // what numbers.
          await expect
            .poll(
              async () => {
                const b = (await compass.boundingBox())!;
                // Not pushed off-screen or under other chrome (the issue's
                // own "don't make it worse" bar): fully inside the viewport.
                if (
                  b.x < 0 ||
                  b.y < 0 ||
                  b.x + b.width > viewport.width ||
                  b.y + b.height > viewport.height
                ) {
                  return `out of bounds: box=${JSON.stringify(b)} viewport=${viewport.width}x${viewport.height}`;
                }
                // The topmost hit at the compass's own centre must be the
                // button or one of its own icon parts (needle/ring/ticks) —
                // never the tab strip or the sheet the #208 bug reports
                // showed instead.
                const compassCx = b.x + b.width / 2;
                const compassCy = b.y + b.height / 2;
                const onTop = await topmostIsWithin(page, compassCx, compassCy, '.compass-btn');
                if (onTop) return 'in-bounds & on-top';
                const hitStack = await elementsAt(page, compassCx, compassCy);
                return JSON.stringify(hitStack);
              },
              { timeout: 10_000 },
            )
            .toBe('in-bounds & on-top');

          await rotateThenTapCompassHome(page, compass);

          // #368 fix-wave, round 5: the toast dismissal above only proves
          // `.banner-area` was empty at ONE point in time, before this
          // per-viewport/per-tab loop even starts — 5 viewports x 2 tabs,
          // each with a drag-rotate, a raw click, and a `toPass` retry, is a
          // far wider window for a late SW install to still mount the toast
          // than the point-in-time checks round 4 closed elsewhere. Unlike
          // those, a stray banner here does NOT produce a vacuous pass: it
          // pushes `.map-stack-tl` down (app.css's `:has()` banner-clearance
          // rule), drops ScaleBar's ceiling below its floor, and the
          // `neverSuppress` branch below throws "scale bar unexpectedly
          // suppressed... has real headroom" — pointing squarely at #208's
          // over-suppression bug, which would be the wrong diagnosis
          // entirely; someone would go hunting in ScaleBar's suppression
          // rule for a defect that is not there. Asserting the actual
          // condition here, right before that branch, makes the failure
          // name its real cause instead of a plausible-looking neighbour.
          await expect(
            page.locator('.banner-area .banner'),
            `a banner appeared mid-sweep at ${viewport.width}x${viewport.height}/${tabName} — this pushes .map-stack-tl down and would misdiagnose the scale-bar check below as #208 over-suppression`,
          ).toHaveCount(0);

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
            // #422 (residual of #412): geometry is RE-SAMPLED on every poll
            // tick below, never frozen before the hit-test that consumes
            // it — see the compass block above for the full mechanism and
            // why a frozen coordinate here is byte-identical, pass-or-fail,
            // to a real interception.
            await expect
              .poll(
                async () => {
                  const b = (await bar.boundingBox())!;
                  if (
                    b.x < 0 ||
                    b.y < 0 ||
                    b.x + b.width > viewport.width ||
                    b.y + b.height > viewport.height
                  ) {
                    return `out of bounds: box=${JSON.stringify(b)} viewport=${viewport.width}x${viewport.height}`;
                  }
                  const barHit = await elementsAt(page, b.x + b.width / 2, b.y + b.height / 2);
                  if (barHit.some((e) => e.cls.includes('app-bottom-sheet'))) {
                    return `under app-bottom-sheet: ${JSON.stringify(barHit)}`;
                  }
                  return 'in-bounds & clear';
                },
                { timeout: 10_000 },
              )
              .toBe('in-bounds & clear');
          }
        });
      }
    }
  } finally {
    server.kill();
  }
});

test('#208 review "Major 2" / #368: the offline banner and .map-stack-tl no longer share screen space', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
    await page.setViewportSize({ width: 375, height: 667 });

    // Dismiss the incidental SW "offline ready" toast so this test pins the
    // SINGLE-banner case its own numbers below assume, rather than whichever
    // of the one- or two-banner cases SW install timing happened to produce.
    // The gap between them is large at this exact viewport: a 152.15px push
    // clears a 96px (one-banner) bottom edge by ~56px but a 146px
    // (two-banner) edge by only ~6px — silently choosing between a loose and
    // a near-zero margin is not an acceptable thing to leave to timing.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

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
    // Pin the count AT THE MOMENT OF MEASUREMENT (not at the dismiss attempt
    // above, whose 5s timeout is swallowed) — a late-mounting toast between
    // here and there would silently swap this test onto the two-banner case.
    await expect(page.locator('.banner-area .banner')).toHaveCount(1);

    // #368: this test USED TO assert `.banner-area` (top: 3rem) and
    // `.map-stack-tl` (top: 3.5rem) overlap BY DESIGN and that the Tier-3
    // banner wins the paint AND hit test at that overlap point — that was
    // correct as far as it went, but "who wins" was the wrong question: Tier
    // 3 winning the paint there also meant it won the hit test, so the
    // banner silently intercepted taps meant for the "Wassertiefen" toggle
    // underneath it (a same-tier-style z-index fix could only have changed
    // WHICH element lost). #368's fix moves `.map-stack-tl` clear of a
    // rendered banner's footprint instead, so the two no longer occupy the
    // same region at all — asserted here as zero overlap, replacing the old
    // "who's on top at the overlap point" probe (still exercised, in more
    // depth, by layout.spec.ts's own #368 regression test).
    // #412: geometry is RE-SAMPLED on every poll tick below, never frozen
    // from a single read taken before the `--sc-banner-height` ResizeObserver
    // write (and the CSS push it drives) has settled — a stale pre-push read
    // and a genuine, still-live overlap would otherwise produce the
    // byte-identical `toBe(0)` failure. `lastOverlapWidth`/`lastOverlapHeight`
    // are tracked outside the poll purely so the catch below can still name
    // the actual last-observed numbers (`expect.poll`'s own `message` option
    // must be a static string, not a function of the polled value).
    //
    // #412 fix-wave (PR #419 review, Minor 1): initialised to `null`, NOT
    // `0` — a `0` initial value is indistinguishable from a genuine "no
    // overlap" MEASUREMENT. If `boundingBox()` ever returns `null` (element
    // not visible/detached), the `!` assertion below throws inside the poll
    // callback — and, MECHANISM CORRECTED (Minor 6, verified against the
    // installed `@playwright/test@1.62.1`, matching `app/package-lock.json`'s
    // pin — `node_modules/playwright/lib/matchers/expect.js:13387-13388`
    // calls `await actual()` OUTSIDE its own `try`, and the `raceAgainstDeadline`/
    // `pollAgainstDeadline` helpers it calls into
    // (`node_modules/playwright-core/lib/coreBundle.js:4270-4305`) never
    // `.catch()` that call either): a throwing poll callback is NOT retried
    // as a non-matching tick — it propagates immediately and fails the WHOLE
    // `expect.poll(...)` on the spot, same-tick. So this is a single-tick
    // failure mode, not a "throws every tick and never gets assigned" one:
    // the only way these trackers stay at their initial value is a `null`
    // box on the very FIRST read, which throws straight out to the `catch`
    // below before ever assigning anything. Without this fix the catch would
    // report `overlapWidth=0 overlapHeight=0` as if it had actually measured
    // a clean, non-overlapping layout — a fabricated measurement, not an
    // honest "never observed".
    let lastOverlapWidth: number | null = null;
    let lastOverlapHeight: number | null = null;
    try {
      await expect
        .poll(
          async () => {
            const bannerBox = (await banner.boundingBox())!;
            const stackBox = (await page.locator('.map-stack-tl').boundingBox())!;
            lastOverlapWidth = Math.max(
              0,
              Math.min(bannerBox.x + bannerBox.width, stackBox.x + stackBox.width) -
                Math.max(bannerBox.x, stackBox.x),
            );
            lastOverlapHeight = Math.max(
              0,
              Math.min(bannerBox.y + bannerBox.height, stackBox.y + stackBox.height) -
                Math.max(bannerBox.y, stackBox.y),
            );
            // AREA, not the two dimensions separately: both clusters are
            // left-anchored, so they always share an x-range
            // (overlapWidth > 0) even once the fix moves them fully clear of
            // each other vertically — asserting `overlapWidth === 0` would
            // fail on that harmless shared x-range, not on a real overlap.
            // Two rects only truly intersect when BOTH dimensions overlap;
            // the product is 0 whenever either one is.
            return lastOverlapWidth * lastOverlapHeight;
          },
          { timeout: 10_000 },
        )
        .toBe(0);
    } catch (e) {
      const height = await bannerHeightVar(page);
      throw new Error(
        `overlapWidth=${fmtOverlap(lastOverlapWidth)} overlapHeight=${fmtOverlap(lastOverlapHeight)} ` +
          `bannerHeight=${height || '(unset)'}\n${(e as Error).message}`,
        { cause: e },
      );
    }

    // The banner itself must still be fully legible — nothing else in the
    // map-chrome tier may cover IT either, now that they no longer share
    // space to arbitrate in the first place.
    //
    // Cost of this rewrite, worth recording rather than losing silently:
    // nothing from the map-chrome tier is at the banner's own centre any
    // more (that's the fix), so `topmostIsWithin` below can now only ever
    // fail on a WHOLLY NEW occluder appearing — it no longer exercises
    // "Tier 3 beats Tier 2 at a genuine overlap point" at all, which is what
    // #208 round 2 was originally about. That guarantee is presently
    // covered only BY CONSTRUCTION (the two no longer overlap), not by an
    // assertion — a future change that legitimately reopens an overlap
    // would have no test left to answer whether the tier order still wins
    // it correctly.
    //
    // Fresh read, taken AFTER the poll above has already confirmed the
    // geometry settled — not a re-use of a pre-settle value.
    const settledBannerBox = (await banner.boundingBox())!;
    const bannerCenterX = settledBannerBox.x + settledBannerBox.width / 2;
    const bannerCenterY = settledBannerBox.y + settledBannerBox.height / 2;
    const onTop = await topmostIsWithin(page, bannerCenterX, bannerCenterY, '.banner-area');
    if (!onTop) {
      const hitStack = await elementsAt(page, bannerCenterX, bannerCenterY);
      throw new Error(
        `offline banner text is covered at its own center: ${JSON.stringify(hitStack)}`,
      );
    }
  } finally {
    await page.context().setOffline(false);
    server.kill();
  }
});

// #368 fix-wave finding (app.css:749 review thread): the banner-clearance
// push SPENDS `.map-stack-tl`'s height budget — its rendered BOTTOM edge
// moves down by roughly the same amount `top` does, because content that
// already filled the base budget keeps filling the smaller one too. `Scale
// Bar`'s own `ceiling` (ScaleBar.tsx) is computed from that rendered bottom,
// so once the banner-inclusive push is large enough, `floor > ceiling` and
// the bar suppresses — at 375x667, the exact viewport `OCCLUSION_VIEWPORTS`
// (above) marks `neverSuppress: true` for with the #208 review "Minor 5"
// rationale "this viewport has real headroom and must show the lifted bar".
// Investigated and accepted as a genuine trade, not a bug to route around:
//   - A bounded/partial push (spending LESS of the budget) was tried by hand
//     against a live build and found to help ScaleBar only by squeezing
//     `.data-layer-controls` harder — directly undoing headroom #368 itself
//     needed for the depth/seamark toggles to stay usable. A LOOSER push
//     (spending MORE) does not help ScaleBar at all: with content already
//     filling the tighter budget, more room only lets the cluster's
//     rendered bottom grow, which can only make `ceiling` smaller.
//   - A separate, real bug WAS found and fixed in the course of this
//     investigation: ScaleBar had no observer on `.banner-area` mounting or
//     unmounting a banner (only on the sheet, the live view, and its own
//     box), so `apply()` never re-ran on that trigger and the bar rendered
//     fully OVERLAPPING `.map-stack-tl`'s new position (measured live,
//     1837.7px^2) instead of cleanly suppressing, until an unrelated resize
//     forced a fresh read. Fixed with a `MutationObserver` on `.banner-area`
//     (ScaleBar.tsx) — this test is what that fix makes reliably assertable;
//     without it, `barClass` below would depend on timing/resize history
//     rather than being a function of the banner state alone.
// Per the Tier principle documented above `.app-header` in app.css (an
// element outranks another when a user unable to reach/see it is the WORSE
// outcome): a clickable depth toggle and a legible offline banner both
// outrank the passive, Tier-0 scale bar, so honest suppression here is the
// accepted answer — pinned explicitly rather than left as an undisclosed
// side effect of the #368 push.
test('#368 fix-wave: partial-push band (375x667) — checkbox clears the banner, scale bar honestly suppresses', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);

    // Dismiss the incidental SW "offline ready" toast FIRST and confirm
    // `.banner-area` is genuinely empty before the probe. This is load-
    // bearing for what this test actually exercises, not just tidiness: if
    // the toast were left up, it would likely have already pushed
    // `.map-stack-tl` down (and fired ScaleBar's sheet/tab-switch-triggered
    // `apply()` at least once AFTER that push) before `setOffline(true)`
    // below ever runs — at which point `setOffline` mounting a SECOND
    // banner changes NOTHING about `.map-stack-tl`'s geometry (the CSS
    // `:has()` gate is a binary "any banner at all", not banner-COUNT-based,
    // so 1-banner and 2-banner states push by the identical amount at a
    // given viewport height). That would let a suppressed/cleared result
    // pass even with `ScaleBar`'s `.banner-area` `MutationObserver` removed
    // — MEASURED: the first version of this test did exactly that, passing
    // unchanged with the observer deleted. Starting from a confirmed-empty
    // `.banner-area`, with the viewport/tab already settled and NO further
    // resize or tab-switch after `setOffline(true)`, makes that one call the
    // ONLY thing that can plausibly re-trigger `apply()` — which is what
    // makes this test actually depend on the observer under test.
    await page
      .locator('.reload-prompt .banner-dismiss')
      .click({ timeout: 5_000 })
      .catch(() => {});

    await page.setViewportSize({ width: 375, height: 667 });
    await page.getByRole('tab', { name: 'Planen' }).click();

    await page.context().setOffline(true);
    const banner = page.locator('.banner-message', { hasText: 'Planung deaktiviert' });
    await expect(banner).toBeVisible();
    // The count that actually matters is at the MOMENT OF MEASUREMENT, not
    // at the dismiss click above: the dismiss click's own 5s timeout is
    // swallowed (`.catch(() => {})`), so on a loaded CI runner or a cold
    // profile where the SW precache install finishes later than that budget,
    // the toast can still mount during setViewportSize/the tab click/
    // setOffline below — at which point `.banner-area` would hold TWO
    // banners while `toHaveCount(0)` right after the dismiss attempt had
    // already (correctly, at that instant) passed on a genuinely empty area.
    // That is self-concealing: the failure mode is a green test, since the
    // two-banner case pushes `.map-stack-tl` by the SAME amount as the
    // one-banner case (`:has()` is a binary "any banner", not banner-COUNT-
    // based) — the exact shape that let the first version of this test pass
    // unchanged with the observer deleted. Asserting the count HERE, right
    // after the banner this test is ABOUT becomes visible, pins which case
    // actually ran instead of assuming it.
    await expect(page.locator('.banner-area .banner')).toHaveCount(1);

    const depthToggle = page.getByRole('checkbox', { name: 'Wassertiefen' });
    // #412: this was the MORE exposed of the two `#368` guards named in the
    // issue — a single, un-polled `boundingBox()` read on each side feeding
    // an IMMEDIATE one-shot `toBe(0)`, with zero settle tolerance for a
    // coordinate sampled before the `--sc-banner-height` push. Both boxes are
    // now RE-SAMPLED on every poll tick; `lastOverlapWidth`/`lastOverlapHeight`
    // are tracked outside the poll purely so the catch below can still name
    // the actual last-observed numbers (`expect.poll`'s own `message` option
    // must be a static string, not a function of the polled value).
    //
    // #412 fix-wave (PR #419 review, Minor 1): initialised to `null`, not
    // `0` — see `fmtOverlap`'s own comment for why a `0` default would
    // fabricate a measurement that never happened. Per the `"Major 2"` test's
    // own comment above (Minor 6, mechanism verified against the installed
    // `@playwright/test@1.62.1`): a `null` box throws on the FIRST tick and
    // propagates immediately — `expect.poll` does not retry a throwing
    // callback — so these trackers stay unassigned only in that single-tick
    // case, never because of repeated per-tick throws.
    let lastOverlapWidth: number | null = null;
    let lastOverlapHeight: number | null = null;
    try {
      await expect
        .poll(
          async () => {
            const toggleBox = (await depthToggle.boundingBox())!;
            const bannerBox = (await banner.boundingBox())!;
            lastOverlapWidth = Math.max(
              0,
              Math.min(bannerBox.x + bannerBox.width, toggleBox.x + toggleBox.width) -
                Math.max(bannerBox.x, toggleBox.x),
            );
            lastOverlapHeight = Math.max(
              0,
              Math.min(bannerBox.y + bannerBox.height, toggleBox.y + toggleBox.height) -
                Math.max(bannerBox.y, toggleBox.y),
            );
            return lastOverlapWidth * lastOverlapHeight;
          },
          { timeout: 10_000 },
        )
        .toBe(0);
    } catch (e) {
      const height = await bannerHeightVar(page);
      throw new Error(
        `overlapWidth=${fmtOverlap(lastOverlapWidth)} overlapHeight=${fmtOverlap(lastOverlapHeight)} ` +
          `bannerHeight=${height || '(unset)'}\n${(e as Error).message}`,
        { cause: e },
      );
    }

    // Poll the class STRING, not a derived boolean — a bare
    // `.toBe(true)` here would discard exactly which class was present on
    // a failure, the same lesson CLAUDE.md records for #243's dogleg.
    await expect
      .poll(() => page.locator('.scale-bar').getAttribute('class'), { timeout: 10_000 })
      .toMatch(/\bscale-bar-suppressed\b/);
  } finally {
    await page.context().setOffline(false);
    server.kill();
  }
});

test('#208 review "Minor 7": the scale bar does not cover the expanded attribution (no z-index on .scale-bar)', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
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
  const server = await startPreview(page);
  try {
    // Deterministic wind (E3 escape hatch, mirrors plan.spec.ts) — the wind
    // grid itself is irrelevant here, only that a real plan/route exists so
    // RouteLayer actually renders `.route-layer-controls` (plan-gated).
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await mapReady(page);
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

        // The cluster's LOWER edge is the row most likely to reach into the
        // sheet — the review's own finding was that its lower rows, not its
        // top, hit-tested to the tab-strip button.
        //
        // #412 fix-wave (PR #419 review, Major 1 + Minor 8): this test never
        // dismisses the SW's one-shot "offline ready" toast, so a
        // late-mounting toast can push `.route-layer-controls` (one of the
        // two selectors the `--sc-banner-height` narrow-layout clearance
        // rule mirrors) down mid-test. Every geometry-dependent assertion
        // below — the four viewport-bounds checks AND the lower-edge hit
        // test — is now folded into ONE poll that RE-SAMPLES a fresh
        // `controls.boundingBox()` on every tick, never a `box` frozen
        // before the loop's own actions run. Minor 8: the bounds checks used
        // to read that same frozen `box`, so a push landing between the read
        // and the (separate) hit-test poll could leave the bounds checks
        // silently validating stale, pre-push geometry — folding them into
        // the same re-sampling poll removes that gap entirely, at zero extra
        // cost (one `boundingBox()` call already had to happen every tick
        // for the hit test).
        //
        // Reachability of the underlying race here is UNKNOWN, not
        // "low"/"dormant" — see this PR's own Major-3 review finding: the
        // window that matters is the roughly-10ms gap between consecutive
        // CDP round trips (`boundingBox()`, then `elementsFromPoint`), and no
        // construction attempted in this PR's mutation-check hit it. The fix
        // is applied regardless because it is strictly more correct and
        // costs nothing.
        //
        // Polls the VALUE, never a collapsed boolean: `'in-bounds & on-top'`
        // on success, or a string naming EXACTLY which check failed and with
        // what numbers — a `.toBe(true)` here would discard which of the two
        // failure classes (out of viewport vs. wrong topmost element) or the
        // frozen bounds checks' inaccuracy.
        await expect
          .poll(
            async () => {
              const b = (await controls.boundingBox())!;
              if (b.x < 0 || b.y < 0 || b.x + b.width > vp.width || b.y + b.height > vp.height) {
                return `out of bounds: box=${JSON.stringify(b)} viewport=${vp.width}x${vp.height}`;
              }
              const lx = b.x + b.width / 2;
              const ly = b.y + b.height - 4;
              const onTop = await topmostIsWithin(page, lx, ly, '.route-layer-controls');
              if (onTop) return 'in-bounds & on-top';
              const hitStack = await elementsAt(page, lx, ly);
              return JSON.stringify(hitStack);
            },
            { timeout: 10_000 },
          )
          .toBe('in-bounds & on-top');

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
    // #628 (review Major 3): `.route-layer-controls` now contains TWO
    // <details> — the new outer Disclosure wrapping the whole cluster, and
    // RouteLegend's pre-existing `details.route-legend` nested one level in.
    // The outer one FOLLOWS `isWide` across a resize (RouteLayer.tsx's own
    // comment): every viewport in the loop above is narrow, so by this point
    // it has auto-COLLAPSED, hiding the nested legend entirely (a closed
    // native <details> does not render its non-summary children at all,
    // MEASURED: `getByText('Legende')` timed out as "hidden" without this).
    // Expand it first — same guard shape as
    // route-alt-rig.spec.ts's planAndGetAltToggle, and the same
    // evaluate()-based `.open` IDL-property read: `getAttribute('open')`
    // returns the EMPTY STRING when present, which is FALSY in JS, so
    // `!getAttribute('open')` cannot distinguish open from closed.
    const outerDisclosure = controls.locator('details.route-layer-controls-disclosure');
    const isOuterOpen = await outerDisclosure.evaluate((el) => (el as HTMLDetailsElement).open);
    if (!isOuterOpen) {
      await outerDisclosure.locator('> summary').click();
    }
    const legend = controls.getByText('Legende');
    await expect(legend).toBeVisible();
    // A bare `controls.locator('details')` is a strict-mode ambiguity now
    // that there are two — narrow to the legend's own class.
    const legendDetails = controls.locator('details.route-legend');
    // #813 fix-wave (self-review): this pin used to hardcode "starts closed,
    // click opens it" — VERIFIED not the same premise as the two
    // layout.spec.ts #813 fixes before reusing their shape (their subject was
    // an unrelated width-pin / an overflow-check setup step; this one is the
    // ORIGINAL #628 review Major 3 measurement above — "MEASURED:
    // `getByText('Legende')` timed out as 'hidden' without [expanding the
    // outer disclosure]", i.e. the nested legend is REACHABLE and TOGGLES
    // once its ancestor disclosure is open, never a claim about which state
    // it starts in). RouteLegend.tsx's own #813 fix-wave comment now defaults
    // `.route-legend` OPEN at narrow layouts — this viewport (740x360) IS
    // narrow — so "starts closed" is no longer true here. Read the actual
    // state and assert the click flips it, in EITHER direction, so the pin
    // survives either default rather than assuming one.
    const wasOpen = await legendDetails.evaluate((el) => (el as HTMLDetailsElement).open);
    await legend.click();
    if (wasOpen) {
      await expect(legendDetails).not.toHaveAttribute('open');
    } else {
      await expect(legendDetails).toHaveAttribute('open', '');
    }
  } finally {
    server.kill();
  }
});
