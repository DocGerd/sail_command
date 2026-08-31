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
// #353 PR2 adds the user-facing controls this file's own PR1 comments named
// as deferred: a size slider (SettingsPanel.tsx, wired to the same
// SEAMARK_SIZE_SCALE axis measured above) and a display-CATEGORY filter
// (Base/Standard/All, `seamarkGlyphs.ts`'s `seamarkDisplayTier`) defaulting
// to STANDARD — per the #353 issue's own design sketch. The mapping was
// CORRECTED in review (#513 F1/F2), informed by IMO MSC.232(82) Appendix 2's
// ECDIS Display Base/Standard Display/All Other Information split: the
// FIRST #353 PR2 revision put whole families (lightMinor/specialPurpose/
// unknown) behind STANDARD, hiding 810 of 1794 shipped marks at the
// default, including 259 explicitly hazard/prohibition-categorised ones —
// see `seamarkGlyphs.ts`'s `seamarkDisplayTier` doc comment for the mapping
// and its reasoning. The CORRECTED default hides 119 of 1794: the two
// `specialPurpose` categories `cable` (117) and `pipeline` (2), a
// deliberate decluttering choice rather than an application of Appendix 2
// item 3.2, whose "submarine cables and pipelines" is plain English naming
// no object class; in S-57 that content is `CBLSUB` (Line) / `PIPSOL`,
// while all 1794 shipped features are Points — object-class question
// tracked in #521. Those 119 are themselves part of the 259
// above, so the correction did not clear that set: 140 of the 259 are shown
// at the default and 119 are not (measured 2026-08-13 against the committed
// `app/public/data/seamarks.json`) — describing the state #513 F1/F2
// shipped, NOT the state today: the #521 maintainer ruling (2026-08-21)
// reversed that carve-out (`SPECIAL_PURPOSE_ALL_CATEGORIES` in
// seamarkGlyphs.ts is now empty), so the STANDARD default hides ZERO of
// 1794 and `SEAMARK_DISPLAY_TIER_ALL` is inert for today's shipped data —
// "All" renders identically to "Standard". So the Standard-category PIN
// VALUES below are no longer smaller than PR1's own committed baseline at
// the identical cluster/zoom pair; they are now IDENTICAL to it (measured,
// not assumed) — this test still re-measures the "category=All" case
// afterwards, which now proves both that selection reproduces PR1's
// original, unfiltered counts byte-for-byte AND that it is
// indistinguishable from "Standard" (the BASE-vs-HEAD control this PR owes
// per CLAUDE.md's #191/#192 rule, now one level indirect: HEAD's "All"
// selection must equal BASE's only selection — and, since #521, HEAD's
// "Standard" selection too).
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
// either. Restricting both reads to one fixed real-world box removes THAT
// confound, but does not make the two regimes' CANDIDATE sets perfectly
// identical on its own (#484 F2): `queryRenderedFeatures` matches a
// symbol's COLLISION BOX against the query geometry, not its anchor point
// (`CollisionIndex.queryRenderedSymbols`, `collision_index.ts:369-409`,
// `maplibre-gl@6.1.0` — confirmed via `npm ci` against
// `app/package-lock.json`'s pin), so the effective capture region is the
// geographic box expanded by the icon's half-extent on every side — a FIXED
// PIXEL amount against a box whose pixel size changes ~8x between z10 and
// z13. At z10 that fringe is a large fraction of a small box (1.88x nominal
// area, 47 geometric candidates); at z13 it's a small fraction of a large
// box (1.13x, 44 candidates) — not identical, though close enough that
// culling still dominates the count difference by a wide margin.
// ZOOM_BELOW_12 is 11.5, not 10, specifically to close most of that gap:
// at z11.5 the capture aperture is 1.32x and the geometric candidate count
// is 44 — matching z13's 44 — while staying below the z12 `icon-overlap`
// threshold, so collision culling is still live. Any remaining SURVIVOR
// count difference between the two regimes at that zoom pair is then
// attributable to collision culling with the smallest residual confound
// this box/zoom construction can achieve, not to "identical candidate
// sets" as an exact claim.
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
  // #232 item 2: geometry was added to the return type (backward-compatible
  // with every existing `.properties`-only consumer above) so the
  // cross-tile measurement at the end of this file can read a rendered
  // feature's own coordinates, not just its properties.
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: [number, number] };
  }>;
  // #232 item 2 only: reads a GeoJSON source's features from whatever tiles
  // MapLibre currently has loaded, BEFORE collision culling — the
  // complement of queryRenderedFeatures (AFTER culling) that makes a direct
  // culled/rendered diff possible instead of guessing from geometry alone.
  querySourceFeatures(sourceId: string): Array<{
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: [number, number] };
  }>;
}

