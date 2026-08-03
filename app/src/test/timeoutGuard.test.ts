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
// reintroduction into a loud, explained CI failure by scanning
// `app/src/**/*.test.{ts,tsx}` for a bare numeric timeout, in EITHER of the
// two shapes vitest accepts, and asserting none exists outside `timeouts.ts`
// itself:
//
//   - the KEYED form: `vi.setConfig({ testTimeout: N })` or
//     `it('x', { timeout: N }, fn)` / `it('x', fn, { timeout: N })`.
//   - the POSITIONAL form: `it('x', fn, N)` — a bare trailing number, no key
//     at all. This is the exact shape #342 itself removed from
//     `invariants.property.test.ts` (`}, 900_000);`) in this same PR; PR
//     #351 review M1 found the keyed-only scanner could not see it, so a
//     straight revert of that file's centralization would not have been
//     caught by the guard meant to protect it.
//
// EXPLICIT RESIDUALS (out of scope, named rather than silently uncovered):
//   - `app/e2e/**/*.spec.ts` and `playwright.config.ts` are NOT scanned —
//     the glob below is `app/src/**` only. Coverage (what #342 exists to
//     protect) never runs e2e, so a Playwright-side timeout is a different
//     concern with its own budget (`playwright.config.ts`'s own
//     `timeout: 120_000`, unrelated to `SC_COVERAGE`).
//   - `it.each(...)(name, fn, N)` — the RETURNED call from `it.each` does
//     not start with the literal text `it(`/`test(` the scanner keys on
//     (it starts with the closing `)` of the `.each([...])` call), so a
//     positional timeout on an `it.each` call would not be caught. LATENT,
//     not live: no `it.each` call in this codebase carries a third
//     positional argument today (checked); closing this needs either a
//     real parser or extending the call-start pattern to match a preceding
//     `.each(...)(`, neither done here.
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

// --- Form 1: KEYED (`timeout: <number>` / `testTimeout: <number>`) ---
//
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
const KEYED_TIMEOUT_PATTERN = /\b(?:timeout|testTimeout)\s*:\s*[\d_]+(?![\w(])/g;

// --- Form 2: POSITIONAL (`it('name', fn, <number>)`) ---
//
// vitest's `it`/`test` signature is `(name, fn, timeout?)` where the third
// argument, if present, is EITHER a bare number or an options object (the
// latter is already covered by Form 1's `{ timeout: N }` match). A bare
// trailing number as the LAST argument to an `it(...)`/`test(...)` call
// (optionally `.only`/`.skip`/`.todo`/`.concurrent`/`.sequential`) is
// therefore unambiguous — vitest's own API shape is what makes this safe,
// not a heuristic. `test(` is included defensively (unused anywhere in this
// codebase today, checked) for the same reason `it.each` is out of scope
// above: match the API surface, not just today's call sites.
const CALL_START_PATTERN = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|sequential))?\s*\(/g;
const BARE_NUMBER_PATTERN = /^[\d_]+$/;

// Finds the index of the `)` matching the `(` at `openParenIndex`, tracking
// string state so a paren/brace/bracket INSIDE a string literal is never
// counted (same technique as stripComments' string tracking, applied to
// depth instead of comment detection). Returns null on unterminated input —
// a scanner over a large glob must not throw on a shape it doesn't expect.
function findMatchingParen(source: string, openParenIndex: number): number | null {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  for (let i = openParenIndex; i < source.length; i++) {
    const c = source[i]!;
    if (inString) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

// Splits a call's argument-list text on TOP-LEVEL commas only — a comma
// inside a nested `{...}`/`[...]`/`(...)` (e.g. the single argument
// `{ timeout: 600_000 }`) or inside a string must not split it.
function splitTopLevelArgs(argsText: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let current = '';
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i]!;
    if (inString) {
      current += c;
      if (c === '\\') {
        current += argsText[i + 1] ?? '';
        i += 1;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      current += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      args.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim().length > 0) args.push(current);
  return args;
}

/** full glob path -> the offending literal/call snippets found in it (both forms combined). */
function findHardcodedTimeouts(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [path, source] of Object.entries(testFiles)) {
    const stripped = stripComments(source);
    const found: string[] = [];

    found.push(...[...stripped.matchAll(KEYED_TIMEOUT_PATTERN)].map((m) => m[0]));

    for (const m of stripped.matchAll(CALL_START_PATTERN)) {
      const openParenIndex = m.index + m[0].length - 1;
      const closeParenIndex = findMatchingParen(stripped, openParenIndex);
      if (closeParenIndex === null) continue;
      const args = splitTopLevelArgs(stripped.slice(openParenIndex + 1, closeParenIndex));
      const last = args[args.length - 1]?.trim();
      if (last !== undefined && BARE_NUMBER_PATTERN.test(last)) {
        found.push(`${m[0].trim()}..., ${last})`);
      }
    }

    if (found.length > 0) hits.set(path, found);
  }
  return hits;
}

describe('#342 structural guard: centralized coverage-aware test timeout', () => {
  it('finds zero hardcoded testTimeout/timeout literals (keyed or positional) in app/src/**/*.test.{ts,tsx}', () => {
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
          `vi.setConfig) or solverTimeoutMs(baseMs) (a larger per-test override, keyed OR ` +
          `positional) from '../test/timeouts' instead of hardcoding a literal.`,
      );
    }
  });
});
