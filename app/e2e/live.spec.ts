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
// - FIX_FJORD_MOUTH: the outer-fjord open-water anchor realmask.repro.test.ts
//   documents as navigable — mid-route between the two harbors. (The naive
//   geometric midpoint of the pair is LAND — Broager peninsula — which is
//   exactly why the reroute has a real route to find from here.)
// - FIX_OFF_SOENDERBORG: ~0.5 nm due south of Sønderborg's harbor snap
//   (54.9046, 9.7833), in Sønderborg Bay on the final approach track.
const FIX_ORIGIN = { latitude: 54.8237, longitude: 9.6524, accuracy: 5 };
const FIX_FJORD_MOUTH = { latitude: 54.83, longitude: 9.9, accuracy: 5 };
const FIX_OFF_SOENDERBORG = { latitude: 54.8963, longitude: 9.7833, accuracy: 5 };

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
  // the 120 s config default on CI runners (6-10x slower than dev machines).
  test.setTimeout(360_000);
  const server = await startPreview();
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
    // Hand-derived expectation: the fix sits ~0.5 nm due SOUTH of the
    // destination snap on the bay approach, so once the active leg advances
    // to the final leg(s), heading-to-steer points at the harbor — within the
    // northerly sector [330°..030°]. Were the projection stuck on leg 0 (the
    // fjord mouth, ~7 nm to the SW), HTS would read ~200-260° instead, so
    // this sector check is genuine leg-advance evidence, not a formatting
    // assertion.
    await context.setGeolocation(FIX_OFF_SOENDERBORG);
    await expect
      .poll(
        async () => {
          const text = (await hts.textContent()) ?? '';
          const deg = Number.parseInt(text, 10);
          if (Number.isNaN(deg)) return false;
          return deg >= 330 || deg <= 30;
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    // The next-event readout is present in its terminal-or-upcoming state
    // (its exact text depends on the solved route's remaining maneuvers).
    await expect(page.locator('.live-view-next-event')).toBeVisible();
  } finally {
    server.kill();
  }
});