// One of the two JOINT-densest cells (#484 F7 — an earlier revision of this
// comment claimed "the single densest cell", which is FALSE: re-derived via
// `node -e` over the committed `app/public/data/seamarks.json` (1,794
// features total, matching seamarkGlyphs.ts's own doc comment), a 0.03°-grid
// scan finds TWO cells tied at 43 marks — this one and (10.695, 54.945) —
// with (10.215, 54.405) next at 42. Nothing depends on the tie being
// broken; a joint-densest cell is just as good a choice for this guard, so
// this is purely a wording fix, not a behaviour change) within +/-0.015° of
// this point by raw coordinate, chosen specifically because a dense cluster
// is what makes below-z12 culling observable at all — a sparse area would
// show no contrast between the two zoom regimes regardless of icon size.
// The z>=12 pin at category=ALL (below) is 44, not 43: `queryRenderedFeatures`
// matches a symbol's RENDERED collision-box extent against the query box,
// not just its anchor coordinate (see the file header's #484 F2 note), so
// one mark whose anchor sits just outside the box still qualifies because
// its icon overlaps the edge — expected, not a discrepancy to chase. #353
// PR2 originally added a SECOND, SMALLER z>=12 pin at the default category
// (Standard, hiding only this box's `cable`/`pipeline`-categorised
// `specialPurpose` marks — #513 F1/F2's corrected mapping); since #521
// (2026-08-21 ruling) reversed that carve-out, the Standard-category z>=12
// pin below is now IDENTICAL to this All-category one, not smaller — see
// the file header and the pin's own comment below.
const CLUSTER_CENTER: [number, number] = [10.515, 54.855];
const CLUSTER_HALF_DEGREES = 0.015;
// #484 F2: 11.5, not 10 — see the file header for why. Still comfortably
// below the z12 `icon-overlap: 'never'`->'always' threshold.
const ZOOM_BELOW_12 = 11.5;
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

// Reads the sorted `icon` ids of every seamark feature rendered inside the
// FIXED geographic box (CLUSTER_CENTER +/- CLUSTER_HALF_DEGREES),
// re-projected to the CURRENT screen pixels every call — never cached across
// zoom changes, since `project()`'s output depends on the live camera
// transform (the file header explains why a fixed geographic box, not a
// fixed pixel box or the whole viewport, is what makes the two zoom regimes
// comparable at all).
//
// #682 (found by CI, run 33008546750): queries BOTH `sc-seamarks` AND
// `sc-seamarks-hazard` — #682 split the single seamark layer into a
// routine layer and a hazard-family overlay (cardinal/isolatedDanger,
// stacked above so they paint correctly at z>=12; see seamarkGeoJson.ts's
// SEAMARKS_LAYOUT doc comment). Querying `sc-seamarks` alone silently
// dropped the 2 hazard marks this box's own z11.5 pin below expects
// (`seamark-cardinal-north`/`seamark-cardinal-south`) — MEASURED: at
// z11.5, querying `sc-seamarks-hazard` alone returns exactly those 2 ids,
// so they are correctly placed and simply live on the other layer, not
// culled (a real z<12 culling regression would have been a design defect
// #682 exists specifically to avoid — this was not that). This function's
// job is "every seamark icon in the box", so it must cover every layer
// that can hold one; the guard's PIN values are unaffected; only its
// query scope was too narrow.
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
          { layers: ['sc-seamarks', 'sc-seamarks-hazard'] },
        )
        .map((f) => String(f.properties.icon))
        .sort();
    },
    { center: CLUSTER_CENTER, half: CLUSTER_HALF_DEGREES },
  );
}

// Same cadence/threshold as labels.spec.ts's settle gate, and for the same
// measured reason: `Placement.stillRecent` (symbol/placement.ts:1268-1277)
// suppresses a fresh placement recompute while `commitTime + fadeDuration *
// durationAdjustment > now`, and `ui/map.ts`'s `Map` constructor defaults
// `fadeDuration` to 300ms (`:539`) — a 400ms interval exceeds that window,
// and three consecutive matches (not two) guard against two reads landing
// inside one quiescent window without ever spanning an actual recompute.
// Read against `maplibre-gl@6.1.0` — confirmed via `npm ci` against
// `app/package-lock.json`'s pin, not merely grepped from a possibly-stale
// `node_modules` (#484 F5: an earlier revision of this comment said "same
// installed version" without having actually run `npm ci` first, which is
// the exact #392 trap CLAUDE.md documents — this checkout's tree WAS stale
// at 6.0.0 when that wording was written, even though the cited line
// numbers happened to be correct at both versions).
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

