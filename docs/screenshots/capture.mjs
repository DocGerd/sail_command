// docs/screenshots/capture.mjs — README screenshot capture (manual, not CI).
//
// start-view.png: needs network (live app + wind fetch) — the bare default
//   below (production) is fine for it.
// plan-route.png: REQUIRES a local server (fix wave, PR #462 review Minor 2
//   — the bare default is now actively wrong for this half, not just an
//   alternative). It routes against a docs-only wind fixture
//   (app/public/test-fixtures/wind-docs-plan-route.json) that is gitignored
//   and must be regenerated locally before every capture (see the #459
//   block below) — it is NEVER part of any deployment. Running the bare
//   default against production instead resolves `?windFixture=...` against
//   https://docgerd.github.io/sail_command/, which cannot serve a file that
//   was never committed: the fetch 404s and the plan step fails outright,
//   landing on the Minor-1 diagnostic further down rather than a screenshot.
//   Required sequence for plan-route.png:
//     node app/scripts/gen-docs-wind-fixture.mjs
//     npm --prefix app run dev -- --port <port>          # or build+preview
//     SC_SCREENSHOT_URL='http://localhost:<port>/sail_command/' node docs/screenshots/capture.mjs
//
// Selectors re-verified against app/src/App.tsx, PlannerPanel.tsx,
// HarborPicker.tsx, RouteSummary.tsx, Disclosure.tsx and app/e2e/plan.spec.ts
// (2026-08-07) — the ORIGINAL 2026-07-17 verification below was invalidated
// the very next day by #64 (852cb8c, "UI Phase 2 — searchable harbor
// combobox"), which this script never noticed because it's manual, not CI:
// - The harbor search <input> now carries role="combobox" (HarborPicker.tsx),
//   not role="searchbox" — same pattern as plan.spec.ts's
//   `getByRole('region', ...).getByRole('combobox')`.
// - Harbor results are `role="option"` <li> rows (no <button> inside them any
//   more) — matched via `getByRole('option')`, not a CSS button selector; the
//   display name is locale-dependent and can differ from the search text
//   (e.g. Sønderborg displays as "Sonderburg" in German; see plan.spec.ts).
// - RouteSummary (rig tabs, ★ recommended marker, leg table) only mounts on
//   the "Routes" tab (App.tsx: `tab === 'routes'`), not inline on "Plan" — the
//   flow must switch tabs after planning before it is visible to screenshot.
// - The leg table (#64) moved behind a Disclosure that defaults CLOSED
//   (Disclosure.tsx `defaultOpen = false`) — it must be clicked open via
//   `.route-legs-disclosure > summary` (same locator plan.spec.ts uses)
//   before the plan-route.png screenshot, or the table isn't visible at all.
//
// #459 (2026-08-09) — plan-route.png strategy: a NEW, non-uniform, DOCS-ONLY
// wind fixture, chosen over the two alternatives the issue left open
// (fixing capture.mjs to reproduce a still-image, or waiting for a
// sail-dominant live forecast). Both were rejected with evidence: this
// script never reproduced the committed image in the first place (it
// hardcodes Flensburg->Sønderborg, but OCR of the pre-#459 image showed
// Langballigau->Sønderborg — a different pairing entirely), and a
// 2026-08-08 sweep found no sail-dominant route across a full 12 h live-wind
// window (unschedulable). Reusing the e2e suite's own
// app/public/test-fixtures/wind-sw12.json was ALSO rejected: it is uniform
// 12 kn / 225° everywhere, so every wind barb in a hero image would be
// identical — a visible synthetic-data tell — and it is CI-pinned by several
// specs (plan.spec.ts's Langballigau->Sønderborg genoa/fock TIE assertion
// among them), so touching its content for a docs concern would risk
// destabilizing the whole e2e suite.
//
// `app/scripts/gen-docs-wind-fixture.mjs` generates a SEPARATE, docs-scoped,
// GITIGNORED fixture (app/public/test-fixtures/wind-docs-plan-route.json —
// see that script's header for why it isn't committed) with wind that
// varies smoothly across a box scoped to the actual routed track — see that
// script's own header for the exact gradient, the GPX-measured route box,
// and for why these constants (SE breeze, TWS ~7-13 kn at the
// Flensburg-Sønderborg leg, TWA mostly ~70-95° with a broader-reach/run tail
// near the end) were chosen against this app's committed Salona 45 polars:
// genoa reliably outsails fock by ~3-5% over most of this TWS/TWA band (a
// light-air reaching advantage that narrows, but does not vanish, toward
// the route's higher-wind final third), enough over a ~19 nm leg to clear
// RIG_TIE_BAND_MS (60 s) decisively, while staying comfortably above the
// ~3.7 kn sail-speed floor that would otherwise plan motor legs.
//
// #577 RETUNE (2026-08-19): the #54 multi-boat routing work landed after the
// 2026-08-09 figures below were first measured and collapsed this pair's
// margin from ~180s to 51.2s — UNDER RIG_TIE_BAND_MS, so the recommendation
// had drifted to a 'tie' (see gen-docs-wind-fixture.mjs's header for the
// reproduction and the retuned SPEED_LON_RANGE_KN constant). MEASURED AGAIN
// against a local dev server (2026-08-19, this fix): Flensburg->Sønderborg
// on the retuned fixture resolves to 83% sail / 17% motor on the
// (recommended, ★) Genoa tab (read directly off the rendered
// `.ergebnis-split-sail`/`.ergebnis-split-motor` legend — "Sailing · 16.0 nm
// · 83%" / "Motor · 3.4 nm · 17%" — and cross-checked against the solver's
// own duration split via the same `planRoute()` call the app makes) and 86%/14%
// on Fock (solver-only; the Fock tab was not itself screenshotted), with
// `.chip-faster-rig` reading "Faster: Genoa" (3h00min vs 3h02min, a 146.6s
// margin) — both #459 requirements (sail share > 50%, a decided ★)
// satisfied simultaneously, on the SAME route/fixture pair, with no
// live-wind dependency and no per-run variance.
//
// BARB VARIATION: gen-docs-wind-fixture.mjs's own header now carries the
// re-measured per-leg TWS span and `barbImageId()` bucket histogram for this
// retuned constant (still crosses all three 5 kn buckets, though the highest
// bucket now covers only one leg near Sønderborg, down from a longer stretch
// pre-retune) — see that file, not this one, for the current numbers, since
// duplicating them here is exactly the twin-drift #577 itself was about.
// UNVERIFIED after this retune, and not claimed either way: whether that one
// highest-bucket leg happens to be visible and unoccluded in the committed
// plan-route.png framing (the pre-retune version of this file recorded that
// check for the OLD constant, where it fell mostly behind the on-map "Route
// layer controls" panel; that specific pixel check was not repeated here).
//
// Reproduction: `node app/scripts/gen-docs-wind-fixture.mjs` (this is the
// ONLY source of the fixture now that it's gitignored — regenerates it with
// a fresh forecast-horizon start time; like gen-wind-fixture.mjs's e2e
// fixture, a stale copy's `time[]` drifts out of the app's forecast horizon
// after a few days, which is why it's never committed at all), then run
// this script against a LOCAL server via SC_SCREENSHOT_URL — see the header
// above; the plain-default form no longer works for plan-route.png.
//
// #428 (was: "the ★-recommendation wait assumes Flensburg->Sønderborg
// always resolves to a 'decided' rig comparison... currently doesn't... the
// wait times out at 120s"): fixed for THIS script by construction, not by
// working around the wait — the docs fixture above was tuned specifically
// so this exact route decides every time, and the wait below now polls the
// rig-comparison chip's actual TEXT (not a boolean `getByText('★')`
// presence check) with a much shorter budget, so a future regression prints
// the chip's real content instead of hanging for two minutes. #428 itself
// (the general fragility of assuming any given route/fixture pair decides)
// remains open for anyone reusing this pattern with a different pairing.
//
// This file has no node_modules of its own, and Node's ESM resolver (unlike
// CJS require) does not honor NODE_PATH — it only walks up from this file's
// own ancestor directories, which never reaches app/node_modules. Resolve
// @playwright/test with an explicit relative file URL instead.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(
  pathToFileURL(resolve(__dirname, '../../app/node_modules/@playwright/test/index.mjs')).href
);

