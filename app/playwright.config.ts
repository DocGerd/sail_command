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
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: process.env.CI ? 1 : 4,
  fullyParallel: false,
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
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