test('#353: seamark size-axis guard — icon-overlap collision culling below z12 vs. none at/above z12, at both display categories', async ({
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
    const low = await settledSeamarkIconIds(page, `z${ZOOM_BELOW_12} (<12) category=Standard`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_BELOW_12} category=Standard settled after ${low.reads} reads ` +
        `(${low.elapsedMs}ms), ${low.iconIds.length} features in the cluster box: ${JSON.stringify(low.iconIds)}`,
    );

    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);
    const high = await settledSeamarkIconIds(
      page,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12) category=Standard`,
    );
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_AT_OR_ABOVE_12} category=Standard settled after ${high.reads} reads ` +
        `(${high.elapsedMs}ms), ${high.iconIds.length} features in the cluster box: ${JSON.stringify(high.iconIds)}`,
    );

    // Regression pins at SEAMARK_SIZE_SCALE = 1 and the DEFAULT display
    // category (Standard — #353 PR2, mapping corrected #513 F1/F2),
    // measured against the real committed seamarks.json — not hand-guessed.
    // A future size-axis change that breaks the icon-padding compensation
    // would move the z<12 SET away from its pin while the z>=12 set
    // (structurally collision-immune, and querying the exact same
    // geographic box) stays exactly where it is — the #191/#192 signature
    // this file exists to catch.
    //
    // #521 (maintainer ruling, 2026-08-21): `cable`/`pipeline` marks now
    // resolve to STANDARD instead of ALL (`SPECIAL_PURPOSE_ALL_CATEGORIES`
    // in seamarkGlyphs.ts is now empty), so these two sets are NO LONGER
    // smaller than PR1's own baseline at the identical cluster/zoom pair —
    // they are IDENTICAL to it, and to the category=All pins measured
    // later in this same test. Before #521 (under #513 F1/F2's
    // now-superseded carve-out) this box's Standard set was missing 1 of 1
    // `seamark-special-black` at z11.5 and 2 of 4 at z13 — measured, not
    // inferred from the icon id (`seamark-special-*` is colour-keyed, not
    // category-keyed). #521 restores both, verified below (in this same
    // run) against the console-logged `high`/`low` reads before the
    // assertions were updated, and re-verified structurally by the
    // category=All re-measurement further down, which now doubles as
    // proof that "Standard" and "All" render identically in this box, not
    // just that "All" reproduces PR1's original counts.
    //
    // #484 F6: pinned as the FULL SORTED ID ARRAY, not `.length` — the
    // settle gate above already refuses to call a read "stable" on a
    // same-count SWAP (one icon type culled while another appears), and an
    // earlier revision of this file threw that work away by reducing the
    // result to a bare count before asserting, which would have let exactly
    // that swap sail through as a pass. The ids were already in hand; this
    // costs nothing. At z13 (icon-overlap:'always') this is unambiguously
    // safe and strictly stronger — nothing is culled, so the set is fully
    // deterministic; `symbol-sort-key` makes the z11.5 survivor set
    // well-defined too, so both are pinned.
    //
    // Both counts are also implicitly coupled to Playwright's `Desktop
    // Chrome` project's default viewport (1280x720, `playwright.config.ts`)
    // via the pixel clip `queryRenderedFeatures` applies — nothing to fix
    // here, but a future default-viewport change would move these pins for
    // a reason unrelated to the size axis, and a reader hitting that red
    // should not have to rediscover why.
    expect(
      low.iconIds,
      `z${ZOOM_BELOW_12} (<12, collision culling live, category=Standard) id set drifted from its pin`,
    ).toEqual([
      'seamark-cardinal-north',
      'seamark-cardinal-south',
      'seamark-lateral-pillar-green-starboard',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-red-port',
      'seamark-special-black',
      'seamark-special-default',
    ]);
    expect(
      high.iconIds,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12, no culling, category=Standard) id set drifted from its pin`,
    ).toEqual([
      'seamark-cardinal-north',
      'seamark-cardinal-south',
      'seamark-lateral-pillar-green-starboard',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-light-minor',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-default',
      'seamark-special-default',
      'seamark-special-default',
      'seamark-special-default',
    ]);

    // Below z12 must actually cull something relative to the uncollided
    // z>=12 view of the SAME geographic box, or this spec would not be
    // exercising the collision code path it exists to guard at all.
    expect(
      low.iconIds.length,
      `expected z${ZOOM_BELOW_12} to cull at least one mark relative to z${ZOOM_AT_OR_ABOVE_12}'s ` +
        `uncollided ${high.iconIds.length} in the same box — got the same count, so this cluster/zoom ` +
        `pair is not exercising collision culling at all`,
    ).toBeLessThan(high.iconIds.length);

    // #353 PR2's own BASE-vs-HEAD regression control (CLAUDE.md's #191/#192
    // rule): selecting "Alle" (All — SEAMARK_DISPLAY_TIER_ALL) via the new
    // Boat-tab control must reproduce PR1's original, unfiltered baseline at
    // this exact cluster/zoom pair BYTE-FOR-BYTE — proving the display-
    // category filter and the pre-existing size-axis/collision guard compose
    // correctly rather than one silently masking a regression in the other.
    // The Boat tab is reachable from anywhere (it only swaps the bottom-
    // sheet content — MapView stays mounted and keeps its current camera),
    // so no re-navigation back to the map view is needed afterwards.
    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByRole('radio', { name: 'Alle' }).click();
    await expect(page.getByRole('radio', { name: 'Alle' })).toBeChecked();

    await jumpToCluster(page, ZOOM_BELOW_12);
    const lowAll = await settledSeamarkIconIds(page, `z${ZOOM_BELOW_12} (<12) category=All`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_BELOW_12} category=All settled after ${lowAll.reads} reads ` +
        `(${lowAll.elapsedMs}ms), ${lowAll.iconIds.length} features in the cluster box: ${JSON.stringify(lowAll.iconIds)}`,
    );
    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);
    const highAll = await settledSeamarkIconIds(
      page,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12) category=All`,
    );
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_AT_OR_ABOVE_12} category=All settled after ${highAll.reads} reads ` +
        `(${highAll.elapsedMs}ms), ${highAll.iconIds.length} features in the cluster box: ${JSON.stringify(highAll.iconIds)}`,
    );

    // Exactly PR1's own committed pins (`git log` on this file before #353
    // PR2) — reproduced here rather than only in history, so a future
    // regression in EITHER the category filter or the underlying
    // size/collision mechanism reds this test directly instead of requiring
    // a diff against a past commit.
    expect(
      lowAll.iconIds,
      `z${ZOOM_BELOW_12} (<12, collision culling live, category=All) id set drifted from PR1's original pin`,
    ).toEqual([
      'seamark-cardinal-north',
      'seamark-cardinal-south',
      'seamark-lateral-pillar-green-starboard',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-red-port',
      'seamark-special-black',
      'seamark-special-default',
    ]);
    expect(
      highAll.iconIds,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12, no culling, category=All) id set drifted from PR1's original pin`,
    ).toEqual([
      'seamark-cardinal-north',
      'seamark-cardinal-south',
      'seamark-lateral-pillar-green-starboard',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-green-starboard',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-light-minor',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-black',
      'seamark-special-default',
      'seamark-special-default',
      'seamark-special-default',
      'seamark-special-default',
    ]);
    expect(
      lowAll.iconIds.length,
      `expected z${ZOOM_BELOW_12} to cull at least one mark relative to z${ZOOM_AT_OR_ABOVE_12}'s ` +
        `uncollided ${highAll.iconIds.length} in the same box at category=All too`,
    ).toBeLessThan(highAll.iconIds.length);

    // #513 F5/R1: the SIZE axis — the PR's headline feature — had no
    // end-to-end evidence at any scale but the default (1). Both ends of
    // the 0.5-1.5 range are exercised here via the REAL slider control
    // (native Home/End keys — a focused `<input type="range">`'s standard
    // browser behaviour, jumping to its `min`/`max`), still at
    // category=All from the block above so the size axis is isolated from
    // the category filter (a category-caused count change would otherwise
    // be indistinguishable from a size-caused one).
    //
    // z>=12 (`icon-overlap:'always'`, nothing culled): the set must equal
    // `highAll.iconIds` EXACTLY at both 0.5 and 1.5. Any drift here is the
    // #191/#192 signature (something moved besides the size) — and it is
    // the STRUCTURALLY sound half: `iconPaddingAt`'s compensation is built
    // so `displayed + 2*padding` has no `scale` term (derivation in
    // `seamarkGeoJson.ts`'s own comment), so the collision box —
    // `queryRenderedFeatures`'s match target — cannot widen with icon size.
    //
    // z<12 (collision culling live) is PINNED, not merely reported — an
    // earlier revision of this comment argued the z<12 set couldn't be
    // pinned because "a bigger icon captures a wider fringe around the
    // query box"; that argument is REFUTED by this file's own measured
    // output (#513 R1): scale=1.5, where a widened fringe would have to
    // show if the argument were true, is BYTE-IDENTICAL to the scale=1
    // baseline (`lowAll.iconIds`), while scale=0.5 — the shrinking
    // direction — is the one that differs, which the "wider fringe"
    // mechanism cannot explain at all. The scale=0.5 difference is a
    // same-COUNT SWAP (`seamark-lateral-pillar-green-starboard` culled,
    // a second `seamark-lateral-spar-red-port` placed instead) that a
    // `.length`-only check cannot see — the exact blindness this file's own
    // settle gate exists to prevent. No cause is asserted for the swap here
    // (the collision box is scale-invariant by the compensation formula, so
    // something OUTSIDE it is deciding placement, and what that is remains
    // undetermined) — only that it is measured and pinned, not argued away.
    const sizeSlider = page.getByRole('slider', { name: 'Symbolgröße (Seezeichen)' });

    await sizeSlider.focus();
    await page.keyboard.press('End'); // jumps to max = 1.5
    await expect(sizeSlider).toHaveValue('1.5');

    await jumpToCluster(page, ZOOM_BELOW_12);
    const lowMax = await settledSeamarkIconIds(page, `z${ZOOM_BELOW_12} (<12) scale=1.5`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_BELOW_12} scale=1.5 settled after ${lowMax.reads} reads ` +
        `(${lowMax.elapsedMs}ms), ${lowMax.iconIds.length} features in the cluster box: ${JSON.stringify(lowMax.iconIds)}`,
    );
    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);
    const highMax = await settledSeamarkIconIds(page, `z${ZOOM_AT_OR_ABOVE_12} (>=12) scale=1.5`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_AT_OR_ABOVE_12} scale=1.5 settled after ${highMax.reads} reads ` +
        `(${highMax.elapsedMs}ms), ${highMax.iconIds.length} features in the cluster box: ${JSON.stringify(highMax.iconIds)}`,
    );
    expect(
      highMax.iconIds,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12, scale=1.5) drifted from the scale=1 baseline — the #191/#192 signature`,
    ).toEqual(highAll.iconIds);
    // Measured identical to the scale=1 baseline (`lowAll.iconIds`) — the
    // strongest guard available, and it passes today.
    expect(
      lowMax.iconIds,
      `z${ZOOM_BELOW_12} (<12, scale=1.5) drifted from the scale=1 baseline — expected byte-identical`,
    ).toEqual(lowAll.iconIds);

    await sizeSlider.focus();
    await page.keyboard.press('Home'); // jumps to min = 0.5
    await expect(sizeSlider).toHaveValue('0.5');

    await jumpToCluster(page, ZOOM_BELOW_12);
    const lowMin = await settledSeamarkIconIds(page, `z${ZOOM_BELOW_12} (<12) scale=0.5`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_BELOW_12} scale=0.5 settled after ${lowMin.reads} reads ` +
        `(${lowMin.elapsedMs}ms), ${lowMin.iconIds.length} features in the cluster box: ${JSON.stringify(lowMin.iconIds)}`,
    );
    await jumpToCluster(page, ZOOM_AT_OR_ABOVE_12);
    const highMin = await settledSeamarkIconIds(page, `z${ZOOM_AT_OR_ABOVE_12} (>=12) scale=0.5`);
    console.log(
      `[#353 seamarks.spec.ts] z${ZOOM_AT_OR_ABOVE_12} scale=0.5 settled after ${highMin.reads} reads ` +
        `(${highMin.elapsedMs}ms), ${highMin.iconIds.length} features in the cluster box: ${JSON.stringify(highMin.iconIds)}`,
    );
    expect(
      highMin.iconIds,
      `z${ZOOM_AT_OR_ABOVE_12} (>=12, scale=0.5) drifted from the scale=1 baseline — the #191/#192 signature`,
    ).toEqual(highAll.iconIds);
    // #513 R1: a same-COUNT SWAP relative to the scale=1 baseline, measured
    // and pinned rather than argued away (see the block comment above) —
    // `seamark-lateral-pillar-green-starboard` (present in `lowAll.iconIds`)
    // is culled at scale=0.5, and a SECOND `seamark-lateral-spar-red-port`
    // is placed instead of the one it displaces. Cause undetermined; the
    // collision box is scale-invariant by construction (see above), so
    // something outside it decides this — left for a follow-up, not this PR.
    expect(
      lowMin.iconIds,
      `z${ZOOM_BELOW_12} (<12, scale=0.5) drifted from its measured pin`,
    ).toEqual([
      'seamark-cardinal-north',
      'seamark-cardinal-south',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-black-port',
      'seamark-lateral-spar-red-port',
      'seamark-lateral-spar-red-port',
      'seamark-special-black',
      'seamark-special-default',
    ]);
  } finally {
    server.kill();
  }
});

