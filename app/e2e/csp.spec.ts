import { test, expect } from '@playwright/test';
import { startPreview } from './helpers';

// #223: closes a structural blind spot in the rest of the e2e suite. Every
// planning spec loads `?windFixture=...` (a local fixture, never a live
// Open-Meteo call), and annotations.spec.ts explicitly asserts ZERO
// Open-Meteo requests happen during a fixture-driven plan. So a CSP directive
// that silently blocks the one live network call the app cannot function
// without — the real Open-Meteo forecast fetch — would pass every other
// spec in this suite. This spec performs a raw page-context `fetch()`
// against the real Open-Meteo origin, no `?windFixture=` (PR #316 review m3
// — nothing here depends on the app's own wind state, so the fixture escape
// hatch would only obscure that this is a bare page load), paired with a
// probe against a definitely-disallowed origin so a future CSP regression in
// EITHER direction is caught: too tight (blocks Open-Meteo, or blocks a
// worker/glyph/style/image/manifest fetch during ordinary startup — the
// PR's dominant risk direction, PR #316 review M2) or too loose (stops
// blocking anything, e.g. an accidental widening to `*`).
//
// Per house style (CLAUDE.md: "assert the value, never a bare boolean"), the
// load-bearing assertions read the actual `securitypolicyviolation` event
// fields (`violatedDirective`, `blockedURI`) rather than collapsing to
// true/false, so a failure names the offending directive and URI directly
// instead of producing an inscrutable timeout.

interface CspViolationRecord {
  violatedDirective: string;
  blockedURI: string;
}

interface WindowWithCspViolations {
  __cspViolations: CspViolationRecord[];
}

// Exact-hostname comparison rather than `blockedURI.includes(...)` — a
// substring match would also match an unrelated host that merely CONTAINS
// the string (e.g. `evil-example.com.attacker.net`, or a query parameter),
// which is imprecise for a security assertion (flagged by CodeQL's
// incomplete-URL-substring-sanitization check on this file, PR #316 review).
function blockedHostname(blockedURI: string): string | null {
  try {
    return new URL(blockedURI).hostname;
  } catch {
    // `blockedURI` for an inline violation (e.g. a blocked inline worker) is
    // a bare token like "blob" or "inline", not a URL — not relevant here.
    return null;
  }
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
    await page.goto(server.url);

    // Real Open-Meteo forecast fetch, same origin/scheme the app's own
    // services/openMeteo.ts uses — a distinct query so it can never be
    // conflated with a fixture or cached app request. The HTTP outcome
    // itself is NOT asserted (PR #316 review m1): an Open-Meteo outage or an
    // egress-restricted runner would then red this REQUIRED check
    // indistinguishably from a real CSP regression. The `securitypolicyviolation`
    // assertion below is what actually proves the policy, and it is
    // outage-proof — a plain network failure produces no violation event at
    // all, only a blocked request does.
    await page.evaluate(async () => {
      try {
        await fetch(
          'https://api.open-meteo.com/v1/forecast?latitude=54.8&longitude=10.0&hourly=wind_speed_10m&forecast_days=1',
        );
      } catch {
        // Ignored here on purpose — see comment above.
      }
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

    // The example.com probe is the ONLY violation this test ever expects,
    // anywhere in the page's lifetime — covering ordinary startup (basemap
    // worker, glyphs, styles, images, manifest) as well as the Open-Meteo
    // fetch above. A narrower filter that only inspected Open-Meteo and
    // example.com (as an earlier revision of this spec did) would have
    // silently passed through a startup violation on anything else — the
    // PR's dominant risk direction (too tight), and exactly the shape its
    // own B2 finding turned out to be (PR #316 review M2).
    const unexpectedViolations = violations.filter(
      (v) => blockedHostname(v.blockedURI) !== 'example.com',
    );
    expect(
      unexpectedViolations,
      `unexpected CSP violation(s) during page load: ${JSON.stringify(unexpectedViolations)}`,
    ).toEqual([]);

    const exampleComViolations = violations.filter(
      (v) => blockedHostname(v.blockedURI) === 'example.com',
    );
    expect(
      exampleComViolations,
      `expected a connect-src violation for https://example.com/, got violations: ${JSON.stringify(violations)}`,
    ).toHaveLength(1);
    expect(exampleComViolations[0]?.violatedDirective).toBe('connect-src');
  } finally {
    server.kill();
  }
});
