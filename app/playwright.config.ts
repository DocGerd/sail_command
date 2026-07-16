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
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
