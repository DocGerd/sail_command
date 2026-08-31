import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// #730: the `changelog.d/` fragment ritual (#131, fragments landed #189)
// fails open on the FILENAME — `buildFragments` (`app/src/lib/
// changelogFragments.ts`) skips a misnamed file with a console warning,
// which is the deliberate, correct fail-open per CLAUDE.md's guard-asymmetry
// rule (a bad fragment costs a missing preview line, never a red build) —
// but has NO guard at all on the CONTENT, and the content half fails the
// OTHER way: loudly and wrongly, rather than invisibly. A fragment whose
// body opens with a markdown heading (e.g. "### Fixed") is ACCEPTED, and
// `normalizeFragmentText` joins every non-empty line with a single space, so
// it ships to the About dialog as "### Fixed - The map's scale bar…" and is
// what a release cut folds into CHANGELOG.md unless a human catches it by
// eye at the §2b hand-fold. Measured over one merge train's 6 fragments: 2
// carried a heading (both from ONE PR, the real defect this guards against),
// 3 a leading "- " (LEGITIMATE — `normalizeFragmentText` strips it — and
// must NOT be flagged here), 1 clean.
//
// Pattern follows this repo's established readFileSync-a-foreign-artifact
// guards (useBannerHeight.test.ts / maskTolerance.test.ts): read the real
// changelog.d/*.md fragments via `node:fs` (never an `import.meta.glob(...,
// {query:'?raw'})` — CLAUDE.md's app/src/test/ header documents that form as
// VACUOUS for at least one extension already, so this file matches the
// established convention rather than risk being a second instance) and fail
// loudly if any fragment body's first non-empty line is a markdown heading.
// README.md is skipped SILENTLY, matching `buildFragments`' own `continue`
// (see that function's header comment: it's the one filename expected to be
// present and ignored in this directory, not an error case).

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CHANGELOG_D_DIR = resolve(REPO_ROOT, 'changelog.d');

/** ATX-style markdown heading: 1-6 leading `#` then whitespace or end of line, e.g. "### Fixed". */
const HEADING_RE = /^#{1,6}(?:\s|$)/;

/**
 * The fragment body's first non-blank line, or null for an empty/
 * whitespace-only file. `buildFragments()` already skips an empty fragment
 * separately (its own "file is empty" warning) — out of scope here, and an
 * empty body correctly does NOT count as "opens with a heading".
 */
function firstNonEmptyLine(raw: string): string | null {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** The actual guard predicate: does this fragment body open with a markdown heading? */
function fragmentOpensWithHeading(raw: string): boolean {
  const line = firstNonEmptyLine(raw);
  return line !== null && HEADING_RE.test(line);
}

describe('#730: changelog.d fragment bodies must not open with a markdown heading', () => {
  // Non-vacuity, FAIL CLOSED per CLAUDE.md's mutation-battery rule ("give
  // any probe whose EMPTINESS you intend to interpret a POSITIVE CONTROL").
  // The real changelog.d/ directory legitimately holds ZERO pending
  // fragments most of the time (only README.md, as of this writing) — a
  // fragment-free repo state is normal, not a bug — so the real-fragment
  // scan below can pass vacuously with fragmentOpensWithHeading() itself
  // broken, deleted, or stubbed to always return false, and nobody would
  // notice from that scan alone. These fixtures exercise the predicate
  // directly, independent of what changelog.d/ currently holds, and prove
  // it can actually fire — this is the "write a fixture, confirm red"
  // mutation check the issue asks for, expressed as a permanent positive
  // control rather than a one-off manual step.
  it('flags a body whose first line is a markdown heading (positive control)', () => {
    expect(fragmentOpensWithHeading("### Fixed\nThe map's scale bar now renders correctly.")).toBe(
      true,
    );
    expect(fragmentOpensWithHeading('## Added\nSomething new.')).toBe(true);
    expect(fragmentOpensWithHeading('# Top-level heading\nBody text.')).toBe(true);
  });

  it('skips leading blank lines before checking for a heading', () => {
    expect(fragmentOpensWithHeading('\n\n### Fixed\nBody.')).toBe(true);
  });

  it('does NOT flag a leading "- " — the documented, tolerated convention', () => {
    expect(fragmentOpensWithHeading('- The map now works correctly.')).toBe(false);
  });

  it('does NOT flag ordinary prose, including a line that merely contains "#"', () => {
    expect(fragmentOpensWithHeading('The map now works correctly.')).toBe(false);
    expect(fragmentOpensWithHeading('Fixes issue #730.')).toBe(false);
  });

  it('does NOT flag an empty or whitespace-only body (buildFragments handles that separately)', () => {
    expect(fragmentOpensWithHeading('')).toBe(false);
    expect(fragmentOpensWithHeading('   \n\n  ')).toBe(false);
  });

  // The real guard: scans every fragment actually committed under
  // changelog.d/, excluding README.md (skipped SILENTLY — see this file's
  // header comment). Runs in the REQUIRED `app` job (a bare `vitest run`
  // collects it automatically), so a fragment landing with a heading blocks
  // the same way a misnamed fragment does NOT (deliberately — see the
  // guard-asymmetry note above).
  it('every real changelog.d/*.md fragment (excluding README.md) passes', () => {
    const filenames = readdirSync(CHANGELOG_D_DIR).filter(
      (f) => f !== 'README.md' && f.endsWith('.md'),
    );
    for (const filename of filenames) {
      const raw = readFileSync(resolve(CHANGELOG_D_DIR, filename), 'utf8');
      expect(
        fragmentOpensWithHeading(raw),
        `${filename}: body's first non-empty line is a markdown heading`,
      ).toBe(false);
    }
  });
});
