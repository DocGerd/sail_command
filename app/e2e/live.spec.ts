import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// #142: Live-view GPS dynamics under EMULATED geolocation — the first e2e
// coverage of a moving boat. Playwright's context-level geolocation emulation
// (`test.use({ geolocation, permissions })` + `context.setGeolocation()`)
// drives a deterministic fix sequence through the REAL
// navigator.geolocation.watchPosition path (services/geolocation.ts), the
// real solver, and the real committed mask/polars — no injected
// watchPosition, unlike the jsdom component tests.
//
// Determinism rules (repo law): no fixed waitForTimeout anywhere — every wait
// gates on a state signal via auto-retrying assertions / expect.poll; all
// assertions are ARIA/DOM, no pixels. Network-free invariant: no `aisApiKey`
// is ever set, so mounting the Live tab opens ZERO sockets (#25 BYOK).
//
// Fix waypoints (hand-picked against the committed mask, snap-verified at the
// default 3.0 m safety depth):
// - FIX_ORIGIN: Langballigau's own harbor snap (harbors.json).
// - FIX_FJORD_MOUTH: the outer-fjord open-water anchor
//   `app/src/test/realmaskFixtures.ts`'s `FJORD_MOUTH`/`OPEN_BALTIC`
//   constants document as navigable — mid-route between the two harbors.
//   (The naive
//   geometric midpoint of the pair is LAND — Broager peninsula — which is
//   exactly why the reroute has a real route to find from here.)
// - FIX_OFF_SOENDERBORG: on Sønderborg Bay's final approach track, chosen
//   for margin against the leg-0/leg-1 selection boundary near the #243
//   depth-comfort dogleg — see the comment at its definition below for the
//   measured margin and the re-validation rule if that dogleg ever moves.
const FIX_ORIGIN = { latitude: 54.8237, longitude: 9.6524, accuracy: 5 };
const FIX_FJORD_MOUTH = { latitude: 54.83, longitude: 9.9, accuracy: 5 };
// #243's depth-comfort derate relocated the rerouted plan's dogleg joint from
// (54.896694, 9.790585) [3.5 m water] to (54.898574, 9.787321) [17.0 m],
// buying leg-1 minimum clearance 3.5 m -> 14.3 m — correct, intended routing
// behaviour, not a regression. The PREVIOUS probe point (54.8963, 9.7833)
// sat almost exactly on the perpendicular through that joint: leg 0 vs. leg
// 1 selection ties there, so the fixture had ZERO margin and flipped from
// passing (pre-#243 base) to failing (this HEAD) purely from the joint
// moving. This point sits ~230 m ENE of the old one (13.3 m water) and was
// re-measured against the real mask/polars: a ~80 m margin to the nearest
// heading pass/fail boundary (106 m on this HEAD, 80 m on the pre-#243
// base — the tighter of the two is what's quoted). A FUTURE routing change
// that moves the Sønderborg dogleg can invalidate this fixture again just
// the same way — the fix is to RE-MEASURE and relocate the probe point,
// never to widen the [330°, 030°] sector or raise the timeout below.
const FIX_OFF_SOENDERBORG = { latitude: 54.8963, longitude: 9.7869, accuracy: 5 };

// Wide (default 1280x720) viewport: the readout portals into the panel column
// (#31) — this also gives the wide with-plan+with-fix state its first e2e
// coverage (plan.spec.ts covers wide with-plan but fix-less).
test.use({
  permissions: ['geolocation'],
  geolocation: FIX_ORIGIN,
});

