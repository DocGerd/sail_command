import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { startPreview, mapReady } from './helpers';

// #981: verifies #860's z12 seamark collision footprint against the
// icon-size bucket.zoom+1 quirk.
//
// MapLibre evaluates a symbol layer's icon-size (and text-size) at
// `EvaluationParameters(bucket.zoom + 1)` when building a tile bucket's
// COLLISION footprint — `possiblyEvaluate(new EvaluationParameters(args.
// bucket.zoom + 1), ...)` at `symbol_layout.ts:98` (re-derived 2026-09-09
// against `maplibre-gl@6.7.0`, the version `app/package-lock.json` pinned at
// that date; unmoved from the issue's original 6.6.0 citation). So the z12
// tile bucket (covering screen zoom [12,13)) computes its COLLISION box
// using icon-size interpolated at zoom=13, even though the RENDERED size
// interpolates continuously within [12,13).
//
// `seamarkGeoJson.ts`'s `BASE_ICON_SIZE_STOPS` grew its top stop from
// `[13, 0.85]` to `[13, 1.4]` at #860 — the [8,12) segment is unchanged, so
// only the z12-bucket collision footprint (evaluated at the new zoom-13
// value) grew, from a 27.2px diameter (0.85 * SEAMARK_NATURAL_ICON_PX=32)
// to 44.8px (1.4 * 32). Since seamarks carry `icon-overlap:
// ['step',['zoom'],'never',12,'always']`, they are never SELF-culled by this
// growth at z>=12 — but `icon-ignore-placement` is NOT set on the seamark
// layers, so the inflated collision box still occupies space in the shared
// MapLibre collision grid and can newly block OTHER, lower-placement-
// priority symbol layers' labels (placement runs top-to-bottom, so a
// later-added layer is placed FIRST — `pauseable_placement.ts`; seamarks are
// added after `sc-harbor-labels` in DataLayers.tsx's `setupLayers()`, so
// seamarks are placed first and can block harbor labels, never the reverse).
//
// MEASURED 2026-09-09 (mutation A/B, `maplibre-gl@6.7.0`): a fixed-box,
// settle-gated (400ms poll, 3 consecutive stable reads — the same cadence
// `seamarks.spec.ts`'s `settledSeamarkIconIds` uses, exceeding MapLibre's
// 300ms `fadeDuration`/`Placement.stillRecent` window) sweep of `sc-harbor-
// labels` presence at zoom 12.5 (unambiguously inside the z12 bucket) over
// all 33 committed harbors found SIX harbors whose harbor-label visibility
// flips depending on the shipped `BASE_ICON_SIZE_STOPS` top stop, all in the
// SAME direction: blocked (false) under the current `[13, 1.4]` stop,
// visible (true) under a reverted `[13, 0.85]` (pre-#860) stop. A z11.5
// control (bucket z11, evaluated at zoom 12 -> 0.775 in BOTH tables, since
// that segment is untouched by #860) was byte-identical across both arms,
// ruling out settle-race noise as the source of the z12.5 difference. No
// harbor flipped in the opposite direction (which would be structurally
// impossible — a SMALLER collision box cannot newly block a label a LARGER
// one did not — and would indicate an unrelated settle race).
//
// VERDICT: the z12 bucket.zoom+1 collision-footprint quirk is NOT harmless
// as the issue's original "likely harmless" read suggested — it measurably
// suppresses `sc-harbor-labels` at a subset of harbors, for one zoom band
// (screen zoom [12,13) only; the label reappears once the covering tile
// bucket becomes z13, whose own bucket.zoom+1 evaluation lands on a stop
// past the table's end and clamps to the same 1.4). This is reported as a
// FOUND, ACCEPTED cross-layer side effect of #860 (a real defect per the
// #981 brief, which explicitly says report rather than fix), not a
// self-cull (self-culling is correctly prevented by `icon-overlap:
// 'always'` at z>=12, and that mechanism is NOT what is being measured
// here). This spec is comments-only in scope terms — it adds no change to
// `seamarkGeoJson.ts` layout/paint properties — and PINS the currently
// measured behaviour (6 named harbors blocked at z12.5) as a forward
// regression guard: growing the z12-bucket collision footprint further (or
// shrinking it back toward pre-#860) will move this set, and this test
// makes that movement OBSERVABLE rather than silent, matching this repo's
// #191/#192 precedent for measuring icon-size collision growth via
// `queryRenderedFeatures` rather than by eye.
//
// MEASURED 2026-09-09, second class (`maplibre-gl@6.7.0`): basemap
// (protomaps) symbol layers ARE a second, REAL victim class of the same
// mechanism, not merely a theoretical one. Protomaps' own layers (from
// `@protomaps/basemaps`'s `layers('protomaps', flavor, {lang})`, called in
// `MapView.tsx`'s `buildStyle()`) are added to the style FIRST, at Map
// construction; `DataLayers.tsx`'s `setupLayers()` adds every `sc-*` layer
// (including seamarks) AFTER, on a later `addLayer` call with no explicit
// `beforeId` ordering it below the basemap stack — so the basemap's own
// symbol layers sit LOWER in the style's layer order than seamarks and are
// placed LATER (`pauseable_placement.ts` walks `order.length-1` down to `0`,
// so the last-added layer is placed FIRST) — the same "placed later can be
// blocked by placed earlier" direction the harbor-label finding above
// exploits, just one layer group further out.
//
// Same fixed-box, settle-gated mutation A/B method as the harbor-label
// measurement above, widened to ALL 33 committed harbors (not just the 6
// harbor-label victims — a different feature set at slightly different
// coordinates has no reason to share the same victim harbors) and to every
// one of the 14 symbol layers `@protomaps/basemaps` emits at the `light`
// flavor (`address_label`, `water_waterway_label`, `roads_oneway`,
// `roads_labels_minor`, `water_label_ocean`, `earth_label_islands`,
// `water_label_lakes`, `roads_shields`, `roads_labels_major`, `pois`,
// `places_subplace`, `places_region`, `places_locality`,
// `places_country`). A z11.5 control ran alongside z12.5 at every harbor,
// as before.
//
// A z11.5 control ran alongside z12.5 at every harbor, as before. Result:
// z11.5 was BYTE-IDENTICAL across all 33 harbors between the shipped `[13,
// 1.4]` table and a reverted pre-#860 `[13, 0.85]` table (0/33 diffs) —
// ruling out settle-race noise, exactly as for the harbor-label finding. At
// z12.5, 8 of 33 harbors showed a basemap symbol-layer count difference
// between the two arms: `aabenraa`, `aaroesund`, `arnis`, `faaborg`,
// `gelting-mole`, `graasten`, `kappeln`, `svendborg` — touching the
// `places_locality`, `places_subplace`, `roads_labels_major` and
// `roads_shields` layers. A same-arm double-run at HEAD (the shipped table,
// run twice) was byte-identical across the full 33x2-zoom sweep, licensing
// the single-shot mutation arm as signal rather than settle noise — the same
// double-run-then-compare control CLAUDE.md's `app/sweep/` bullet prescribes
// for a mask/data mutation, reused here for a style mutation. 7 of the 8
// follow the SAME monotonic signature as the harbor-label finding (the
// reverted, smaller-footprint arm has a strict SUPERSET of the shipped arm's
// features at that harbor — never fewer, matching "a smaller collision box
// cannot newly block a label a larger one did not"). ONE, `faaborg`, shows a
// non-monotonic SWAP instead: shipped shows `roads_labels_major` alone,
// reverted shows `places_locality`+`roads_shields` with NO
// `roads_labels_major` — a second-order effect where freeing the seamark's
// collision footprint lets a higher-priority basemap candidate claim a slot
// that had been going to a different, lower-priority one under the bigger
// box. Reported as measured, not smoothed into the monotonic story: the
// `BASEMAP_VICTIM_PAIRS` guard below pins only the 6 harbors' 8 (harbor,
// layer) pairs that flip cleanly from ABSENT (0 features) under the shipped
// table to PRESENT (>=1) under the reverted one — `gelting-mole` and
// `graasten` show a same-layer COUNT increase without a layer newly
// appearing (already-present `places_locality` count goes up), and
// `faaborg`'s reverse-direction `roads_labels_major` flip is a different
// assertion SHAPE (present->absent, not absent->present) — both are real
// measured evidence but are not asserted as a boolean-presence forward
// guard here, to keep the pin unambiguous and mutation-checkable the same
// way `BLOCKED_AT_HEAD` above is.
//
// VERDICT: the basemap symbol-layer victim class named as UNMEASURED in the
// #981 issue is REAL and MEASURED, not merely theoretical — it is broader
// than the harbor-label class (8 harbors vs 6, four distinct basemap layers
// vs one app layer) and touches a DIFFERENT set of harbors (only
// `gelting-mole` overlaps the harbor-label `BLOCKED_AT_HEAD` set), which is
// expected: basemap point features (town centres, POIs) sit at different
// coordinates than this app's own harbor-snap points. #1126 should treat
// this as widening its lever choice's scope, not as a separate follow-up —
// any fix scoped to `sc-harbor-labels` alone (e.g. reordering just that one
// layer, or `icon-ignore-placement` narrowly aimed at the seamark/
// harbor-label pair) leaves this broader basemap class untouched.

