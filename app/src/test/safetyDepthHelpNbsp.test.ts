import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const DICT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../i18n');
const EN_PATH = resolve(DICT_DIR, 'dict.en.ts');
const DE_PATH = resolve(DICT_DIR, 'dict.de.ts');

// #744: `options.safetyDepth.help` interpolates {max} directly before the
// unit ("m"), and a plain space there let the unit wrap onto its own orphan
// line when the help paragraph wrapped (measured live: a lone "m" alone on
// a 12.47px-wide line at several viewports). The fix is a non-breaking
// space between {max} and "m" -- but a raw U+00A0 character pasted straight
// into source is INVISIBLE in a diff and trivially dropped or reverted
// without anyone noticing (this repo's own PR #764 lost one on a first
// attempt). So both dicts spell it as an escape sequence rather than a
// literal invisible byte. This guard pins that SOURCE FORM deliberately,
// not merely the decoded runtime value: the whole point of an escape is
// that it is reviewable, so what must never regress is the *spelling*, and
// only reading the raw file bytes (readFileSync, never a `?raw` glob --
// vitest's default `test.css: false` proxies every CSS-suffixed module to
// an empty string regardless of query string, and the same class of
// silent-empty read is exactly what a byte-level guard must not risk) can
// see that.
//
// MUTATION-CHECKED (PR #764 review, reproduced here): with no guard for
// this, reverting either dict's escape back to a plain space left every
// existing PlannerPanel test green, INCLUDING the hardcoded German literal
// at ~line 854 -- jest-dom's `toHaveTextContent` normalises the RECEIVED
// side's whitespace (`\s+`, and JS `\s` matches U+00A0) while comparing the
// EXPECTED argument verbatim, so neither existing assertion can tell a
// non-breaking space from a plain one apart. This file reads the dict
// SOURCE directly instead of rendering anything, so it is not subject to
// that normalisation and is the only thing standing between this fix and a
// silent revert.
//
// #764 review MINOR 1: \u00A0, \u00a0, \u{00A0} and \u{00a0} are all valid,
// semantically identical, non-raw-byte escape spellings that prettier does
// NOT normalise -- an exact single-literal match would red on a CORRECT
// edit using one of the other three, which is its own defect (the first
// person it inconveniences weakens the guard). NBSP_AFTER_MAX_RE accepts
// any of the four, anchored immediately after {max} and immediately before
// the trailing unit "m", and requires a literal backslash -- so it still
// cannot match a raw invisible U+00A0 byte, which is the thing that
// actually matters.
const NBSP_AFTER_MAX_RE = /\{max\}(\\u(?:00[Aa]0|\{00[Aa]0\}))m$/;
const RAW_NBSP = String.fromCharCode(0x00a0); // constructed, never pasted, to avoid
// reintroducing the exact invisible-character hazard this guard exists to catch

function readHelpValue(path: string, label: string): string {
  const source = readFileSync(path, 'utf8');
  const match = source.match(/'options\.safetyDepth\.help':\s*'([^']*)'/);
  // Fail CLOSED: assert the regex actually matched BEFORE looking at the
  // captured value. A regex that silently stops matching (the key renamed,
  // the entry reformatted, the quoting style changed) must red loudly here,
  // never pass quietly -- the same shape as the #223 CSP `String.replace`
  // incident, which shipped a build with zero CSP metas exactly this way.
  expect(
    match,
    `options.safetyDepth.help not found in ${label} (${path}) -- did the key, its quoting, or its formatting change?`,
  ).not.toBeNull();
  return match![1];
}

function assertEndsWithNbspEscape(value: string, label: string): void {
  // #764 review MINOR 2: assert on the extracted VALUE, not a boolean
  // condition computed from it -- a `.toBe(true)` assertion can only ever
  // report "Expected: true / Received: false", discarding exactly the
  // diagnostic (what the dict actually contains) a 3am CI failure needs.
  // The regex match result IS the value under test, and its own
  // not.toBeNull() failure message names the actual dict contents rather
  // than a bare boolean.
  const escapeMatch = value.match(NBSP_AFTER_MAX_RE);
  expect(
    escapeMatch,
    `${label}'s options.safetyDepth.help must end with {max} followed by a ` +
      'recognised non-breaking-space escape (\\u00A0, \\u00a0, \\u{00A0} or ' +
      `\\u{00a0}) and the unit "m" -- actual value: ${JSON.stringify(value)}`,
  ).not.toBeNull();
}

describe('#744: options.safetyDepth.help keeps its non-breaking space', () => {
  it('dict.en.ts spells it as a recognised \\u00A0-family escape, immediately before the unit', () => {
    const value = readHelpValue(EN_PATH, 'dict.en.ts');
    assertEndsWithNbspEscape(value, 'dict.en.ts');
    // Must be an escape, never a raw invisible byte -- a future hand-edit
    // pasting a real nbsp character back in must red here.
    expect(value).not.toContain(RAW_NBSP);
  });

  it('dict.de.ts spells it as a recognised \\u00A0-family escape, immediately before the unit', () => {
    const value = readHelpValue(DE_PATH, 'dict.de.ts');
    assertEndsWithNbspEscape(value, 'dict.de.ts');
    expect(value).not.toContain(RAW_NBSP);
  });
});
