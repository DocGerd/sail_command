import { test, expect, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS } from './helpers';

// #324: "show both foresail routes on the map at once" — a map-only overlay
// of the rig NOT currently displayed as the primary route, toggled from
// `.route-layer-controls`, default OFF. jsdom can't exercise MapLibre layers
// (RouteLayer.test.tsx pins the static layer SPEC — dash pattern, opacity,
// beforeId anchor — against the fake map instead), so this spec proves the
// two tracks actually render TOGETHER, distinctly, on a real browser against
// a real solve. Determinism per house style: gate on state signals via
// expect.poll/toBeVisible, never a fixed waitForTimeout; assert the VALUE
// (feature counts, paint properties), never a bare boolean.

// The subset of the MapLibre map API these assertions call. Types are erased
// before the closures reach the browser; this only satisfies tsc for the
// page.evaluate() source text (this project can't import app source).
interface ScTestMap {
  queryRenderedFeatures(opts: { layers: string[] }): Array<{ properties: Record<string, unknown> }>;
  getLayoutProperty(id: string, name: string): unknown;
  getPaintProperty(id: string, name: string): unknown;
}

/**
 * Plans Langballigau -> Sønderborg on the deterministic wind-sw12 fixture —
 * the same route annotations.spec.ts uses, already known to produce a
 * multi-leg route with both a gybe and several heading joints on this wind.
 * Returns the enabled alt-rig toggle once RouteLayer (and its
 * `window.__scMap` E2E handle) is up.
 */
async function planAndGetAltToggle(page: Page, serverUrl: string) {
  await page.goto(`${serverUrl}?windFixture=test-fixtures/wind-sw12.json`);
  await page.getByRole('tab', { name: 'Planen' }).click();
  const origin = page.getByRole('region', { name: 'Start' });
  await origin.getByRole('combobox').fill('Langballigau');
  await expect(origin.getByRole('option')).toHaveCount(1);
  await origin.getByRole('option').first().click();
  const dest = page.getByRole('region', { name: 'Ziel' });
  await dest.getByRole('combobox').fill('Sønderborg');
  await expect(dest.getByRole('option')).toHaveCount(1);
  await dest.getByRole('option').first().click();
  const planButton = page.getByRole('button', { name: 'Route planen' });
  await planButton.click();
  await expect(planButton).toBeEnabled({ timeout: 60_000 });

  const altToggle = page.getByRole('checkbox', { name: 'Anderes Rigg anzeigen' });
  await expect(altToggle).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(() =>
    Boolean(
      (window as { __scMap?: { getLayer(id: string): unknown } }).__scMap?.getLayer(
        'sc-route-alt-sail',
      ),
    ),
  );
  return altToggle;
}

