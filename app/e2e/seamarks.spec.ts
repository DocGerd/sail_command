import { test, expect, type Page } from '@playwright/test';
import { startPreview, mapReady } from './helpers';

// #353 PR1: measurement guard for the seamark size axis. This repo has
// already been bitten (#191/#192): enlarging map icons CULLS them below the
// z12 `icon-overlap` threshold, because MapLibre's collision footprint
// scales with icon size — `icon-padding` is the documented lever for
// offsetting that growth without changing the collision footprint
// (`seamarkGeoJson.ts`'s `SEAMARKS_LAYOUT` doc comment, CLAUDE.md). A size
// control shipped without a measurement guard would silently delete
// navigation marks — on a marine chart that's a safety-relevant regression,
// not a cosmetic one — so this file's job is to make that regression
// OBSERVABLE, never to assert anything about how the app "looks".
//
// PR1 itself ships NO visible change (SEAMARK_SIZE_SCALE = 1 in
// seamarkGlyphs.ts), so every pin below is a regression baseline measured
// against the real committed `app/public/data/seamarks.json` at that
// default, not a hand-guessed number. The actual PROOF that the guard has
// teeth — bumping the scale without the icon-padding compensation reds the
// z<12 assertion while the z>=12 one stays green, and restoring the
// compensation turns z<12 green again — is a manual 2x2 experiment run
// against this same spec (four scale/compensation combinations); the
// resulting counts are reported in the PR description rather than
// hardcoded here as a second, easily-stale copy of the same numbers.
//
// Two zoom regimes are measured because they behave OPPOSITELY
// (SEAMARKS_LAYOUT's own `icon-overlap` is `['step', ['zoom'], 'never', 12,
// 'always']`), and that contrast IS the signature — a single-zoom
// measurement cannot tell "the source data changed" from "collision
// growth ate some marks":
//  - z < 12: `icon-overlap: 'never'` — collision culling is LIVE, so this is
//    where a scale-driven icon-size increase deletes marks if the
//    icon-padding compensation is wrong or missing.
//  - z >= 12: `icon-overlap: 'always'` — nothing is culled, so EVERY feature
//    in view is placed regardless of icon size or padding; this count is
//    structurally invariant to the size axis and isolates "something else
//    changed" (source data, layer wiring) from a collision regression.
//
// Both regimes query the SAME fixed geographic box (CLUSTER_CENTER +/-
// CLUSTER_HALF_DEGREES, translated to screen pixels per-zoom via
// `map.project()`) rather than the whole viewport. Measured directly: a
// whole-viewport query at z10 returned MORE features (64) than at z13 (56)
// — the OPPOSITE of what culling alone would predict — because a lower zoom
// shows a much LARGER geographic area on screen, so raw viewport counts
// conflate "more area visible" with "less culling" and cannot isolate
// either. Restricting both reads to one fixed real-world box removes that
// confound: the box's CANDIDATE feature set (what a human would call "the
// marks in this harbour approach") is identical at both zooms, so a count
// difference between the two regimes can only be collision culling.
//
// Settle gate modelled on labels.spec.ts's `settledPlacedLabels` (#320),
// NOT on `map.once('idle')`: CLAUDE.md records that idle is measurably
// UNREACHABLE here — on an already-loaded static map the one-shot initial
// 'idle' has already fired before a listener can attach, so a
// `map.once('idle', done)` raced against a cap always takes the cap (an
// unconditional sleep in a state-signal costume that is also
// self-concealing, since a gate that always times out and always passes
// looks identical to one that settles fast). This polls the actual state —
// the sorted list of rendered `icon` ids in the fixed box — until
// SETTLE_STABLE_READS_REQUIRED consecutive reads are byte-identical, and
// fails CLOSED (throws, naming the full count history and the last
// unstable reads) rather than proceeding on a still-settling snapshot.

interface ScTestMap {
  jumpTo(options: { center: [number, number]; zoom: number }): unknown;
  getLayer(id: string): unknown;
  project(lngLat: [number, number]): { x: number; y: number };
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
}

