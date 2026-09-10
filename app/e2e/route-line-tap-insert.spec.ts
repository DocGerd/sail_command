import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #1170: tap the route line to insert a waypoint while the "Add waypoint"
// pick is armed — the TOUCH counterpart to #850's pointer-only hover-drag
// gesture (route-line-drag.spec.ts). The #1170 spike (§2.2) measured that no
// map-tap interaction in this app had ever been exercised on a real touch
// device — every existing tap-to-pick spec runs the desktop-mouse
// `chromium` project with no `hasTouch` context — so this is the first
// touch-driven spec in the suite. `tabletPortrait` (820x1180) is the
// maintainer's 2026-09-07 floor: it renders the NARROW layout branch and is
// first-class, not a nice-to-have.
test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } });

// Types are erased before this reaches the browser (page.evaluate); this
// only satisfies tsc for the source text — same shape as
// route-line-drag.spec.ts's own copy, duplicated rather than imported
// (e2e specs in this repo do not import from one another, only from
// ./helpers).
interface ScTestGeoJsonSource {
  getData(): Promise<{
    features: Array<{ geometry: { type: string; coordinates: [number, number][] } }>;
  }>;
}
interface ScTestMap {
  project(lngLat: [number, number]): { x: number; y: number };
  getSource(id: string): ScTestGeoJsonSource | undefined;
  easeTo(options: { center: [number, number]; offset?: [number, number]; duration?: number }): void;
}

/**
 * Plans Langballigau -> Sønderborg on the deterministic wind-sw12 fixture —
 * the SAME route route-alt-rig.spec.ts and route-line-drag.spec.ts use,
 * already known to produce a real multi-leg route on this wind. Explicitly
 * selects the "Planen" tab first: at this viewport's narrow layout the
 * planner panel is a bottom sheet over the map, not a permanent side panel.
 *
 * If the fixture's baked-in forecast window has drifted stale (only
 * possible when this spec is exercised OUTSIDE `npm run e2e` — see
 * CLAUDE.md's "pree2e regenerates wind-sw12.json with fresh timestamps"
 * bullet), planning fails with "beyond horizon" and every downstream
 * assertion in this file becomes a false negative rooted entirely in stale
 * test fixtures, not in RouteLayer/App.tsx — asserting a real result exists
 * here turns that failure mode into a clear, attributable error instead of
 * a confusing downstream one (measured while writing this spec: a
 * git-restored, un-regenerated fixture produced exactly this failure, with
 * `plan`/`rig` both null throughout and `sc-route-hit`'s visibility
 * consequently stuck at 'none' — nothing to do with the feature itself).
 */
async function planRoute(page: Page, serverUrl: string): Promise<void> {
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
  await expect(page.getByRole('heading', { name: 'Ergebnis' })).toBeVisible({ timeout: 10_000 });
}

/** Page-space pixel centre of a lngLat at the live camera — mirrors
 * route-line-drag.spec.ts's own pagePointOf helper. */