interface ScTestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  project(lngLat: [number, number]): { x: number; y: number };
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{
    properties: Record<string, unknown>;
    layer: { id: string };
  }>;
}

interface Harbor {
  id: string;
  snap: { lat: number; lon: number };
}

const harbors: Harbor[] = JSON.parse(
  readFileSync(new URL('../public/data/harbors.json', import.meta.url), 'utf8'),
);

// The 6 of 33 committed harbors whose sc-harbor-labels visibility at z12.5
// is currently BLOCKED by seamarks' inflated z12-bucket collision box
// (measured 2026-09-09, see header). Every other harbor is either blocked
// in both the current and the pre-#860 table (label-dense area, unrelated
// to #860) or visible in both (no seamark contention there) and carries no
// #860-attributable signal either way.
const BLOCKED_AT_HEAD = [
  'aaroesund',
  'drejoe',
  'gelting-mole',
  'hoeruphav',
  'troense',
  'wackerballig',
];
const PROBE_ZOOM = 12.5;
const HALF_DEGREES = 0.01;

const SETTLE_POLL_INTERVAL_MS = 400;
const SETTLE_STABLE_READS_REQUIRED = 3;
const SETTLE_MAX_READS = 27;

async function readLabelPresent(page: Page, h: Harbor): Promise<boolean> {
  return page.evaluate(
    ({ lat, lon, half }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const nw = map.project([lon - half, lat + half]);
      const se = map.project([lon + half, lat - half]);
      const feats = map.queryRenderedFeatures(
        [
          [nw.x, nw.y],
          [se.x, se.y],
        ],
        { layers: ['sc-harbor-labels'] },
      );
      return feats.length > 0;
    },
    { lat: h.snap.lat, lon: h.snap.lon, half: HALF_DEGREES },
  );
}