// Densest real cluster found in the committed `app/public/data/seamarks.json`
// (1,794 features total, matching seamarkGlyphs.ts's own doc comment) via a
// one-off 0.03°-grid density scan: 43 marks fall within +/-0.015° of this
// point by raw coordinate — the single densest cell in the whole
// 54.3-55.3°N / 9.4-11.0°E forecast area, chosen specifically because a
// dense cluster is what makes below-z12 culling observable at all; a sparse
// area would show no contrast between the two zoom regimes regardless of
// icon size. Independently re-derived via `node -e` over the committed data
// before this spec was written (not eyeballed). The z>=12 pin below is 44,
// not 43: `queryRenderedFeatures` matches a symbol's RENDERED icon extent
// against the query box, not just its anchor coordinate, so one mark whose
// anchor sits just outside the box still qualifies because its icon
// overlaps the edge — expected, not a discrepancy to chase.
const CLUSTER_CENTER: [number, number] = [10.515, 54.855];
const CLUSTER_HALF_DEGREES = 0.015;
const ZOOM_BELOW_12 = 10;
const ZOOM_AT_OR_ABOVE_12 = 13;

// Every page.evaluate() callback below is re-parsed and run inside the
// BROWSER realm — it shares no closure with this module, so each one reads
// `window.__scE2eMap` directly (installed by helpers.ts's mapReady()) rather
// than calling a shared Node-side helper, which would ReferenceError at
// runtime (measured: exactly that mistake in an earlier revision of this
// file, `getTestMap is not defined`).

async function waitForSeamarksLayer(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Boolean(
            (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.getLayer('sc-seamarks'),
          ),
        ),
      {
        timeout: 30_000,
        message: "the 'sc-seamarks' layer never appeared on the map",
      },
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

// Reads the sorted `icon` ids of every 'sc-seamarks' feature rendered inside
// the FIXED geographic box (CLUSTER_CENTER +/- CLUSTER_HALF_DEGREES),
// re-projected to the CURRENT screen pixels every call — never cached across
// zoom changes, since `project()`'s output depends on the live camera
// transform (the file header explains why a fixed geographic box, not a
// fixed pixel box or the whole viewport, is what makes the two zoom regimes
// comparable at all).
async function readSortedSeamarkIconIdsInClusterBox(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ center, half }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const nw = map.project([center[0] - half, center[1] + half]);
      const se = map.project([center[0] + half, center[1] - half]);
      return map
        .queryRenderedFeatures(
          [
            [nw.x, nw.y],
            [se.x, se.y],
          ],
          { layers: ['sc-seamarks'] },
        )
        .map((f) => String(f.properties.icon))
        .sort();
    },
    { center: CLUSTER_CENTER, half: CLUSTER_HALF_DEGREES },
  );
}

// Same cadence/threshold as labels.spec.ts's settle gate, and for the same
// measured reason: maplibre-gl 6.1.0's `Placement.stillRecent`
// (symbol/placement.ts:1268-1277) suppresses a fresh placement recompute
// while `commitTime + fadeDuration * durationAdjustment > now`, and
// `ui/map.ts`'s `Map` constructor defaults `fadeDuration` to 300ms
// (`:539`, same installed version, app/package-lock.json's pin) — a 400ms
// interval exceeds that window, and three consecutive matches (not two)
// guard against two reads landing inside one quiescent window without ever
// spanning an actual recompute.
const SETTLE_POLL_INTERVAL_MS = 400;
const SETTLE_STABLE_READS_REQUIRED = 3;
const SETTLE_MAX_READS = 27; // ~10.8s budget at 400ms cadence — see labels.spec.ts's identical constant for the CI-margin rationale.

interface SettledSeamarks {
  iconIds: string[];
  reads: number;
  elapsedMs: number;
}