// SC_SCREENSHOT_URL overrides the target for a pre-release recapture — at
// release-cut time production is, by definition, still serving the PREVIOUS
// release, so capturing against it would recapture the OLD build rather than
// the one being released. Defaults to production, which is fine for
// start-view.png but NOT for plan-route.png — see the header above.
const APP = process.env.SC_SCREENSHOT_URL ?? 'https://docgerd.github.io/sail_command/';
const START_HARBOR = 'Flensburg';
const DEST_HARBOR = 'Sønderborg';
// #459: docs-only fixture (see the header block above) — resolved relative
// to APP by the browser, same convention app/e2e/*.spec.ts uses for
// `?windFixture=test-fixtures/wind-sw12.json`.
const WIND_FIXTURE_PATH = 'test-fixtures/wind-docs-plan-route.json';
// #459 requirement 4: widen the left panel so the legs table's Time/
// Duration/Type/COG columns are all visible without horizontal scroll.
// Written directly to localStorage (usePersistedNumber's storage key,
// App.tsx) via addInitScript, BEFORE the app boots, so it takes effect on
// first paint rather than requiring a scripted drag of PanelResizer.
const PANEL_WIDTH_PX = 518;
// #741 fix wave: the Plan tab's unfilled form (empty Origin/Destination, no
// route yet) is taller than the shared 800px capture viewport now that
// #710's bordered card-box fields replaced bare native chrome — measured
// live against this exact flow (navigate, switch to English, before any
// harbor is picked): `.app-panel` starts at document y=173 and its content
// runs to y=962, so the Departure field and the Safety-depth input/help
// text were rendering entirely below the viewport. 1000px covers that with
// margin. This bump is START-VIEW-ONLY: the page is resized back to the
// shared 800px height immediately after that one screenshot so
// plan-route.png is deliberately framed with its legs table scrolled — a
// long table is meant to be cut off, unlike a form field, which is what
// made the start-view crop a defect and this one not.
const START_VIEW_HEIGHT_PX = 1000;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: START_VIEW_HEIGHT_PX } });
await page.addInitScript((px) => {
  window.localStorage.setItem('sc-panel-width', String(px));
}, PANEL_WIDTH_PX);
// #462 review nit: build via URL rather than string-concatenating `?` onto
// APP, which would silently break if APP ever carried its own query string.
const startUrl = new URL(APP);
startUrl.searchParams.set('windFixture', WIND_FIXTURE_PATH);
await page.goto(startUrl.toString(), { waitUntil: 'networkidle' });
// Switch UI to English for the README's international audience. The button's
// VISIBLE text is "EN", but its accessible name comes from its aria-label
// (App.tsx), which overrides text content in accessible-name computation —
// on first load (default German) that aria-label is "English anzeigen"
// (dict.de.ts 'nav.langToggle'), so match on that instead of the "EN" text.
await page.getByRole('button', { name: 'English anzeigen' }).click();
await page.waitForTimeout(2000); // map tile settle for a static capture is fine here (not a test)
await page.screenshot({ path: 'docs/screenshots/start-view.png' });
// Back to the shared 800px height for the rest of the flow (plan-route.png).
await page.setViewportSize({ width: 1280, height: 800 });

