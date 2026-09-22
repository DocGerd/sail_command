import { test, expect } from '@playwright/test';
import { startPreview, assertCleanServiceWorkerState } from './helpers';

// #1405 review BLOCKER: playwright.config.ts's `storageState` default seeds
// `sc-caveat-banner-dismissed` for every OTHER spec in this suite (see that
// file's own comment) — without this spec the caveat banner (#1399a) would
// be entirely invisible to e2e: nothing else exercises its actual first-run
// appearance or its persistence across a reload. This is "the one spec that
// needs the UNDISMISSED banner" that comment names.
//
// Own page via `browser.newContext()` with an EXPLICIT EMPTY `storageState`,
// overriding the config default — the only way to reach a genuinely fresh
// profile in this suite.
//
// Scoped by CSS, never `getByRole`'s accessible name: `banner.dismiss`'s
// label ("Schließen"/"Dismiss") is shared by every other dismissible banner
// in App.tsx (CLAUDE.md's Playwright getByRole-substring-collision rule),
// and on this exact fresh-profile path the reload-prompt SW toast (a
// one-shot `offlineReady` state, ReloadPrompt.tsx) ALSO renders with its own
// same-named dismiss button. Worse, that toast's own root className is
// `banner banner-info reload-prompt` — a PLAIN `.banner-info` selector would
// match BOTH it and the caveat banner, so the caveat locator excludes it
// explicitly (`:not(.reload-prompt)`); no other Banner call site in App.tsx
// renders `kind="info"` on a cold load with no prior user interaction
// (the other two — tapTarget, droppedVia — both require one this test never
// takes).
test('#1399a: the caveat banner appears on a genuinely fresh profile and stays dismissed across a reload', async ({
  browser,
}) => {
  const server = await startPreview();
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await assertCleanServiceWorkerState(page);
    await page.goto(server.url);

    const caveat = page.locator('.banner-area .banner-info:not(.reload-prompt)');
    await expect(caveat).toBeVisible();
    await expect(caveat).toContainText(
      'SailCommand ist eine Törnplanungshilfe, kein Navigationsgerät.',
    );

    await caveat.locator('.banner-dismiss').click();
    await expect(page.locator('.banner-area .banner-info:not(.reload-prompt)')).toHaveCount(0);

    // Persistence: a reload within the SAME context (same localStorage) must
    // not bring it back.
    await page.reload();
    await expect(page.locator('.banner-area .banner-info:not(.reload-prompt)')).toHaveCount(0);
  } finally {
    server.kill();
  }
});
