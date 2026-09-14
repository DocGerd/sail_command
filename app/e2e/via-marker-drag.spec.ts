import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { startPreview, mapReady, STANDARD_VIEWPORTS } from './helpers';

// #1198: two via markers overlapping at the widened 44px hit target (#1186)
// used to capture each other's drags — MapLibre's own hit test resolves to
// whichever marker paints on top (the later-constructed one), so pressing
// nearer the EARLIER marker's own centre still dragged the later one.
// ViaMarkers.test.tsx pins the redirect's SELECTION LOGIC against a fake map
// with stubbed geometry; this spec proves the gesture actually completes
// against the real library, real DOM hit-testing and a real browser — mouse
// AND touch, since touch is this app's primary on-deck, gloved input. It
// also pins the PR #1221 review Major: a press on #850's route-line ghost
// handle, positioned inside the SAME overlap, must still INSERT a waypoint
// rather than being hijacked into moving an existing via.
//
// `tabletLandscape` (1180x820, STANDARD_VIEWPORTS) — the >=820px maintainer
// floor, and WIDE layout (>=1024px) keeps the planner panel a permanent side
// column rather than a bottom sheet, so the coordinate-entry fields and the
// map are both reachable without a tab switch.
test.use({ viewport: STANDARD_VIEWPORTS.tabletLandscape });

// Types are erased before this reaches the browser (page.evaluate) — same
// shape as route-line-drag.spec.ts's own copy, duplicated rather than
// imported (e2e specs in this repo do not import from one another).
interface ScTestGeoJsonSource {
  getData(): Promise<{
    features: Array<{ geometry: { type: string; coordinates: [number, number][] } }>;
  }>;
}
interface ScTestMap {
  project(lngLat: [number, number]): { x: number; y: number };
  getSource(id: string): ScTestGeoJsonSource | undefined;
  jumpTo(options: { center: [number, number]; zoom: number }): void;
}

/** Same route/fixture route-line-drag.spec.ts and route-alt-rig.spec.ts use —
 * already known to produce a real multi-leg route on this wind. */
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
}

/** Adds a via point through the #829 keyboard-reachable coordinate-entry
 * form (PlannerPanel.tsx) — a deterministic SECOND producer of the same
 * LatLon a map tap produces, so two via points can be placed at EXACT,
 * known coordinates rather than approximated from drag geometry. Fields
 * reset to "add" mode after each commit, so this is safely callable twice
 * in a row. */
async function addViaByCoord(page: Page, lat: number, lon: number): Promise<void> {
  const latField = page.getByLabel('Breitengrad');
  const lonField = page.getByLabel('Längengrad');
  await latField.fill(String(lat));
  await latField.blur();
  await lonField.fill(String(lon));
  await lonField.blur();
  await page.getByRole('button', { name: 'Koordinaten hinzufügen', exact: true }).click();
}

/** Page-space pixel centre of a lngLat at the live camera — the map canvas
 * is not at the page origin in the wide layout (panel | resizer | map).
 * Mirrors route-line-drag.spec.ts's own helper. */
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

