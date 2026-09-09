import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #850: drag the plotted route line to insert a waypoint at the release
// point. jsdom cannot exercise a real MapLibre drag (no canvas/WebGL, no
// native mousedown/mousemove/mouseup dispatch) — RouteLayer.test.tsx pins
// the gesture's LOGIC (hover tolerance, ghost lifecycle, the
// onRouteLineInsert call) against the shared fake map; this spec proves the
// gesture actually WORKS against the real library, a real solved route and
// a real browser drag.
//
// The subset of the MapLibre map API this spec's page.evaluate() closures
// call. Types are erased before they reach the browser; this only satisfies
// tsc for the source text (this project can't import app source into e2e).
interface ScTestGeoJsonSource {
  getData(): Promise<{
    features: Array<{ geometry: { type: string; coordinates: [number, number][] } }>;
  }>;
}
interface ScTestMap {
  project(lngLat: [number, number]): { x: number; y: number };
  getSource(id: string): ScTestGeoJsonSource | undefined;
}

/**
 * Plans Langballigau -> Sønderborg on the deterministic wind-sw12 fixture —
 * the SAME route route-alt-rig.spec.ts uses, already known to produce a
 * real multi-leg route on this wind (that spec's own comment records it).
 * A multi-leg route is not required by this gesture (a single leg suffices
 * to grab), but reusing an already-verified route avoids introducing a
 * SECOND unverified fixture-route pairing into the suite.
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
  // The plan-change auto-fit (RouteLayer.tsx's #297 `fitToLegs`, both call
  // sites) passes `duration: 0` — an instant camera jump, never an eased
  // one — so by the time the button re-enables (run() has fully settled)
  // no camera animation is in flight. Not because of #391: a real MapLibre
  // `Marker` drag rides its own map-level Evented listeners, never the
  // HandlerManager an ease's completion resets (see RouteLayer.tsx's own
  // comment above the drag effect) — this drag would be structurally safe
  // from #391 even mid-ease.
  await expect(planButton).toBeEnabled({ timeout: 60_000 });
}

/** Page-space pixel centre of a lngLat at the live camera — the map canvas
 * is not at the page origin in the wide layout (panel | resizer | map), so
 * `map.project()`'s container-relative point needs the canvas box added.
 * Mirrors saved-waypoints.spec.ts's `pagePointOf` helper. */
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

/**
 * The midpoint of the FIRST rendered route leg, read from the `sc-route`
 * GeoJSON source's own `getData()` — the ORIGINAL, un-tiled leg geometry
 * `routeGeoJson.ts`'s `legsToFeatureCollection` built (one 2-point
 * LineString per leg), never `queryRenderedFeatures`'s TILE-CLIPPED
 * per-tile fragments, which would make a midpoint computation unreliable at
 * some zooms/tile boundaries.
 */
