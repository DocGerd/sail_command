import { test, expect, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS } from './helpers';

// #885: force a segment's mode from the planner and see it honoured end to end
// on the real worker, mask and polars. Design floor is 820 CSS px (ruling
// 2026-09-07), so the tablet pair straddling the 1024 px breakpoint is covered.

async function pickRoute(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Planen' }).click();
  const originSection = page.getByRole('region', { name: 'Start' });
  await originSection.getByRole('combobox').fill('Langballigau');
  await expect(originSection.getByRole('option')).toHaveCount(1);
  await originSection.getByRole('option').first().click();
  const destSection = page.getByRole('region', { name: 'Ziel' });
  await destSection.getByRole('combobox').fill('Sønderborg');
  await expect(destSection.getByRole('option')).toHaveCount(1);
  await destSection.getByRole('option').first().click();
}

// Scoped to its group: the bare mode words are not unique page-wide.
const segmentGroup = (page: Page) =>
  page.getByRole('group', { name: 'Abschnitt 1: Start → Ziel', exact: true });

for (const name of ['tabletPortrait', 'tabletLandscape'] as const) {
  test.describe(`#885 forced segment at ${name}`, () => {
    test.use({ viewport: STANDARD_VIEWPORTS[name] });

    test('forced motor routes every leg under motor and labels it forced, on both rigs', async ({
      page,
    }) => {
      const server = await startPreview(page);
      try {
        await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
        await pickRoute(page);

        const motor = segmentGroup(page).getByRole('button', { name: 'Motor', exact: true });
        await motor.click();
        await expect(motor).toHaveAttribute('aria-pressed', 'true');

        const planButton = page.getByRole('button', { name: 'Route planen' });
        await planButton.click();
        await expect(planButton).toBeEnabled({ timeout: 60_000 });

        await page.getByRole('tab', { name: 'Routen' }).click();
        const rigTabs = page.getByRole('tablist', { name: 'Riggvergleich' });
        await expect(rigTabs).toBeVisible({ timeout: 60_000 });
        await page.locator('.route-legs-disclosure > summary').click();

        for (const rig of [/Genua/, /Fock/]) {
          await rigTabs.getByRole('tab', { name: rig }).click();
          // Kind chips only: depth chips share the .chip class in the same rows.
          const chips = page.locator('.route-legs tbody .chip-motor, .route-legs tbody .chip-sail');
          await expect(chips.first()).toBeVisible();
          // Poll the texts, not a boolean, so a failure names the offending leg.
          await expect
            .poll(() => chips.allTextContents())
            .toEqual(expect.arrayContaining([expect.stringContaining('vorgegeben')]));
          const texts = await chips.allTextContents();
          expect(texts.filter((t) => !(t.startsWith('Motor') && t.includes('vorgegeben')))).toEqual(
            [],
          );
        }
      } finally {
        server.kill();
      }
    });

    test('R4: with the motor disabled a motor-marked segment shows the conflict and planning refuses', async ({
      page,
    }) => {
      const server = await startPreview(page);
      try {
        await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
        await pickRoute(page);
        await segmentGroup(page).getByRole('button', { name: 'Motor', exact: true }).click();

        await page.getByRole('tab', { name: 'Boot' }).click();
        await page.getByLabel('Motor aktiviert').click();
        await page.getByRole('tab', { name: 'Planen' }).click();

        const group = segmentGroup(page);
        await expect(group.getByRole('button', { name: 'Motor', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(group).toContainText('Die Planung wird das ablehnen');

        await page.getByRole('button', { name: 'Route planen' }).click();
        await expect(
          // The refusal copy's remedy clause; the in-group notice words the
          // conflict differently, so this matches the planner error only.
          page.getByText('oder den Abschnitt ändern'),
        ).toBeVisible({
          timeout: 60_000,
        });
      } finally {
        server.kill();
      }
    });
  });
}
