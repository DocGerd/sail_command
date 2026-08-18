import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';

/**
 * #553/#549 — the #282 sweep harness must DERIVE its `sailIds` from the
 * catalogue, never hardcode them.
 *
 * WHY THIS GUARD LIVES IN `app/src/` AND NOT IN `app/sweep/`. The sweep sits
 * outside `src/` precisely so `vite.config.ts`'s
 * `include: ['src/**\/*.test.{ts,tsx}']` never drags ~20 min of solver time
 * into `npm run test` or CI. That is also why the bare `sailIds: ['genoa',
 * 'fock']` literal survived there unnoticed: the #54 structural guard
 * (`sailLiteralCallSites.test.ts`) globs `../**\/*.{ts,tsx}` relative to this
 * directory and therefore scans only `app/src/`, so it could never have
 * reported it. A guard placed inside `app/sweep/` would inherit exactly the
 * same invisibility. Reading the harness as TEXT from here is what puts it
 * back under the required `app` check, at zero solver cost.
 *
 * Same `node:fs`-reads-a-real-artifact pattern as `panelWidth.test.ts`,
 * `useBannerHeight.test.ts` and `maskTolerance.test.ts` (registered in
 * tsconfig.test.json for the node builtins, like all of those).
 */
const SWEEP_ARMS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../sweep/sweepArms.ts',
);

/**
 * Collapsed whitespace, so the assertions below survive a prettier reflow
 * (the derivation is long enough to be wrapped differently at any time).
 */
function sweepArmsSource(): string {
  const raw = readFileSync(SWEEP_ARMS_PATH, 'utf8');
  // FAIL CLOSED, before any of the real assertions run. A guard that reads an
  // empty/renamed/moved file must say so loudly rather than pass vacuously on
  // "the forbidden literal is absent" — the same shape as
  // useBannerHeight.test.ts's `not.toBeNull()` running before its value
  // comparison, and the reason that guard survives a silent regex miss.
  expect(raw.length, `#553 guard: ${SWEEP_ARMS_PATH} is empty or unreadable`).toBeGreaterThan(1000);
  expect(raw, `#553 guard: ${SWEEP_ARMS_PATH} does not look like the sweep harness`).toContain(
    'planRoute(',
  );
  return raw.replace(/\s+/g, ' ');
}

describe('#553/#549 sweep harness derives sailIds from the catalogue', () => {
  it('passes a derived `sailIds`, never an inline array literal', () => {
    const src = sweepArmsSource();

    // The defect itself. Matches ANY inline array assigned to the property —
    // an empty one, a one-element one, a differently-ordered pair — not just
    // the exact `['genoa', 'fock']` that was there, because re-hardcoding is
    // the hazard and the particular ids are incidental to it.
    expect(
      /sailIds:\s*\[/.test(src),
      '#553: app/sweep/sweepArms.ts passes an inline sailIds array literal again. ' +
        'PlanRequest.sailIds IS the solve order (spec §E.3), so a hardcoded pair ' +
        'silently pins the sweep to two ids the catalogue may rename, reorder or ' +
        'extend. Derive it from the same `boat` the harness already resolves: ' +
        '`const sailIds: readonly SailId[] = boat.sails.map((s) => s.id as SailId);`',
    ).toBe(false);

    // And the positive half — absence of the literal is not presence of the
    // derivation. Without this, deleting the `sailIds` property outright (or
    // renaming it) would leave the row above GREEN.
    expect(
      /const sailIds\s*:[^=]*=\s*boat\.sails\s*\.\s*map\s*\(/.test(src),
      '#553: the catalogue-derived `sailIds` binding is gone from sweepArms.ts',
    ).toBe(true);
    expect(
      /sailIds\s*,/.test(src),
      '#553: sweepArms.ts no longer passes `sailIds` into the PlanRequest',
    ).toBe(true);
  });

  /**
   * THE TWIN (#411's "a guard's DATA needs a twin"). The structural row above
   * proves the harness derives its list; it says nothing about what that list
   * currently IS, so on its own it cannot support the claim that swapping the
   * literal for the derivation left every recorded #282 baseline comparable.
   *
   * `EXPECTED` is HAND-WRITTEN here on purpose and NOT read from `BOATS`.
   * Deriving both sides from the catalogue would be the worse tautology — it
   * would pass for any catalogue whatsoever, including one where the sails had
   * been reordered, which is exactly the change that WOULD invalidate a
   * baseline. Perturbing production alone reds this row; perturbing this array
   * alone also reds it. That two-sided sensitivity is the point.
   */
  it('TWIN: the derived list is byte-identical to the retired literal today', () => {
    const EXPECTED = ['genoa', 'fock'];
    expect(boatById(DEFAULT_BOAT_ID).sails.map((s) => s.id)).toEqual(EXPECTED);
  });
});
