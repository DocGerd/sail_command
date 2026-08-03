import { describe, it } from 'vitest';

// #342 structural guard: a hardcoded `testTimeout`/`timeout` literal in a
// test file silently reintroduces the exact failure this issue exists to
// close. Nine test files each hardcoded their own
// `vi.setConfig({ testTimeout: 120_000 })`; PR #335's first two fix attempts
// patched only the files that had most recently failed CI, and each round
// cost ~43 minutes to reveal one more instance of a pattern `git grep`
// enumerates in one second. `timeouts.ts` (this directory) is now the single
// definition — every solver-heavy test file imports `SOLVER_TEST_TIMEOUT_MS`
// / `solverTimeoutMs()` from there instead. This test converts a silent
// reintroduction into a loud, explained CI failure by scanning every test
// file for a bare numeric `testTimeout`/`timeout` and asserting none exists
// outside `timeouts.ts` itself.
//
// Modeled on `cameraAnimationCallSites.test.ts` (#253): source is read via
// Vite's `?raw` glob import so this file needs no tsconfig.test.json entry,
// and comments are stripped first so this file's OWN prose (which names the
// pattern being guarded against) can't trip a false positive.
const testFiles = import.meta.glob<string>(['../**/*.test.{ts,tsx}', '!./timeoutGuard.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Same character-scanning comment stripper as cameraAnimationCallSites.test.ts
// (kept local rather than shared — extracting a two-file-used helper isn't
// worth the indirection, and each guard documents its own known residuals
// independently). KNOWN RESIDUAL, latent not live: no notion of a regex
// literal, so a quote character inside one could desync the string-state
// tracking; the failure direction is a FALSE GREEN (a hardcoded timeout goes
// unreported), never a false failure — no such regex exists near a timeout
// literal in this codebase today (checked).
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += c2 ?? '';
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && c2 === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// Matches `testTimeout: <number>` (vi.setConfig) and `{ timeout: <number> }`
// / `timeout: <number>` (per-test option object) with a BARE numeric literal
// — `_`-separated numeric literals (120_000, 900_000, 600_000) included. A
// call importing `SOLVER_TEST_TIMEOUT_MS` or wrapping the value in
// `solverTimeoutMs(...)` does not match this pattern at all, since the
// right-hand side is an identifier/call, not a numeric literal — which is
// exactly the distinction this guard exists to enforce.
//
// Case-sensitive and keyed on the EXACT two vitest option names (`timeout`,
// `testTimeout`), not a case-insensitive substring match: a naive
// `/timeout/i` false-positived on `services/geolocation.test.ts`'s
// `TIMEOUT: 3` — a mocked `GeolocationPositionError.TIMEOUT` numeric error
// code, unrelated to vitest's own timeout options entirely.
const HARDCODED_TIMEOUT_PATTERN = /\b(?:timeout|testTimeout)\s*:\s*[\d_]+(?![\w(])/g;

/** full glob path -> the offending literal snippets found in it. */
function findHardcodedTimeouts(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [path, source] of Object.entries(testFiles)) {
    const stripped = stripComments(source);
    const matches = [...stripped.matchAll(HARDCODED_TIMEOUT_PATTERN)].map((m) => m[0]);
    if (matches.length === 0) continue;
    hits.set(path, matches);
  }
  return hits;
}

describe('#342 structural guard: centralized coverage-aware test timeout', () => {
  it('finds zero hardcoded testTimeout/timeout literals across the test suite', () => {
    const hits = findHardcodedTimeouts();

    if (hits.size > 0) {
      const detail = [...hits.entries()]
        .map(([file, matches]) => `${file}: ${matches.join(', ')}`)
        .join('\n  ');
      throw new Error(
        `Hardcoded test timeout literal(s) found outside timeouts.ts:\n  ${detail}\n\n` +
          `Why this matters (#342): a per-file hardcoded testTimeout/timeout does not scale ` +
          `under v8 coverage instrumentation, which costs a SEPARATE, bigger multiplier on ` +
          `solver-heavy tests than CI's general slowdown does. A per-file patch to the two ` +
          `files that had most recently failed CI missed a third file with the identical ` +
          `shape, at ~43 minutes of CI per round. Import SOLVER_TEST_TIMEOUT_MS (file-level ` +
          `vi.setConfig) or solverTimeoutMs(baseMs) (a larger per-test override) from ` +
          `'../test/timeouts' instead of hardcoding a literal.`,
      );
    }
  });
});