async function firstLegMidpoint(page: Page): Promise<[number, number]> {
  const coords = await page.evaluate(async () => {
    const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
    const src = map.getSource('sc-route');
    if (!src) throw new Error('sc-route source not installed');
    const data = await src.getData();
    const first = data.features[0];
    if (!first || first.geometry.type !== 'LineString') {
      throw new Error('sc-route has no leg features yet');
    }
    return first.geometry.coordinates as [number, number][];
  });
  const [a, b] = coords;
  if (!a || !b) throw new Error('leg feature has fewer than 2 coordinates');
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

test('dragging the route line inserts a waypoint at the release point', async ({ page }) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    // No via points exist yet — the drop must be the FIRST one, so its
    // marker carries index 1 (ViaMarkers.tsx's `planner.via.marker`
    // fallback label). Asserting the SPECIFIC label, not just a count,
    // rules out "some unrelated control happened to render" passing this
    // check for the wrong reason.
    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(0);

    const midLngLat = await firstLegMidpoint(page);
    const grabPoint = await pagePointOf(page, midLngLat);

    // Hover to reveal the grab handle, then poll for it — the SAME state-
    // signal-not-timeout gate this repo's E2E determinism rule requires.
    await page.mouse.move(grabPoint.x, grabPoint.y);
    const ghost = page.locator('.sc-route-drag-handle');
    await expect(ghost).toBeVisible({ timeout: 10_000 });

    // Drag to a point clearly OFF the original line — a real drag, not a
    // wobble at the grab point — then release. Multiple intermediate
    // `steps` exceed MapLibre's own click-tolerance so the marker's
    // internal `_isDragging` flips true (a plain down+up with no movement
    // must NOT insert anything — a bare click is not a drag).
    await page.mouse.down();
    const dropPoint = { x: grabPoint.x + 60, y: grabPoint.y + 40 };
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 12 });
    await page.mouse.up();

    // The insert landed: exactly one new via marker, correctly labelled.
    // `exact: true` per CLAUDE.md's getByRole-substring-collision rule —
    // without it this would also match a longer future label containing
    // this one as a substring.
    await expect(page.getByRole('button', { name: 'Wegpunkt 1', exact: true })).toHaveCount(1, {
      timeout: 10_000,
    });
    // The transient ghost handle must not survive the drop as a stray
    // marker distinct from the real via marker it produced.
    await expect(ghost).toHaveCount(0);

    // #571 ruling: a via edit is a plain, synchronous DRAFT write — no
    // replan happens on the drag itself. The map-side staleness chip
    // (ViaMarkers.tsx's `.via-markers-spinner-chip`) discloses exactly
    // that: the drafted via list now differs from the plan's last
    // committed `request.viaPoints`, and nothing here has pressed "Route
    // planen" again yet. Scoped to that ONE element — the identical
    // sentence is ALSO duplicated into an sr-only live region and the
    // panel's own stale-result chip (PlannerPanel.tsx), so the bare text
    // locator is a Playwright strict-mode violation (three matches).
    await expect(page.locator('.via-markers-spinner-chip')).toBeVisible();
  } finally {
    server.kill();
  }
});

test('#850 round-2 BLOCKER: dragging an existing via marker moves it, never inserts a duplicate', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    const midLngLat = await firstLegMidpoint(page);
    const grabPoint = await pagePointOf(page, midLngLat);
    await page.mouse.move(grabPoint.x, grabPoint.y);
    const ghost = page.locator('.sc-route-drag-handle');
    await expect(ghost).toBeVisible({ timeout: 10_000 });
    await page.mouse.down();
    const dropPoint = { x: grabPoint.x + 60, y: grabPoint.y + 40 };
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 12 });
    await page.mouse.up();
    const via = page.getByRole('button', { name: 'Wegpunkt 1', exact: true });
    await expect(via).toHaveCount(1, { timeout: 10_000 });

    // Replan so the route actually passes through the new via point (the
    // #391/duration-0 argument above only covers THIS re-fit; the drag
    // below rides its own map-level listeners regardless).
    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    await expect(planButton).toBeEnabled({ timeout: 60_000 });
    await mapReady(page);
    await expect(via).toHaveCount(1);

    // The BLOCKER this test pins: the ghost handle used to stack directly
    // over the real via marker and steal its drag — dragging what looked
    // like the existing marker instead fired `onRouteLineInsert` and
    // produced a SECOND, duplicate marker ("Wegpunkt 2") rather than moving
    // the first.
    // (the ghost's own hit lands on the rendered route line, close enough
    // to the marker to cover it)
    //
    // #412: re-sampled INSIDE the poll on every attempt, never frozen from a
    // single read before this — the replan above moves the camera
    // (`fitToLegs`), and a box read before that settles would make a stale
    // coordinate and a real defect produce the same signature.
    let viaCentre = { x: 0, y: 0 };
    await expect
      .poll(
        async () => {
          const viaBox = await via.boundingBox();
          if (!viaBox) return null;
          viaCentre = { x: viaBox.x + viaBox.width / 2, y: viaBox.y + viaBox.height / 2 };
          return viaCentre;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    // Hovering the real marker must NOT reveal the route-drag ghost at all
    // (the fix suppresses it before the route-line hit-test ever runs) —
    // checked explicitly, not just inferred from the drag's outcome below.
    await page.mouse.move(viaCentre.x, viaCentre.y);
    await expect(ghost).toHaveCount(0);

    await page.mouse.down();
    await page.mouse.move(viaCentre.x + 50, viaCentre.y - 30, { steps: 12 });
    await page.mouse.up();

    // Exactly one via marker survives, whatever its index — a duplicate
    // would show up as a SECOND "Wegpunkt N" button, not a renamed first.
    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(1, {
      timeout: 10_000,
    });
  } finally {
    server.kill();
  }
});
