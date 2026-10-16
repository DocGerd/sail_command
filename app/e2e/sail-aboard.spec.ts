import { test, expect, type Page } from '@playwright/test';
import { startPreview, STANDARD_VIEWPORTS } from './helpers';

// #1661: the "Sails aboard" inventory (Boat tab control, planner line, one-sail
// result). Design floor is 820 CSS px (ruling 2026-09-07), so only viewports at
// or above it run: tabletPortrait 820 renders the NARROW layout, tabletLandscape
// and desktopHd the wide one. Copy is asserted in both languages; the language
// is seeded through `sc-lang` before the first paint.

const LANGS = {
  de: {
    plan: 'Planen',
    routes: 'Routen',
    boat: 'Boot',
    group: 'Segel an Bord',
    both: 'Beide',
    genoa: 'Genua',
    fock: 'Fock',
    lineBoth: 'Segel an Bord: Genua, Fock',
    lineFock: 'Segel an Bord: Fock',
    origin: 'Start',
    destination: 'Ziel',
    planButton: 'Route planen',
    rigTabs: 'Riggvergleich',
    oneSail: 'Nur mit Fock geplant',
    scanHelpGenoa: /nur mit der Genua berechnet/,
    scanHelpFock: /nur mit Fock berechnet/,
  },
  en: {
    plan: 'Plan',
    routes: 'Routes',
    boat: 'Boat',
    group: 'Sails aboard',
    both: 'Both',
    genoa: 'Genoa',
    fock: 'Fock',
    lineBoth: 'Sails aboard: Genoa, Fock',
    lineFock: 'Sails aboard: Fock',
    origin: 'Origin',
    destination: 'Destination',
    planButton: 'Plan route',
    rigTabs: 'Rig comparison',
    oneSail: 'Planned with Fock only',
    scanHelpGenoa: /computed on the genoa alone/,
    scanHelpFock: /computed on Fock alone/,
  },
} as const;

type Lang = keyof typeof LANGS;
type Copy = (typeof LANGS)[Lang];

const VIEWPORT_NAMES = ['tabletPortrait', 'tabletLandscape', 'desktopHd'] as const;
const PLAN_VIEWPORT_NAMES = ['tabletPortrait', 'tabletLandscape'] as const;

async function seedLang(page: Page, lang: Lang): Promise<void> {
  await page.addInitScript((l) => {
    try {
      window.localStorage.setItem('sc-lang', l);
    } catch {
      // best-effort: the app falls back to its default language
    }
  }, lang);
}

// Exact on the nav tabs: 'Plan' is a substring of nothing else today, but the
// match is case-insensitive substring unless exact.
const navTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const sailGroup = (page: Page, c: Copy) => page.getByRole('group', { name: c.group, exact: true });
const aboardLine = (page: Page, line: string) =>
  page.getByRole('button', { name: line, exact: true });

async function pickRoute(page: Page, c: Copy): Promise<void> {
  await navTab(page, c.plan).click();
  const originSection = page.getByRole('region', { name: c.origin, exact: true });
  await originSection.getByRole('combobox').fill('Langballigau');
  await expect(originSection.getByRole('option')).toHaveCount(1);
  await originSection.getByRole('option').first().click();
  const destSection = page.getByRole('region', { name: c.destination, exact: true });
  await destSection.getByRole('combobox').fill('Sønderborg');
  await expect(destSection.getByRole('option')).toHaveCount(1);
  await destSection.getByRole('option').first().click();
}

async function expectPressed(page: Page, c: Copy, pressed: string): Promise<void> {
  const group = sailGroup(page, c);
  for (const name of [c.both, c.genoa, c.fock]) {
    await expect(group.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-pressed',
      name === pressed ? 'true' : 'false',
    );
  }
}