// Plan flow — "Plan" tab is the default (App.tsx useState<Tab>('plan')), so
// no tab click is needed before selecting harbors.
const originSection = page.getByRole('region', { name: 'Origin' });
await originSection.getByRole('combobox').fill(START_HARBOR);
await originSection.getByRole('option').first().click();

const destSection = page.getByRole('region', { name: 'Destination' });
await destSection.getByRole('combobox').fill(DEST_HARBOR);
await destSection.getByRole('option').first().click();

const planButton = page.getByRole('button', { name: 'Plan route' });
await planButton.click();
// canPlan (App.tsx) requires an idle/error phase, so the button re-enabling
// is the settle signal — mirrors plan.spec.ts's wait after clicking "Route
// planen". The docs fixture above routes against local static JSON, not live
// wind, so this settles in seconds — the generous 120s budget is kept only
// as a safety margin, never expected to be exhausted.
const planDeadline = Date.now() + 120_000;
while ((await planButton.isDisabled()) && Date.now() < planDeadline) {
  await page.waitForTimeout(500);
}

// RouteSummary (rig comparison, legs, ★ recommended marker) only renders on
// the "Routes" tab, not inline on "Plan" (App.tsx).
await page.getByRole('tab', { name: 'Routes' }).click();

// #428/#459/#462: poll the rig-comparison chip's own TEXT rather than
// blindly waiting on `getByText('★')`'s boolean presence — a timeout here
// prints what the chip actually says instead of hanging silently for two
// minutes on a route/fixture pairing that doesn't decide.
//
// #462 review Minor 1: the original form of this loop called
// `chip.textContent()` directly, which — this script runs Playwright in
// LIBRARY mode (`chromium.launch()`, no test runner) — carries Playwright's
// own 30s actionability default. A no-route plan (the LIKELIEST failure,
// caused by exactly the drifted-fixture case this diagnostic's own error
// message names) never mounts RouteSummary at all (`plan && rig` gate,
// App.tsx), so `.chip-faster-rig` never attaches — the first loop iteration
// then blocked 30s and threw Playwright's bare TimeoutError, overshooting
// this loop's own 20s budget and burying the crafted message entirely.
// Fixed by polling `.count()` first: unlike `textContent()`/`waitFor()`,
// Playwright's own docs specify `.count()` does NOT auto-wait — it is a
// same-tick DOM query — so a still-unattached chip costs one cheap poll,
// never a 30s stall, and this loop's own deadline is what actually governs.
const chip = page.locator('.chip-faster-rig');
const chipDeadline = Date.now() + 20_000;
let chipText = '';
let chipSeen = false;
while (Date.now() < chipDeadline) {
  if ((await chip.count()) > 0) {
    chipSeen = true;
    chipText = (await chip.first().textContent())?.trim() ?? '';
    if (chipText.startsWith('Faster:')) break;
  }
  await page.waitForTimeout(300);
}
if (!chipText.startsWith('Faster:')) {
  throw new Error(
    chipSeen
      ? `expected a decided rig recommendation ("Faster: …"), got "${chipText}" — ` +
        'the docs wind fixture (app/scripts/gen-docs-wind-fixture.mjs) may need retuning.'
      : '.chip-faster-rig never attached — RouteSummary only mounts once a plan ' +
        'succeeds (`plan && rig`, App.tsx), so planning itself failed. Most likely ' +
        'cause: the docs wind fixture has drifted past its forecast horizon (it is ' +
        'gitignored and regenerated fresh before every capture — see the header ' +
        'above). Run `node app/scripts/gen-docs-wind-fixture.mjs` and retry.',
  );
}

// #64: the leg table moved behind a Disclosure that defaults closed — open it
// so Duration/COG/etc. are actually visible in the capture (same locator
// plan.spec.ts uses).
await page.locator('.route-legs-disclosure > summary').click();
// The panel scrolls to wherever focus/render last landed (observed deep in
// the legs table) — scroll it back to the top so the rig tabs, ★
// recommendation and route totals (the point of this screenshot) are visible
// together with the legs, not cropped out above the fold.
await page.evaluate(() => document.querySelector('.app-panel')?.scrollTo(0, 0));
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/screenshots/plan-route.png' });
await browser.close();