function distancePx(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Zooms the live camera (a plain `jumpTo`, no animation) until the two
 * lngLats project to a screen-space separation inside [min,max]px — the
 * contended band this defect needs (both roots' 44px boxes overlapping, but
 * still two distinct centres). Each +1 zoom step doubles screen distance for
 * a fixed geographic pair, so a small number of geometric-mean corrections
 * converges quickly; asserts the precondition explicitly rather than
 * silently proceeding at whatever separation the last attempt landed on —
 * a wider separation would make this an uncontended-press test in disguise.
 */
async function zoomForContendedSeparation(
  page: Page,
  a: [number, number],
  b: [number, number],
  [min, max]: [number, number] = [10, 20],
): Promise<void> {
  const center: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let zoom = 12;
  let sep = 0;
  for (let i = 0; i < 25; i++) {
    await page.evaluate(
      ([c, z]) =>
        (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.jumpTo({
          center: c as [number, number],
          zoom: z as number,
        }),
      [center, zoom] as const,
    );
    const [pa, pb] = await Promise.all([pagePointOf(page, a), pagePointOf(page, b)]);
    sep = distancePx(pa, pb);
    if (sep >= min && sep <= max) return;
    zoom += sep < min ? 1 : -0.5;
    zoom = Math.max(4, Math.min(19, zoom));
  }
  throw new Error(
    `could not reach a ${min}-${max}px separation; last sep=${sep.toFixed(1)}px at zoom=${zoom}`,
  );
}

async function viaCentre(page: Page, label: string): Promise<{ x: number; y: number }> {
  const box = await page.getByRole('button', { name: label, exact: true }).boundingBox();
  if (!box) throw new Error(`via marker "${label}" has no bounding box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a mouse drag on the EARLIER of two overlapping via markers moves that one, never the other', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    // 0.005 deg apart at ~54.87N (~320m) — the review's own probe values.
    const A: [number, number] = [9.72, 54.87];
    const B: [number, number] = [9.725, 54.87];
    await addViaByCoord(page, A[1], A[0]); // constructed FIRST -> "Wegpunkt 1", painted BELOW.
    await addViaByCoord(page, B[1], B[0]); // constructed SECOND -> "Wegpunkt 2", painted ON TOP.
    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(2);

    await zoomForContendedSeparation(page, A, B);

    const aBefore = await viaCentre(page, 'Wegpunkt 1');
    const bBefore = await viaCentre(page, 'Wegpunkt 2');

    // Press exactly at A's own centre — the point CLOSEST to A even though
    // B (painted on top) covers it too — then drag +80px and release.
    await page.mouse.move(aBefore.x, aBefore.y);
    await page.mouse.down();
    await page.mouse.move(aBefore.x + 80, aBefore.y, { steps: 12 });
    await page.mouse.up();

    // #412: re-sampled fresh inside the poll, never frozen before settle.
    await expect
      .poll(async () => (await viaCentre(page, 'Wegpunkt 1')).x, { timeout: 10_000 })
      .toBeGreaterThan(aBefore.x + 50);
    const aAfter = await viaCentre(page, 'Wegpunkt 1');
    const bAfter = await viaCentre(page, 'Wegpunkt 2');

    expect(distancePx(aAfter, aBefore)).toBeGreaterThan(50);
    // The unmoved sibling is the control: at BASE (no #1198 fix) this same
    // press would have dragged B instead, moving it by the same ~80px.
    expect(distancePx(bAfter, bBefore)).toBeLessThan(5);
  } finally {
    server.kill();
  }
});

test('a touch drag on the EARLIER of two overlapping via markers moves that one, never the other', async ({
  page,
  context,
}) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    const A: [number, number] = [9.72, 54.87];
    const B: [number, number] = [9.725, 54.87];
    await addViaByCoord(page, A[1], A[0]);
    await addViaByCoord(page, B[1], B[0]);
    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(2);

    await zoomForContendedSeparation(page, A, B);

    const aBefore = await viaCentre(page, 'Wegpunkt 1');
    const bBefore = await viaCentre(page, 'Wegpunkt 2');

    // Playwright's page.touchscreen only exposes tap() (no move/drag), so a
    // real multi-step touch drag needs CDP Input.dispatchTouchEvent
    // directly — same mechanism the PR #1221 review used to verify this.
    const cdp: CDPSession = await context.newCDPSession(page);
    const steps = 12;
    const dx = 80 / steps;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: aBefore.x, y: aBefore.y }],
    });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: aBefore.x + dx * i, y: aBefore.y }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect
      .poll(async () => (await viaCentre(page, 'Wegpunkt 1')).x, { timeout: 10_000 })
      .toBeGreaterThan(aBefore.x + 50);
    const aAfter = await viaCentre(page, 'Wegpunkt 1');
    const bAfter = await viaCentre(page, 'Wegpunkt 2');

    expect(distancePx(aAfter, aBefore)).toBeGreaterThan(50);
    expect(distancePx(bAfter, bBefore)).toBeLessThan(5);
  } finally {
    server.kill();
  }
});

test('#1221 review Major: a drag on the #850 route-line ghost handle still inserts, even inside two overlapping via boxes', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await planRoute(page, server.url);
    await mapReady(page);

    // The first leg's own midpoint, read from the sc-route source (the
    // same technique route-line-drag.spec.ts uses) — the ghost handle
    // appears when hovering ON the rendered route line, so it must sit
    // there, not at an arbitrary offset.
    const midLngLat = await page.evaluate(async () => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const src = map.getSource('sc-route');
      if (!src) throw new Error('sc-route source not installed');
      const data = await src.getData();
      const first = data.features[0];
      if (!first || first.geometry.type !== 'LineString') {
        throw new Error('sc-route has no leg features yet');
      }
      const [a, b] = first.geometry.coordinates as [number, number][];
      if (!a || !b) throw new Error('leg feature has fewer than 2 coordinates');
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as [number, number];
    });

    // Two via points straddling the leg midpoint by ~0.0025 deg each side
    // (~320m total) — close enough that at the SAME contended zoom used
    // above, the midpoint (and thus the ghost handle) sits inside BOTH via
    // roots' 44px boxes, not just near them.
    const A: [number, number] = [midLngLat[0] - 0.0025, midLngLat[1]];
    const B: [number, number] = [midLngLat[0] + 0.0025, midLngLat[1]];
    await addViaByCoord(page, A[1], A[0]);
    await addViaByCoord(page, B[1], B[0]);
    await expect(page.getByRole('button', { name: /^Wegpunkt \d+$/ })).toHaveCount(2);

    // A wider band than the mouse/touch tests' [10,20]: the midpoint (the
    // ghost's own hover point) sits roughly separation/2 from EACH via
    // centre, and RouteLayer.tsx's #850 round-2 ghost suppression fires
    // within VIA_MARKER_HALF_WIDTH_PX (8px) of any via — so the midpoint
    // must clear 8px from each while staying inside each via's 22px
    // half-width box (contention intact).
    await zoomForContendedSeparation(page, A, B, [20, 30]);

    const aBefore = await viaCentre(page, 'Wegpunkt 1');
    const bBefore = await viaCentre(page, 'Wegpunkt 2');
    const midPoint = await pagePointOf(page, midLngLat);
    // Precondition, asserted explicitly rather than assumed: the ghost's own
    // hover point must clear the #850 suppression radius around each via
    // AND still fall inside both via boxes (half-width 22px), or this does
    // not exercise the #1221 Major at all.
    expect(distancePx(midPoint, aBefore)).toBeGreaterThan(8);
    expect(distancePx(midPoint, aBefore)).toBeLessThan(22);
    expect(distancePx(midPoint, bBefore)).toBeGreaterThan(8);
    expect(distancePx(midPoint, bBefore)).toBeLessThan(22);

    await page.mouse.move(midPoint.x, midPoint.y);
    const ghost = page.locator('.sc-route-drag-handle');
    await expect(ghost).toBeVisible({ timeout: 10_000 });

    // Drop STRAIGHT DOWN in screen-Y only, never toward either via along
    // the X axis A and B share: RouteLayer.tsx's own (pre-existing, correct)
    // #850 round-2 suppression removes the ghost the instant the cursor
    // comes within VIA_MARKER_HALF_WIDTH_PX (8px) of ANY via — including
    // mid-drag — so a drop path that drifts toward B (the nearer one on an
    // X-only path) would kill this test's OWN ghost before it completes,
    // for a reason unrelated to #1198. Moving in Y only keeps distance to
    // BOTH vias monotonically increasing from their ~14-15px starting gap.
    await page.mouse.down();
    await page.mouse.move(midPoint.x, midPoint.y + 80, { steps: 12 });
    await page.mouse.up();

    // A THIRD via must appear (the insert) — never a mutation of the first
    // two, which is the #1221 Major this test exists to pin.
    const allVias = page.getByRole('button', { name: /^Wegpunkt \d+$/ });
    await expect(allVias).toHaveCount(3, { timeout: 10_000 });
    // The INSERT re-numbers labels by route order (the new via can land
    // BETWEEN A and B), so "Wegpunkt 2" after the insert may no longer BE
    // the original B — identify survivors by POSITION, not label: both
    // original centres must still be present among the three, unmoved.
    const boxes = await allVias.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    const nearest = (p: { x: number; y: number }) =>
      Math.min(...boxes.map((b) => distancePx(p, b)));
    expect(nearest(aBefore)).toBeLessThan(5);
    expect(nearest(bBefore)).toBeLessThan(5);
  } finally {
    server.kill();
  }
});