async function settledSeamarkIconIds(page: Page, label: string): Promise<SettledSeamarks> {
  const start = Date.now();
  const countHistory: number[] = [];
  const recentReads: string[][] = [];
  const first = await readSortedSeamarkIconIdsInClusterBox(page);
  countHistory.push(first.length);
  recentReads.push(first);

  for (let extraReads = 1; extraReads <= SETTLE_MAX_READS; extraReads++) {
    await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = await readSortedSeamarkIconIdsInClusterBox(page);
    countHistory.push(next.length);
    recentReads.push(next);
    if (recentReads.length > SETTLE_STABLE_READS_REQUIRED) recentReads.shift();

    // Compare the full sorted id array, not just the count — a same-count
    // swap (one icon type culled while another appears) must not read as
    // stable, the same blindness class labels.spec.ts's settle gate guards
    // against.
    const windowStable =
      recentReads.length === SETTLE_STABLE_READS_REQUIRED &&
      recentReads.every((ids) => JSON.stringify(ids) === JSON.stringify(recentReads[0]));
    if (windowStable) {
      return { iconIds: next, reads: extraReads + 1, elapsedMs: Date.now() - start };
    }
  }
  const totalReads = countHistory.length;
  throw new Error(
    `[${label}] sc-seamarks placement never stabilized across ${totalReads} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ~${(totalReads * SETTLE_POLL_INTERVAL_MS) / 1000}s budget, ` +
      `${SETTLE_STABLE_READS_REQUIRED} consecutive matches required); counts seen: ${JSON.stringify(countHistory)}; ` +
      `last ${recentReads.length} icon-id sets: ${JSON.stringify(recentReads)}`,
  );
}

test('#353: seamark size-axis guard — icon-overlap collision culling below z12 vs. none at/above z12', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    await page.goto(server.url);
    await mapReady(page);
    await waitForSeamarksLayer(page);

    // #7: seamarks default OFF (opt-in specialist layer) — must be enabled
    // before anything renders on 'sc-seamarks'.
    const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
    await expect(seamarksToggle).toBeVisible();
    await seamarksToggle.check();
    await expect(seamarksToggle).toBeChecked();

    await jumpToCluster(page, ZOOM_BELOW_12);
    const low = await settledSeamarkIconIds(page, `z${ZOOM_BELOW_12} (<12)`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_BELOW_12} settled after ${low.reads} reads ` +
        `(${low.elapsedMs}ms), ${low.iconIds.length} features in the cluster box`,
    );

    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);
    const high = await settledSeamarkIconIds(page, `z${ZOOM_AT_OR_ABOVE_12} (>=12)`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_AT_OR_ABOVE_12} settled after ${high.reads} reads ` +
        `(${high.elapsedMs}ms), ${high.iconIds.length} features in the cluster box`,
    );

    // Regression pins at SEAMARK_SIZE_SCALE = 1 (today's shipped default),
    // measured against the real committed seamarks.json — not hand-guessed.
    // A future size-axis change that breaks the icon-padding compensation
    // would move the z<12 count away from its pin while the z>=12 count
    // (structurally collision-immune, and querying the exact same
    // geographic box) stays exactly where it is — the #191/#192 signature
    // this file exists to catch.
    expect(
      low.iconIds.length,
      `z${ZOOM_BELOW_12} (<12, collision culling live) feature count drifted from its pin — ` +
        `full id set: ${JSON.stringify(low.iconIds)}`,
    ).toBe(5);
    expect(
      high.iconIds.length,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12, no culling) feature count drifted from its pin — ` +
        `full id set: ${JSON.stringify(high.iconIds)}`,
    ).toBe(44);

    // Below z12 must actually cull something relative to the uncollided
    // z>=12 view of the SAME geographic box, or this spec would not be
    // exercising the collision code path it exists to guard at all.
    expect(
      low.iconIds.length,
      `expected z${ZOOM_BELOW_12} to cull at least one mark relative to z${ZOOM_AT_OR_ABOVE_12}'s ` +
        `uncollided ${high.iconIds.length} in the same box — got the same count, so this cluster/zoom ` +
        `pair is not exercising collision culling at all`,
    ).toBeLessThan(high.iconIds.length);
  } finally {
    server.kill();
  }
});
