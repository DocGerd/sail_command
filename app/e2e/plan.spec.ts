import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// End-to-end happy path: harbor search -> plan -> rig comparison -> saved
// under Routen. Deterministic wind via the `?windFixture=` escape hatch
// (E3) — no live Open-Meteo call, no route-dependent flakiness.
//
// Harbor-name note: the search box matches all three locale name fields
// (HarborPicker.tsx's `matchesQuery`), so searching the Danish/English
// "Sønderborg" finds the harbor even though its *displayed* name in the
// app's default German UI is the exonym "Sonderburg" — the two names are
// intentionally different, so results are selected structurally (first
// button in the filtered list) rather than by matching display text.
test('plans a route: harbor search -> rig comparison -> saved under Routen', async ({ page }) => {
  const server = await startPreview();
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    await page.getByRole('tab', { name: 'Planen' }).click();

    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('searchbox').fill('Langballigau');
    // Exactly one match expected — pins the search actually narrowed the
    // list rather than clicking whatever happened to render first.
    const originResults = originSection.locator('.harbor-picker li button');
    await expect(originResults).toHaveCount(1);
    await originResults.first().click();
    // '> p' (direct child): the section's own "selected point" status
    // paragraph, distinct from HarborPicker's nested approach-note <p>
    // (Langballigau has one — matching getByRole('paragraph') unscoped
    // would hit both and make toHaveText ambiguous).
    await expect(originSection.locator('> p')).toHaveText('Langballigau');

    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('searchbox').fill('Sønderborg');
    const destResults = destSection.locator('.harbor-picker li button');
    await expect(destResults).toHaveCount(1);
    await destResults.first().click();
    await expect(destSection.locator('> p')).not.toHaveText('Nicht ausgewählt');

    // Cheap smoke check on the via UI (Phase E gate backlog item): arming
    // tap-to-pick shows the map-tap banner and "Abbrechen" disarms it. A
    // real via add/drag needs a canvas-coordinate map tap, which depends on
    // MapLibre's live projection (center/zoom/bounds) and was judged too
    // fragile for this spec — see task-F2-report.md.
    await page.getByRole('region', { name: 'Wegpunkte' }).getByRole('button', { name: 'Wegpunkt hinzufügen' }).click();
    const tapPickBanner = page.getByText('Auf Karte tippen für Wegpunkte.');
    await expect(tapPickBanner).toBeVisible();
    await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(tapPickBanner).not.toBeVisible();

    const planButton = page.getByRole('button', { name: 'Route planen' });
    await planButton.click();
    // Wait for run() to fully settle (button re-enabled: usePlanFlow.ts's
    // phase back to idle/error) *before* switching tabs. PlansList.tsx only
    // calls listPlans() once, on mount, and it mounts fresh every time the
    // Routen tab is entered (App.tsx renders it only while `tab ===
    // 'routes'`) — switching tabs any earlier mounts PlansList before
    // run()'s `save()` has written the record, and it never re-fetches
    // afterwards, leaving the list stuck empty for the rest of the test.
    await expect(planButton).toBeEnabled({ timeout: 60_000 });

    await page.getByRole('tab', { name: 'Routen' }).click();

    const rigTabs = page.getByRole('tablist', { name: 'Riggvergleich' });
    await expect(rigTabs).toBeVisible({ timeout: 60_000 });
    const genoaTab = rigTabs.getByRole('tab', { name: /Genua/ });
    const fockTab = rigTabs.getByRole('tab', { name: /Fock/ });
    await expect(genoaTab).toBeVisible();
    await expect(fockTab).toBeVisible();
    // Exactly one rig is marked recommended (★, aria-label "Empfohlen").
    await expect(rigTabs.getByLabel('Empfohlen')).toHaveCount(1);

    // Both rigs must have actually found a route (an ETA, not a no-route
    // alert) — a broad reach in 12 kn should always be sailable for either
    // sail plan on this short leg.
    for (const tab of [genoaTab, fockTab]) {
      await tab.click();
      await expect(page.locator('.route-summary dt', { hasText: 'Ankunft' })).toBeVisible();
      await expect(page.locator('.route-summary [role="alert"]')).toHaveCount(0);
    }

    const legRows = page.locator('.route-legs tbody tr');
    await expect(legRows.first()).toBeVisible();
    expect(await legRows.count()).toBeGreaterThan(0);

    await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();

    await expect(page.locator('.plans-list-row')).toHaveCount(1);
  } finally {
    server.kill();
  }
});
