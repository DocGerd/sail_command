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
  // PR #351 review N8 — the THIRD fail-open in this ~20-line function, a
  // different route to the same CLASS as N5's first-match-wins: an
  // UNPARSEABLE governing key was silently DROPPED whenever any OTHER key
  // in the file parsed. The previous version matched the KEY and the VALUE
  // in one regex (`timeout-minutes:\s*(\d+)\s*$`) — a value that regex
  // couldn't read (an ordinary YAML trailing comment, `120 # bumped`)
  // simply failed to match at all, so `matchAll` silently returned one
  // fewer element with no signal that a governing line went unread. The
  // "could not find any" branch only fired when EVERY key failed to
  // parse — not when ANY key did — so a decoy key that parsed (even a
  // large, safe one) hid a small, colliding one that didn't. Constructed
  // and confirmed by review N8: a job-level `timeout-minutes: 600`
  // (parses) above a step-level `timeout-minutes: 120 # bumped` (silently
  // dropped — a shape the quoted-string case below never exercised)
  // validated GREEN against 600 while 120 was the real, uncaught cap.
  //
  // Fix: separate MATCHING the key from VALIDATING the value, so a value
  // this can't read THROWS instead of vanishing — no line that matches the
  // key can be silently skipped just because a sibling line parsed. A YAML
  // trailing comment (`240 # bumped`) is stripped before validation, since
  // that value genuinely IS 240; anything left over that isn't a bare
  // integer (a quoted string, an anchor/alias, an expression) throws
  // loudly, naming the unparseable text.
  //
  // Self-reflection on why this is the THIRD instance, not just a third
  // fix: the first two fail-opens were both about WHICH match wins
  // (a comment-narrated value; first-match vs. tightest-match) — this one
  // is about a match that never happened at all being invisible to the
  // "did I find anything?" check. "Did the regex I expect match?" is not
  // the same question as "did every governing line get READ?" — ask the
  // second explicitly before trusting this function again; that is the
  // question a fourth instance would exploit.
  const keyLines = [...source.matchAll(/^[ \t]*timeout-minutes:[ \t]*(.*)$/gm)];
  if (keyLines.length === 0) {
    throw new Error(
      `Could not find any 'timeout-minutes:' YAML key (line-anchored, not merely mentioned in a ` +
        `comment) in ${workflowPath} — has the workflow's shape changed? This guard cannot ` +
        `verify the job-cap coupling without at least one key, and must not silently assume a value.`,
    );
  }
  const values = keyLines.map((m) => {
    const raw = m[1]!.replace(/\s*#.*$/, '').trim(); // strip a YAML trailing comment
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `Unparseable 'timeout-minutes' value ${JSON.stringify(raw)} in ${workflowPath} — this ` +
          `guard must not silently SKIP a key it cannot read, because that key may be the one ` +
          `governing the step. Use a bare unquoted integer (a trailing '# comment' is fine).`,
      );
    }
    return Number(raw);
  });
  return Math.min(...values);
}

// KNOWN RESIDUAL (constructed and confirmed during the N8 fix-wave, PR #351):
// this scans the ENTIRE workflow file for `timeout-minutes:` keys, with no
// notion of which JOB or STEP a key belongs to. Adding a second job to
// `coverage.yml` with its own smaller `timeout-minutes` (for an unrelated
// purpose) would make `Math.min` pick up that irrelevant value and FAIL this
// guard against a `coverage` job cap that is actually perfectly safe — the
// opposite failure direction from N5/N8 (a false failure on a safe config,
// rather than a false pass on an unsafe one), but still wrong, and this
// guard runs inside the REQUIRED `app` check (`npm run test`), so a false
// failure here would block an unrelated, legitimate PR. LATENT, not live:
// `coverage.yml` has exactly one job today (checked). Not fixed here — see
// this file's own PR #351 review thread (N8) for the reasoning that a job/
// step-scoped read needs a real YAML parse to do correctly, which is a
// larger change than this fix-wave's scope.
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
