// #1121: shared regex-literal-aware comment/string stripper for
// source-scanning structural guards.
//
// EXTRACTED FROM `startPreviewSwAssertCallSites.test.ts` (#976/PR #1120),
// byte-for-byte identical logic — this file is the ONLY copy now; that
// guard imports it rather than defining its own. Two other guards
// (`cameraAnimationCallSites.test.ts`, `timeoutGuard.test.ts`) previously
// carried an OLDER, WEAKER character-scanning stripper with a documented
// "KNOWN RESIDUAL, latent not live" comment: no notion of a regex literal,
// so a quote character inside one (e.g. `/['"]/`) got read as an ordinary
// string opener, desyncing the string-state tracking for the rest of the
// scan. That residual is now measured LIVE for both guards' real scan
// targets (see #1121's PR body for the specific files and line numbers) —
// this helper closes it for both by construction, the same way #1120 closed
// it for its own scan target.
//
// NOT registered in `app/src/test/setup.ts` — deliberately. `EXTRA_EDGES` in
// the sweep-closure tool maps `vitest.config.ts` -> `setup.ts`, so a global
// registration there would pull this file into the `app/sweep/` transitive
// closure and flip its OWED verdict (measured 2026-09-04, per CLAUDE.md).
// Every consumer imports this module directly instead.
//
// Masks (replaces with a single space, or a newline for a literal newline
// inside a masked run, so line numbers computed on the output stay true to
// the original file) the CONTENT of every string, template literal, and
// regex literal, and removes every `//` line comment and `/* */` block
// comment outright. Newlines are preserved character-for-character on every
// path, so a line number computed on the returned string is the true line
// number in the ORIGINAL source.
//
// Regex-vs-division disambiguation (`isRegexContext`): a `/` is read as
// opening a regex literal unless the last non-whitespace character before it
// is an identifier/number/`)`/`]` NOT immediately preceded by one of a small
// set of keywords after which a regex literal is still legal
// (`return /x/`, `typeof /x/`, etc.) — i.e. the common "division vs regex"
// heuristic real JS tokenizers use, good enough for this class of guard
// (never fed genuinely adversarial input, only real repo source).
//
// `scanRegexLiteral` tracks character-class (`[...]`) depth because an
// UNESCAPED `/` inside `[...]` does not end the regex literal
// (`/[a/b]/` is one regex, not two) and returns -1 (treat the `/` as an
// ordinary character) for anything that is not a terminated SINGLE-LINE
// regex literal — a real JS regex literal can never contain a literal
// newline, so this never accidentally swallows unrelated code across lines.
export function isRegexContext(outSoFar: string): boolean {
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
 * case the caller must fall back to treating `/` as an ordinary character).
 */
export function scanRegexLiteral(source: string, start: number): number {
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

/**
 * Strips `//` and `/* *\/` comments and masks string/template-literal and
 * regex-literal CONTENT to spaces (newlines preserved). See this module's
 * header comment for why regex-literal awareness matters and what class of
 * guard this is for.
 *
 * KNOWN RESIDUALS (#1121 review round 2), named rather than fixed — none is
 * live against any current caller's scan target, checked by that caller's
 * own guard, not merely asserted here:
 *
 *   1. A template literal's `${...}` interpolation is invisible to this
 *      scanner — the backtick opens an opaque string mode that runs to the
 *      matching closing backtick, so a regex literal or a quote character
 *      INSIDE an interpolated expression gets masked as ordinary string
 *      content instead of being separately parsed. Closing this needs a
 *      real tokenizer that can re-enter code mode inside `${}`, which this
 *      character-only scanner does not attempt.
 *   2. Regex-vs-division ambiguity after a `)` or `]` not preceded by one of
 *      `isRegexContext`'s recognised keywords: the heuristic defaults to
 *      "division", matching how real JS tokenizers resolve the same
 *      ambiguity — not a gap so much as an inherent limit of a
 *      context-free character scanner, named here for completeness.
 *
 * A THIRD candidate — a regex literal containing an escaped forward slash
 * (e.g. `/\//`) — was checked, not merely assumed: `scanRegexLiteral`'s
 * `c === '\\'` branch advances two characters before the next check can see
 * the escaped `/`, so an escaped slash never prematurely ends the literal.
 * Verified by inspection against every `\\`-handling branch in this file;
 * not listed as a residual because it is not one.
 */
export function stripCommentsAndStrings(source: string): string {
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

/**
 * Non-vacuity guard for any caller that intends to treat an EMPTY or
 * near-empty stripped result as meaningful (e.g. a strip-and-hash
 * equivalence proof). Per CLAUDE.md's "strip-and-hash proof needs TWO
 * controls" rule: this repo shipped a hasher that silently emitted the empty
 * string for every input once (a swallowed dependency), producing three
 * identical sha256-of-nothing digests that read as proof. Throws rather than
 * returning a falsy/ambiguous value, so a caller cannot accidentally treat a
 * silent failure as a clean scan.
 */
export function assertNonVacuousStrip(stripped: string, needle: string, context: string): void {
  if (stripped.length === 0) {
    throw new Error(`sourceStrip: stripped output for ${context} was empty — refusing to proceed`);
  }
  if (!stripped.includes(needle)) {
    throw new Error(
      `sourceStrip: stripped output for ${context} does not contain the expected control needle ` +
        `${JSON.stringify(needle)} — the stripper may be silently swallowing real content`,
    );
  }
}