test.describe('alt-rig map overlay (#324)', () => {
  test('shows both rigs simultaneously when toggled, visually distinct, with no extra solver run or wind fetch', async ({
    page,
  }) => {
    const server = await startPreview();
    const openMeteoRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
    });
    try {
      const altToggle = await planAndGetAltToggle(page, server.url);

      // Both rigs solved on this wind (SW 12kt is well above the sail-speed
      // floor): the toggle must be enabled, not the "only one rig found a
      // route" disabled state.
      await expect(altToggle).toBeEnabled();
      // Default OFF (#324's settled design).
      await expect(altToggle).not.toBeChecked();

      const featureCount = (layer: string) =>
        page.evaluate(
          (id) =>
            (window as { __scMap?: ScTestMap }).__scMap?.queryRenderedFeatures({ layers: [id] })
              .length ?? -1,
          layer,
        );
      const paint = (layer: string, prop: string) =>
        page.evaluate(
          ([id, p]) => (window as { __scMap?: ScTestMap }).__scMap?.getPaintProperty(id, p),
          [layer, prop] as const,
        );

      // Before toggling: the primary route renders, the overlay does not.
      await expect
        .poll(() => featureCount('sc-route-sail'), { timeout: 30_000 })
        .toBeGreaterThan(0);
      const altHiddenLayout = await page.evaluate(
        () =>
          (window as { __scMap?: ScTestMap }).__scMap?.getLayoutProperty(
            'sc-route-alt-sail',
            'visibility',
          ) as string | undefined,
      );
      expect(altHiddenLayout).toBe('none');
      await expect.poll(() => featureCount('sc-route-alt-sail'), { timeout: 5_000 }).toBe(0);

      // Toggle on: BOTH tracks render at the same time.
      await altToggle.check();
      await expect
        .poll(
          async () =>
            (await featureCount('sc-route-alt-sail')) + (await featureCount('sc-route-alt-motor')),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await expect
        .poll(() => featureCount('sc-route-sail'), { timeout: 30_000 })
        .toBeGreaterThan(0);

      // Visually distinct: real paint values, not a boolean. The overlay's
      // sail line is dashed and lower-opacity; the primary sail line is
      // solid (no dasharray) at full/unset opacity.
      expect(await paint('sc-route-alt-sail', 'line-dasharray')).toEqual([1, 1.5]);
      expect(await paint('sc-route-alt-sail', 'line-opacity')).toBe(0.45);
      expect(await paint('sc-route-sail', 'line-dasharray')).toBeUndefined();
      expect(await paint('sc-route-sail', 'line-opacity')).toBeUndefined();

      // Toggle off again: the overlay disappears, the primary route stays.
      await altToggle.uncheck();
      await expect.poll(() => featureCount('sc-route-alt-sail'), { timeout: 30_000 }).toBe(0);
      await expect.poll(() => featureCount('sc-route-sail'), { timeout: 5_000 }).toBeGreaterThan(0);

      // #324's own definition of done: no additional solver run (both rigs
      // were already computed by the ORIGINAL plan) and no additional
      // forecast fetch. planRoute.ts's real double-solve already happened
      // above the wind-fixture boundary; this only proves the overlay
      // itself triggers no NETWORK activity.
      expect(
        openMeteoRequests,
        `expected zero Open-Meteo requests, got: ${openMeteoRequests.join(', ')}`,
      ).toEqual([]);
    } finally {
      server.kill();
    }
  });

  // Dark mode has no in-app toggle (pure `prefers-color-scheme`) — emulate
  // it rather than looking for a UI control. Lighter than the test above: it
  // only proves the toggle stays reachable, the overlay still paints under
  // the dark stylesheet, and the one theme-sensitive PIXEL this change added
  // — the legend swatch's #757575 dash, deliberately a fixed literal rather
  // than a `--sc-bg`-relative alpha value (see app.css's comment on
  // `.route-legend-alt-rig`) — actually reaches the DOM unchanged; MapLibre's
  // own paint colors are canvas-rendered and theme-invariant by construction
  // (CLAUDE.md), so re-asserting every paint value from the test above would
  // prove nothing new here.
  test('the toggle stays visible and functional, and the legend swatch keeps its literal colour, under the dark theme', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const server = await startPreview();
    try {
      const altToggle = await planAndGetAltToggle(page, server.url);
      await expect(altToggle).toBeEnabled();

      const featureCount = (layer: string) =>
        page.evaluate(
          (id) =>
            (window as { __scMap?: ScTestMap }).__scMap?.queryRenderedFeatures({ layers: [id] })
              .length ?? -1,
          layer,
        );
      await altToggle.check();
      await expect
        .poll(
          async () =>
            (await featureCount('sc-route-alt-sail')) + (await featureCount('sc-route-alt-motor')),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);

      // Open the legend (default-collapsed) and read the swatch's actual
      // computed background — proving the dark stylesheet did not silently
      // override or drop the rule, not just that the rule exists in source.
      await page.locator('details.route-legend > summary').click();
      const swatchBackground = await page.evaluate(() => {
        const el = document.querySelector('.route-legend-alt-rig');
        return el ? getComputedStyle(el).backgroundImage : null;
      });
      expect(swatchBackground, 'route-legend-alt-rig computed background-image').toContain(
        '117, 117, 117',
      );
    } finally {
      server.kill();
    }
  });

  // Narrow-viewport legibility. `.route-layer-controls` has a documented,
  // tightly-measured `max-width` (app.css, ~4.1px of DE headroom at 390px) —
  // asserting only that the ~13px CHECKBOX is in the viewport would pass
  // even if the new row's LABEL text clips or the cluster gains horizontal
  // overflow, since the input itself is far from the clipped edge. Measure
  // the actual box geometry instead.
  test('the alt-rig row stays fully within the viewport, without widening the controls cluster, at phone-portrait width', async ({
    page,
  }) => {
    await page.setViewportSize(STANDARD_VIEWPORTS.phonePortrait);
    const server = await startPreview();
    try {
      const altToggle = await planAndGetAltToggle(page, server.url);
      await altToggle.scrollIntoViewIfNeeded();

      const measurement = await page.evaluate(() => {
        const cluster = document.querySelector('.route-layer-controls') as HTMLElement | null;
        const label = Array.from(document.querySelectorAll('.route-layer-controls label')).find(
          (el) => el.textContent?.includes('Anderes Rigg anzeigen'),
        ) as HTMLElement | undefined;
        if (!cluster || !label) return null;
        const rect = label.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          labelRight: rect.right,
          clusterScrollWidth: cluster.scrollWidth,
          clusterClientWidth: cluster.clientWidth,
        };
      });
      expect(measurement, 'alt-rig label / controls-cluster measurement').not.toBeNull();
      // The label's right edge must not run past the viewport.
      expect(
        measurement!.labelRight,
        `label right edge ${measurement!.labelRight}px vs viewport ${measurement!.viewportWidth}px`,
      ).toBeLessThanOrEqual(measurement!.viewportWidth);
      // The cluster must not have grown horizontal overflow (1px slack for
      // sub-pixel layout rounding).
      expect(
        measurement!.clusterScrollWidth,
        `cluster scrollWidth ${measurement!.clusterScrollWidth}px vs clientWidth ${measurement!.clusterClientWidth}px`,
      ).toBeLessThanOrEqual(measurement!.clusterClientWidth + 1);

      // Still functional at this width.
      await altToggle.check();
      await expect(altToggle).toBeChecked();
    } finally {
      server.kill();
    }
  });
});