// #232 item 2 — cross-tile placement ordering, RE-MEASUREMENT (2026-08-31
// work session, retitle comment on #232). Three of the four #200 residuals
// grouped under #232 have shipped (z>=12 paint order via #682's layer
// split; tap wiring; popup anchoring) — cross-tile ordering is the only one
// left, and it needed re-measuring, not fixing: the issue's ORIGINAL
// premise ("symbol-sort-key only sorts within one tile bucket, so a
// low-priority mark in an earlier tile can beat a high-priority one in a
// later tile") was REFUTED by reading MapLibre source
// (seamarkGeoJson.ts's SEAMARKS_LAYOUT doc comment, item (c) under STATUS):
// `LayerPlacement._sortAcrossTiles` collects one BucketPart per tile from
// EVERY renderable tile of a layer's source, then sorts the WHOLE array by
// `sortKey` GLOBALLY before placing any of it — so a hazard mark in a
// later-processed tile IS placed (and therefore collision-wins) ahead of a
// lower-significance mark in an earlier tile, exactly as `symbol-sort-key`
// intends; there is no cross-tile leak in THAT mechanism. The REPLACEMENT
// hypothesis (2026-08-25 issue comment, unmeasured until this test): the
// residual z8/z9 sub-100% hazard retention #200 measured is ordinary
// EQUAL-OR-LOWER-KEY collision (a hazard mark legitimately culled by
// another hazard mark of equal or better rank), not a leak at all.
//
// Method, per CLAUDE.md's own prescription for re-measuring this and this
// file's own #353 precedent: measure ORDER, not counts — a per-family
// COUNT check is structurally blind to a placement-order defect, because
// `queryRenderedFeatures` results are order-independent. Use a FIXED
// geographic box, never a whole-viewport comparison across zooms (#353's
// own measured inverse signature: a whole-viewport query returned MORE
// features at z10 than at z13, backwards from what culling alone predicts,
// because a lower zoom shows a much larger geographic area on screen and
// conflates "more area visible" with "less culling"). This test's box is
// the app's own stated data region (CLAUDE.md: 54.3-55.3 degrees N,
// 9.4-11.0 degrees E) — fixed in exactly the sense CLUSTER_CENTER above is
// fixed (one constant real-world rectangle, re-projected to current screen
// pixels via map.project() at each zoom), and it is deliberately the WHOLE
// data footprint rather than a hand-picked sub-box: a `node -e` scan of the
// committed app/public/data/seamarks.json against the standard XYZ
// slippy-tile formula (2026-08-31) found the closest genuinely cross-tile
// hazard-mark pairs sitting within ~2km of each other near (9.75, 54.98)
// and (9.85, 54.85) at z8/z9 tile boundaries inside this region — a
// hand-picked box risked missing them or a sibling case just as easily.
//
// Post-#682 the hazard layer (`sc-seamarks-hazard`) is placed BEFORE the
// routine layer in every frame (a later-added layer paints AND places
// FIRST — CLAUDE.md's "placement runs top-to-bottom" rule, re-derived in
// seamarkGeoJson.ts's own STATUS comment item (b)), so nothing on the
// routine layer can displace a hazard mark any more: any residual hazard
// retention loss at z8/z9 must now be hazard-vs-hazard. This test diffs
// the hazard layer's SOURCE features (querySourceFeatures on the shared
// 'sc-seamarks' source, filtered to `hazard === true` — every hazard mark
// MapLibre has loaded for the current tiles, BEFORE collision culling)
// against its RENDERED features (queryRenderedFeatures on
// 'sc-seamarks-hazard' — what actually survived culling) to find every
// CULLED hazard mark directly, rather than inferring culling from
// geometry. For each culled mark it re-queries 'sc-seamarks-hazard' at
// that mark's own projected screen pixel (a radius generous enough to
// cover the icon collision box at either zoom) to find the feature
// actually occupying that space — the DISPLACER — and compares
// `symbol-sort-key` (the `priority` property both source and rendered
// features carry, stamped once by seamarkFeatureCollectionWithIcons and
// never re-derived here, so this test trusts the app's OWN computed value
// rather than a second, possibly-divergent implementation of
// seamarkPriority()). Per seamarkGeoJson.ts's `pickSeamarkByPriority` doc
// comment, a LOWER priority number is the more significant mark and must
// win under `icon-overlap: 'never'` (live below z12): a displacer whose
// priority is numerically WORSE (higher) than the mark it displaced is a
// genuine ordering violation, cross-tile or not — this test does not
// require the pair to straddle a tile boundary to count a leak, since the
// underlying question ("did a worse-ranked mark win?") does not depend on
// tile membership; tile membership is recorded per row for diagnosis only.
const SEAMARK_REGION = { lonMin: 9.4, lonMax: 11.0, latMin: 54.3, latMax: 55.3 } as const;

