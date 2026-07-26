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
