import { test, expect, type Page } from '@playwright/test';
import { startPreview } from './helpers';

// #1291 (design docs/spikes/1135-boat-picker-gate-design.md §5.2/§5.3):
// per-boat harbour access markers in HarborPicker's options and
// PlannerPanel's selected-endpoint row, end to end against the REAL
// committed mask/harbors/boat catalogue — jsdom (HarborPicker.test.tsx,
// PlannerPanel.test.tsx) exhaustively covers harborAccessCopy's precedence
// table with a synthetic mask/hint; this spec proves the real wiring
// (loadRoutingAssets -> useNavMask -> computeHarborAccess/
// findLowerSettingHint -> the rendered marker) on a NON-default boat, per
// #1291's own requirement.
//
// Two real, deterministic targets, no plan/route needed:
//   - "Arnis": one of the 5 #9 KNOWN_DISCONNECTED harbours — boat/gate
//     independent, so it is the pre-existing #652/#834 disclosure, kept
//     working through this task's refactor of its render path.
//   - "Marstal": 'shallow-approach' for every catalogue boat gated <= 3.0 m
//     at its OWN default safety depth (harborReachability.test.ts's
//     EXPECTED_ACCESS table) — reachable at DEFAULT settings without raising
//     the safety depth via the Options panel. EASY GO!'s 3.5 m gate reads it
//     'unreachable' instead; the second test below covers that.
test('#1291: per-boat harbour access markers render for a non-default boat, in the picker and on the selected-endpoint row', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);

    // Switch to a NON-default boat (#1291's own requirement) — SPEEDY GO!
    // (Salona 44) shares the reference boat's 2.10 m draft, so its own
    // default safety depth is the SAME 3.0 m and this switch changes no
    // other precondition the test depends on.
    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByRole('radio', { name: /SPEEDY GO!/ }).click();
    await expect(page.getByRole('radio', { name: /SPEEDY GO!/ })).toBeChecked();

    await page.getByRole('tab', { name: 'Planen' }).click();

    // Origin: a known-disconnected harbour — boat-independent, must still
    // disclose exactly as before this task's refactor.
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Arnis');
    await expect(originSection.getByRole('option')).toHaveCount(1);
    const arnisOption = originSection.getByRole('option').first();
    await expect(
      arnisOption.getByText(
        'Vom Routenplaner bei keiner Tiefeneinstellung erreichbar – eine Grenze der Tiefendaten, keine Aussage über das Fahrwasser.',
      ),
    ).toBeVisible();
    await arnisOption.click();

    // Destination: Marstal, 'shallow-approach' for THIS boat at its own
    // default gate — the marker must name the SELECTED boat.
    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Marstal');
    await expect(destSection.getByRole('option')).toHaveCount(1);
    const marstalOption = destSection.getByRole('option').first();
    await expect(
      marstalOption.getByText(
        'Mit Salona 44 (SPEEDY GO!) nur über eine flachere Zufahrt – Tiefenwarnung.',
      ),
    ).toBeVisible();
    await marstalOption.click();

    // §5.3: both markers must SURVIVE onto the collapsed selected-endpoint
    // rows — the whole point of #834/#1291 (a solve-before-disclosure
    // regression this repo has already shipped once, #652).
    await expect(
      originSection.getByText(
        'Vom Routenplaner bei keiner Tiefeneinstellung erreichbar – eine Grenze der Tiefendaten, keine Aussage über das Fahrwasser.',
      ),
    ).toBeVisible();
    await expect(
      destSection.getByText(
        'Mit Salona 44 (SPEEDY GO!) nur über eine flachere Zufahrt – Tiefenwarnung.',
      ),
    ).toBeVisible();
  } finally {
    server.kill();
  }
});

// #1721: unreachable at every 0.1 m gate from EASY GO!'s lowest allowed (2.7 m)
// to its live 3.5 m, so the picker shows the range line.
const EASY_GO_ANY_SETTING_LINE =
  'Die Tiefendaten der App ergeben für Salona 44 (EASY GO!) bei keiner Sicherheitstiefe von 2,7 m bis 3,5 m eine Verbindung.';

