import { describe, expect, it } from 'vitest';
// `?raw` rather than `node:fs`: planRoute.ts is INSIDE the Vite root, so this
// needs no `server.fs.allow` widening (#131) and — unlike the node-builtin
// guards — no tsconfig.app.json/tsconfig.test.json split either.
import planRouteSource from './planRoute.ts?raw';
import {
  comfortRetryMayHelp,
  depthRelaxationMayHelp,
  NO_ROUTE_LABEL_OF_CAUSE,
  type SolveFailureCause,
} from './planRoute';

// #282: the no-route `reason` string used to be a CONTROL INPUT — the #243
// tier-2 retry gate and the #53 relaxation gate both branched on which LABEL
// had been selected for the user, so a classification change that was meant to
// be presentational moved real routes. `planRoute.ts` now keeps two separate
// vocabularies: an internal `SolveFailureCause` that the gates read, and the
// user-facing `NoRouteReason` label derived from it. These tests pin that
// separation from both sides — by VALUE (the predicates' truth table, written
// from the documented intent of each gate, not read off the implementation)
// and STRUCTURALLY (no gate may mention a solver-derived label at all).

// Hand-written from the gates' documented intent, NOT copied from the
// implementation's output (#50: an expectation derived from the function under
// test always passes).
//
// comfortRetry — "could the #243 depth-comfort preference plausibly have caused
// this failure, so that re-solving with it off might succeed?" The preference
// inflates the ranking clock, so it can exhaust the search ('mask-blocked') or
// trip the forecast-horizon guard ('horizon-exceeded'). It cannot make the air
// calmer or the engine available, so 'calm-without-motor' is beyond its reach —
// mirroring #53's own rule that only mask-unreachability degrades further.
//
// depthRelaxation — "might a SHALLOWER safety gate connect a mask that the
// requested gate does not?" Only a mask-level block can be answered by moving
// the depth gate; a calm forecast or an exhausted horizon is unchanged by it.
const EXPECTED: Record<SolveFailureCause, { comfortRetry: boolean; depthRelaxation: boolean }> = {
  'mask-blocked': { comfortRetry: true, depthRelaxation: true },
  'horizon-exceeded': { comfortRetry: true, depthRelaxation: false },
  'calm-without-motor': { comfortRetry: false, depthRelaxation: false },
};

// The user-facing label each cause carries today. Pinned so that a change to
// the LABEL is a visible, deliberate edit to this table rather than a silent
// side effect — and so that the structural guard below has a twin that would
// notice if the mapping table were emptied instead of edited.
const EXPECTED_LABELS: Record<SolveFailureCause, string> = {
  'mask-blocked': 'unreachable',
  'horizon-exceeded': 'beyond-horizon',
  'calm-without-motor': 'calm-motor-off',
};

describe('#282: retry gates read an internal cause, never the user-facing reason', () => {
  for (const cause of Object.keys(EXPECTED) as SolveFailureCause[]) {
    it(`comfortRetryMayHelp('${cause}') === ${EXPECTED[cause].comfortRetry}`, () => {
      expect(comfortRetryMayHelp(cause)).toBe(EXPECTED[cause].comfortRetry);
    });
    it(`depthRelaxationMayHelp('${cause}') === ${EXPECTED[cause].depthRelaxation}`, () => {
      expect(depthRelaxationMayHelp(cause)).toBe(EXPECTED[cause].depthRelaxation);
    });
  }

  it('every cause carries exactly the label pinned above', () => {
    expect(NO_ROUTE_LABEL_OF_CAUSE).toEqual(EXPECTED_LABELS);
  });

  it('the label map is total over the cause union (no cause can be added unlabelled)', () => {
    expect(Object.keys(NO_ROUTE_LABEL_OF_CAUSE).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

// ---------------------------------------------------------------------------
// Structural guard: the recoupling this issue exists to prevent
// ---------------------------------------------------------------------------

/**
 * The three solver-derived NoRouteReason values. `snap-failed-*` are
 * deliberately excluded: they are returned before any solve runs and never
 * reach either gate, so `planRoute` may name them freely.
 */
const SOLVER_LABELS = ['unreachable', 'beyond-horizon', 'calm-motor-off'] as const;

/**
 * Strip line and block comments. Load-bearing, per #388: `planRoute.ts`'s own
 * prose legitimately names all three labels while explaining the gates, and a
 * guard that matched PROSE rather than code would fire on documentation and
 * never on a real recoupling. The vacuity direction is checked explicitly in
 * the mutation notes on this file's PR.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice out `const <name> = { ... } as const satisfies ...;` including braces. */
function sliceTable(src: string, name: string): { table: string; rest: string } {
  const start = src.indexOf(`const ${name}`);
  expect(start, `#282 guard: could not find the \`${name}\` table in planRoute.ts`).toBeGreaterThan(
    -1,
  );
  const open = src.indexOf('{', start);
  expect(open, `#282 guard: \`${name}\` has no object literal`).toBeGreaterThan(-1);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  expect(end, `#282 guard: \`${name}\`'s object literal is unbalanced`).toBeGreaterThan(-1);
  return { table: src.slice(start, end), rest: src.slice(0, start) + src.slice(end) };
}

describe('#282 structural guard: no gate may branch on a solver-derived label', () => {
  // Fail closed: an empty/unresolved `?raw` import would make every assertion
  // below pass vacuously.
  it('reads planRoute.ts source', () => {
    expect(planRouteSource.length, '#282 guard: planRoute.ts?raw came back empty').toBeGreaterThan(
      5000,
    );
  });

  const stripped = stripComments(planRouteSource);

  it('the two translation tables are the ONLY code mentioning a solver-derived label', () => {
    const a = sliceTable(stripped, 'CAUSE_OF_SOLVE_REASON');
    const b = sliceTable(a.rest, 'NO_ROUTE_LABEL_OF_CAUSE');
    const tables = `${a.table}\n${b.table}`;
    const rest = b.rest;

    // Fail closed: if the slicing ever over-matches and swallows the file, the
    // "no labels outside the tables" assertion below would pass vacuously.
    expect(rest, '#282 guard: excision swallowed planRoute() itself').toContain(
      'export function planRoute',
    );
    expect(
      rest.length / stripped.length,
      '#282 guard: the two tables should be a small slice of the file',
    ).toBeGreaterThan(0.8);

    // Non-vacuity in the other direction: each label must really live in a table.
    for (const label of SOLVER_LABELS) {
      expect(tables, `#282 guard: '${label}' is not in either translation table`).toContain(
        `'${label}'`,
      );
    }

    const leaked = SOLVER_LABELS.filter((label) => rest.includes(`'${label}'`));
    expect(
      leaked,
      `#282: planRoute.ts names the solver-derived no-route label(s) ${leaked
        .map((l) => `'${l}'`)
        .join(', ')} outside CAUSE_OF_SOLVE_REASON / NO_ROUTE_LABEL_OF_CAUSE. The retry and ` +
        `relaxation gates must branch on SolveFailureCause, never on the string shown to the ` +
        `user — see issue #282.`,
    ).toEqual([]);
  });
});
