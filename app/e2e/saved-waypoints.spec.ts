import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #924: the COLLISION BUDGET guard for the saved-waypoint map layer.
//
// The issue's own acceptance bar: adding a symbol layer to this map can CULL
// the layers already in it, and this repo has paid for that twice (#191/#192
// enlarged icons and silently deleted navigation marks below the z12
// `icon-overlap` threshold; #378's `sc-wind-barbs` set `icon-allow-overlap`
// WITHOUT `icon-ignore-placement`, so every healthy-looking barb inserted a
// collision box that evicted the ETA and speed labels underneath). A layer
// that looks perfectly correct on its own is exactly the shape that does
// this, so the question can only be settled by measurement.
//
// WHAT THE SHIPPED LAYER CLAIMS, and why the measurement is a CONFIRMATION
// rather than the whole argument (SavedWaypointsLayer.tsx's own header
// carries the full version): the marker is a CIRCLE layer, which takes no
// part in MapLibre's symbol collision index at all, and the one symbol layer
// — the name label — enters that index (`text-ignore-placement: false`, so
// its labels de-conflict with EACH OTHER) but cannot evict anyone, because
// these are the LOWEST symbol layers in the style and MapLibre places
// TOP-TO-BOTTOM: every other family is placed BEFORE them. Every other
// family's placement is therefore unchanged BY CONSTRUCTION. This spec
// exists because "by construction" is an argument about code, and #378's
// defect was equally invisible in the code that caused it.
//
// METHOD, and each choice's reason:
//
// - A FIXED GEOGRAPHIC box (CLUSTER_CENTER +/- CLUSTER_HALF_DEGREES,
//   re-projected to pixels at the live camera on every read), never the
//   whole viewport. A whole-viewport comparison moves the sampled GEOGRAPHY
//   and the collision REGIME together and reads BACKWARDS: seamarks.spec.ts
//   measured 64 features at z10 against 56 at z13, the opposite of the true
//   signature (#353).
// - The A/B is the SAME BUILD, SAME CAMERA, SAME TILES — the waypoint layers
//   VISIBLE versus `visibility: 'none'` — not two git checkouts. A layer set
//   to `none` is not placed, so it contributes nothing to the collision
//   index: for collision purposes that IS the absent-layer control, and it
//   eliminates the tile-load and placement-timing noise a BASE-vs-HEAD run
//   across two builds would add. It is the same isolation #378 itself used
//   ("hiding `sc-wind-barbs` alone took an evicted label from 0 back to
//   present").
// - A POSITIVE CONTROL before every comparison: the waypoint layer must
//   itself return features inside the box. Without it, "every other family
//   is unchanged" is the answer an EMPTY layer would also give — a seeded
//   store that failed to load, a layer that never installed, or a box the
//   waypoints missed would all read as a clean pass (CLAUDE.md: give any
//   probe whose emptiness you intend to interpret a needle known present).
// - Seamarks are turned ON. They default OFF (#7), so leaving them alone
//   would have both seamark families read 0 in both arms and prove nothing.
// - BOTH SIDES of the z12 `icon-overlap` 'never'/'always' threshold. Below
//   it, culling is live and a new collision box can evict a mark; at or
//   above it, `always` means identical counts are expected — that pair is
//   the signature #191/#192 established for isolating collision growth from
//   every other explanation.
// - Counts are ORDER-INDEPENDENT, so this method is structurally blind to
//   paint-order inversion (#200). Paint order is therefore asserted
//   SEPARATELY, from the style's own layer order, in its own test below.
//
// MEASURED, at the merge-base of this branch, inside the fixed box below.
// z11.5: 12 waypoint features; other families 9 with the layer and 9
// without — `sc-harbor-points` 1, `sc-harbor-labels` 0, `sc-seamarks` 6,
// `sc-seamarks-hazard` 2 in BOTH arms. z13: 15 waypoint features; 45 and 45
// — 1 / 0 / 42 / 2 in both arms. Culling is demonstrably LIVE at z11.5
// rather than merely assumed: the SAME box yields 42 `sc-seamarks` at z13
// under `icon-overlap: 'always'` against 6 at z11.5 under `'never'`, so the
// z11.5 arm is competing for roughly one slot in seven.
//
// WHAT THIS MEASUREMENT CANNOT DETECT — stated because a green result is
// otherwise read as wider than it is, and the first item was MEASURED here,
// not reasoned about:
//
// 1. It cannot detect `text-ignore-placement` being flipped to `true` — the
//    value that would stop the layer's own labels de-conflicting and let
//    several waypoints saved in one anchorage overprint. MEASURED in this
//    box with the knob flipped at runtime: with seamarks ON (this spec's
//    own state) every count above is byte-identical, waypoint labels
//    included (3 at z11.5, 6 at z13, both values), because the seamark
//    boxes already cull our labels before they can collide with each other.
//    The discriminating configuration is the app's DEFAULT one, seamarks
//    OFF: there the flip takes our labels from 6 to 9 of 9 rings at z11.5 —
//    all nine placed on top of one another — while `sc-harbor-labels` 1 and
//    `sc-harbor-points` 1 do not move either way. So this spec's arm cannot
//    see the label-legibility half of that knob at all; the unit pin in
//    SavedWaypointsLayer.test.tsx is what holds the value.
// 2. It DOES detect the stack regression, and since the knob no longer
//    suppresses our own boxes the stack position is now the SOLE protection
//    for every other family. MEASURED by moving both layers to the top of
//    the style at runtime, everything else unchanged: `sc-seamarks` falls
//    from 6 to 4 at z11.5 — two navigation marks silently deleted, the
//    #191/#192 signature — while our own labels rise 3 to 6. This test's
//    red on that regression was then OBSERVED rather than inferred: the
//    mutant was BUILT (the
//    `beforeId` argument dropped from both `addLayer` calls, so real
//    MapLibre appends them topmost), `dist` confirmed replaced, and this
//    test run against it — 1 failed at z11.5, reporting `sc-seamarks` 4
//    with the layer against 6 without. At z13 the same move
//    leaves 42 and 42, which is the expected `icon-overlap: 'always'`
//    reading and the reason the z11.5 arm is the one carrying this.
// 3. `sc-harbor-labels` renders 0 in this box in BOTH arms at BOTH zooms, so
//    it contributes nothing here despite being the family whose culling
//    regime (`text-allow-overlap: false`) most resembles #378's victims. The
//    seamark families are what carry this measurement.
// 4. It plans NO route, so #378's own victims — `sc-eta-primary`,
//    `sc-eta-secondary`, `sc-leg-speed` — are not on the map at all here and
//    are not measured.