async function settledLabelPresent(page: Page, h: Harbor): Promise<boolean> {
  const recent: boolean[] = [];
  for (let reads = 0; reads < SETTLE_MAX_READS; reads++) {
    const val = await readLabelPresent(page, h);
    recent.push(val);
    if (recent.length > SETTLE_STABLE_READS_REQUIRED) recent.shift();
    const stable =
      recent.length === SETTLE_STABLE_READS_REQUIRED && recent.every((v) => v === recent[0]);
    if (stable) return recent[0];
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `[${h.id}] sc-harbor-labels presence never stabilized across ${SETTLE_MAX_READS} reads: ${JSON.stringify(recent)}`,
  );
}

test('#981: seamark z12-bucket collision growth blocks 6 named harbor labels at z12.5', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
    const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
    await expect(seamarksToggle).toBeVisible();
    await seamarksToggle.check();

    for (const id of BLOCKED_AT_HEAD) {
      const h = harbors.find((x) => x.id === id);
      expect(h, `harbor ${id} missing from harbors.json`).toBeTruthy();
      if (!h) continue;
      await page.evaluate(
        ({ center, zoom }) =>
          (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.jumpTo({ center, zoom }),
        { center: [h.snap.lon, h.snap.lat] as [number, number], zoom: PROBE_ZOOM },
      );
      const present = await settledLabelPresent(page, h);
      expect(
        present,
        `${id}: expected sc-harbor-labels BLOCKED at z${PROBE_ZOOM} (#981/#860)`,
      ).toBe(false);
    }
  } finally {
    await server.kill();
  }
});

