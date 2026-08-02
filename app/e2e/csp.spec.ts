import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// #223: closes a structural blind spot in the rest of the e2e suite. Every
// planning spec loads `?windFixture=...` (a local fixture, never a live
// Open-Meteo call), and annotations.spec.ts explicitly asserts ZERO
// Open-Meteo requests happen during a fixture-driven plan. So a CSP directive
// that silently blocks the one live network call the app cannot function
// without — the real Open-Meteo forecast fetch — would pass every other
// spec in this suite. This spec performs a raw page-context `fetch()`
// against the real Open-Meteo origin (bypassing the app's own fixture escape
// hatch entirely) so a regression surfaces here specifically, and pairs it
// with a probe against a definitely-disallowed origin so a future CSP
// regression in EITHER direction — too tight (blocks Open-Meteo) or too
// loose (stops blocking anything, e.g. an accidental widening to `*`) — is
// caught. Per house style (CLAUDE.md: "assert the value, never a bare
// boolean"), the load-bearing assertions read the actual
// `securitypolicyviolation` event fields (`violatedDirective`, `blockedURI`)
// rather than collapsing to true/false, so a failure names the offending
// directive and URI directly instead of producing an inscrutable timeout.

interface CspViolationRecord {
  violatedDirective: string;
  blockedURI: string;
}

interface WindowWithCspViolations {
  __cspViolations: CspViolationRecord[];
}

test('CSP: real Open-Meteo fetch is allowed, an arbitrary third-party origin is not', async ({
  page,
}) => {
  const server = await startPreview();
  try {
    // Installed before navigation so it captures every securitypolicyviolation
    // event for the whole page lifetime, not just ones after some later
    // manual trigger.
    await page.addInitScript(() => {
      (window as unknown as WindowWithCspViolations).__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as WindowWithCspViolations).__cspViolations.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
        });
      });
    });
    await page.goto(`${server.url}?windFixture=test-fixtures/wind-sw12.json`);

    // Real Open-Meteo forecast fetch, same origin/scheme the app's own
    // services/openMeteo.ts uses — a distinct query so it can never be
    // conflated with a fixture or cached app request.
    const openMeteoResult = await page.evaluate(async () => {
      try {
        const res = await fetch(
          'https://api.open-meteo.com/v1/forecast?latitude=54.8&longitude=10.0&hourly=wind_speed_10m&forecast_days=1',
        );
        return { ok: true as const, status: res.status };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    });
    expect(openMeteoResult, `Open-Meteo fetch result: ${JSON.stringify(openMeteoResult)}`).toEqual({
      ok: true,
      status: 200,
    });

    // Disallowed-origin probe: proves the policy actually restricts
    // connect-src rather than having degraded to an unrestrictive default.
    await page.evaluate(async () => {
      try {
        await fetch('https://example.com/');
      } catch {
        // Expected to throw (CSP block) — the securitypolicyviolation
        // listener below is the actual assertion target, not this catch.
      }
    });

    const violations = await page.evaluate(
      () => (window as unknown as WindowWithCspViolations).__cspViolations,
    );

    const openMeteoViolations = violations.filter((v) => v.blockedURI.includes('open-meteo'));
    expect(
      openMeteoViolations,
      `unexpected CSP violation(s) against Open-Meteo: ${JSON.stringify(openMeteoViolations)}`,
    ).toEqual([]);

    const exampleComViolations = violations.filter((v) => v.blockedURI.includes('example.com'));
    expect(
      exampleComViolations,
      `expected a connect-src violation for https://example.com/, got violations: ${JSON.stringify(violations)}`,
    ).toHaveLength(1);
    expect(exampleComViolations[0]?.violatedDirective).toBe('connect-src');
  } finally {
    server.kill();
  }
});