interface ScTestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  getLayer(id: string): unknown;
  project(lngLat: [number, number]): { x: number; y: number };
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
  getStyle(): { layers: Array<{ id: string }> };
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{ properties: Record<string, unknown>; layer: { id: string } }>;
}

// Same cluster seamarks.spec.ts measures, for the same reason: it is a real
// patch of the committed `seamarks.json`/`harbors.json` dense enough that
// collision culling is actually live there below z12.
const CLUSTER_CENTER: [number, number] = [10.515, 54.855];
const CLUSTER_HALF_DEGREES = 0.015;
// 11.5 rather than 10 — seamarks.spec.ts's #484 F2 note: at z11.5 the
// capture aperture (queryRenderedFeatures matches the COLLISION box, so the
// fringe is a fixed pixel amount around a box whose pixel size changes with
// zoom) is close to z13's, while staying below the z12 threshold where
// `icon-overlap: 'never'` keeps culling live.
const ZOOM_BELOW_12 = 11.5;
const ZOOM_AT_OR_ABOVE_12 = 13;

const SAVED_WAYPOINT_LAYERS = ['sc-saved-waypoints', 'sc-saved-waypoint-labels'];
// The families whose budget must not move. The two seamark families are what
// actually carry the measurement (see the header's item 3 — `sc-harbor-labels`
// measured 0 in this box in both arms); the harbour layers stay in the query
// anyway, so a future box or dataset change that makes them non-empty is
// covered without editing this list.
const OTHER_FAMILIES = [
  'sc-harbor-points',
  'sc-harbor-labels',
  'sc-seamarks',
  'sc-seamarks-hazard',
];