// #981 second victim class (see header MEASURED block above): the 6
// harbors x 8 (harbor, layer) pairs whose basemap symbol-layer presence at
// z12.5 flips cleanly ABSENT (shipped `[13, 1.4]` table) -> PRESENT
// (reverted pre-#860 `[13, 0.85]` table). Deliberately narrower than the
// full 8-of-33-harbor finding the header describes — `gelting-mole` and
// `graasten`'s count-only increases and `faaborg`'s reverse-direction
// `roads_labels_major` flip are excluded here because they are not a clean
// "0 at head, >=1 reverted" boolean and would need a differently-shaped
// assertion; see the header for why.
const BASEMAP_VICTIM_PAIRS: Array<{ harborId: string; layer: string }> = [
  { harborId: 'aabenraa', layer: 'places_locality' },
  { harborId: 'aabenraa', layer: 'roads_labels_major' },
  { harborId: 'aaroesund', layer: 'places_locality' },
  { harborId: 'arnis', layer: 'roads_shields' },
  { harborId: 'faaborg', layer: 'places_locality' },
  { harborId: 'faaborg', layer: 'roads_shields' },
  { harborId: 'kappeln', layer: 'places_subplace' },
  { harborId: 'svendborg', layer: 'places_subplace' },
];

async function readLayerFeatureCount(page: Page, h: Harbor, layer: string): Promise<number> {
  return page.evaluate(
    ({ lat, lon, half, layer }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const nw = map.project([lon - half, lat + half]);
      const se = map.project([lon + half, lat - half]);
      const feats = map.queryRenderedFeatures(
        [
          [nw.x, nw.y],
          [se.x, se.y],
        ],
        { layers: [layer] },
      );
      return feats.length;
    },
    { lat: h.snap.lat, lon: h.snap.lon, half: HALF_DEGREES, layer },
  );
}

async function settledLayerAbsent(page: Page, h: Harbor, layer: string): Promise<boolean> {
  const recent: boolean[] = [];
  for (let reads = 0; reads < SETTLE_MAX_READS; reads++) {
    const val = (await readLayerFeatureCount(page, h, layer)) === 0;
    recent.push(val);
    if (recent.length > SETTLE_STABLE_READS_REQUIRED) recent.shift();
    const stable =
      recent.length === SETTLE_STABLE_READS_REQUIRED && recent.every((v) => v === recent[0]);
    if (stable) return recent[0];
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `[${h.id}/${layer}] presence never stabilized across ${SETTLE_MAX_READS} reads: ${JSON.stringify(recent)}`,
  );
}

test('#981: seamark z12-bucket collision growth blocks basemap symbol layers at z12.5', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const server = await startPreview(page);
  try {
    await page.goto(server.url);
    await mapReady(page);
    const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
    await expect(seamarksToggle).toBeVisible();
    await seamarksToggle.check();

    for (const { harborId, layer } of BASEMAP_VICTIM_PAIRS) {
      const h = harbors.find((x) => x.id === harborId);
      expect(h, `harbor ${harborId} missing from harbors.json`).toBeTruthy();
      if (!h) continue;
      await page.evaluate(
        ({ center, zoom }) =>
          (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.jumpTo({ center, zoom }),
        { center: [h.snap.lon, h.snap.lat] as [number, number], zoom: PROBE_ZOOM },
      );
      const absent = await settledLayerAbsent(page, h, layer);
      expect(
        absent,
        `${harborId}/${layer}: expected BLOCKED (absent) at z${PROBE_ZOOM} (#981 basemap victim class)`,
      ).toBe(true);
    }
  } finally {
    await server.kill();
  }
});