interface RenderedHazardFeature {
  lng: number;
  lat: number;
  priority: number;
  icon: string;
}

interface SourceHazardFeature extends RenderedHazardFeature {
  seamarkType: string;
}

// Standard XYZ slippy-tile indices (same formula the #232 re-measurement
// used to scan the committed seamarks.json for candidate cross-tile pairs
// before this test was written) — used here ONLY to label each row for
// diagnosis, never to gate the leak assertion itself.
function tileXY(lon: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

async function readHazardSourceFeatures(page: Page): Promise<SourceHazardFeature[]> {
  return page.evaluate(() => {
    const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
    const raw = map.querySourceFeatures('sc-seamarks');
    // querySourceFeatures can return the SAME feature more than once across
    // internal tile boundaries (MapLibre does not dedupe it the way
    // queryRenderedFeatures does for point queries) — dedupe by coordinate.
    const seen = new Set<string>();
    const out: SourceHazardFeature[] = [];
    for (const f of raw) {
      if (!f.properties.hazard) continue;
      const [lng, lat] = f.geometry.coordinates;
      const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        lng,
        lat,
        priority: Number(f.properties.priority),
        icon: String(f.properties.icon),
        seamarkType: String(f.properties.seamarkType),
      });
    }
    return out;
  });
}

async function readHazardRenderedFeaturesInRegion(
  page: Page,
  region: typeof SEAMARK_REGION,
): Promise<RenderedHazardFeature[]> {
  return page.evaluate((region) => {
    const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
    const nw = map.project([region.lonMin, region.latMax]);
    const se = map.project([region.lonMax, region.latMin]);
    return map
      .queryRenderedFeatures(
        [
          [nw.x, nw.y],
          [se.x, se.y],
        ],
        { layers: ['sc-seamarks-hazard'] },
      )
      .map((f) => ({
        lng: f.geometry.coordinates[0],
        lat: f.geometry.coordinates[1],
        priority: Number(f.properties.priority),
        icon: String(f.properties.icon),
      }));
  }, region);
}