// Nine waypoints on a grid across the measured box, deliberately ON TOP of
// whatever harbour and seamark symbols live there — a layer can only cull
// what it overlaps, so a sparse or off-box seeding would make the whole
// comparison vacuous. The names are long on purpose: MapLibre's text
// collision box scales with the rendered string, so these are the LARGEST
// boxes this feature can realistically produce.
const SEED_WAYPOINTS = Array.from({ length: 9 }, (_, i) => ({
  id: `e2e-waypoint-${i}`,
  name: `Ankerplatz Nordwest ${i}`,
  lon: CLUSTER_CENTER[0] + (((i % 3) - 1) * CLUSTER_HALF_DEGREES) / 1.5,
  lat: CLUSTER_CENTER[1] + ((Math.floor(i / 3) - 1) * CLUSTER_HALF_DEGREES) / 1.5,
  createdAtMs: 1_700_000_000_000 + i,
}));

/** Writes straight into the app's own IndexedDB store. Runs AFTER the app has
 * opened `sailcommand` at its current version, so this never races the
 * schema upgrade — it only adds rows to a store that already exists. */
async function seedWaypoints(page: Page): Promise<number> {
  return page.evaluate(async (waypoints) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sailcommand');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(String(req.error)));
      // A blocked/upgrade path here would mean the app had not opened the DB
      // yet — fail loudly rather than write into a half-built schema.
      req.onupgradeneeded = () => reject(new Error('sailcommand DB not yet created by the app'));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('waypoints', 'readwrite');
      for (const w of waypoints) tx.objectStore('waypoints').put(w);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(String(tx.error)));
    });
    const count = await new Promise<number>((resolve, reject) => {
      const req = db.transaction('waypoints', 'readonly').objectStore('waypoints').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(String(req.error)));
    });
    db.close();
    return count;
  }, SEED_WAYPOINTS);
}

async function waitForLayer(page: Page, layerId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => Boolean((window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.getLayer(id)),
          layerId,
        ),
      { timeout: 30_000, message: `the '${layerId}' layer never appeared on the map` },
    )
    .toBe(true);
}

async function jumpToCluster(page: Page, zoom: number): Promise<void> {
  await page.evaluate(
    ({ center, zoom }) =>
      (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.jumpTo({ center, zoom }),
    { center: CLUSTER_CENTER, zoom },
  );
}

/** Sorted `<layerId>:<identity>` strings for every feature rendered inside
 * the fixed geographic box, re-projected at the live camera on every call —
 * never cached across a zoom change, since `project()` reads the current
 * transform. Layer-qualified so a same-count swap BETWEEN families cannot
 * read as unchanged. */
async function readInBox(page: Page, layers: string[]): Promise<string[]> {
  return page.evaluate(
    ({ center, half, layers }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const present = layers.filter((id) => Boolean(map.getLayer(id)));
      if (present.length === 0) return [];
      const nw = map.project([center[0] - half, center[1] + half]);
      const se = map.project([center[0] + half, center[1] - half]);
      return map
        .queryRenderedFeatures(
          [
            [nw.x, nw.y],
            [se.x, se.y],
          ],
          { layers: present },
        )
        .map(
          (f) =>
            `${f.layer.id}:${String(f.properties.icon ?? f.properties.id ?? f.properties.name ?? '')}`,
        )
        .sort();
    },
    { center: CLUSTER_CENTER, half: CLUSTER_HALF_DEGREES, layers },
  );
}

// Settle gate copied in SHAPE from labels.spec.ts / seamarks.spec.ts, and for
// the recorded reason: `map.once('idle')` is measurably unreachable on an
// already-loaded map (the one-shot initial idle has fired before a listener
// can attach), so such a gate always takes its cap — an unconditional sleep
// in a state-signal costume, and self-concealing, since a gate that always
// times out and always passes looks identical to one that settles fast. This
// polls the actual rendered set and fails CLOSED with its history.
const SETTLE_POLL_INTERVAL_MS = 400;
const SETTLE_STABLE_READS_REQUIRED = 3;
const SETTLE_MAX_READS = 27;

async function settledInBox(page: Page, layers: string[], label: string): Promise<string[]> {
  const countHistory: number[] = [];
  const recentReads: string[][] = [];
  const first = await readInBox(page, layers);
  countHistory.push(first.length);
  recentReads.push(first);

  for (let extraReads = 1; extraReads <= SETTLE_MAX_READS; extraReads++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = await readInBox(page, layers);
    countHistory.push(next.length);
    recentReads.push(next);
    if (recentReads.length > SETTLE_STABLE_READS_REQUIRED) recentReads.shift();
    // The full sorted array, not the count: a same-count swap (one mark
    // culled while another appears) must not read as stable.
    const stable =
      recentReads.length === SETTLE_STABLE_READS_REQUIRED &&
      recentReads.every((ids) => JSON.stringify(ids) === JSON.stringify(recentReads[0]));
    if (stable) return next;
  }
  throw new Error(
    `[${label}] placement never stabilized across ${countHistory.length} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ${SETTLE_STABLE_READS_REQUIRED} consecutive matches ` +
      `required); counts seen: ${JSON.stringify(countHistory)}; last ${recentReads.length} sets: ` +
      `${JSON.stringify(recentReads)}`,
  );
}

async function setWaypointLayersVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(
    ({ layers, visibility }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      for (const id of layers) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      }
    },
    { layers: SAVED_WAYPOINT_LAYERS, visibility: visible ? 'visible' : 'none' },
  );
}

