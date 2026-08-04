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
//
// #320: a second disallowed-origin probe uses a glyph-.pbf-SHAPED path. It
// does NOT pin which directive governs glyph requests — CSP dispatch is
// destination-based, not URL-shape-based, so it's mechanically identical to
// the bare-origin probe above (see the comment at that probe below for the
// full correction). labels.spec.ts covers the actual hard half of #320:
// that the app's own real (same-origin, allowed) glyph fetch produces a
// rendered label rather than a silent library-internal fallback.

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

    // #320: a glyph-SHAPED path at the same disallowed origin. IMPORTANT —
    // CORRECTED after PR #375 review: this probe does NOT pin that
    // connect-src (rather than font-src) judges glyph requests. CSP
    // directive selection for a `fetch()` call is DESTINATION-based only
    // (the browser dispatches every fetch/XHR/WebSocket/beacon through
    // connect-src regardless of the URL's path/extension) — it never
    // inspects URL shape, so this probe is mechanically identical to the
    // bare `https://example.com/` probe above and proves nothing beyond it.
    // Kept anyway (harmless, and the toHaveLength(2)/per-violation
    // connect-src check below still passes honestly) but NOT as evidence for
    // the connect-src-governs-glyphs claim. That claim rests on two things
    // instead: reading load_glyph_range.ts's getArrayBuffer -> ajax.ts's
    // fetch() call (source), and the measured 'connect-src' violatedDirective
    // against the app's OWN real glyph-manifest.json fetch when connect-src's
    // 'self' is removed (see the PR description's mutation-check) — a
    // same-origin, normally-allowed request, unlike this probe's
    // already-disallowed-origin one.
    await page.evaluate(async () => {
      try {
        await fetch('https://example.com/basemap-assets/fonts/Noto%20Sans%20Regular/0-255.pbf');
      } catch {
        // Expected to throw (CSP block) — see comment above.
      }
    });

    const violations = await page.evaluate(
      () => (window as unknown as WindowWithCspViolations).__cspViolations,
    );

    // The two example.com probes are the ONLY violations this test ever
    // expects, anywhere in the page's lifetime — covering ordinary startup
    // (basemap worker, glyphs, styles, images, manifest) as well as the
    // Open-Meteo fetch above. A narrower filter that only inspected
    // Open-Meteo and example.com (as an earlier revision of this spec did)
    // would have silently passed through a startup violation on anything
    // else — the PR's dominant risk direction (too tight), and exactly the
    // shape its own B2 finding turned out to be (PR #316 review M2).
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
      `expected connect-src violations for both example.com probes (bare + glyph-shaped path), got violations: ${JSON.stringify(violations)}`,
    ).toHaveLength(2);
    for (const v of exampleComViolations) {
      expect(v.violatedDirective, `expected connect-src, got: ${JSON.stringify(v)}`).toBe(
        'connect-src',
      );
    }
  } finally {
    server.kill();
  }
});
