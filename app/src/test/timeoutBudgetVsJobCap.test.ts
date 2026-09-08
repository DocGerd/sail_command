import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { COVERAGE_MULTIPLIER_WHEN_ENABLED } from './timeouts';

// #342 fix-wave (PR #351): a structural guard for the COUPLING between
// `timeouts.ts`'s coverage multiplier and `.github/workflows/coverage.yml`'s
// two `timeout-minutes` values (job-level AND the `test:coverage` step) —
// the coupling whose absence let the multiplier's 4->8 bump silently make
// the heaviest per-test budget exactly equal to (and therefore provably
// unable to ever fire before) the job cap. A per-test timer starts only
// once its OWN test starts, strictly after that step's node boot/transform/
// collection already consumed time, so a budget merely EQUAL to the cap is
// still a collision, not a coincidence that happens to work.
//
// ORCHESTRATOR DECISION (PR #351, review rounds 2-4): this guard originally
// READ `coverage.yml` at test time via `readFileSync` + REGEX and compared
// against the file's ACTUAL `timeout-minutes` value — a VERIFIED coupling.
// That shape produced FOUR distinct fail-opens across two review rounds: a
// value narrated in a comment misread as the real key; first-match-wins
// across job-level and step-level keys; an unparseable value (a YAML
// trailing comment) silently DROPPED whenever any other key parsed; and a
// job/step-SCOPING gap where an unrelated job's smaller cap could produce a
// FALSE failure against a perfectly safe `coverage` job. A FIFTH, broader
// instance was found later (#359's issue body): the regex has no notion of
// YAML STRUCTURE at all, so a `run: |` block-scalar step whose shell-script
// BODY happens to contain text that merely LOOKS like a key (e.g. an echoed
// `timeout-minutes: 5`) matched identically to a real one. Regex-scraping a
// structured, comment/quote/block-scalar-bearing format kept finding new
// ways to be misread — fixing four instances closed zero of the CLASS. PR
// #351 round 5 therefore demoted the guard to a DECLARED TypeScript
// constant (`JOB_CAP_MINUTES = 240`), kept in sync with `coverage.yml` by a
// twin comment only — DOCUMENTED, not VERIFIED, coupling — and #359 was
// filed to track restoring a real parse, explicitly including the
// counter-argument that the guard had, to that point, caught zero real
// defects (every fail-open was the CHECKER'S OWN bug, found by review
// constructing adversarial inputs, never a real coverage.yml/timeouts.ts
// drift in the wild).
//
// #359 + #357 (this file, one PR — deliberately bundled: same guard, same
// artifact, and splitting them pays two review cycles for one change):
//
// #359 restores VERIFIED coupling with a REAL YAML PARSE using ADDRESSED
// LOOKUPS (`jobs.coverage['timeout-minutes']`, and the specific
// `npm run test:coverage` step's own `timeout-minutes`, found by an EXACT
// match on its `run:` text within that one job's step list) rather than a
// whole-file regex scan. This closes every one of the five historical
// fail-opens BY CONSTRUCTION: a real YAML tokenizer never treats a comment,
// a quote, or a scalar block's string CONTENTS as a candidate key, and
// addressing `jobs.coverage` specifically (never scanning the whole file)
// eliminates the job/step-scoping gap outright. Per #359's own "trap to
// avoid" note, the step should ideally be addressed by a stable `id:`/
// `name:` anchor rather than by matching `run:` text — but this PR's brief
// forbids editing `coverage.yml` (guarding it, not changing it), and that
// step currently carries neither. EXACT-match-with-uniqueness (below) is
// the best available substitute: it still fails closed on ambiguity (zero
// or more-than-one match), which is the property the "trap" note actually
// cares about — a decoy step elsewhere in `coverage.yml` cannot silently
// win, because it isn't in `jobs.coverage` at all, and a second identically-
// worded step in the SAME job would trip the uniqueness check rather than
// picking one silently. It is narrower protection than a stable anchor
// would give (a step renamed to keep the same `run:` text but move to a
// different semantic role would not be caught), which is why this is a
// documented residual, not a claim of full closure.
//
// #357 replaces the NECESSARY-only comparison (heaviest single test alone)
// with the SUFFICIENT one `coverage.yml`'s own derivation comment states:
// `heaviest test's ceiling + REST OF THE SUITE'S wall time (+ start-up
// margin, folded into the constant below) < binding cap`. The rest-of-
// suite figure cannot be computed from source the way the multiplier or
// the per-test ceiling can — it is an empirical CI wall-clock measurement —
// so it is a DECLARED, DATED constant (`SUITE_WALL_TIME_MS_AT_8X` below),
// exactly like `JOB_CAP_MINUTES` used to be, with a staleness check that
// fails LOUDLY once the measurement is old enough that trusting it forever
// would be irresponsible (#357's own "why this is not simply closed":
// a stale, un-monitored wall-time constant rots in the FAIL-OPEN direction,
// silently permitting a cap that is no longer sufficient).
//
// HOW #359 AND #357 RESOLVE THE TENSION #359 raises: #359's own text argues
// this guard's ROI has, to date, been negative (four regex fail-opens
// fixing the CHECKER's bugs, zero real coverage.yml/timeouts.ts drift ever
// caught) — an argument for spending LESS effort here, and #357 asks for a
// STRONGER (sufficient, not merely necessary) assertion, i.e. MORE
// assertions. These are not actually opposed once #359 is done correctly:
// every one of the five historical fail-opens was a defect of TEXT-PATTERN
// MATCHING over raw YAML, never of the comparison ARITHMETIC — so replacing
// the regex with a real parser (addressed lookups, fail-closed on any
// unresolved address) closes the failure class the ROI argument is about,
// and #357's stronger inequality is then just a second application of that
// SAME closed-off machinery, not a second surface that can regress the
// same way. The resolution implemented here: build the YAML-parse
// foundation first (never a regex), and layer the sufficient-condition
// check on top of it — accepting #359's counter-argument as a reason NOT to
// invest in a fancier YAML-address scheme (e.g. a stable-anchor lookup that
// would need editing `coverage.yml`), but not as a reason to leave #357
// half-done on the fragile constant-comparison this PR is retiring anyway.
const COVERAGE_WORKFLOW_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.github/workflows/coverage.yml',
);

