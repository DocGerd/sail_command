// docs/screenshots/capture.mjs — README screenshot capture (manual, not CI).
// Run: node docs/screenshots/capture.mjs  (needs network: live app + wind fetch
//   for start-view.png; plan-route.png routes against a committed, deterministic
//   docs wind fixture — see the #459 section below — so it needs no live wind)
// Run against a local build instead of production:
// SC_SCREENSHOT_URL='http://localhost:PORT/sail_command/' node docs/screenshots/capture.mjs
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
// `app/scripts/gen-docs-wind-fixture.mjs` generates a SEPARATE,
// docs-scoped fixture (app/public/test-fixtures/wind-docs-plan-route.json,
// gitignored-free but never read by any test or CI job) with wind that
// varies smoothly across the forecast grid — see that script's own header
// for the exact gradient and for why these constants (SE breeze, TWS
// ~7-10 kn at the Flensburg-Sønderborg leg, TWA ~70-95°, a close-to-beam
// reach) were chosen against this app's committed Salona 45 polars: genoa
// reliably outsails fock by ~3-5% at this TWS/TWA band (a light-air reaching
// advantage), which is enough over a ~14 nm leg to clear RIG_TIE_BAND_MS
// (60 s) decisively, while staying comfortably above the ~3.7 kn
// sail-speed floor that would otherwise plan motor legs. MEASURED against a
// local dev server (2026-08-09): Flensburg->Sønderborg on this fixture
// resolves to 81% sail / 19% motor on the (recommended, ★) Genoa tab and
// 78%/22% on Fock, with `.chip-faster-rig` reading "Faster: Genoa" — both
// #459 requirements (sail share > 50%, a decided ★) satisfied
// simultaneously, on the SAME route/fixture pair, with no live-wind
// dependency and no per-run variance.
//
// Reproduction: `node app/scripts/gen-docs-wind-fixture.mjs` (regenerates
// the fixture with a fresh forecast-horizon start time — like
// gen-wind-fixture.mjs's e2e fixture, the COMMITTED copy's `time[]` drifts
// out of the app's forecast horizon after a few days; this is expected, not
// a bug — always regenerate immediately before recapturing), then run this
// script against a local build per the header above.
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
// the one being released. Defaults to production so normal (post-release)
// usage is unchanged.
const APP = process.env.SC_SCREENSHOT_URL ?? 'https://docgerd.github.io/sail_command/';
const START_HARBOR = 'Flensburg';
const DEST_HARBOR = 'Sønderborg';
// #459: docs-only fixture (see the header block above) — resolved relative
// to APP by the browser, same convention app/e2e/*.spec.ts uses for
// `?windFixture=test-fixtures/wind-sw12.json`.
const WIND_FIXTURE_PARAM = 'windFixture=test-fixtures/wind-docs-plan-route.json';
// #459 requirement 4: widen the left panel so the legs table's Time/
// Duration/Type/COG columns are all visible without horizontal scroll.
// Written directly to localStorage (usePersistedNumber's storage key,
// App.tsx) via addInitScript, BEFORE the app boots, so it takes effect on
// first paint rather than requiring a scripted drag of PanelResizer.
const PANEL_WIDTH_PX = 518;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript((px) => {
  window.localStorage.setItem('sc-panel-width', String(px));
}, PANEL_WIDTH_PX);
await page.goto(`${APP}?${WIND_FIXTURE_PARAM}`, { waitUntil: 'networkidle' });
// Switch UI to English for the README's international audience. The button's
// VISIBLE text is "EN", but its accessible name comes from its aria-label
// (App.tsx), which overrides text content in accessible-name computation —
// on first load (default German) that aria-label is "English anzeigen"
// (dict.de.ts 'nav.langToggle'), so match on that instead of the "EN" text.
await page.getByRole('button', { name: 'English anzeigen' }).click();
await page.waitForTimeout(2000); // map tile settle for a static capture is fine here (not a test)
await page.screenshot({ path: 'docs/screenshots/start-view.png' });

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

// #428/#459: poll the rig-comparison chip's own TEXT rather than blindly
// waiting on `getByText('★')`'s boolean presence — a timeout here now prints
// what the chip actually says (tie/moot/decided-for-the-other-rig) instead
// of hanging silently for two minutes on a route/fixture pairing that
// doesn't decide. The docs fixture is tuned so this always reads
// "Faster: Genoa" (MEASURED, see the header above), but the diagnostic
// stays useful if that ever regresses.
const chip = page.locator('.chip-faster-rig');
const chipDeadline = Date.now() + 20_000;
let chipText = '';
while (Date.now() < chipDeadline) {
  chipText = (await chip.textContent())?.trim() ?? '';
  if (chipText.startsWith('Faster:')) break;
  await page.waitForTimeout(300);
}
if (!chipText.startsWith('Faster:')) {
  throw new Error(
    `expected a decided rig recommendation ("Faster: …"), got "${chipText}" — ` +
      'the docs wind fixture (app/scripts/gen-docs-wind-fixture.mjs) may need retuning, ' +
      'or it needs regenerating (its forecast horizon drifts over time).',
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
