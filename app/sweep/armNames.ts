/**
 * Canonical #282/#452 sweep arm-name list — kept in a standalone file with NO
 * other imports so it can be loaded two different ways without the two ever
 * drifting apart:
 *
 *   - `sweepArms.ts` imports it under vitest/vite and types `ARMS` as
 *     `Record<(typeof ARM_NAMES)[number], Arm>`. TypeScript's excess- and
 *     missing-property checks on that object LITERAL then make it a COMPILE
 *     ERROR for `ARMS`'s keys to ever diverge from this list — add a key to
 *     one without the other and `npm --prefix app run typecheck` fails.
 *   - `compare.mjs` `import()`s this file directly under PLAIN Node (no vite,
 *     no vitest, no `--prefix app run`) — Node 24's native TypeScript
 *     type-stripping handles a file this simple (no other imports, no
 *     non-erasable syntax: `erasableSyntaxOnly` is already ON repo-wide, see
 *     the root CLAUDE.md) with zero tooling. MEASURED: a file with any import
 *     of its own (e.g. `sweepArms.ts` itself, which pulls in
 *     `../src/lib/mask` and onward) fails under plain `node` with
 *     `Cannot find module '.../src/lib/mask'` — Node's loader does not do
 *     Vite's bundler-style extensionless resolution. This file must stay
 *     import-free for `compare.mjs` to keep working without a build step.
 *
 * This is what makes `compare.mjs`'s arm-count expectation DERIVED from the
 * arm definitions rather than a second hardcoded number that could drift
 * from the first (#452 — `compare.mjs` used to fail closed on ZERO arms but
 * not on FEWER than expected, so a partial run could produce a confident
 * looking verdict over an incomplete arm set).
 */
export const ARM_NAMES = [
  'breeze',
  'no-comfort',
  'short-horizon',
  'light-motorless',
  'becalmed',
  'deep-becalmed',
  'margin-zero',
  'relaxation-dense',
  'tier4-forcing',
] as const;