async function openMapWithSeededWaypoints(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await mapReady(page);
  const seeded = await seedWaypoints(page);
  expect(seeded, 'seeded waypoints did not land in the sailcommand store').toBeGreaterThanOrEqual(
    SEED_WAYPOINTS.length,
  );
  // The layer reads the store on mount; a reload is the cheapest way to make
  // the freshly seeded rows the mounted state rather than driving the panel.
  await page.reload();
  await mapReady(page);
  await waitForLayer(page, 'sc-saved-waypoints');
  // Seamarks default OFF (#7) — without this both seamark families read 0 in
  // BOTH arms and contribute nothing to the comparison.
  await page.getByRole('checkbox', { name: 'Seezeichen' }).check();
  await waitForLayer(page, 'sc-seamarks');
}

test('#924: the saved-waypoint layer changes no other symbol family’s collision budget, at both sides of z12', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await openMapWithSeededWaypoints(page, server.url);

    for (const zoom of [ZOOM_BELOW_12, ZOOM_AT_OR_ABOVE_12]) {
      await jumpToCluster(page, zoom);

      // POSITIVE CONTROL first — see the file header. Everything below is
      // uninterpretable until the layer is proven to be rendering INSIDE the
      // very box the comparison reads.
      await setWaypointLayersVisible(page, true);
      const waypointsInBox = await settledInBox(page, SAVED_WAYPOINT_LAYERS, `z${zoom} waypoints`);
      expect(
        waypointsInBox.length,
        `z${zoom}: no saved-waypoint feature rendered inside the measured box — every ` +
          `"unchanged" result below would be the answer an EMPTY layer gives`,
      ).toBeGreaterThan(0);

      const withLayer = await settledInBox(page, OTHER_FAMILIES, `z${zoom} with layer`);
      expect(
        withLayer.length,
        `z${zoom}: no harbour or seamark feature in the box — nothing to be culled, so the ` +
          `comparison would pass vacuously`,
      ).toBeGreaterThan(0);

      // The control arm: a layer with `visibility: 'none'` is not placed, so
      // it enters no collision box — for collision purposes, the layer is
      // absent.
      await setWaypointLayersVisible(page, false);
      const withoutLayer = await settledInBox(page, OTHER_FAMILIES, `z${zoom} without layer`);

      expect(
        withLayer,
        `z${zoom}: the saved-waypoint layer changed which harbour/seamark features render. ` +
          `Present with the layer but not without: ` +
          `${JSON.stringify(withLayer.filter((f) => !withoutLayer.includes(f)))}; ` +
          `present without but not with: ` +
          `${JSON.stringify(withoutLayer.filter((f) => !withLayer.includes(f)))}`,
      ).toEqual(withoutLayer);

      await setWaypointLayersVisible(page, true);
    }
  } finally {
    server.kill();
  }
});

