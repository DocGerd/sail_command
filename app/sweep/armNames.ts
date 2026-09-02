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
 *     no vitest, no `--prefix app run`) — Node's native TypeScript
 *     type-stripping handles a file this simple (no other imports, no
 *     non-erasable syntax: `erasableSyntaxOnly` is already ON repo-wide, see
 *     the root CLAUDE.md) with zero tooling. Requires Node >= 22.18 (PR #488
 *     review measurement: an older Node throws `ERR_UNKNOWN_FILE_EXTENSION`
 *     trying to import a bare `.ts` file at all — unflagged type-stripping
 *     is not available below that floor). `ci.yml` pins `node-version: 22`,
 *     which `actions/setup-node` resolves to the latest 22.x patch at
 *     install time — comfortably past 22.18 for any CI run — but
 *     `compare.mjs` is a manual tool `ci.yml` never invokes, so this floor
 *     is a LOCAL-machine concern, not a CI gate. MEASURED: a file with any
 *     import of its own (e.g. `sweepArms.ts` itself, which pulls in
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
 *
 * #653 ADDS the two `salona44-*` arms below. Both boats share a 2.1 m draft,
 * so `boatDepth.ts`'s `defaultSafetyDepthM`/`relaxationFloorM` compute the
 * IDENTICAL gate for either — the two arms deliberately do NOT discriminate
 * a depth-gate regression on their own (see `sweepArms.ts`'s `Arm.boatId`
 * comment for the full reasoning); what they exercise is the boat-keyed
 * POLAR lookup (`polarKey(boat.id, sail.id)`) and the plan/ETA it produces —
 * a `sweepArms.ts`/`realmask.repro.test.ts` mixup that swapped the OTHER
 * 2.1 m Salona in would still compute the SAME gate but a WRONG speed (a
 * draft-different entry such as the 1.9 m `elan-444` would move the gate
 * too, and so is caught by the gate assertions instead).
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
  'margin-extreme',
  'salona44-breeze',
  'salona44-relaxation',
] as const;