for (const lang of ['de', 'en'] as const) {
  const c = LANGS[lang];

  for (const viewportName of VIEWPORT_NAMES) {
    test.describe(`#1661 sails aboard control at ${viewportName} (${lang})`, () => {
      test.use({ viewport: STANDARD_VIEWPORTS[viewportName] });

      test('the planner line opens the Boat tab; the control has 44px targets, a re-click on the pressed sail is a no-op and it does not overflow', async ({
        page,
      }) => {
        await seedLang(page, lang);
        const server = await startPreview(page);
        try {
          await page.goto(server.url);
          await navTab(page, c.plan).click();

          await aboardLine(page, c.lineBoth).click();
          await expect(navTab(page, c.boat)).toHaveAttribute('aria-selected', 'true');

          const group = sailGroup(page, c);
          await expect(group).toBeVisible();
          await expectPressed(page, c, c.both);

          // Re-sample every box inside the poll; the smaller side of the smallest
          // button is the value, so a failure names the shortfall.
          await expect
            .poll(async () => {
              const sides: number[] = [];
              for (const name of [c.both, c.genoa, c.fock]) {
                const box = await group.getByRole('button', { name, exact: true }).boundingBox();
                sides.push(box === null ? 0 : Math.min(box.width, box.height));
              }
              return Math.min(...sides);
            })
            .toBeGreaterThanOrEqual(44);

          await group.getByRole('button', { name: c.fock, exact: true }).click();
          await expectPressed(page, c, c.fock);
          // A re-click on the pressed sail is a no-op; the never-empty guarantee lives in the unit tests.
          await group.getByRole('button', { name: c.fock, exact: true }).click();
          await expectPressed(page, c, c.fock);

          // CLAUDE.md #299: border boxes cannot see overflow, scroll extents can.
          await expect
            .poll(() =>
              page.evaluate(() => {
                const panel = document.querySelector('.app-panel');
                return {
                  page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  panel: panel === null ? null : panel.scrollWidth - panel.clientWidth,
                };
              }),
            )
            .toEqual({ page: 0, panel: 0 });

          await navTab(page, c.plan).click();
          await expect(aboardLine(page, c.lineFock)).toBeVisible();

          await aboardLine(page, c.lineFock).click();
          await group.getByRole('button', { name: c.both, exact: true }).click();
          await expectPressed(page, c, c.both);
          await navTab(page, c.plan).click();
          await expect(aboardLine(page, c.lineBoth)).toBeVisible();
        } finally {
          server.kill();
        }
      });
    });
  }

  for (const viewportName of PLAN_VIEWPORT_NAMES) {
    test.describe(`#1661 one-sail plan at ${viewportName} (${lang})`, () => {
      test.use({ viewport: STANDARD_VIEWPORTS[viewportName] });

      test('Fock only plans with one sail: one-sail copy, no rig tabs, scan help names the sail', async ({
        page,
      }) => {
        await seedLang(page, lang);
        const server = await startPreview(page);
        try {
          await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
          await pickRoute(page, c);

          await aboardLine(page, c.lineBoth).click();
          await sailGroup(page, c).getByRole('button', { name: c.fock, exact: true }).click();
          await expectPressed(page, c, c.fock);

          await navTab(page, c.plan).click();
          await page.getByRole('button', { name: c.planButton, exact: true }).click();

          await navTab(page, c.routes).click();
          const routesPanel = page.getByRole('tabpanel', { name: c.routes, exact: true });
          // Gates on the solve: no plan exists on a fresh page, so the copy
          // appearing is also what makes the rig-tabs absence below meaningful.
          await expect(routesPanel.getByText(c.oneSail, { exact: true })).toBeVisible({
            timeout: 60_000,
          });
          await expect(page.getByRole('tablist', { name: c.rigTabs, exact: true })).toHaveCount(0);

          await navTab(page, c.plan).click();
          await expect(
            page.getByRole('tabpanel', { name: c.plan, exact: true }).getByText(c.scanHelpFock),
          ).toBeVisible();
        } finally {
          server.kill();
        }
      });
    });
  }

  test.describe(`#1661 control: both sails aboard (${lang})`, () => {
    test.use({ viewport: STANDARD_VIEWPORTS.tabletLandscape });

    test('Both keeps the rig comparison and no one-sail copy', async ({ page }) => {
      await seedLang(page, lang);
      const server = await startPreview(page);
      try {
        await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);
        await pickRoute(page, c);
        await page.getByRole('button', { name: c.planButton, exact: true }).click();

        await navTab(page, c.routes).click();
        const rigTabs = page.getByRole('tablist', { name: c.rigTabs, exact: true });
        await expect(rigTabs).toBeVisible({ timeout: 60_000 });
        // Substring match is intended here: the tab names carry the sail label.
        await expect(rigTabs.getByRole('tab', { name: new RegExp(c.genoa) })).toBeVisible();
        await expect(rigTabs.getByRole('tab', { name: new RegExp(c.fock) })).toBeVisible();
        await expect(page.getByText(c.oneSail, { exact: true })).toHaveCount(0);

        await navTab(page, c.plan).click();
        await expect(
          page.getByRole('tabpanel', { name: c.plan, exact: true }).getByText(c.scanHelpGenoa),
        ).toBeVisible();
      } finally {
        server.kill();
      }
    });
  });
}
