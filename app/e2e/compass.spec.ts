import { test, expect, type Page } from '@playwright/test';
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

const bearing = (page: Page) =>
  page.evaluate(() =>
    Math.round(
      (window as unknown as Record<string, { getBearing: () => number }>).__scE2eMap.getBearing(),
    ),
  );

/** The bearing the user can actually SEE, read back out of the needle's own matrix. */
const needleDeg = (page: Page) =>
  page.evaluate(() => {
    const n = document.querySelector('.compass-needle');
    if (!n) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(n).transform);
    return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
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
const OCCLUSION_VIEWPORTS = [
  { width: 844, height: 390 },
  { width: 740, height: 360 },
  { width: 667, height: 375 },
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

  const cbox = (await compass.boundingBox())!;
  await page.mouse.click(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  await expect(compass).toHaveAttribute('data-orientation', 'north-up');
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
