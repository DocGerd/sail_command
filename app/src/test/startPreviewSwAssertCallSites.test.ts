import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #976: PR #973 threaded an explicit `assertCleanServiceWorkerState(page)`
 * call through every e2e spec's OWN-PAGE `startPreview()` call site — a
 * BARE call with no `page` argument. `startPreview(page)` already runs the
 * assert internally (see `helpers.ts`'s own doc comment above
 * `startPreview`: "this also runs assertCleanServiceWorkerState(page)"
 * whenever a `page` is passed) — the bare form does not, so a caller that
 * creates its own page afterwards must invoke the guard itself.
 *
 * Nothing pinned that the call STAYS there. Per the issue: delete
 * `await assertCleanServiceWorkerState(page);` from any one of the own-page
 * sites and the suite stays green — the exact silent-regression shape
 * #928/#832/#803 exist to close, in the dangerous direction (a false
 * GREEN is what a merge is gated on, per #803).
 *
 * Structural precedent: `cameraAnimationCallSites.test.ts` (scan every
 * source file for a method call, assert the offending set is exactly an
 * explained allowlist) and `sailLiteralCallSites.test.ts` (same shape, plus
 * a hand-pinned KNOWN_OFFENDERS/ALLOWED twin, and a "the scan actually
 * detects" positive control run with an EMPTY allowlist). This guard
 * follows both shapes but reads `app/e2e/*.spec.ts` via `node:fs`, NOT an
 * `import.meta.glob(..., {query:'?raw'})`: both of those precedents glob
 * `'../**\/*.{ts,tsx}'` relative to `app/src/test/`, which resolves to
 * `app/src/**` — `app/e2e/` is a SIBLING of `src/`, entirely outside that
 * tree (`tsconfig.app.json`'s `include: ["src"]`; `app/e2e/` has its own
 * separate `tsconfig.e2e.json`), so a `?raw` glob rooted at `app/src/test/`
 * could never reach it regardless of file extension. This is NOT the
 * `.css`-`?raw` vacuity trap documented at the top of this directory (a
 * `.ts`/`.tsx` `?raw` glob genuinely works — see
 * `sailLiteralCallSites.test.ts`'s own header comment) — it is a different,
 * unrelated reason to use `node:fs`: the files live outside the globbable
 * directory tree, not inside an extension vitest empties. Same
 * `node:fs`-reads-a-real-artifact-outside-`src/`-via-`readFileSync` pattern
 * as `sweepSailIds.test.ts` (registered in `tsconfig.test.json` for the
 * node builtins, exactly like that file).
 *
 * GRANULARITY: per TEST BODY, not per file. A single file legitimately
 * mixes `startPreview(page)` sites (self-contained, no guard needed),
 * compliant bare `startPreview()` sites (guard called in the same body),
 * and — as of #976 — one bare `startPreview()` site that never creates a
 * page at all and so needs no guard call either.
 * `startPreviewIdentity.spec.ts` has all three today. A file-level "does
 * this file contain the string anywhere" check cannot distinguish any of
 * these from each other.
 */

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../e2e');

/** Sorted so failure output and the pinned-count check below are stable. */
function listSpecFiles(): string[] {
  return readdirSync(E2E_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
}

function readSpec(name: string): string {
  return readFileSync(resolve(E2E_DIR, name), 'utf8');
}

// Comment/string stripper. Adapted from cameraAnimationCallSites.test.ts's
// stripComments with one deliberate difference: string and template-literal
// CONTENT is replaced with spaces rather than kept verbatim, so a test
// TITLE (always a string, and the one place in a test body most likely to
// narrate "startPreview()"/"assertCleanServiceWorkerState(" in prose — this
// repo's own comments do exactly that throughout this file) can never
// contribute a real brace/arrow to the structural scan below, and prose
// mentioning either name in a title can never be mistaken for a real call.
// Newlines are preserved character-for-character on every path (masked
// strings, dropped line comments, block comments, masked regex literals), so
// a line number computed on the RETURNED string is the true line number in
// the ORIGINAL file — which is what lets `declarationTitle` below index
// straight into the original file's own lines with no separate offset
// bookkeeping.
//
// UNLIKE cameraAnimationCallSites.test.ts's stripComments (which documents a
// regex-literal blind spot as a "KNOWN RESIDUAL, latent not live" because no
// camera-method-adjacent regex ever tripped it), this scan's REAL subject —
// `app/e2e/*.spec.ts` — hits that exact hole live, not latently: a quote
// character INSIDE a regex literal (never given special handling by a
// string-only stripper) gets read as an ordinary string opener, and
// everything after it — including real structural braces — is silently
// swallowed as "string content" until a LATER, unrelated matching quote
// somewhere else in the file is found (or never is, throwing "unbalanced
// braces"). Measured against this exact tree at #976: `startPreviewIdentity
// .spec.ts` contains `/service worker doesn't byte-match/` (an apostrophe
// inside a regex body) and `offline.spec.ts` contains
// `/importScripts\(|new URL\(|import\s*[*{"']/g` (a double-quote AND a
// single-quote inside a regex CHARACTER CLASS) — both throw
// "unbalanced braces" with the string-only stripper, over real, currently
// shipped, non-test code. So this stripper ALSO recognizes and masks regex
// literals — `isRegexContext`/`scanRegexLiteral` below — closing the hole
// this file's own scan target requires closed, rather than inheriting it.
function isRegexContext(outSoFar: string): boolean {
  let j = outSoFar.length - 1;
  while (j >= 0 && /\s/.test(outSoFar[j]!)) j -= 1;
  if (j < 0) return true; // start of file
  const c = outSoFar[j]!;
  if (/[A-Za-z0-9_$)\]]/.test(c)) {
    // Ends in an identifier/number/`)`/`]` char — normally division, UNLESS
    // the trailing WORD is a keyword after which a regex literal is legal
    // (`return /x/`, `typeof /x/` never occurs but kept for safety, etc.).
    const wordMatch = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(outSoFar.slice(0, j + 1));
    const REGEX_LEGAL_AFTER_KEYWORD = new Set([
      'return',
      'typeof',
      'instanceof',
      'in',
      'of',
      'new',
      'void',
      'delete',
      'yield',
      'case',
      'do',
      'else',
      'throw',
    ]);
    return wordMatch !== null && REGEX_LEGAL_AFTER_KEYWORD.has(wordMatch[1]!);
  }
  return true; // trailing punctuation/operator — a regex literal is plausible
}

/**
 * `source[start]` is the opening `/` of a candidate regex literal. Returns
 * the index just past its closing `/` and any trailing flag letters, or -1
 * if this is not actually a terminated single-line regex literal (in which
 * case the caller must fall back to treating `/` as an ordinary character —
 * a real JS regex literal can never contain a literal newline). Tracks
 * character-class (`[...]`) depth because an UNESCAPED `/` inside `[...]`
 * does not end the regex (`/[a/b]/` is one regex, not two) — the same
 * detail `offline.spec.ts`'s own `[*{"']` character class depends on.
 */
function scanRegexLiteral(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') return -1;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      i += 1;
      continue;
    }
    if (c === '[') {
      inClass = true;
      i += 1;
      continue;
    }
    if (c === '/') {
      i += 1;
      while (i < source.length && /[a-zA-Z]/.test(source[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  let inString: '"' | "'" | '`' | null = null;
  while (i < source.length) {
    const c = source[i]!;
    const c2 = source[i + 1];
    if (inString) {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\\') {
        out += c2 === '\n' ? '\n' : ' ';
        i += 2;
        continue;
      }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      out += ' ';
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
        out += source[i] === '\n' ? '\n' : '';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '/') {
      const contextAllowsRegex = isRegexContext(out);
      if (contextAllowsRegex) {
        const end = scanRegexLiteral(source, i);
        if (end !== -1) {
          for (let k = i; k < end; k += 1) out += source[k] === '\n' ? '\n' : ' ';
          i = end;
          continue;
        }
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

// Matches a real Playwright test declaration — bare `test(`, `test.skip(` or
// `test.only(` — while excluding the ubiquitous `someRegex.test(str)`
// (RegExp#test) false-positive source via the negative lookbehind: a real
// `.test(` call is always preceded by a dot, which neither `test(` nor
// `test.skip(`/`test.only(` (the dot sits AFTER "test", not before it) ever
// is. `test.describe(`/`test.step(`/`test.beforeEach(` etc. are
// deliberately NOT matched: they are suite/hook wrappers, not test bodies,
// and no spec in this suite calls `startPreview()` from inside one (checked
// with a repo-wide grep as of #976 — `grep -n
// "test\.\(describe\|beforeEach\|afterEach\|beforeAll\|afterAll\)("`).
const TEST_DECL_PATTERN = /(?<!\.)\btest(?:\.(?:skip|only))?\(/g;

interface TestBody {
  /** index of the "test("/"test.skip("/"test.only(" match start, in the STRIPPED source. */
  declIndex: number;
  /** index of the body's opening '{', in the STRIPPED source. */
  bodyStart: number;
  /** index of the body's closing '}', in the STRIPPED source (inclusive). */
  bodyEnd: number;
}

/**
 * Finds every test declaration's own callback body as a brace range in the
 * STRIPPED (comments removed, strings masked) source. The body's opening
 * brace is found via the FIRST `=>` strictly after the call's own `(`, then
 * optional whitespace, then `{` — reliable because a test's title is always
 * its first argument and, once masked, can never itself contain a real
 * `=>`, so the first `=>` following the call is always the test's own
 * callback arrow. Every test body in this suite is written
 * `test(title, async (fixtures) => { ... })`, never a concise-body arrow
 * (checked: every real call site opens its callback with `{`) — a missing
 * `{` after the arrow throws rather than silently mis-scanning, per the
 * guard-asymmetry rule (a structural assumption violated should fail
 * loudly, not report a false "no offenders").
 */
function findTestBodies(stripped: string): TestBody[] {
  const bodies: TestBody[] = [];
  for (const m of stripped.matchAll(TEST_DECL_PATTERN)) {
    const declIndex = m.index;
    const argsStart = declIndex + m[0].length;
    const arrowIdx = stripped.indexOf('=>', argsStart);
    if (arrowIdx === -1) {
      throw new Error(`#976 guard: no '=>' found after a test() declaration at index ${declIndex}`);
    }
    let braceIdx = arrowIdx + 2;
    while (braceIdx < stripped.length && /\s/.test(stripped[braceIdx]!)) braceIdx += 1;
    if (stripped[braceIdx] !== '{') {
      throw new Error(
        `#976 guard: test() callback at index ${declIndex} is not a block body ("{ ... }") — ` +
          'this guard assumes every test body is a block statement.',
      );
    }
    let depth = 0;
    let bodyEnd = -1;
    for (let i = braceIdx; i < stripped.length; i += 1) {
      if (stripped[i] === '{') depth += 1;
      else if (stripped[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    if (bodyEnd === -1) {
      throw new Error(`#976 guard: unbalanced braces scanning test() body at index ${declIndex}`);
    }
    bodies.push({ declIndex, bodyStart: braceIdx, bodyEnd });
  }
  return bodies;
}

function lineOf(stripped: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (stripped[i] === '\n') line += 1;
  }
  return line;
}

// `startPreview()` with no argument (optional internal whitespace only) —
// never `startPreview(page)`/`startPreview(anythingElse)`, which routes
// through the internally-guarded path (helpers.ts's own doc comment above
// `startPreview`).
const BARE_START_PREVIEW_PATTERN = /startPreview\(\s*\)/;
const ASSERT_CALL_PATTERN = /assertCleanServiceWorkerState\(/;

function bodyText(stripped: string, body: TestBody): string {
  return stripped.slice(body.bodyStart, body.bodyEnd + 1);
}

/**
 * The test's own title text, read from the ORIGINAL (unstripped) source at
 * the declaration's own line — every test() call in this suite opens its
 * title on the same physical line as `test(`/`test.skip(`/`test.only(`
 * (checked: no multi-line title exists today), so a single-line regex
 * against that one line is enough. Used only for EXEMPT_SITES keys and
 * failure messages, never for structural detection, which stays entirely
 * on the line-number-only stripped-source scan above.
 */
function declarationTitle(originalLines: string[], declLine: number): string {
  const line = originalLines[declLine - 1] ?? '';
  const m = /(?<!\.)\btest(?:\.(?:skip|only))?\(\s*(['"`])((?:(?!\1).)*)\1/.exec(line);
  if (!m) {
    throw new Error(
      `#976 guard: could not extract a title from line ${declLine}: ${JSON.stringify(line)}`,
    );
  }
  return m[2]!;
}

interface Offender {
  file: string;
  line: number;
  title: string;
}

interface ExemptSite {
  file: string;
  title: string;
  reason: string;
}

/**
 * Sites where a bare `startPreview()` call legitimately does not need
 * `assertCleanServiceWorkerState` in the same test body — a HAND-WRITTEN,
 * EXPLAINED twin, per #411's "a guard's DATA needs a twin too" rule (see
 * the twin test below, which stubs this to `[]` and confirms the guard is
 * still meaningful). Empty is the expected steady state for every NEW bare
 * call site; a new entry must justify itself the way this one does.
 *
 * `startPreviewIdentity.spec.ts` / "#803: still starts normally against its
 * own build with no foreign server" — this test's callback takes NO
 * fixtures at all (`async () => {...}`, no `page`/`browser`/`context`
 * destructured) and never creates a page: it checks `server.url` and does a
 * plain `fetch()`. The hazard `assertCleanServiceWorkerState` defends
 * against (a stale SW/cache from a foreign build intercepting a real page's
 * first navigation) cannot occur here because there is no page to
 * intercept — calling the guard would require fabricating a page this test
 * has no other reason to create.
 */
const EXEMPT_SITES: ExemptSite[] = [
  {
    file: 'startPreviewIdentity.spec.ts',
    title: '#803: still starts normally against its own build with no foreign server',
    reason:
      'test takes no page/browser/context fixture and never creates one; checks server.url via a plain fetch() only',
  },
];

function isExempt(file: string, title: string, exempt: readonly ExemptSite[]): boolean {
  return exempt.some((e) => e.file === file && e.title === title);
}

/**
 * Scans ONE file's already-read source. Split out from `findOffenders` so
 * the positive-control tests below can feed a synthetic fixture through the
 * EXACT same code path the real scan uses, rather than re-implementing (and
 * therefore possibly mis-implementing) the detection logic a second time.
 */
function scanFileSource(file: string, source: string, exempt: readonly ExemptSite[]): Offender[] {
  const offenders: Offender[] = [];
  const originalLines = source.split('\n');
  const stripped = stripCommentsAndStrings(source);
  for (const body of findTestBodies(stripped)) {
    const text = bodyText(stripped, body);
    if (!BARE_START_PREVIEW_PATTERN.test(text)) continue;
    if (ASSERT_CALL_PATTERN.test(text)) continue;
    const line = lineOf(stripped, body.declIndex);
    const title = declarationTitle(originalLines, line);
    if (isExempt(file, title, exempt)) continue;
    offenders.push({ file, line, title });
  }
  return offenders;
}

/**
 * `exempt` is a PARAMETER (defaulting to EXEMPT_SITES) purely so the
 * mutation-check below can re-run the real scan with an EMPTY exemption
 * list and confirm the one currently-exempted site reappears as an
 * offender — proving the exemption is load-bearing, not decorative.
 */
function findOffenders(exempt: readonly ExemptSite[] = EXEMPT_SITES): Offender[] {
  return listSpecFiles()
    .flatMap((file) => scanFileSource(file, readSpec(file), exempt))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

describe('#976 structural guard: sanity on synthetic fixtures (proves detection itself, not just the real tree)', () => {
  it('flags a bare startPreview() with no assertCleanServiceWorkerState call in the same test body', () => {
    const fixture = [
      "import { test } from '@playwright/test';",
      "import { startPreview } from './helpers';",
      '',
      "test('synthetic offender', async ({ page }) => {",
      '  const server = await startPreview();',
      '  try {',
      '    await page.goto(server.url);',
      '  } finally {',
      '    server.kill();',
      '  }',
      '});',
      '',
    ].join('\n');
    const offenders = scanFileSource('synthetic.spec.ts', fixture, []);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatchObject({ file: 'synthetic.spec.ts', title: 'synthetic offender' });
  });

  it('does NOT flag startPreview(page) — the internally-guarded form', () => {
    const fixture = [
      "test('uses page arg', async ({ page }) => {",
      '  const server = await startPreview(page);',
      '  try {',
      '    await page.goto(server.url);',
      '  } finally {',
      '    server.kill();',
      '  }',
      '});',
      '',
    ].join('\n');
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toEqual([]);
  });

  it('does NOT flag a bare startPreview() that also calls assertCleanServiceWorkerState in the same body', () => {
    const fixture = [
      "test('compliant', async ({ browser }) => {",
      '  const server = await startPreview();',
      '  const context = await browser.newContext();',
      '  const page = await context.newPage();',
      '  await assertCleanServiceWorkerState(page);',
      '});',
      '',
    ].join('\n');
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toEqual([]);
  });

  it('does NOT flag a bare startPreview()/assertCleanServiceWorkerState( mention sitting only in a COMMENT', () => {
    const fixture = [
      '// mentions startPreview() and assertCleanServiceWorkerState( in prose only, never as real calls',
      "test('comment mention only', async ({ page }) => {",
      "  await page.goto('about:blank');",
      '});',
      '',
    ].join('\n');
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toEqual([]);
  });

  it('ignores a RegExp#test(...) call and never mistakes it for a test() declaration', () => {
    const fixture = [
      "test('has a regex .test( call inside', async ({ page }) => {",
      '  const server = await startPreview();',
      '  const ok = /foo/.test(page.url());',
      '  await assertCleanServiceWorkerState(page);',
      '  void ok;',
      '});',
      '',
    ].join('\n');
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toEqual([]);
  });

  // Regression pins for the regex-literal handling in `stripCommentsAndStrings`
  // (see its header comment): each fixture mirrors a REAL, currently shipped
  // e2e spec that a string-only stripper throws "unbalanced braces" on.
  it('does not choke on a regex literal containing an apostrophe (real shape: startPreviewIdentity.spec.ts)', () => {
    const fixture = [
      "test('regex with apostrophe', async ({ page }) => {",
      '  const server = await startPreview();',
      "  const rejects = /service worker doesn't byte-match/;",
      '  void rejects;',
      '  await page.goto(server.url);',
      '});',
      '',
    ].join('\n');
    // Missing assertCleanServiceWorkerState — must still be DETECTED as an
    // offender, not merely fail to throw. A stripper bug that swallowed the
    // rest of the file as "string content" would silently drop the
    // `startPreview()`/assert MATCH entirely and report a false clean scan.
    const offenders = scanFileSource('synthetic.spec.ts', fixture, []);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatchObject({ title: 'regex with apostrophe' });
  });

  it('does not choke on a regex literal containing a quote inside a character class (real shape: offline.spec.ts)', () => {
    const fixture = [
      "test('regex with quoted char class', async ({ page }) => {",
      '  const server = await startPreview();',
      '  const markers = /importScripts\\(|new URL\\(|import\\s*[*{"\']/g;',
      '  void markers;',
      '  await assertCleanServiceWorkerState(page);',
      '  await page.goto(server.url);',
      '});',
      '',
    ].join('\n');
    // Compliant this time — proves the regex-aware stripper does not
    // spuriously THROW on this shape (the real-world bug: everything after
    // the quote inside `[*{"']` used to be swallowed as an unterminated
    // string, corrupting the brace count for the rest of the file).
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toEqual([]);
  });

  it('respects an EXEMPT_SITES entry passed explicitly', () => {
    const fixture = [
      "test('exempt by title', async () => {",
      '  const server = await startPreview();',
      '  void server;',
      '});',
      '',
    ].join('\n');
    const exempt: ExemptSite[] = [
      { file: 'synthetic.spec.ts', title: 'exempt by title', reason: 'test fixture' },
    ];
    expect(scanFileSource('synthetic.spec.ts', fixture, exempt)).toEqual([]);
    // The SAME fixture, scanned with NO exemption, must report the offender —
    // proving the exemption above is what suppressed it, not the scan itself
    // being unable to see this shape.
    expect(scanFileSource('synthetic.spec.ts', fixture, [])).toHaveLength(1);
  });
});

describe('#976 structural guard: real e2e suite', () => {
  it('the file scan is not vacuous (finds at least the known e2e spec files)', () => {
    const files = listSpecFiles();
    // 15 *.spec.ts files exist under app/e2e today; 10 is a conservative
    // floor that still fails loudly if the directory read or the
    // `.spec.ts` filter silently starts finding nothing.
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('layout.spec.ts');
    expect(files).toContain('startPreviewIdentity.spec.ts');
    expect(files).toContain('datalayers.spec.ts');
    expect(files).toContain('basemap-fallback.spec.ts');
  });

  it('the exemption table is pinned (guard against a silent regrowth of exemptions)', () => {
    expect(EXEMPT_SITES).toEqual([
      {
        file: 'startPreviewIdentity.spec.ts',
        title: '#803: still starts normally against its own build with no foreign server',
        reason:
          'test takes no page/browser/context fixture and never creates one; checks server.url via a plain fetch() only',
      },
    ]);
  });

  it('every REAL bare startPreview() call site in app/e2e either calls assertCleanServiceWorkerState in the same test body, or is explicitly exempted', () => {
    const offenders = findOffenders();
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.file}:${o.line} "${o.title}"`).join('\n  ');
      throw new Error(
        '#976: bare startPreview() call site(s) with no assertCleanServiceWorkerState() call in ' +
          `the same test body, and not in EXEMPT_SITES:\n  ${detail}\n\n` +
          "Why this matters: startPreview() with no 'page' argument does NOT run the internal " +
          "SW/cache guard (see helpers.ts's own doc comment above startPreview) — a test that " +
          'creates its own page after calling it must invoke assertCleanServiceWorkerState(page) ' +
          'itself once that page exists (#928/#832/#803/#975), or the silent-false-GREEN hazard ' +
          'those issues exist to close is back. Either add the missing call, or — only if this ' +
          'site genuinely never creates a page — add an explained entry to EXEMPT_SITES in this file.',
      );
    }
  });

  // #411 twin-vacuity check: with the exemption list stubbed to [], the one
  // currently-exempted site (which never creates a page and genuinely needs
  // no guard call) must reappear as a reported offender. If it does not,
  // EXEMPT_SITES is decorative — the real scan would report the same
  // (empty) result whether or not it exists at all.
  it('with EXEMPT_SITES stubbed to [], the currently-exempted site reappears as an offender', () => {
    const offenders = findOffenders([]);
    expect(offenders).toContainEqual(
      expect.objectContaining({
        file: 'startPreviewIdentity.spec.ts',
        title: '#803: still starts normally against its own build with no foreign server',
      }),
    );
  });
});
