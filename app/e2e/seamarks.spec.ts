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
// `app/public/data/seamarks.json`). So hiding THOSE two categories makes
// the PIN VALUES below SMALLER than PR1's own committed baseline at the
// identical cluster/zoom pair, by construction, but only by however many of
// them happen to sit in this specific geographic box (measured per-pin below,
// not assumed) — this test re-measures the "category=All" case afterwards
// specifically to prove that selection reproduces PR1's original,
// unfiltered counts byte-for-byte (the BASE-vs-HEAD control this PR owes
// per CLAUDE.md's #191/#192 rule, now one level indirect: HEAD's "All"
// selection must equal BASE's only selection).
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
  queryRenderedFeatures(
    geometry: [[number, number], [number, number]],
    options: { layers: string[] },
  ): Array<{ properties: Record<string, unknown> }>;
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
// PR2 adds a SECOND, SMALLER z>=12 pin at the default category (Standard,
// hiding only this box's `cable`/`pipeline`-categorised `specialPurpose`
// marks — #513 F1/F2's corrected mapping) — that reduction is the new
// display-category filter working as designed, not a re-occurrence of this
// same effect.
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
    // this file exists to catch. These two sets are SMALLER than PR1's own
    // baseline at the identical cluster/zoom pair, but only by the
    // `specialPurpose` marks in this box whose `category` is `cable` or
    // `pipeline` — measured, not inferred from the icon id
    // (`seamark-special-*` is colour-keyed, not category-keyed): at z11.5,
    // 1 of 1 `seamark-special-black` is hidden and 1 of 1
    // `seamark-special-default` is shown; at z13, 2 of 4
    // `seamark-special-black` are hidden and 4 of 4 `seamark-special-default`
    // are shown — expected (see the file header), re-verified below by
    // reproducing PR1's original counts at
    // category=All.
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
