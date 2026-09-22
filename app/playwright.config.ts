import { defineConfig, devices } from '@playwright/test';

// No `webServer` here: each spec spawns and tears down its own preview
// server via e2e/helpers.ts's startPreview() — offline.spec.ts needs to
// SIGKILL the server mid-test (the only honest way to prove the app is
// truly offline, since context.setOffline() alone does not block a service
// worker's own fetches — see offline.spec.ts's own comment), which a
// framework-managed shared webServer can't do per-test.
//
// Chromium only: service-worker APIs (navigator.serviceWorker) are not
// available in Playwright's WebKit/Firefox channels.
//
// #1260: `startPreviewIdentity.spec.ts` gets its OWN project (`identity`),
// capped at `workers: 1`, and the `chromium` project DEPENDS on it — so
// Playwright always runs the whole `identity` project, single worker, to
// completion BEFORE starting any `chromium` test. That is what its port
// (hardcoded `4173` in that file) and its `dist/index.html`/`dist/sw.js`
// mutate-then-restore tests need: nothing else may be reading or writing
// those files, or contending for that port, while it runs — the exact
// "tests share one resource, so cap that project's workers" shape
// Playwright's own docs recommend `TestProject.workers` for. A red
// `identity` test skips `chromium` entirely (its own project fails and
// nothing downstream needs its build-identity guarantee anyway) — a
// diagnostic trade against running everything and reporting every red, but
// keeps the ordering simple and matches how `identity`'s own tests already
// reason about "nothing else contending" (see that file's header comment).
// Filtering the CLI to one file (`npm run e2e -- plan.spec.ts`) still runs
// the full `identity` project first — Playwright does not skip a
// dependency for an unrelated file filter; pass `--no-deps` to skip it for
// a quick local iteration where build-identity does not matter.
//
// Every OTHER spec derives its own preview-server port from
// `helpers.ts`'s `currentPort()` (`4173 + test.info().parallelIndex`), so
// raising `workers` below no longer means every worker's `vite preview
// --strictPort` child fights over one socket.
//
// #1405 review BLOCKER: App.tsx's #1399a first-run caveat banner is
// unconditional on a fresh profile, and this suite's specs assert a
// banner-free cold load (seamarks.spec.ts's #830 composition guard among
// others). `storageState.origins[]` seeds `sc-caveat-banner-dismissed`
// BEFORE the page's own scripts ever run, for every spec using the
// `page`/`context` FIXTURE (the vast majority) — this is "where every spec
// gets it" without editing each spec file. One origin entry per possible
// worker port (`BASE_PORT + parallelIndex`, `helpers.ts`'s own formula,
// `workers: process.env.CI ? 1 : 4` below bounds parallelIndex to 0..3):
// CI only ever uses port 4173, so only that entry matters there; the other
// three exist for local multi-worker runs. `helpers.ts`'s `startPreview(page)`
// ALSO seeds this (belt-and-suspenders for the documented "own page created
// via browser.newContext() AFTER startPreview()" pattern several specs use,
// where this config-level seed cannot reach) — see that function's comment.
// A spec that must see the UNDISMISSED banner (this repo has exactly one:
// `caveat-banner.spec.ts`) creates its OWN context with an explicit EMPTY
// `storageState` to override this default.
const CAVEAT_DISMISSED_STORAGE_STATE = {
  cookies: [],
  origins: [0, 1, 2, 3].map((workerOffset) => ({
    origin: `http://localhost:${4173 + workerOffset}`,
    localStorage: [{ name: 'sc-caveat-banner-dismissed', value: '1' }],
  })),
};

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: process.env.CI ? 1 : 4,
  fullyParallel: false,
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: { storageState: CAVEAT_DISMISSED_STORAGE_STATE },
  projects: [
    {
      name: 'identity',
      testMatch: /startPreviewIdentity\.spec\.ts/,
      workers: 1,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testIgnore: /startPreviewIdentity\.spec\.ts/,
      dependencies: ['identity'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
