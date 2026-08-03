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
  // since `RegExp#exec` without a global flag returns the first hit in
  // document order and the comment sits above the real YAML key. Caught by
  // this guard's own mutation check finding 20 (the narrated historical
  // value) instead of 240 (the real key) on first implementation.
  const match = /^[ \t]*timeout-minutes:\s*(\d+)\s*$/m.exec(source);
  if (!match) {
    throw new Error(
      `Could not find a 'timeout-minutes: N' YAML key (line-anchored, not merely mentioned in a ` +
        `comment) in ${workflowPath} — has the workflow's shape changed? This guard cannot ` +
        `verify the job-cap coupling without it.`,
    );
  }
  return Number(match[1]);
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
    const jobCapMs = coverageJobTimeoutMinutes() * 60_000;

    if (worstCaseMs >= jobCapMs) {
      throw new Error(
        `The heaviest per-test budget under coverage (${largestBaseMs}ms base x ` +
          `${COVERAGE_MULTIPLIER_WHEN_ENABLED}x = ${worstCaseMs}ms) is not strictly less than ` +
          `coverage.yml's job-level timeout-minutes (${jobCapMs}ms). A per-test timer can never ` +
          `fire before a job cap it is equal to or larger than, which collapses the two failure ` +
          `surfaces #342 exists to keep separate (see timeouts.ts's COVERAGE_MULTIPLIER_WHEN_ENABLED ` +
          `comment and coverage.yml's timeout-minutes comment). Raise coverage.yml's ` +
          `timeout-minutes rather than shrinking the multiplier — over-provisioning a nightly is free.`,
      );
    }
  });
});
