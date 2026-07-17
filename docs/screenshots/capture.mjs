// docs/screenshots/capture.mjs — README screenshot capture (manual, not CI).
// Run: node docs/screenshots/capture.mjs  (needs network: live app + wind fetch)
//
// Selectors verified against app/src/App.tsx, PlannerPanel.tsx, HarborPicker.tsx,
// RouteSummary.tsx and app/e2e/plan.spec.ts (2026-07-17) rather than guessed:
// - The harbor search <input> has no placeholder (HarborPicker.tsx) — it is
//   reached via its <section aria-label> region + role=searchbox, same pattern
//   as plan.spec.ts's `getByRole('region', ...).getByRole('searchbox')`.
// - Harbor results are `.harbor-picker li button`, not a name-matched button —
//   the display name is locale-dependent and can differ from the search text
//   (e.g. Sønderborg displays as "Sonderburg" in German; see plan.spec.ts).
// - RouteSummary (rig tabs, ★ recommended marker, leg table) only mounts on
//   the "Routes" tab (App.tsx: `tab === 'routes'`), not inline on "Plan" — the
//   flow must switch tabs after planning before it is visible to screenshot.
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

const APP = 'https://docgerd.github.io/sail_command/';
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
await originSection.getByRole('searchbox').fill(START_HARBOR);
await originSection.locator('.harbor-picker li button').first().click();

const destSection = page.getByRole('region', { name: 'Destination' });
await destSection.getByRole('searchbox').fill(DEST_HARBOR);
await destSection.locator('.harbor-picker li button').first().click();

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
// The panel scrolls to wherever focus/render last landed (observed deep in
// the legs table) — scroll it back to the top so the rig tabs, ★
// recommendation and route totals (the point of this screenshot) are visible
// together with the legs, not cropped out above the fold.
await page.evaluate(() => document.querySelector('.app-panel')?.scrollTo(0, 0));
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/screenshots/plan-route.png' });
await browser.close();