test('live view: emulated GPS drives readout, reroute-from-here, and leg advance', async ({
  page,
  context,
}) => {
  // Two real dual-rig solves (plan + reroute) plus PWA startup — well beyond
  // the 120 s config default even before accounting for CI being slower than
  // dev machines (CLAUDE.md's measured ~2.1x/~2.5x figures are for the
  // vitest unit suite specifically; no equivalent Playwright/e2e ratio has
  // been measured).
  test.setTimeout(360_000);
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // --- Plan Langballigau -> Sønderborg (German UI, same flow as plan.spec) ---
    await page.getByRole('tab', { name: 'Planen' }).click();

    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Langballigau');
    const originResults = originSection.getByRole('option');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    await expect(originSection.locator('.endpoint-name')).toHaveText('Langballigau');

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Sønderborg');
    const destResults = destSection.getByRole('option');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    await expect(destSection.locator('.endpoint-name')).toHaveText('Sonderburg');

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Solve settled (usePlanFlow back to idle) before leaving the tab.
    await expect(planButton).toBeEnabled({ timeout: 120_000 });

    // --- Live tab: pre-fix state ---
    await page.getByRole('tab', { name: 'Live' }).click();

    const liveToggle = page.getByRole('button', { name: 'Live-Ansicht' });
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'false');

    // Reroute action rendered but disabled with the needs-a-fix hint — and it
    // must not have started GPS by itself (no readout appears while idle).
    const rerouteButton = page.getByRole('button', { name: 'Route ab hier neu planen' });
    await expect(rerouteButton).toBeDisabled();
    await expect(page.getByText(/Erfordert eine aktive GPS-Position/)).toBeVisible();
    await expect(page.locator('.live-view-data')).toHaveCount(0);

    // --- Toggle tracking on: the emulated fix (at the origin harbor) arrives ---
    await liveToggle.click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'true');

    const hts = page.locator('.live-view-hts-value');
    await expect(hts).toHaveText(/^\d{3}°$/, { timeout: 30_000 });
    // Chromium's emulated position carries no heading/speed -> the wrapper
    // maps both to null -> the readout shows the en-dash placeholders (the
    // degradation contract the component tests pin in jsdom, here proven
    // against the real geolocation API).
    const cogSogValues = page.locator('.live-view-cogsog dd');
    await expect(cogSogValues).toHaveCount(2);
    await expect(cogSogValues.nth(0)).toHaveText('—');
    await expect(cogSogValues.nth(1)).toHaveText('—');
    await expect(page.getByText('Voraussichtliche Ankunft')).toBeVisible();
    // Permission granted -> the one-time GPS hint must NOT appear.
    await expect(page.locator('.live-view-gps-hint')).toHaveCount(0);

    // Reroute becomes available, hint switches to the planning-aid copy.
    await expect(rerouteButton).toBeEnabled();
    await expect(page.getByText(/Planungshilfe, keine Navigationsführung/)).toBeVisible();

    const htsAtOrigin = await hts.textContent();

    // --- Move the boat mid-route: a new fix must flow through the live watch ---
    await context.setGeolocation(FIX_FJORD_MOUTH);
    await expect.poll(async () => hts.textContent(), { timeout: 60_000 }).not.toBe(htsAtOrigin);

    // --- Reroute from here: full lifecycle against the real solver ---
    await rerouteButton.click();
    // In flight: the button flips to its busy label and disables (the real
    // dual-rig solve is seconds long even on a dev machine, so the busy
    // window is comfortably wide for the auto-retrying assertion).
    await expect(
      page.getByRole('button', { name: 'Route wird ab aktueller Position neu geplant…' }),
    ).toBeDisabled({ timeout: 30_000 });
    // Completed: idle label back and enabled (the fix is still current).
    await expect(rerouteButton).toBeEnabled({ timeout: 120_000 });
    // No error surfaced (stale wind / fix outside mask would raise a Banner).
    await expect(page.locator('[role="alert"]')).toHaveCount(0);

    // The reroute persisted as a NEW plan alongside the original.
    await page.getByRole('tab', { name: 'Routen' }).click();
    await expect(page.locator('.plans-list-row')).toHaveCount(2, { timeout: 30_000 });
    await expect(
      page.locator('.plans-list-row', { hasText: '(ab Position neu geplant)' }),
    ).toHaveCount(1);

    // --- Back to Live: leaving the tab stopped tracking (App.tsx contract) ---
    await page.getByRole('tab', { name: 'Live' }).click();
    await expect(liveToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.live-view-data')).toHaveCount(0);

    // Re-acquire on the rerouted (now active) plan.
    await liveToggle.click();
    await expect(hts).toHaveText(/^\d{3}°$/, { timeout: 30_000 });

    // --- Leg advance: jump to the final approach off Sønderborg ---
    // Hand-derived expectation: heading-to-steer from this fix points toward
    // the #243 depth-comfort dogleg joint / the harbor beyond it, both
    // effectively due north from here — within the sector [330°..030°].
    // (See the FIX_OFF_SOENDERBORG comment above for why this specific point
    // carries margin on that check regardless of which leg — 0 or 1 — the
    // live projection currently has active.) The FAILURE signature this
    // guards against: a projection stuck on leg 0 at a point that sits on
    // the leg-0/leg-1 boundary reads the bearing back toward the dogleg
    // joint, ~045° — outside the sector (the old, zero-margin fixture's
    // observed failure on this HEAD; NOT the stale "~200-260°" this comment
    // used to claim, which described a different, pre-reroute leg 0).
    await context.setGeolocation(FIX_OFF_SOENDERBORG);
    await expect
      .poll(
        async () => {
          const text = (await hts.textContent()) ?? '';
          const deg = Number.parseInt(text, 10);
          // Not yet rendered / mid-transition text: never pass, never throw —
          // +Infinity fails the bound below exactly like the old `false` did,
          // so the poll keeps retrying instead of asserting prematurely.
          if (Number.isNaN(deg)) return Number.POSITIVE_INFINITY;
          // Re-center on north (range (-180, 180]) and take the absolute
          // value so the wrap-around sector [330°, 030°] collapses to one
          // symmetric bound — and, crucially, a failure now reports the
          // actual offset in degrees (e.g. 45) instead of a bare `false`.
          return Math.abs(((((deg + 180) % 360) + 360) % 360) - 180);
        },
        { timeout: 60_000 },
      )
      .toBeLessThanOrEqual(30);
    // The next-event readout is present in its terminal-or-upcoming state
    // (its exact text depends on the solved route's remaining maneuvers).
    await expect(page.locator('.live-view-next-event')).toBeVisible();
  } finally {
    server.kill();
  }
});