// #1575: the real `unreachable` state, reached by a plain default-settings
// boat switch. EASY GO!'s 3.5 m gate leaves Marstal and Augustenborg
// unreachable, so switching into it from SPEEDY GO! with Marstal selected must
// raise the depth, announce the endpoint as unreachable and mark it on the
// collapsed row.
test('#1575: switching to EASY GO! announces an unreachable destination and marks it', async ({
  page,
}) => {
  const server = await startPreview(page);
  try {
    await page.goto(server.url);

    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByRole('radio', { name: /SPEEDY GO!/ }).click();
    await expect(page.getByRole('radio', { name: /SPEEDY GO!/ })).toBeChecked();

    await page.getByRole('tab', { name: 'Planen' }).click();
    const destSection = page.getByRole('region', { name: 'Ziel' });
    await destSection.getByRole('combobox').fill('Marstal');
    await expect(destSection.getByRole('option')).toHaveCount(1);
    await destSection.getByRole('option').first().click();
    await expect(
      destSection.getByText(
        'Mit Salona 44 (SPEEDY GO!) nur über eine flachere Zufahrt – Tiefenwarnung.',
      ),
    ).toBeVisible();

    await page.getByRole('tab', { name: 'Boot' }).click();
    await page.getByRole('radio', { name: /EASY GO!/ }).click();
    await expect(page.getByRole('radio', { name: /EASY GO!/ })).toBeChecked();
    const notice = page.locator('.boat-picker-notice', {
      hasText: 'Salona 44 (EASY GO!) ausgewählt.',
    });
    await expect(notice).toContainText(
      'Sicherheitstiefe auf 3,5 m angehoben – Standardwert für Salona 44 (EASY GO!).',
    );
    await expect(notice).toContainText(
      'Ziel Marstal ist mit Salona 44 (EASY GO!) nicht erreichbar.',
    );

    await page.getByRole('tab', { name: 'Planen' }).click();
    await expect(destSection.getByText(EASY_GO_ANY_SETTING_LINE)).toBeVisible();

    // The snap-failure branch: Augustenborg has no navigable cell within the
    // snap radius at 3.5 m.
    const originSection = page.getByRole('region', { name: 'Start' });
    await originSection.getByRole('combobox').fill('Augustenborg');
    await expect(originSection.getByRole('option')).toHaveCount(1);
    // Reachable at the lowest gate, so only the live-gate line applies.
    await expect(
      originSection
        .getByRole('option')
        .first()
        .getByText('Mit Salona 44 (EASY GO!) bei 3,5 m Sicherheitstiefe nicht erreichbar.'),
    ).toBeVisible();
  } finally {
    server.kill();
  }
});
// #1721: a real-solver plan; pass 1 fails, pass 2 solves from the handover.
const HANDOVER_PLAN_TEST_TIMEOUT_MS = 180_000;
const HANDOVER_PLAN_WAIT_MS = 120_000;

async function planEasyGoMarstalToBagenkop(page: Page, safetyDepthM?: string): Promise<void> {
  await page.getByRole('tab', { name: 'Boot' }).click();
  await page.getByRole('radio', { name: /EASY GO!/ }).click();
  await expect(page.getByRole('radio', { name: /EASY GO!/ })).toBeChecked();

  await page.getByRole('tab', { name: 'Planen' }).click();
  if (safetyDepthM !== undefined) {
    const safetyDepth = page.getByLabel('Sicherheitstiefe (m)');
    await safetyDepth.fill(safetyDepthM);
    await safetyDepth.blur();
  }
  const originSection = page.getByRole('region', { name: 'Start' });
  await originSection.getByRole('combobox').fill('Marstal');
  await originSection.getByRole('option').first().click();
  const destSection = page.getByRole('region', { name: 'Ziel' });
  await destSection.getByRole('combobox').fill('Bagenkop');
  await destSection.getByRole('option').first().click();

  await page.getByRole('button', { name: 'Route planen' }).click();
}

interface HandoverTestMap {
  getSource(
    id: string,
  ): { getData(): Promise<{ features?: { geometry: { type: string } }[] }> } | undefined;
}

test('#1721: planning EASY GO! from Marstal starts at a handover point and discloses the approach', async ({
  page,
}) => {
  test.setTimeout(HANDOVER_PLAN_TEST_TIMEOUT_MS);
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await planEasyGoMarstalToBagenkop(page);

    const notice = page.locator('.harbor-handover-notice').filter({ visible: true }).first();
    await expect(notice).toContainText('Hafenansteuerung nicht berechnet', {
      timeout: HANDOVER_PLAN_WAIT_MS,
    });
    await expect(notice).toContainText(
      'Start: Das Tiefenraster der App (~46-m-Zellen, schmale ausgebaggerte Rinnen können darin fehlen) findet für Salona 44 (EASY GO!) bei 3,5 m Sicherheitstiefe keine Verbindung aus dem Hafen.',
    );
    await expect(page.getByRole('alert').filter({ hasText: 'Keine Route' })).toHaveCount(0);

    await expect(
      page
        .locator('.route-legend')
        .getByText('Hafenansteuerung – nicht berechnet, nicht tiefengeprüft'),
    ).toHaveCount(1);

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const map = (window as unknown as { __scMap?: HandoverTestMap }).__scMap;
          const data = await map?.getSource('sc-harbor-handover')?.getData();
          if (!data) return 'no-source';
          return (data.features ?? []).map((f) => f.geometry.type).join(',');
        }),
      )
      .toBe('LineString,Point');
  } finally {
    server.kill();
  }
});

// #1721: above 4.8 m no grid-connected cell lies within 1 nm of Marstal, so no
// handover exists and the plan fails with the #1723 range message.
test('#1721: with no handover in reach, planning EASY GO! from Marstal names the checked gate range', async ({
  page,
}) => {
  test.setTimeout(HANDOVER_PLAN_TEST_TIMEOUT_MS);
  const server = await startPreview(page);
  try {
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
    await planEasyGoMarstalToBagenkop(page, '4.9');

    const banner = page.getByRole('alert').filter({ hasText: 'Keine Route' });
    await expect(banner).toContainText(
      'Keine Route mit Salona 44 (EASY GO!) (Tiefgang 2,59 m): Das Tiefenraster der App (~46-m-Zellen, schmale ausgebaggerte Rinnen können darin fehlen) findet bei keiner Sicherheitstiefe von 2,7 m bis 4,9 m eine Verbindung von oder nach Marstal.',
      { timeout: HANDOVER_PLAN_WAIT_MS },
    );
    await expect(page.locator('.harbor-handover-notice')).toHaveCount(0);
  } finally {
    server.kill();
  }
});