// Same settle cadence/threshold as settledSeamarkIconIds above, and for the
// same measured reason (this file's header comment) — generalized to a
// region query instead of the small cluster box, and comparing the full
// sorted (lng,lat,priority,icon) tuple set rather than icon ids alone, so a
// same-count SWAP at the region scale is caught exactly as it is above.
async function settledHazardRenderedFeatures(
  page: Page,
  region: typeof SEAMARK_REGION,
  label: string,
): Promise<RenderedHazardFeature[]> {
  const countHistory: number[] = [];
  const recentReads: RenderedHazardFeature[][] = [];
  for (let reads = 0; reads <= SETTLE_MAX_READS; reads++) {
    if (reads > 0) await page.waitForTimeout(SETTLE_POLL_INTERVAL_MS);
    const next = (await readHazardRenderedFeaturesInRegion(page, region)).sort(
      (a, b) => a.lng - b.lng || a.lat - b.lat,
    );
    countHistory.push(next.length);
    recentReads.push(next);
    if (recentReads.length > SETTLE_STABLE_READS_REQUIRED) recentReads.shift();
    const windowStable =
      recentReads.length === SETTLE_STABLE_READS_REQUIRED &&
      recentReads.every((r) => JSON.stringify(r) === JSON.stringify(recentReads[0]));
    if (windowStable) return next;
  }
  throw new Error(
    `[${label}] hazard layer placement in the region never stabilized across ${countHistory.length} reads ` +
      `(${SETTLE_POLL_INTERVAL_MS}ms apart, ${SETTLE_STABLE_READS_REQUIRED} consecutive matches required); ` +
      `counts seen: ${JSON.stringify(countHistory)}`,
  );
}

