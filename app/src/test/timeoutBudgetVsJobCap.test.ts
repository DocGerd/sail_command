import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVERAGE_MULTIPLIER_WHEN_ENABLED } from './timeouts';

// #342 fix-wave (PR #351 review N1): a structural guard for the COUPLING
// between `timeouts.ts`'s coverage multiplier and
// `.github/workflows/coverage.yml`'s job-level `timeout-minutes` — the
// coupling whose absence let the multiplier's 4->8 bump silently make the
// heaviest per-test budget exactly equal to (and therefore provably unable
// to ever fire before) the job cap. A per-test timer starts only once its
// OWN test starts, strictly after that step's node boot/transform/
// collection already consumed time, so a budget merely EQUAL to the cap is
// still a collision, not a coincidence that happens to work. See both
// files' own derivation comments for the full numeric argument; this test
// only pins the INEQUALITY so a future change to either number fails loudly
// instead of quietly re-creating the collision.
//
// Needs node:fs to read the workflow file from outside app/src — kept out
// of tsconfig.app.json and added to tsconfig.test.json's node-types
// allowlist, same pattern as gpx.parse.test.ts / realmask.repro.test.ts /
// seamarkPopover.coverage.test.ts.
const workflowPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows/coverage.yml',
);

// Scans every .ts/.tsx file under app/src (not just *.test.*, so this
// file's own timeouts.ts, where `SOLVER_TEST_TIMEOUT_MS` is defined, is
// included) for a `solverTimeoutMs(<literal>)` call and takes the LARGEST
// literal found — that is the heaviest per-test budget the suite could ever
// produce under coverage, regardless of which file introduces it next.
// Comments are deliberately NOT stripped: a comment mentioning a larger
// example number could only inflate the detected maximum, which makes this
// guard MORE conservative, never blind to a real violation — the opposite
// failure direction from timeoutGuard.test.ts, where an unstripped comment
// would risk a FALSE positive on prose describing the pattern itself.
const sourceFiles = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function largestSolverTimeoutBaseMs(): number {
  const pattern = /solverTimeoutMs\(\s*([\d_]+)\s*\)/g;
  let max = 0;
  for (const source of Object.values(sourceFiles)) {
    for (const m of source.matchAll(pattern)) {
      const n = Number(m[1]!.replaceAll('_', ''));
      if (n > max) max = n;
    }
  }
  return max;
}

function coverageJobTimeoutMinutes(): number {
  const source = readFileSync(workflowPath, 'utf8');
  // Anchored to the actual start of a line (ignoring leading whitespace) so
  // this does NOT match a comment merely MENTIONING "timeout-minutes: N" in
  // prose — this file's own header comment narrates the historical
  // `timeout-minutes: 20` job cap from an earlier failed run, which a bare
  // `/timeout-minutes:\s*(\d+)/` (no anchor) matches FIRST and wrongly,
  // since a non-global `RegExp#exec` returns the first hit in document
  // order and the comment sits above the real YAML key. Caught by this
  // guard's own mutation check finding 20 (the narrated historical value)
  // instead of 240 (the real key) on first implementation.
  //
  // PR #351 review N5 — the anchor closed that ONE instance but not the
  // CLASS: GitHub Actions allows `timeout-minutes` at BOTH job level and
  // step level, and applies the TIGHTEST one that governs a given step.
  // Reading only the first line-anchored match (`.exec` without `/g`) is
  // therefore unsound in general — a job-level key ABOVE the step-level one
  // (an ordinary, arguably more idiomatic Actions edit, and conventionally
  // the LARGER of the two) would be read as "the" cap while a smaller
  // step-level key silently governs the real collision. Constructed and
  // confirmed by review N5: a job-level `timeout-minutes: 600` above a
  // step-level `timeout-minutes: 120` (the colliding value) validated
  // GREEN against 600 while 120 was the real, uncaught cap.
  //
  // Fix: take the MINIMUM of every line-anchored match, since the
  // EFFECTIVE cap on any given step is always the tightest key that
  // applies to it — never assume there is exactly one key, and never
  // assume position (first, last, job-level, step-level) tells you which
  // one binds. The length check runs BEFORE `Math.min` deliberately:
  // `Math.min()` on an empty array is `Infinity`, which would silently
  // recreate the exact fail-open this exists to close (an inequality
  // checked against Infinity always holds).
  //
  // Self-reflection this guard's SECOND fail-open earns (the first was the
  // comment-narrated historical value): the next way this could still read
  // the wrong number is a value this regex's `\d+` cannot parse at all —
  // e.g. a quoted `timeout-minutes: "240"` (YAML permits numbers as
  // strings) — which is why the empty-match branch below throws LOUDLY
  // rather than falling back to a default; a guard that goes silent on an
  // unparseable format is the same fail-open shape one level earlier.
  const matches = [...source.matchAll(/^[ \t]*timeout-minutes:\s*(\d+)\s*$/gm)];
  if (matches.length === 0) {
    throw new Error(
      `Could not find any 'timeout-minutes: N' YAML key (line-anchored, unquoted integer, not ` +
        `merely mentioned in a comment) in ${workflowPath} — has the workflow's shape changed, ` +
        `or is the value quoted/non-integer? This guard cannot verify the job-cap coupling ` +
        `without at least one parseable key, and must not silently assume a value.`,
    );
  }
  return Math.min(...matches.map((m) => Number(m[1]!)));
}

describe('#342/N1 structural guard: coverage.yml job cap vs. timeouts.ts multiplier', () => {
  it('the largest per-test budget under coverage stays strictly below the job cap', () => {
    const largestBaseMs = largestSolverTimeoutBaseMs();
    // Guard against a vacuous pass: if the scan found nothing, the PATTERN
    // itself broke (e.g. solverTimeoutMs got renamed) rather than the suite
    // having zero solver-heavy tests — timeouts.ts's own
    // `solverTimeoutMs(120_000)` call site is always present.
    expect(largestBaseMs).toBeGreaterThan(0);

    const worstCaseMs = largestBaseMs * COVERAGE_MULTIPLIER_WHEN_ENABLED;
    const jobCapMinutes = coverageJobTimeoutMinutes();
    const jobCapMs = jobCapMinutes * 60_000;

    if (worstCaseMs >= jobCapMs) {
      // PR #351 review N7: name the value in the form the reader actually
      // edits (`timeout-minutes: N`, a whole number of minutes), not just
      // the millisecond figure the comparison runs on — closes the mental
      // "divide by 60,000" step between this message and the one-line fix.
      throw new Error(
        `The heaviest per-test budget under coverage (${largestBaseMs}ms base x ` +
          `${COVERAGE_MULTIPLIER_WHEN_ENABLED}x = ${worstCaseMs}ms = ${worstCaseMs / 60_000} min) ` +
          `is not strictly less than coverage.yml's job-level timeout-minutes ` +
          `(${jobCapMinutes} min = ${jobCapMs}ms). A per-test timer can never fire before a job ` +
          `cap it is equal to or larger than, which collapses the two failure surfaces #342 ` +
          `exists to keep separate (see timeouts.ts's COVERAGE_MULTIPLIER_WHEN_ENABLED comment ` +
          `and coverage.yml's timeout-minutes comment). Raise coverage.yml's timeout-minutes ` +
          `rather than shrinking the multiplier — over-provisioning a nightly is free.`,
      );
    }
  });
});
