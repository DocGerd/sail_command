import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// Map annotations & wind-barb density (#35 #36 #37). jsdom can't exercise
// MapLibre layers, so the barb-density and toggle contracts are asserted here
// against a real browser. RouteLayer publishes the live map on window.__scMap
// (there is no DOM handle for rendered symbol counts) — mirrors the
// window.__sailGlyphWarmup E2E-signal convention. Determinism per house style:
// gate on state signals via expect.poll, never a fixed waitForTimeout.
//
// Wide viewport so the map (with its top-right control cluster) is unobstructed
// by the bottom sheet while we toggle barbs and annotations.
test.use({ viewport: { width: 1280, height: 800 } });

// The subset of the MapLibre map API these assertions call. Types are erased
// before the closures reach the browser; this only satisfies tsc for the
// page.evaluate() source text (this project can't import app source).
interface ScTestMap {
  queryRenderedFeatures(opts: { layers: string[] }): Array<{ properties: Record<string, unknown> }>;
  querySourceFeatures(source: string): Array<{
    geometry: { coordinates: [number, number] };
    properties: Record<string, unknown>;
  }>;
  getLayer(id: string): unknown;
  getLayoutProperty(id: string, name: string): unknown;
  jumpTo(opts: { zoom?: number; center?: [number, number] }): void;
  panBy(offset: [number, number]): void;
}

test('map annotations: barb density, annotations toggle, no wind re-fetch (#35 #36 #37)', async ({
  page,
}) => {
  const server = await startPreview();
  // (j)#1: barbs/profile wind come only from plan.windGrid — never a re-fetch.
  const openMeteoRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('open-meteo')) openMeteoRequests.push(req.url());
  });
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // --- Plan a route on the deterministic fixture wind ---
    await page.getByRole('tab', { name: 'Planen' }).click();
    const origin = page.getByRole('region', { name: 'Start' });
    await origin.getByRole('searchbox').fill('Langballigau');
    const originResults = origin.locator('.harbor-picker li button');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    const dest = page.getByRole('region', { name: 'Ziel' });
    await dest.getByRole('searchbox').fill('Sønderborg');
    const destResults = dest.locator('.harbor-picker li button');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    // The barb toggle only exists once a plan is active (RouteLayer renders).
    const barbToggle = page.getByRole('checkbox', { name: 'Windpfeile anzeigen' });
    await expect(barbToggle).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(() => Boolean((window as { __scMap?: unknown }).__scMap));

    const barbCount = () =>
      page.evaluate(() => {
        const map = (window as { __scMap?: ScTestMap }).__scMap;
        return map ? map.queryRenderedFeatures({ layers: ['sc-wind-barbs'] }).length : -1;
      });

    // --- #63: barbs are ON by default for a fresh profile (clean Playwright
    // context) — no click needed before they render. ---
    await expect(barbToggle).toBeChecked();

    // --- #36: overview zoom shows many barbs (the reported repro was "barely
    // any barbs at overview") ---
    await expect.poll(barbCount, { timeout: 30_000 }).toBeGreaterThan(3);

    // --- #37/#35: maneuver circles are kind-filtered to tack/gybe. The shared
    // point source now also carries start/finish/heading points; removing the
    // filter would draw r=9 circles at those too. Assert every rendered circle
    // is a maneuver (and that at least one is in view, so the filter is
    // actually exercised). ---
    const maneuverKinds = await page.evaluate(() => {
      const map = (window as { __scMap?: ScTestMap }).__scMap;
      return (map?.queryRenderedFeatures({ layers: ['sc-maneuver-circles'] }) ?? []).map(
        (f) => f.properties.kind,
      );
    });
    expect(maneuverKinds.length).toBeGreaterThan(0);
    for (const k of maneuverKinds) expect(['tack', 'gybe']).toContain(k);

    // --- #36: zooming into a leg still shows barbs (the route ribbon keeps
    // wind on the route at high zoom). Center on the origin (on the route). ---
    const startCoord = await page.evaluate(() => {
      const map = (window as { __scMap?: ScTestMap }).__scMap;
      const feats = map?.querySourceFeatures('sc-maneuvers') ?? [];
      const start = feats.find((f) => f.properties.kind === 'start');
      return start ? start.geometry.coordinates : null;
    });
    expect(startCoord).not.toBeNull();
    await page.evaluate((center) => {
      (window as { __scMap?: ScTestMap }).__scMap?.jumpTo({ center: center!, zoom: 13 });
    }, startCoord);
    await expect.poll(barbCount, { timeout: 30_000 }).toBeGreaterThan(0);

    // Toggling barbs off removes them.
    await barbToggle.uncheck();
    await expect.poll(barbCount, { timeout: 30_000 }).toBe(0);

    // --- #35: the "Times & speeds" toggle flips exactly the ETA + speed
    // layers together (poll getLayoutProperty, never a fixed sleep) ---
    const visibility = (layer: string) =>
      page.evaluate((id) => {
        const map = (window as { __scMap?: ScTestMap }).__scMap;
        if (!map || !map.getLayer(id)) return null;
        return (map.getLayoutProperty(id, 'visibility') as string | undefined) ?? 'visible';
      }, layer);

    const annotationLayers = ['sc-eta-primary', 'sc-eta-secondary', 'sc-leg-speed'];
    const annToggle = page.getByRole('checkbox', { name: 'Zeiten & Geschwindigkeiten' });
    await expect(annToggle).toBeChecked(); // default ON
    for (const id of annotationLayers) {
      await expect.poll(() => visibility(id), { timeout: 30_000 }).toBe('visible');
    }
    await annToggle.uncheck();
    for (const id of annotationLayers) {
      await expect.poll(() => visibility(id), { timeout: 30_000 }).toBe('none');
    }
    // Heading dots are deliberately NOT part of the toggle — they stay visible.
    await expect.poll(() => visibility('sc-heading-dots'), { timeout: 30_000 }).toBe('visible');

    // --- (j)#1: pan/zoom/slider must not trigger an Open-Meteo call ---
    await page.evaluate(() => {
      (window as { __scMap?: ScTestMap }).__scMap?.panBy([90, 60]);
    });
    const slider = page.getByRole('slider', { name: 'Vorhersagezeitpunkt' });
    await expect(slider).toBeVisible();
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForLoadState('networkidle');
    expect(
      openMeteoRequests,
      `expected zero Open-Meteo requests, got: ${openMeteoRequests.join(', ')}`,
    ).toEqual([]);
  } finally {
    server.kill();
  }
});