const COVERAGE_JOB_ID = 'coverage';
const COVERAGE_STEP_RUN = 'npm run test:coverage';

// Loose structural types for exactly the fields this guard reads — not a
// general GitHub Actions workflow type. Fields are `unknown` until narrowed
// so a malformed/renamed workflow fails the guard's own checks rather than
// producing a wrong number silently.
type WorkflowStep = { readonly run?: unknown; readonly 'timeout-minutes'?: unknown };
type WorkflowJob = { readonly 'timeout-minutes'?: unknown; readonly steps?: unknown };
type WorkflowFile = { readonly jobs?: Record<string, unknown> };

function readCoverageWorkflow(): WorkflowFile {
  const text = readFileSync(COVERAGE_WORKFLOW_PATH, 'utf8');
  const parsed: unknown = parseYaml(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `coverage.yml did not parse to an object (got ${JSON.stringify(parsed)}). Fail closed: ` +
        `a workflow file that doesn't parse to a mapping cannot be addressed at all.`,
    );
  }
  return parsed as WorkflowFile;
}

function coverageJob(workflow: WorkflowFile): WorkflowJob {
  const job = workflow.jobs?.[COVERAGE_JOB_ID];
  if (typeof job !== 'object' || job === null) {
    throw new Error(
      `coverage.yml has no job addressable as jobs.${COVERAGE_JOB_ID} (got ` +
        `${JSON.stringify(job)}). Fail closed: the job may have been renamed — update ` +
        `COVERAGE_JOB_ID here to match, don't silently skip this half of the coupling.`,
    );
  }
  return job as WorkflowJob;
}

/** Addressed lookup of `jobs.coverage['timeout-minutes']` (the JOB-level cap). */
function jobCapMinutes(workflow: WorkflowFile): number {
  const value = coverageJob(workflow)['timeout-minutes'];
  if (typeof value !== 'number') {
    throw new Error(
      `jobs.${COVERAGE_JOB_ID}['timeout-minutes'] did not resolve to a number in coverage.yml ` +
        `(got ${JSON.stringify(value)}). Fail closed rather than silently skip the job-level cap.`,
    );
  }
  return value;
}

