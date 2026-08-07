// docs/screenshots/capture.mjs — README screenshot capture (manual, not CI).
// Run: node docs/screenshots/capture.mjs  (needs network: live app + wind fetch)
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
// KNOWN REMAINING BLOCKER (2026-08-07, not fixed here): the ★-recommendation
// wait below still assumes Flensburg->Sønderborg always resolves to a
// 'decided' rig comparison. On this build/fixture pairing it currently
// doesn't (RouteSummary.tsx only renders ★ when
// `rigRecommendation.kind === 'decided'`; this route measures a tie), so the
// wait times out at 120s and the script never reaches the final screenshot.
// This is route/fixture-outcome fragility, not a stale selector — fixing it
// means either asserting on the rig-comparison chip instead of an
// unconditional ★, or picking a route/fixture combination that reliably
// decides. Left open; tracked separately.
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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(APP, { waitUntil: 'networkidle' });
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
// planen". Generous timeout: live wind fetch + solve, not the fixture path.
const planDeadline = Date.now() + 120_000;
while ((await planButton.isDisabled()) && Date.now() < planDeadline) {
  await page.waitForTimeout(500);
}

// RouteSummary (rig comparison, legs, ★ recommended marker) only renders on
// the "Routes" tab, not inline on "Plan" (App.tsx).
await page.getByRole('tab', { name: 'Routes' }).click();
await page.getByText('★').first().waitFor({ timeout: 120_000 });
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