// Radius generous enough to cover a hazard icon's collision box at either
// z8 (icon-size 0.55 * 32px natural footprint) or z9 (~0.6): the displacer
// that culled a mark must have a collision box overlapping the culled
// mark's own anchor, so its own anchor can be up to roughly one icon-width
// away — 30px comfortably covers that at both zooms with margin to spare.
const DISPLACER_PROBE_RADIUS_PX = 30;

async function hazardDisplacersAt(
  page: Page,
  lngLat: [number, number],
): Promise<RenderedHazardFeature[]> {
  return page.evaluate(
    ({ lngLat, r }) => {
      const map = (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap;
      const p = map.project(lngLat);
      return map
        .queryRenderedFeatures(
          [
            [p.x - r, p.y - r],
            [p.x + r, p.y + r],
          ],
          { layers: ['sc-seamarks-hazard'] },
        )
        .map((f) => ({
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
          priority: Number(f.properties.priority),
          icon: String(f.properties.icon),
        }));
    },
    { lngLat, r: DISPLACER_PROBE_RADIUS_PX },
  );
}

interface CulledHazardRow {
  zoom: number;
  culled: SourceHazardFeature & { tile: [number, number] };
  displacer: (RenderedHazardFeature & { tile: [number, number] }) | null;
  crossTile: boolean | null;
  leak: boolean | null;
}

test('#232 item 2: cross-tile placement ordering — measurement, not a fix', async ({ page }) => {
  const server = await startPreview();
  try {
    // Big enough that the whole SEAMARK_REGION's map-canvas footprint
    // (~1165x1263 CSS px at z9, per the #232 re-measurement's own tile-math
    // scan) fits inside the visible map, even after the wide-layout side
    // panel takes its share of the viewport width.
    await page.setViewportSize({ width: 2200, height: 1500 });
    await page.goto(server.url);
    await mapReady(page);
    await waitForSeamarksLayer(page);

    const seamarksToggle = page.getByRole('checkbox', { name: 'Seezeichen' });
    await expect(seamarksToggle).toBeVisible();
    await seamarksToggle.check();
    await expect(seamarksToggle).toBeChecked();

    const regionCenter: [number, number] = [
      (SEAMARK_REGION.lonMin + SEAMARK_REGION.lonMax) / 2,
      (SEAMARK_REGION.latMin + SEAMARK_REGION.latMax) / 2,
    ];

    const rows: CulledHazardRow[] = [];

    for (const zoom of [8, 9]) {
      await page.evaluate(
        ({ center, zoom }) =>
          (window as unknown as { __scE2eMap: ScTestMap }).__scE2eMap.jumpTo({ center, zoom }),
        { center: regionCenter, zoom },
      );

      const rendered = await settledHazardRenderedFeatures(page, SEAMARK_REGION, `z${zoom}`);
      const source = await readHazardSourceFeatures(page);
      const renderedKeys = new Set(rendered.map((f) => `${f.lng.toFixed(5)},${f.lat.toFixed(5)}`));

      for (const mark of source) {
        // Restrict to marks inside the query region itself —
        // querySourceFeatures can return features from buffered tiles that
        // extend slightly past it.
        if (
          mark.lng < SEAMARK_REGION.lonMin ||
          mark.lng > SEAMARK_REGION.lonMax ||
          mark.lat < SEAMARK_REGION.latMin ||
          mark.lat > SEAMARK_REGION.latMax
        ) {
          continue;
        }
        const key = `${mark.lng.toFixed(5)},${mark.lat.toFixed(5)}`;
        if (renderedKeys.has(key)) continue; // present — nothing culled here

        const displacers = await hazardDisplacersAt(page, [mark.lng, mark.lat]);
        const displacer =
          displacers.length === 0
            ? null
            : displacers.reduce((best, f) => {
                const d = (f.lng - mark.lng) ** 2 + (f.lat - mark.lat) ** 2;
                const bd = (best.lng - mark.lng) ** 2 + (best.lat - mark.lat) ** 2;
                return d < bd ? f : best;
              });

        const culledTile = tileXY(mark.lng, mark.lat, zoom);
        const displacerTile = displacer ? tileXY(displacer.lng, displacer.lat, zoom) : null;

        rows.push({
          zoom,
          culled: { ...mark, tile: culledTile },
          displacer: displacer && displacerTile ? { ...displacer, tile: displacerTile } : null,
          crossTile: displacerTile
            ? culledTile[0] !== displacerTile[0] || culledTile[1] !== displacerTile[1]
            : null,
          leak: displacer ? displacer.priority > mark.priority : null,
        });
      }
    }

    console.log(
      `[#232 item 2] culled-hazard-mark measurement across z8/z9, whole app data region ` +
        `(${JSON.stringify(SEAMARK_REGION)}): ${rows.length} culled hazard mark(s). ` +
        `Table: ${JSON.stringify(rows, null, 2)}`,
    );

    // The measurement must actually EXERCISE hazard-vs-hazard collision
    // culling at least once, at z8 or z9 — otherwise a green result here
    // carries no information (CLAUDE.md: "an experiment that never ran
    // emits exactly the output of one that found nothing").
    expect(
      rows.length,
      'no hazard mark was culled at z8 or z9 anywhere in the app data region — this measurement ' +
        'did not exercise hazard-vs-hazard collision culling at all, so it cannot speak to #232 item 2',
    ).toBeGreaterThan(0);

    // Every culled mark must have a displacer this test could actually
    // find at its own screen pixel — a culled mark with none found would
    // mean the methodology itself is unsound (e.g. clipped by the region's
    // own edge, or the probe radius too small) rather than a genuine,
    // explicable collision-culling case.
    const unexplained = rows.filter((r) => r.displacer === null);
    expect(
      unexplained,
      `${unexplained.length} culled hazard mark(s) had no displacer found at their own screen pixel — ` +
        `investigate the measurement before trusting the rest of this table: ` +
        `${JSON.stringify(unexplained, null, 2)}`,
    ).toEqual([]);

    // The actual #232 item 2 question: is any displacer's priority
    // NUMERICALLY WORSE (higher) than the mark it displaced? Under
    // icon-overlap:'never' (live below z12) a lower symbol-sort-key must
    // win — a worse-ranked displacer beating a better-ranked mark is a
    // genuine ordering violation.
    const leaks = rows.filter((r) => r.leak === true);
    expect(
      leaks,
      `${leaks.length} of ${rows.length} culled hazard mark(s) were displaced by a WORSE-ranked ` +
        `neighbour — a genuine #232 item 2 ordering leak: ${JSON.stringify(leaks, null, 2)}`,
    ).toEqual([]);
  } finally {
    server.kill();
  }
});
