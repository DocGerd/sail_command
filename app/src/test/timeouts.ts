// #342: single, centralized definition of the coverage-aware timeout budget
// for solver-heavy test files.
//
// Root cause this replaces: nine test files each hardcoded their own
// `vi.setConfig({ testTimeout: 120_000 })` (two of them also carrying
// per-test `timeout`/explicit-duration overrides up to 900_000ms). PR #335's
// first two fix attempts patched only the files that had most recently
// failed CI — attempt 2 multiplied the two files that had failed, attempt 3
// then failed on a THIRD file with the identical shape, at ~43 minutes of CI
// per round to learn one more instance of a pattern `git grep` enumerates in
// one second. Every solver-heavy test file now imports from HERE instead of
// hardcoding its own budget, and `timeoutGuard.test.ts` (this directory)
// fails loudly if a file reintroduces a hardcoded `testTimeout`.
//
// Why this needs to be coverage-AWARE, not just a bigger flat number: v8
// coverage instrumentation is a SEPARATE multiplier from CI's general
// slowdown, and solver-heavy tests pay a bigger coverage penalty than
// component tests (measured 2026-08-03, CLAUDE.md's coverage bullet):
// `npm run test` ran local 249.8s vs CI ~515-535s (~2.1x), while
// `npm run test:coverage` ran local ~983-1029s vs CI 2558s (~2.5x) — no
// single ratio predicts both, so a flat CI-only multiplier would either
// starve the coverage run or bloat the plain run's hang-detection budget.
// `SC_COVERAGE` is set by `vite.config.ts`'s `test.env` whenever the CLI's
// own `--coverage`/`--coverage.enabled*` flag is present (PR #351 review
// m5 — previously a POSIX `SC_COVERAGE=1 ` shell prefix on the
// `test:coverage` npm script, which silently broke on Windows cmd/
// PowerShell and only covered invocations that went through that exact
// script) — the plain `npm run test` path an actual hang runs against keeps
// its tight, uninstrumented budget, so a genuine hang still surfaces fast;
// only a run that actually requests coverage gets the wider one, regardless
// of which command requested it.
//
// A job's `timeout-minutes` and a per-test `vi.setConfig`/`it(..., {
// timeout })` budget are DIFFERENT failure surfaces — raising the former
// cannot rescue the latter (this is what made the per-file patch not
// converge in the first place; see .github/workflows/coverage.yml's header
// comment for the three-run evidence).
//
// Read via `globalThis` rather than the ambient `process` global: this
// module is imported both by test files typechecked under
// tsconfig.app.json (no "node" in `types`) and by realmask.repro.test.ts,
// which is ALSO reachable through tsconfig.test.json's node-types allowlist
// — the same source file therefore gets type-checked twice, under two
// different `types` arrays. A bare `process.env` read would need an
// `@ts-expect-error` to satisfy the first config and would trip "unused
// directive" under the second (process is validly typed there). Vitest's
// runtime always has a real Node `process` regardless of the `environment:
// 'jsdom'` test setting (jsdom only adds browser globals on top of Node), so
// reading it dynamically through `globalThis` gets the same runtime value
// with no ambient-type dependency in either program.
const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;

