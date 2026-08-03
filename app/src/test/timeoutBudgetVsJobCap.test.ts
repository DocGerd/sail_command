import { describe, expect, it } from 'vitest';
import { COVERAGE_MULTIPLIER_WHEN_ENABLED } from './timeouts';

// #342 fix-wave (PR #351): a structural guard for the COUPLING between
// `timeouts.ts`'s coverage multiplier and `.github/workflows/coverage.yml`'s
// job-level `timeout-minutes` — the coupling whose absence let the
// multiplier's 4->8 bump silently make the heaviest per-test budget exactly
// equal to (and therefore provably unable to ever fire before) the job cap.
// A per-test timer starts only once its OWN test starts, strictly after
// that step's node boot/transform/collection already consumed time, so a
// budget merely EQUAL to the cap is still a collision, not a coincidence
// that happens to work.
//
// ORCHESTRATOR DECISION (PR #351, after review rounds 2-4): this guard used
// to READ `coverage.yml` at test time (`readFileSync` + regex) and compare
// against the file's ACTUAL `timeout-minutes` value — a VERIFIED coupling.
// That shape produced FOUR distinct fail-opens across two review rounds: a
// value narrated in a comment misread as the real key; first-match-wins
// across job-level and step-level keys; an unparseable value (a YAML
// trailing comment) silently DROPPED whenever any other key parsed; and a
// job/step-SCOPING gap where an unrelated job's smaller cap could produce a
// FALSE failure against a perfectly safe `coverage` job. Regex-scraping a
// structured, comment-and-quote-bearing format kept finding new ways to be
// misread — four fixes closed four INSTANCES, none closed the CLASS. And
// unlike the collision it exists to prevent (which review CAUGHT, before
// this guard existed), this guard itself had by then caught zero real
// defects while running inside `npm run test` — the REQUIRED `app` CI
// check, so each of those four fail-opens carried a blast radius of every
// PR in the repo, not just this one. The orchestrator judged that trade not
// worth continuing to patch.
//
// CURRENT SHAPE: the file read is GONE. `JOB_CAP_MINUTES` below is a plain
// TypeScript constant, DECLARED, not READ from `coverage.yml` — it cannot
// misparse a comment, cannot pick the wrong key by position, and cannot
// misjudge which job/step governs, because there is no text left to
// misread. Stated honestly, not papered over: this demotes VERIFIED
// coupling (this guard used to be ABLE to catch coverage.yml and
// timeouts.ts drifting apart) to DOCUMENTED coupling (the two files must be
// kept in sync by a human reading both comments — a change to ONE without
// the other is now a SILENT drift, not a loud one). `coverage.yml`'s
// `timeout-minutes: 240` line carries the TWIN half of this comment, naming
// this constant and this file (this repo's twin-search rule, CLAUDE.md, for
// a fact stated in two artifacts) — if you change one, change the other.
// #359 tracks the option that would restore VERIFIED coupling (a real YAML
// parse, which structurally closes the job/step scoping gap too) as a
// deliberate follow-up, not an oversight — including the honest
// counter-argument that this guard has, to date, caught zero real defects.
const JOB_CAP_MINUTES = 240;

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

describe('#342/N1 structural guard: coverage.yml job cap vs. timeouts.ts multiplier', () => {
  it('the largest per-test budget under coverage stays strictly below the declared job cap', () => {
    const largestBaseMs = largestSolverTimeoutBaseMs();
    // Guard against a vacuous pass: if the scan found nothing, the PATTERN
    // itself broke (e.g. solverTimeoutMs got renamed) rather than the suite
    // having zero solver-heavy tests — timeouts.ts's own
    // `solverTimeoutMs(120_000)` call site is always present.
    expect(largestBaseMs).toBeGreaterThan(0);

    const worstCaseMs = largestBaseMs * COVERAGE_MULTIPLIER_WHEN_ENABLED;
    const jobCapMs = JOB_CAP_MINUTES * 60_000;

    if (worstCaseMs >= jobCapMs) {
      throw new Error(
        `The heaviest per-test budget under coverage (${largestBaseMs}ms base x ` +
          `${COVERAGE_MULTIPLIER_WHEN_ENABLED}x = ${worstCaseMs}ms = ${worstCaseMs / 60_000} min) ` +
          `is not strictly less than the DECLARED job cap JOB_CAP_MINUTES ` +
          `(${JOB_CAP_MINUTES} min = ${jobCapMs}ms). A per-test timer can never fire before a job ` +
          `cap it is equal to or larger than, which collapses the two failure surfaces #342 ` +
          `exists to keep separate. Raise BOTH this constant AND coverage.yml's real ` +
          `timeout-minutes together (they are documented, not verified, coupling — see the ` +
          `header comment above) rather than shrinking the multiplier — over-provisioning a ` +
          `nightly is free.`,
      );
    }
  });
});
