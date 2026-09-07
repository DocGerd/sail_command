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
// — the name label — sets `text-ignore-placement: true`, so no box of its
// enters that index either. Every other family's placement is therefore
// unchanged BY CONSTRUCTION. This spec exists because "by construction" is
// an argument about code, and #378's defect was equally invisible in the
// code that caused it.
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
// 1. It cannot detect `text-ignore-placement` being flipped to `false` ON
//    ITS OWN. That mutation was run: every count above is byte-identical and
//    both tests still pass. The reason is the OTHER half of the design —
//    MapLibre places TOP-TO-BOTTOM (`PauseablePlacement` starts at
//    `order.length - 1` and walks down), so these layers, sitting BELOW
//    every harbour and seamark layer, are placed LAST and can only lose a
//    collision, never win one. The stack position is therefore a SECOND,
//    INDEPENDENT protection, not a cosmetic choice.
// 2. It DOES detect the realistic composite regression — someone raises the
//    layer above the marker stack and forgets the knob. Dropping the
//    `beforeId` (so both layers append topmost, and are placed FIRST) with
//    `text-ignore-placement: false` culls `sc-seamarks` from 6 to 4 at
//    z11.5 — two navigation marks silently deleted, the #191/#192 signature
//    — and reds this test. So the guard has teeth against the failure that
//    can actually reach production, and the two mutations together show
//    which of the two protections each half of the design provides.
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
