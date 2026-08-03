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
// `SC_COVERAGE` is set only by the `test:coverage` npm script (see
// package.json) — the plain `npm run test` path an actual hang runs against
// keeps its tight, uninstrumented budget, so a genuine hang still surfaces
// fast; only the coverage-instrumented run gets the wider one.
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
const COVERAGE_MULTIPLIER = processEnv?.SC_COVERAGE ? 4 : 1;

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
