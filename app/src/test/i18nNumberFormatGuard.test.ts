import { describe, it, expect } from 'vitest';

// #525: `formatNm`/`formatKn` (app/src/lib/format.ts) now take an explicit
// `lang` argument to render the correct decimal separator (comma for
// German, point for English). Their `lang` parameter has a DEFAULT value
// ('de'), not a required one — format.ts's own doc comment records why:
// two production call sites this batch is FORBIDDEN from touching
// (PlannerPanel.tsx, owned by the parallel #571 batch; App.test.tsx's
// fixture literals, outside this batch's file allowlist) call formatNm
// positionally with no `lang` argument, and a required parameter would not
// typecheck at either site.
//
// That default is exactly what defeats the type checker as a guard: a
// FUTURE call site that forgets its `lang` argument is not a compile error
// anywhere else in the tree, only silently wrong at runtime (always
// German-formatted, regardless of the active UI language). This is the
// structural guard standing in for the type system — it scans every
// PRODUCTION .ts/.tsx source file (never *.test.*) under app/src for a
// formatNm(/formatKn( call and flags any that supply only ONE argument,
// against a hand-written, DOCUMENTED allowlist of exactly the known
// residual above.
//
// SCAN MECHANISM: `import.meta.glob(..., { query: '?raw', eager: true })`,
// not `node:fs` — same choice and same reason as sailLiteralCallSites.test.ts
// / timeoutGuard.test.ts / cameraAnimationCallSites.test.ts: a many-file
// TypeScript-source scan needs no tsconfig.test.json entry this way (that
// file's explicit `include` list is reserved for tests reading a
// NON-TypeScript asset via real node:fs — app.css, a .py/.json pipeline
// file — which this guard does not).
const rawSourceFiles = import.meta.glob<string>(
  ['../**/*.{ts,tsx}', '!../test/**', '!../**/*.test.{ts,tsx}'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

// import.meta.glob's keys are relative to THIS file's own directory
// (app/src/test/), e.g. `'../components/PlannerPanel.tsx'`. Normalise the
// single leading `../` away so file identities read the way
// ALLOWED_SINGLE_ARG_SITES below spells them (`components/PlannerPanel.tsx`)
// — same normalisation, same reason, as sailLiteralCallSites.test.ts.
const sourceByPath = new Map(
  Object.entries(rawSourceFiles).map(([key, content]) => [key.replace(/^\.\.\//, ''), content]),
);

// Hand-written, NEVER derived from scanning production — the whole point of
// this guard is to notice when production drifts from this list, so the
// list itself must not be computed from the thing it is checking (CLAUDE.md's
// "a guard's DATA needs a twin too" / the SOLVER_LABELS lesson). Each entry
// is a (file, exact call text) pair so a DIFFERENT single-arg call in the
// same file — a genuinely new regression — is not silently swallowed by a
// file-level exemption.
//
// PlannerPanel.tsx is OUT OF SCOPE for #525/#439 (forbidden file for this
// batch, owned by the parallel #571 batch) — its `formatNm(announcedResult.
// distanceNm)` call (~:293, the ARIA live-region plan-announcement text)
// keeps using the DEFAULT 'de' lang regardless of the active UI language
// until that file is next touched. Flagged as a known residual in this PR's
// body rather than silently left for a future session to rediscover.
const ALLOWED_SINGLE_ARG_SITES: readonly { file: string; call: string }[] = [
  {
    file: 'components/PlannerPanel.tsx',
    call: 'formatNm(announcedResult.distanceNm)',
  },
];

// Standard (imperfect, but adequate here — verified against every real file
// this guard scans) comment stripper: without it, a doc-comment mention of
// bare `formatNm(N)`-shaped text (this guard's own header above, or
// format.ts's/migratePlan.ts's prose) would false-positive as a violation.
// Blanks `/* */` and `//` content; does not special-case a `//` or `/*`
// sequence inside a string/template literal, which none of the real call
// sites this guard scans contain near a formatNm/formatKn call.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// Paren-depth-aware (not a naive `formatNm\(([^()]*)\)` regex, which fails
// on a NESTED call like `formatNm(roundExposureNm(nm), lang)` — the real
// shape of RouteSummary.tsx's exposure-distance call site): finds every
// `fnName(...)` call in `source` and returns the raw argument text between
// its balanced parens.
function callArgs(source: string, fnName: string): string[] {
  const args: string[] = [];
  const needle = `${fnName}(`;
  let i = source.indexOf(needle);
  while (i !== -1) {
    let depth = 1;
    let j = i + needle.length;
    for (; j < source.length && depth > 0; j++) {
      if (source[j] === '(') depth++;
      else if (source[j] === ')') depth--;
    }
    args.push(source.slice(i + needle.length, j - 1));
    i = source.indexOf(needle, j);
  }
  return args;
}

// A call has only ONE argument iff its trimmed arg text is non-empty and
// contains no TOP-LEVEL comma. `[^()]*`-style regexes cannot tell a
// top-level comma from one nested inside a further call's own argument
// list; this walks depth explicitly instead.
function hasSingleArg(argText: string): boolean {
  const trimmed = argText.trim();
  if (trimmed.length === 0) return false; // formatNm() with zero args — a separate TS error, not this guard's concern
  let depth = 0;
  for (const c of trimmed) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) return false;
  }
  return true;
}

interface Violation {
  file: string;
  call: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const [file, rawSource] of sourceByPath) {
    const source = stripComments(rawSource);
    for (const fnName of ['formatNm', 'formatKn'] as const) {
      for (const argText of callArgs(source, fnName)) {
        if (hasSingleArg(argText)) {
          violations.push({ file, call: `${fnName}(${argText.trim()})` });
        }
      }
    }
  }
  return violations;
}

describe('#525 i18n number-format guard: every formatNm/formatKn call supplies lang', () => {
  it('scanned a non-trivial number of production source files (floor against an empty/broken scan)', () => {
    // If the glob ever matched zero (or near-zero) files — a wrong pattern,
    // an overzealous exclusion — every assertion below about "no unexpected
    // single-arg calls" would pass VACUOUSLY (nothing to violate). This
    // floor is what stops that reading as a clean guard. 50 is comfortably
    // below the real count (140+ non-test .ts/.tsx files under app/src at
    // the time this was written) and comfortably above zero.
    expect(sourceByPath.size).toBeGreaterThan(50);
  });

  it('found at least one real formatNm/formatKn call site to scan (floor against a broken detector)', () => {
    // Complements the file-count floor above: proves `callArgs`/`hasSingleArg`
    // themselves are reachable and finding SOMETHING, not merely that files
    // were listed. RouteSummary.tsx alone carries 6+ real call sites.
    let compliantCallSites = 0;
    for (const rawSource of sourceByPath.values()) {
      const source = stripComments(rawSource);
      compliantCallSites += callArgs(source, 'formatNm').filter((a) => !hasSingleArg(a)).length;
      compliantCallSites += callArgs(source, 'formatKn').filter((a) => !hasSingleArg(a)).length;
    }
    expect(compliantCallSites).toBeGreaterThan(5);
  });

  it('flags every single-argument formatNm/formatKn call, exactly matching the documented allowlist', () => {
    const violations = findViolations();
    // Exact-count, not <=: if ALLOWED_SINGLE_ARG_SITES were ever emptied,
    // the expected count drops to 0 while the real PlannerPanel.tsx residual
    // still exists in production, so this reds rather than passing
    // vacuously (the mutation this guard's own PR description requires).
    expect(
      violations,
      `expected exactly ${ALLOWED_SINGLE_ARG_SITES.length} allowlisted single-arg call(s), found: ` +
        JSON.stringify(violations, null, 2),
    ).toHaveLength(ALLOWED_SINGLE_ARG_SITES.length);
    for (const v of violations) {
      const allowed = ALLOWED_SINGLE_ARG_SITES.some((s) => s.file === v.file && s.call === v.call);
      expect(
        allowed,
        `unexpected single-arg call ${v.call} in ${v.file} — either thread lang through it, or ` +
          'add it to ALLOWED_SINGLE_ARG_SITES with a documented reason',
      ).toBe(true);
    }
  });
});