test('#924: the saved-waypoint layers sit above the depth overlays and below every harbour, seamark, AIS and route layer', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await openMapWithSeededWaypoints(page, server.url);

    // Counts are order-independent, so the test above is structurally blind
    // to a paint-order inversion (#200). This reads the style's own layer
    // order — bottom to top — and asserts the position directly.
    const order = await page.evaluate(() =>
      (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap
        .getStyle()
        .layers.map((l) => l.id),
    );
    const at = (id: string) => order.indexOf(id);

    expect(
      at('sc-saved-waypoints'),
      `sc-saved-waypoints missing from ${JSON.stringify(order)}`,
    ).toBeGreaterThan(-1);
    expect(at('sc-saved-waypoint-labels')).toBeGreaterThan(-1);

    // The label paints above its own ring — both are added with the same
    // beforeId, so this pins the INSERTION order that decides it.
    expect(at('sc-saved-waypoint-labels')).toBeGreaterThan(at('sc-saved-waypoints'));

    // Below every curated or safety-bearing marker: a personal convenience
    // marker must never outrank a charted hazard or a harbour.
    for (const above of ['sc-harbor-points', 'sc-harbor-labels', 'sc-seamarks']) {
      expect(at(above), `${above} missing from ${JSON.stringify(order)}`).toBeGreaterThan(-1);
      expect(
        at('sc-saved-waypoint-labels'),
        `sc-saved-waypoint-labels must paint below ${above}`,
      ).toBeLessThan(at(above));
    }

    // Above the depth overlays when they exist (they are canvas-backed and
    // only added once the mask decodes, so their presence is asserted rather
    // than assumed — a silently absent layer would make this vacuous).
    const depth = at('sc-depth');
    expect(depth, `sc-depth missing from ${JSON.stringify(order)}`).toBeGreaterThan(-1);
    expect(
      at('sc-saved-waypoints'),
      'sc-saved-waypoints must paint above the depth ramp',
    ).toBeGreaterThan(depth);
  } finally {
    server.kill();
  }
});

// The tap chain, exercised END TO END IN A REAL BROWSER.
//
// Why this test exists at all, given the unit suite already fires a fake
// layer event: the chain has FIVE links and no other check crosses more than
// one of them — App.tsx's conditional `interactiveLayerIds` (which decides
// whether MapView's generic tap handler yields this click), MapView's own
// bail-on-hit gate, MapLibre's delegated click delivery to a layer that
// exists only in a real style, resolving the feature id back through the
// IndexedDB-backed list, and the insert-plus-disarm in App.tsx. PR #688
// shipped DEAD CODE under exactly this shape: a fully green suite whose
// fixture supplied a state production never reaches. `plan.spec.ts`'s own
// via smoke check stops at the arming banner and says so, judging a
// canvas-coordinate tap too fragile — that is true of a tap aimed by eye,
// but not of one aimed by `map.project()` at a camera this test set itself,
// which is deterministic.
//
// The DISCRIMINATOR is the NAME. A raw-coordinate tap at the same pixel adds
// a via row too — it just renders as formatted coordinates
// (`v.name ?? formatLatLon(v)` in PlannerPanel's via row). Asserting the
// seeded name is what separates "snapped to the saved waypoint" from "the
// generic map tap fired", so a row count would pass with the whole feature
// removed.

/** Page-space pixel centre of a seeded waypoint at the live camera. The map
 * canvas is NOT at the page origin in the wide layout (panel | resizer |
 * map), so `map.project()`'s container-relative point needs the canvas box
 * added. Re-sampled at every call — never cached across a camera change. */
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

/** Ids of `sc-saved-waypoints` features rendered under a page point. Used as
 * the aiming gate before the click: it proves the pixel the mouse is about
 * to hit really carries the intended feature, so a miss fails as a named
 * aiming failure rather than as a silent "nothing was inserted". */
async function waypointIdsAtPoint(page: Page, point: { x: number; y: number }): Promise<string[]> {
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('the map canvas has no bounding box');
  return page.evaluate(
    ({ x, y }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      if (!map.getLayer('sc-saved-waypoints')) return [];
      return map
        .queryRenderedFeatures(
          [
            [x - 2, y - 2],
            [x + 2, y + 2],
          ],
          { layers: ['sc-saved-waypoints'] },
        )
        .map((f) => String(f.properties.id));
    },
    { x: point.x - box.x, y: point.y - box.y },
  );
}