async function pagePointOf(
  page: Page,
  lngLat: [number, number],
): Promise<{ x: number; y: number }> {
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('the map canvas has no bounding box');
  const local = await page.evaluate(
    (ll) => (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.project(ll),
    lngLat,
  );
  return { x: box.x + local.x, y: box.y + local.y };
}

/** Every rendered route leg's [start, end] pair, source order — read from
 * the `sc-route` GeoJSON source's own `getData()` (the ORIGINAL, un-tiled
 * leg geometry `routeGeoJson.ts`'s `legsToFeatureCollection` built, never
 * `queryRenderedFeatures`'s tile-clipped fragments), mirroring
 * route-line-drag.spec.ts's own firstLegMidpoint helper. */
async function legEndpoints(page: Page): Promise<[number, number][][]> {
  return page.evaluate(async () => {
    const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
    const src = map.getSource('sc-route');
    if (!src) throw new Error('sc-route source not installed');
    const data = await src.getData();
    const lines = data.features.filter((f) => f.geometry.type === 'LineString');
    if (lines.length === 0) throw new Error('sc-route has no leg features yet');
    return lines.map((f) => f.geometry.coordinates as [number, number][]);
  });
}

/** A point 8% of the way along the FIRST leg, from its start — close enough
 * to the origin to stay unambiguously nearest the origin->via1 segment of
 * the draft chain (the geometric property the ordinal test below depends
 * on), but far enough from the origin's own coordinate to clear
 * EndpointMarkers.tsx's `sc-endpoint-marker-origin` DOM marker, which sits
 * exactly ON the route's start point and — being an absolutely-positioned
 * sibling over the canvas — swallows a touch tap landing on it before
 * MapLibre ever sees the event (measured: tapping the EXACT origin
 * coordinate hit that marker div, not the canvas, and inserted nothing). */
async function firstLegNearOrigin(page: Page): Promise<[number, number]> {
  const legs = await legEndpoints(page);
  const [a, b] = legs[0]!;
  if (!a || !b) throw new Error('first leg has fewer than 2 coordinates');
  const t = 0.08;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** The END point of the LAST leg — the route's own destination, as close to
 * `destination.point`/`snappedDestination` as the geometry gets. Used to
 * place a pre-existing via point hugging the DESTINATION end, mirroring
 * App.test.tsx's own #1170 unit test and the #845 seamark e2e fixture shape
 * (`'inserts at the NEAREST point along the route, not appended after an
 * existing via point'`). Deliberately the leg's END, not its midpoint: a
 * midpoint can sit ANYWHERE along a tacking route, which is not
 * unambiguously nearest the destination-side chain segment; the true
 * endpoint is. */
async function lastLegEnd(page: Page): Promise<[number, number]> {
  const legs = await legEndpoints(page);
  const [, end] = legs[legs.length - 1]!;
  if (!end) throw new Error('last leg has no end coordinate');
  return end;
}

/**
 * At this narrow (tabletPortrait) layout `.app-bottom-sheet` — carrying the
 * whole planner panel, including the "Wegpunkte" section this test just
 * armed — is capped at 55vh (app.css) and painted ON TOP of the map
 * (untiered above map chrome, per app.css's own declared stacking order).
 * The auto-fit camera `fitToLegs` runs after planning has NO knowledge of
 * that DOM overlay, so a leg's projected point lands under the sheet as
 * often as not (measured: y=1027 of a 1180px-tall viewport, deep inside the
 * sheet's bottom ~55%). Re-centres the camera via `easeTo({ duration: 0,
 * offset })` — `jumpTo` was tried first and does NOT honour `offset` at all
 * (re-derived against the installed maplibre-gl 6.7.0: `jumpTo`'s own
 * `handleJumpToCenterZoom` reads only `center`/`zoom`, never `offset`,
 * measured live — the camera landed at the exact UNOFFSET canvas centre);
 * `easeTo`'s `handleEaseTo` DOES consult it (`mercator_camera_helper.ts`'s
 * `offsetAsPoint`), and `duration: 0` makes it instant, matching this file's
 * own `fitToLegs` precedent. So `lngLat` instead projects near the TOP of
 * the canvas, comfortably inside the free strip above the sheet — a
 * legitimate map-API SETUP step (the touch tap itself, further below, is
 * what this spec exists to exercise, not the camera positioning).
 */
async function centerAboveBottomSheet(page: Page, lngLat: [number, number]): Promise<void> {
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('the map canvas has no bounding box');
  const targetCanvasY = 100; // page y ~= box.y + 100, well inside the free strip
  await page.evaluate(
    ({ ll, ch, targetY }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      map.easeTo({ center: ll, offset: [0, targetY - ch / 2], duration: 0 });
    },
    { ll: lngLat, ch: box.height, targetY: targetCanvasY },
  );
}

test('a touch tap on the route line inserts a waypoint at the NEAREST point, not appended after an existing via, at the tablet-portrait floor', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(0);
    const viaSection = page.getByRole('region', { name: 'Wegpunkte' });

    // Place ONE via point hugging the DESTINATION end via the coordinate-
    // entry row, BEFORE arming or tapping — mirrors App.test.tsx's own
    // #1170 unit test and the #845 seamark e2e fixture. This is the ONLY
    // construction that discriminates "insert at the nearest point" from
    // "append": with no via point pre-placed and a tap landing exactly on
    // the route line, the correct nearest-point insert and the pre-existing
    // raw-tap-append fallback (App.tsx's handleMapTap 'via' branch, reached
    // whenever a click misses every layer in `interactiveLayerIds`) would
    // both produce an INDISTINGUISHABLE single "Wegpunkt 1" — only a
    // SECOND, already-ordered via point makes the two paths diverge.
    const [destLon, destLat] = await lastLegEnd(page);
    await viaSection.getByLabel('Breitengrad').fill(destLat.toFixed(4));
    await viaSection.getByLabel('Längengrad').fill(destLon.toFixed(4));
    await viaSection.getByRole('button', { name: 'Koordinaten hinzufügen' }).click();
    await expect(viaSection.getByRole('listitem')).toHaveCount(1);
    // Captured verbatim rather than re-deriving the panel's own display
    // rounding (formatLatLon) from destLat/destLon — comparing the SAME
    // rendered string before/after avoids any rounding-boundary mismatch.
    const preExistingViaText = await viaSection.getByRole('listitem').first().textContent();

    // Arm "Add waypoint" — the same control #845/#924's specs drive.
    await viaSection.getByRole('button', { name: 'Wegpunkt hinzufügen', exact: true }).click();
    await expect(page.getByText('Auf Karte tippen für Wegpunkte.')).toBeVisible();
    // #1170's discoverability requirement: the route line's tappability is
    // named explicitly in the armed banner, not left for the user to guess.
    await expect(
      page.getByText('Oder auf die Routenlinie tippen, um dort einen Wegpunkt einzufügen.'),
    ).toBeVisible();

    // Tap near the ORIGIN end — nearest the origin->via1 segment, so it
    // must land BEFORE via1, not after it.
    const startLngLat = await firstLegNearOrigin(page);
    await centerAboveBottomSheet(page, startLngLat);
    const tapPoint = await pagePointOf(page, startLngLat);

    // A real touch TAP (hasTouch: true above), never a mouse click — the
    // whole point of this spec is proving MapLibre relays it as a 'click'
    // RouteLayer's ROUTE_HIT_LAYER handler can act on.
    await page.touchscreen.tap(tapPoint.x, tapPoint.y);

    // Inserted FIRST (nearest the origin->via1 segment), not appended after
    // the pre-existing via — the ordinal check, not just a presence count.
    // This is what rules out the "false green from the raw-tap-append
    // fallback" failure mode: that path always appends, regardless of
    // where on the map the tap lands, so it could only ever produce
    // item[1] === the new point, never item[0].
    await expect(viaSection.getByRole('listitem')).toHaveCount(2, { timeout: 10_000 });
    const items = await viaSection.getByRole('listitem').all();
    await expect(items[0]!).not.toHaveText(preExistingViaText ?? '');
    await expect(items[1]!).toHaveText(preExistingViaText ?? '');

    // The pick disarmed itself in the same gesture (handleRouteLineArmedTap's
    // extra step over the #850 drag path, which has no arming to clear).
    await expect(page.getByText('Auf Karte tippen für Wegpunkte.')).not.toBeVisible();
  } finally {
    server.kill();
  }
});