// DERIVATION of the multiplier (PR #351 review M3 — the prior `4` was
// asserted, not derived, and sat BELOW the only measured ratio that bears on
// it). Method, so this can be re-run when the underlying measurement moves,
// not just the number it currently produces:
//
//   1. The two figures that isolate coverage's OWN marginal cost, once
//      already inside CI's general slowdown, are CI-plain and CI-coverage
//      full-suite durations (both quoted above and in CLAUDE.md's coverage
//      bullet): ~515-535s plain vs 2558s coverage.
//   2. ratio = CI-coverage / CI-plain = 2558 / ~525 (midpoint) ~= 4.9x —
//      this is the SUITE-AVERAGE marginal coverage cost, already inside a
//      CI-sized budget (the base constants below, e.g. 120_000ms, are
//      themselves already sized for CI's general slowdown per their own
//      file-level comments — this multiplier only needs to cover
//      COVERAGE's additional cost on top of that, not CI-vs-local again).
//   3. UPDATE (PR #351 review N4, folded into this derivation rather than
//      left to go stale beside it): that 2558s figure originally came from
//      CI runs 30810112565 / 30815617721, which were KILLED by their own
//      per-test `vi.setConfig`/`timeout` budgets before the suite finished
//      — a LOWER BOUND, not a measurement of a completed run. Run
//      **30829788656 has since completed successfully in 40m56s (2456s)**
//      — a real passing CI coverage duration, and the stronger of the two
//      data points. This does NOT move the multiplier (point 5's asymmetry
//      still holds — over-provisioning is free, so 8 stays right); the
//      killed-run figure is kept above as the historical reason the floor
//      was originally uncertain, not as the current best estimate.
//   4. CLAUDE.md's coverage bullet separately documents that solver-heavy
//      tests pay a BIGGER coverage penalty than component tests — the
//      suite-AVERAGE 4.9x therefore understates the solver-specific factor
//      this multiplier actually needs to cover.
//   5. Asymmetric cost: an over-large PER-TEST budget costs nothing BY
//      ITSELF (`SC_COVERAGE` already isolates it from the plain run's tight
//      hang-detection budget) — the guard-asymmetry principle CLAUDE.md
//      applies elsewhere to blocking-vs-nudge guards, applied here to a
//      floor sized from an incomplete measurement: round UP, not to the
//      nearest whole number of the lower bound itself.
//
//   => 8 (roughly 2x the measured 4.9x lower-bound floor, absorbing both the
//      "measured on a killed run" gap in point 3 and the "solver tests pay
//      more than average" gap in point 4).
//
//   IMPORTANT COUPLING (PR #351 review N1): raising this multiplier is NOT
//   free with respect to `.github/workflows/coverage.yml`'s job-level
//   `timeout-minutes`, even though it is free with respect to CI runner
//   cost. `invariants.property.test.ts`'s `solverTimeoutMs(900_000)` is the
//   heaviest per-test ceiling in the suite; at this multiplier that is
//   exactly `900_000 * 8 = 7_200_000ms = 120.0 min`. When this constant was
//   first raised to 8, `coverage.yml`'s cap was ALSO 120 — making that
//   per-test timer provably unable to ever fire (a per-test timer starts
//   only once its OWN test starts, strictly after node boot/transform/
//   collection consume time inside the step, so a budget numerically equal
//   to the step cap is always reached by the step cap FIRST). That collapses
//   the two failure surfaces this file's own header comment says must stay
//   separate: a hang would surface as GitHub's generic job-timeout with no
//   test named, instead of vitest's per-test timeout naming the offender.
//   `coverage.yml`'s cap is 240 as of this comment specifically to leave
//   headroom above this multiplier's heaviest product — see that file's own
//   comment for the numeric derivation. THE RULE, so the next person who
//   changes either number sees the coupling: `coverage.yml`'s
//   `timeout-minutes` MUST stay strictly greater than
//   `solverTimeoutMs(900_000)` (currently the largest base in the suite)
//   PLUS the rest of the suite's wall time — raising this multiplier without
//   re-checking that file's cap re-creates exactly the N1 defect.
//   `timeoutBudgetVsJobCap.test.ts` (this directory) asserts the inequality
//   structurally so a future bump fails loudly instead of silently
//   recreating the collision.
export const COVERAGE_MULTIPLIER_WHEN_ENABLED = 8;
const COVERAGE_MULTIPLIER = processEnv?.SC_COVERAGE ? COVERAGE_MULTIPLIER_WHEN_ENABLED : 1;

/** Scales a base millisecond budget by the coverage multiplier when `SC_COVERAGE` is set. */
export function solverTimeoutMs(baseMs: number): number {
  return baseMs * COVERAGE_MULTIPLIER;
}

/**
 * The shared file-level `vi.setConfig({ testTimeout })` budget for
 * solver-heavy test files. CI runners execute the isochrone solver slower
 * than dev machines even without coverage; fast test files keep vitest's 5s
 * default so hang detection stays meaningful there — only files that
 * exercise the real solver import this.
 */
export const SOLVER_TEST_TIMEOUT_MS = solverTimeoutMs(120_000);