test('#924: a via-armed tap on a saved waypoint inserts it BY NAME; a disarmed tap inserts nothing and an origin-armed tap falls through to the raw coordinate', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
    const seeded = await seedWaypoints(page);
    expect(seeded, 'seeded waypoints did not land in the sailcommand store').toBeGreaterThanOrEqual(
      SEED_WAYPOINTS.length,
    );
    await page.reload();
    await mapReady(page);
    await waitForLayer(page, 'sc-saved-waypoints');
    // Seamarks are deliberately left OFF here (their default, #7): this test
    // is about the tap chain, and a seamark popover opening on the same tap
    // is a separate, documented and harmless interaction.
    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);

    // SEED_WAYPOINTS[4] sits exactly on CLUSTER_CENTER, so it lands at the
    // container centre — clear of every map-chrome cluster.
    const target = SEED_WAYPOINTS[4];
    const viaSection = page.getByRole('region', { name: 'Wegpunkte' });
    const armButton = viaSection.getByRole('button', {
      name: 'Wegpunkt hinzufügen',
      exact: true,
    });
    // `exact` is load-bearing in GERMAN specifically: 'Wegpunkt hinzufügen
    // abbrechen' (the armed label) CONTAINS the disarmed one, and
    // Playwright's getByRole matches by substring by default.
    const tapPickBanner = page.getByText('Auf Karte tippen für Wegpunkte.');

    // Aim, and prove the aim, before touching the mouse.
    let point = await pagePointOf(page, [target.lon, target.lat]);
    await expect
      .poll(() => waypointIdsAtPoint(page, point), {
        timeout: 30_000,
        message: `no sc-saved-waypoints feature rendered at the projected pixel for ${target.id}`,
      })
      .toContain(target.id);

    // NEGATIVE ARM FIRST, at the identical pixel: disarmed, this layer must
    // do nothing at all. Without it, a passing positive arm cannot tell an
    // armed-gated pick from a layer that fires on every tap.
    await page.mouse.click(point.x, point.y);
    await expect(viaSection.getByText(target.name)).toHaveCount(0);
    await expect(viaSection.locator('.planner-via-row')).toHaveCount(0);

    await armButton.click();
    await expect(tapPickBanner).toBeVisible();

    // Re-project rather than reusing the point above: arming renders the
    // map-tap banner, which can move the canvas box in the narrow layout.
    point = await pagePointOf(page, [target.lon, target.lat]);
    await expect
      .poll(() => waypointIdsAtPoint(page, point), {
        timeout: 30_000,
        message: `after arming, no sc-saved-waypoints feature at the projected pixel for ${target.id}`,
      })
      .toContain(target.id);
    await page.mouse.click(point.x, point.y);

    // THE discriminator: the row carries the SAVED NAME, not coordinates.
    await expect(
      viaSection.getByText(target.name),
      'the via row does not show the saved waypoint name — a raw-coordinate tap would also add a row',
    ).toHaveCount(1);
    await expect(
      viaSection.locator('.planner-via-row'),
      'more than one via row - something inserted a second point for this tap',
    ).toHaveCount(1);
    // And the pick disarms itself, like every other one-shot map pick.
    await expect(tapPickBanner).not.toBeVisible();
    await expect(armButton).toHaveAttribute('aria-pressed', 'false');

    // THE ORIGIN ARM. App.tsx puts SAVED_WAYPOINT_LAYER into MapView's
    // `interactiveLayerIds` only while the VIA pick is armed, so an
    // origin-armed tap on a ring must fall through to the generic
    // raw-coordinate pick — the promise App.tsx's own comment makes ("no
    // dead zone is created for the other two armings"). Arming
    // `interactiveLayerIds` on the wrong target instead makes MapView bail
    // on the ring hit: origin never moves and the pick stays armed. Nothing
    // in the via arm above can see that, because there the bail and the
    // delegated pick produce the same visible result.
    const startSection = page.getByRole('region', { name: 'Start' });
    // `exact` again: 'Auf Karte wählen abbrechen' contains the plain label.
    const originArmButton = startSection.getByRole('button', {
      name: 'Auf Karte wählen',
      exact: true,
    });
    await expect(startSection.locator('.endpoint-name')).toHaveCount(0);
    await originArmButton.click();

    point = await pagePointOf(page, [target.lon, target.lat]);
    await expect
      .poll(() => waypointIdsAtPoint(page, point), {
        timeout: 30_000,
        message: `after arming origin, no sc-saved-waypoints feature at the projected pixel for ${target.id}`,
      })
      .toContain(target.id);
    await page.mouse.click(point.x, point.y);

    await expect(
      startSection.locator('.endpoint-name'),
      'origin did not move — the tap was swallowed instead of falling through to the raw-coordinate pick',
    ).toHaveText(/\d+\.\d{3}°N \d+\.\d{3}°E/);
    await expect(originArmButton).toHaveAttribute('aria-pressed', 'false');
  } finally {
    server.kill();
  }
});