/**
 * Addressed lookup of the `npm run test:coverage` step's OWN `timeout-minutes`
 * (the STEP-level cap) — found by an EXACT match on that step's `run:` text
 * within `jobs.coverage.steps` specifically (never a whole-file scan), and
 * requiring EXACTLY ONE match so an ambiguous or missing step fails closed
 * rather than picking "the first match" (#359's documented instance-4 defect,
 * relocated from "which job" to "which step" is exactly what this refuses to
 * do silently).
 */
function stepCapMinutes(workflow: WorkflowFile): number {
  const job = coverageJob(workflow);
  const steps = Array.isArray(job.steps) ? (job.steps as WorkflowStep[]) : [];
  const matches = steps.filter(
    (step) => typeof step.run === 'string' && step.run.trim() === COVERAGE_STEP_RUN,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one step under jobs.${COVERAGE_JOB_ID} with run: '${COVERAGE_STEP_RUN}' ` +
        `(found ${matches.length}). Fail closed: an exact-run-text match that isn't unique is ` +
        `ambiguous, and picking "the first match" is exactly the #359 instance-4 fail-open this ` +
        `guard exists to avoid — the step may have been renamed, removed, or duplicated.`,
    );
  }
  const value = matches[0]!['timeout-minutes'];
  if (typeof value !== 'number') {
    throw new Error(
      `The '${COVERAGE_STEP_RUN}' step has no numeric timeout-minutes in coverage.yml (got ` +
        `${JSON.stringify(value)}). Fail closed rather than silently skip the step-level cap.`,
    );
  }
  return value;
}

/** The BINDING cap — whichever of the two `timeout-minutes` values is smaller. */
function bindingCapMinutes(workflow: WorkflowFile): number {
  return Math.min(jobCapMinutes(workflow), stepCapMinutes(workflow));
}

// #357: the SUFFICIENT rule `coverage.yml`'s own derivation comment states —
// `heaviest test's ceiling + rest-of-suite wall time (+ start-up margin) <
// binding cap` — needs a real measured suite wall time at the SHIPPED
// coverage multiplier. That number cannot be derived from source (it's a CI
// wall-clock fact, not a property of the code), so it is DECLARED, exactly
// like `JOB_CAP_MINUTES` used to be, and DATED so staleness is checkable.
//
// Source: CI run 30833176564, landed 2026-08-03T16:39:46Z -> 17:22:32Z =
// 42m46s = 2,566,000ms, the completed run #357's own issue body names as
// "the real number to derive from once this is picked up" — measured at the
// 8x multiplier this file's `COVERAGE_MULTIPLIER_WHEN_ENABLED` still ships
// today (re-confirmed: unchanged since that run). This INCLUDES the
// heaviest test's own actual (not ceiling) run time, which is fine — it
// makes the sum a slight over-count of "heaviest ceiling + everything
// else", i.e. MORE conservative than the true sufficient bound, never less.
const SUITE_WALL_TIME_MS_AT_SHIPPED_MULTIPLIER = 42 * 60_000 + 46_000;
const SUITE_WALL_TIME_MEASURED_AT = '2026-08-03';
// How long a wall-time measurement may go untouched before this guard
// refuses to trust it further. #357's own "why this is not simply closed"
// warns that an un-monitored constant rots in the FAIL-OPEN direction as the
// suite grows — so this is a BLOCKING failure (fail closed), not a warning,
// per this repo's guard-asymmetry rule: the guard governs a REQUIRED `app`
// CI check, and the alternative (never re-checking) is the expensive
// failure this whole issue exists to close. 200 days is deliberately loose
// (per coverage.yml's own "no PR-latency cost to over-provisioning" stance
// applied to A CHECK-INTERVAL rather than a minutes budget) — the point is
// forcing periodic re-derivation, not chasing a tight window.
const SUITE_WALL_TIME_MAX_AGE_DAYS = 200;

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

