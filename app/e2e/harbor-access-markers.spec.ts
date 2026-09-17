import { test, expect } from '@playwright/test';
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
//   - "Marstal": the ONE harbour every catalogue boat reads as
//     'shallow-approach' at its OWN default safety depth
//     (harborReachability.test.ts's own `it.each(BOATS)` pin: "34 ok,
//     marstal shallow-approach, 0 unreachable, 5 known-disconnected") — the
//     only per-boat state reachable at DEFAULT settings, so it is the one
//     real-data case an e2e spec can hit without also raising the safety
//     depth via the Options panel.
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