describe('#342/#359/#357 structural guard: coverage.yml job cap vs. timeouts.ts multiplier', () => {
  it('the largest per-test budget under coverage stays strictly below the binding CI cap (necessary)', () => {
    const largestBaseMs = largestSolverTimeoutBaseMs();
    // Guard against a vacuous pass: if the scan found nothing, the PATTERN
    // itself broke (e.g. solverTimeoutMs got renamed) rather than the suite
    // having zero solver-heavy tests — timeouts.ts's own
    // `solverTimeoutMs(120_000)` call site is always present.
    expect(largestBaseMs).toBeGreaterThan(0);

    const workflow = readCoverageWorkflow();
    const capMinutes = bindingCapMinutes(workflow);
    const worstCaseMs = largestBaseMs * COVERAGE_MULTIPLIER_WHEN_ENABLED;
    const capMs = capMinutes * 60_000;

    if (worstCaseMs >= capMs) {
      throw new Error(
        `The heaviest per-test budget under coverage (${largestBaseMs}ms base x ` +
          `${COVERAGE_MULTIPLIER_WHEN_ENABLED}x = ${worstCaseMs}ms = ${worstCaseMs / 60_000} min) ` +
          `is not strictly less than the BINDING cap read from coverage.yml (min of ` +
          `jobs.${COVERAGE_JOB_ID}['timeout-minutes'] and the '${COVERAGE_STEP_RUN}' step's own ` +
          `timeout-minutes = ${capMinutes} min = ${capMs}ms). A per-test timer can never fire ` +
          `before a job/step cap it is equal to or larger than, which collapses the two failure ` +
          `surfaces #342 exists to keep separate. Raise coverage.yml's timeout-minutes rather than ` +
          `shrinking the multiplier — over-provisioning a nightly is free.`,
      );
    }
  });

  it('the heaviest test PLUS the rest of the suite fits under the binding cap (sufficient, #357)', () => {
    const largestBaseMs = largestSolverTimeoutBaseMs();
    expect(largestBaseMs).toBeGreaterThan(0);

    const workflow = readCoverageWorkflow();
    const capMinutes = bindingCapMinutes(workflow);
    const worstCaseMs = largestBaseMs * COVERAGE_MULTIPLIER_WHEN_ENABLED;
    const sufficientMs = worstCaseMs + SUITE_WALL_TIME_MS_AT_SHIPPED_MULTIPLIER;
    const capMs = capMinutes * 60_000;

    if (sufficientMs >= capMs) {
      throw new Error(
        `The SUFFICIENT bound (heaviest per-test ceiling ${worstCaseMs}ms + measured rest-of-suite ` +
          `wall time ${SUITE_WALL_TIME_MS_AT_SHIPPED_MULTIPLIER}ms = ${sufficientMs}ms = ` +
          `${sufficientMs / 60_000} min) is not strictly less than the binding cap read from ` +
          `coverage.yml (${capMinutes} min = ${capMs}ms). Passing the NECESSARY check above while ` +
          `failing this one means the cap only works if the rest of the suite runs near-instantly — ` +
          `exactly the gap #357 exists to close. Raise coverage.yml's timeout-minutes.`,
      );
    }
  });

  it('the measured suite-wall-time constant (#357) has not gone stale', () => {
    const measuredAtMs = new Date(`${SUITE_WALL_TIME_MEASURED_AT}T00:00:00Z`).getTime();
    expect(Number.isNaN(measuredAtMs)).toBe(false);
    const ageDays = (Date.now() - measuredAtMs) / 86_400_000;
    if (ageDays >= SUITE_WALL_TIME_MAX_AGE_DAYS) {
      throw new Error(
        `SUITE_WALL_TIME_MS_AT_SHIPPED_MULTIPLIER was last measured on ` +
          `${SUITE_WALL_TIME_MEASURED_AT} (${ageDays.toFixed(1)} days ago), past this guard's ` +
          `${SUITE_WALL_TIME_MAX_AGE_DAYS}-day trust window. #357's own warning: an unmonitored ` +
          `wall-time constant rots FAIL-OPEN as the suite grows, silently permitting a cap that is ` +
          `no longer sufficient. Re-measure a real coverage-run wall time at the CURRENT ` +
          `COVERAGE_MULTIPLIER_WHEN_ENABLED, update the constant and SUITE_WALL_TIME_MEASURED_AT ` +
          `together, and cite the run id/timestamps the way the constant's own comment does.`,
      );
    }
  });
});
