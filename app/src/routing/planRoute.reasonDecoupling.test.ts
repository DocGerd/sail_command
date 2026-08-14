import { describe, expect, it } from 'vitest';
// `?raw` rather than `node:fs`: both modules are INSIDE the Vite root, so this
// needs no `server.fs.allow` widening (#131) and — unlike the node-builtin
// guards — no tsconfig.app.json/tsconfig.test.json split either.
import planRouteSource from './planRoute.ts?raw';
import isochroneSource from './isochrone.ts?raw';
import { comfortRetryMayHelp, depthRelaxationMayHelp, NO_ROUTE_LABEL_OF_CAUSE } from './planRoute';
import type { SolveFailureCause } from './isochrone';

// #282: the no-route `reason` string used to be a CONTROL INPUT — the #243
// tier-2 retry gate and the #53 relaxation gate both branched on which LABEL
// had been selected for the user, so a classification change that was meant to
// be presentational moved real routes.
//
// PR #411 split the vocabularies at the GATES. This file's second half now also
// pins the split at the SOURCE: `solve()` returns a `SolveFailureCause`
// directly, so the presentational `NoRouteReason` no longer appears in
// `isochrone.ts` at all and there is exactly ONE translation table
// (`NO_ROUTE_LABEL_OF_CAUSE`, cause -> label) in the whole routing path.
//
// These tests pin the separation from both sides — by VALUE (the predicates'
// truth table, written from the documented intent of each gate, not read off
// the implementation) and STRUCTURALLY (neither the gates nor the solver may
// mention a user-facing label at all).

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
//
// #432 budget-exhausted — "the plan's wall-clock budget ran out mid-search".
// FALSE for both gates, and this table is the ONLY thing pinning that:
// planRoute.ts deliberately does not carry a redundant
// `if (cause === 'budget-exhausted') return false;` in either predicate,
// because with the `===` lists as written such a statement could not be
// reddened by any mutation and would be an unfalsifiable guard (PR #410).
// The rows below ARE falsifiable — widening either list to admit the cause
// reds them. Hand-derived intent: both gates exist to answer "would spending
// MORE solver time a different way succeed?", and the one thing known here
// is that there is no more time to spend; every retried solve would abort at
// its own first ring, and the relaxation gate would additionally run
// findRelaxedGate's BFS probes past a deadline that has already passed.
const EXPECTED: Record<SolveFailureCause, { comfortRetry: boolean; depthRelaxation: boolean }> = {
  'mask-blocked': { comfortRetry: true, depthRelaxation: true },
  'horizon-exceeded': { comfortRetry: true, depthRelaxation: false },
  'calm-without-motor': { comfortRetry: false, depthRelaxation: false },
  'budget-exhausted': { comfortRetry: false, depthRelaxation: false },
};

// The user-facing label each cause carries today. Pinned so that a change to
// the LABEL is a visible, deliberate edit to this table rather than a silent
// side effect — and so that the structural guards below have a twin that would
// notice if the mapping table were emptied instead of edited.
const EXPECTED_LABELS: Record<SolveFailureCause, string> = {
  'mask-blocked': 'unreachable',
  'horizon-exceeded': 'beyond-horizon',
  'calm-without-motor': 'calm-motor-off',
  // #432: deliberately spelled UNLIKE its cause ('budget-exhausted') — the
  // two vocabularies must stay greppable apart, and the near-synonymous
  // spellings of the other three are part of why they were conflated in the
  // first place. This row also keeps the structural guard below honest: the
  // label appears in planRoute.ts exactly once, inside
  // NO_ROUTE_LABEL_OF_CAUSE, and the pre-relaxation budget check nearby
  // reaches it through the CAUSE key rather than by naming the string.
  'budget-exhausted': 'search-budget-exceeded',
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
// Structural guards: the recoupling this issue exists to prevent
// ---------------------------------------------------------------------------

/**
 * The solver-derived NoRouteReason values. `snap-failed-*` are deliberately
 * excluded: they are returned before any solve runs and never reach either
 * gate, so `planRoute` may name them freely.
 *
 * DERIVED from `EXPECTED_LABELS`, not written out a second time (PR #411
 * review). As a hand-copied literal this array had NO TWIN: stubbing it to
 * `[]` left the whole structural guard 12/12 GREEN, because every failing
 * assertion below iterates it — silently dropping a label disabled the check
 * while it kept reporting success. Same fail-open shape as the backtick hole
 * below, one level up, in the guard's DATA rather than its detection.
 *
 * Deliberately NOT derived from `NO_ROUTE_LABEL_OF_CAUSE`: the haystack is
 * `planRoute.ts`'s / `isochrone.ts`'s own source text, and pulling the needle
 * from that same production module would make both sides one source — the
 * worse tautology #388 records, where a suggested fix passed its own vacuity
 * probe while testing nothing. `EXPECTED_LABELS` is hand-written HERE and
 * merely PINNED against production by the `toEqual` row above, so production
 * drift reds that row rather than silently following it.
 */
const SOLVER_LABELS: readonly string[] = Object.values(EXPECTED_LABELS);

/**
 * The internal control vocabulary, from this file's own hand-written table for
 * the same reason `SOLVER_LABELS` is. Used as the POSITIVE control on the
 * isochrone scan: without it, pointing that scan at an empty or wrong file
 * would satisfy every "no label appears" assertion vacuously.
 */
const SOLVER_CAUSES: readonly string[] = Object.keys(EXPECTED);

/**
 * A label written as a TypeScript string literal, in ANY of the three quote
 * forms the language accepts. Matching only `'…'` failed OPEN (PR #411
 * review, MEASURED): a recoupling written with backticks —
 * ``NO_ROUTE_LABEL_OF_CAUSE[cause] === `unreachable` `` — left this guard
 * 10/10 green while passing both `lint` and `typecheck`, because prettier
 * normalises `"…"` to `'…'` but leaves a template literal alone. Quotes are
 * REQUIRED (no bare-identifier form): `cause === unreachable` is not valid
 * TypeScript, so the compiler already closes that shape.
 *
 * The label must be the WHOLE literal — a longer string that merely STARTS
 * with one is not a match. That is deliberate and is pinned by its own row
 * below: `isochrone.ts` legitimately throws
 * `new Error('unreachable: sail node without a board')`, an
 * internal-invariant message with nothing to do with the no-route label, and
 * a substring matcher would red on it forever.
 */
function labelLiteral(label: string): RegExp {
  return new RegExp(`['"\`]${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
}

/**
 * Strip line and block comments. Load-bearing, per #388: both modules'
 * prose legitimately names the labels while explaining the gates, and a guard
 * that matched PROSE rather than code would fire on documentation and never on
 * a real recoupling. The vacuity direction is pinned by its own row below, not
 * only by a manual mutation.
 *
 * ONE pass with alternation, deliberately — not two sequential `replace`
 * calls. Running the block-comment regex FIRST (the shape this started as,
 * PR #411 review) lets a `//` line comment containing `/*` open a spurious
 * block match that swallows everything up to the next block terminator,
 * silently deleting
 * real code from the scanned text: a fail-OPEN in the guard whose entire value
 * is that it fails closed. A single alternation is scanned left-to-right, so
 * whichever comment opener appears EARLIER in the source always wins, in both
 * directions. The `(^|[^:])` prefix keeps a `://` inside a real string literal
 * from being read as a line comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, (_match, before?: string) =>
    // Unmatched groups arrive as `undefined`, which is what discriminates the
    // block-comment alternative (no group) from the line-comment one.
    before === undefined ? ' ' : before,
  );
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

describe('#282 structural guard: the guard\u2019s own primitives', () => {
  // Fail closed: an empty/unresolved `?raw` import would make every assertion
  // in the two describes below pass vacuously.
  it('reads both modules\u2019 source', () => {
    expect(planRouteSource.length, '#282 guard: planRoute.ts?raw came back empty').toBeGreaterThan(
      5000,
    );
    expect(isochroneSource.length, '#282 guard: isochrone.ts?raw came back empty').toBeGreaterThan(
      5000,
    );
  });

  // The guard's own three primitives, pinned directly. Without these rows the
  // only evidence that the detector, its data and the comment stripper work is
  // a manual mutation nobody re-runs — and the first two of these shapes were
  // LIVE fail-open holes found in review, not hypotheticals.
  it('SOLVER_LABELS carries one label per cause — an emptied or truncated list cannot pass', () => {
    // Without this row, `SOLVER_LABELS = []` disables every label assertion
    // below while the file still reports green (MEASURED before the fix). The
    // expectation comes from the hand-written test tables, never from
    // planRoute.ts / isochrone.ts — which are the haystacks searched IN.
    expect(
      [...SOLVER_LABELS].sort(),
      '#282 guard: SOLVER_LABELS no longer covers every cause — the structural ' +
        'checks below would silently stop looking for the missing label(s)',
    ).toEqual(Object.values(EXPECTED_LABELS).sort());
    expect(SOLVER_LABELS.length, '#282 guard: one label per cause').toBe(
      Object.keys(EXPECTED).length,
    );
  });

  it('SOLVER_CAUSES carries every cause — an emptied list cannot pass', () => {
    // The isochrone positive control iterates this; emptied, that control
    // would confirm nothing while still reporting green.
    expect([...SOLVER_CAUSES].sort(), '#282 guard: SOLVER_CAUSES lost a cause').toEqual(
      Object.keys(EXPECTED).sort(),
    );
    // #432: 3 -> 4 for 'budget-exhausted'. Deliberately still a hand-written
    // LITERAL and not `Object.keys(EXPECTED).length`: SOLVER_CAUSES IS
    // `Object.keys(EXPECTED)`, so the comparison just above is a tautology and
    // this literal is the only half of the row carrying information — it is
    // what catches a cause being dropped from the type and the table TOGETHER.
    // Deriving it would make the whole row vacuous.
    expect(SOLVER_CAUSES.length, '#282 guard: the cause union should have 4 members').toBe(4);
  });

  it("the label detector recognises all three of TypeScript's quote forms", () => {
    for (const label of SOLVER_LABELS) {
      for (const q of ["'", '"', '`']) {
        expect(
          labelLiteral(label).test(`if (NO_ROUTE_LABEL_OF_CAUSE[cause] === ${q}${label}${q}) {`),
          `#282 guard: a ${q}-quoted '${label}' recoupling would not be detected`,
        ).toBe(true);
      }
    }
    // ...and does not fire on an unquoted mention: prose is stripped before
    // this ever runs, and `cause === unreachable` is not valid TypeScript.
    expect(labelLiteral('unreachable').test('the destination is unreachable')).toBe(false);
    // ...nor on a LONGER literal that merely starts with a label. This exact
    // string is live in isochrone.ts (the sail-node-without-a-board invariant
    // throw); a substring matcher would red the isochrone scan below forever,
    // so the whole-literal requirement is a deliberate, pinned property.
    expect(
      labelLiteral('unreachable').test(
        "throw new Error('unreachable: sail node without a board');",
      ),
      '#282 guard: the detector must match a WHOLE literal, not a prefix',
    ).toBe(false);
  });

  it('stripComments handles a nested opener in EITHER order without eating code', () => {
    // (i) A `//` line comment containing a block OPENER, followed later by a
    // real block TERMINATOR — the fail-open the block-first two-pass form had.
    // The trailing `/** doc */` is load-bearing: without a later `*/` the lazy
    // block regex never matches at all and the row passes under BOTH orderings,
    // i.e. it would be vacuous (measured — this row did exactly that at first).
    expect(
      stripComments(
        "// prose with a /* opener in it\nconst b = 'beyond-horizon';\n/** doc */\nconst z = 1;",
      ),
      'block-comment-first stripping swallowed real code',
    ).toContain("const b = 'beyond-horizon';");

    // (ii) The mirror: a block comment containing a line OPENER, with code on
    // the SAME line after the block closes. Line-comment-first stripping would
    // eat `// */ const c = …` through end-of-line. Same vacuity trap: the code
    // must share the line, or the row passes under both orderings.
    expect(
      stripComments("/* prose with a // opener */ const c = 'unreachable';"),
      'line-comment-first stripping swallowed real code',
    ).toContain("const c = 'unreachable';");

    // (iii) A `://` inside a real string literal is not a line comment.
    expect(stripComments("const u = 'https://example.com/x';")).toContain('example.com');
  });
});

describe('#282 structural guard: no gate may branch on a solver-derived label', () => {
  const stripped = stripComments(planRouteSource);

  it('the ONE translation table is the only code mentioning a solver-derived label', () => {
    const { table, rest } = sliceTable(stripped, 'NO_ROUTE_LABEL_OF_CAUSE');

    // Fail closed: if the slicing ever over-matches and swallows the file, the
    // "no labels outside the table" assertion below would pass vacuously.
    expect(rest, '#282 guard: excision swallowed planRoute() itself').toContain(
      'export function planRoute',
    );
    // The table is ~1.5% of the comment-stripped file (re-measured on the
    // commit that removed the second table — it was 0.970 with two), so 0.8 is
    // a loose bound on "the excision ate something it should not have", NOT a
    // budget anyone can trip by adding a cause value.
    expect(
      rest.length / stripped.length,
      '#282 guard: the table should be a small slice of the file',
    ).toBeGreaterThan(0.8);

    // Non-vacuity in the other direction: each label must really live in the table.
    for (const label of SOLVER_LABELS) {
      expect(
        labelLiteral(label).test(table),
        `#282 guard: '${label}' is not in the translation table`,
      ).toBe(true);
    }

    const leaked = SOLVER_LABELS.filter((label) => labelLiteral(label).test(rest));
    expect(
      leaked,
      `#282: planRoute.ts names the solver-derived no-route label(s) ${leaked
        .map((l) => `'${l}'`)
        .join(', ')} outside NO_ROUTE_LABEL_OF_CAUSE. The retry and relaxation gates must branch ` +
        `on SolveFailureCause, never on the string shown to the user — see issue #282.`,
    ).toEqual([]);
  });
});

describe('#282 structural guard: the solver speaks only the internal cause vocabulary', () => {
  const stripped = stripComments(isochroneSource);

  // POSITIVE CONTROL, and it must come first: every assertion in this describe
  // is an ABSENCE assertion, which carries no information until the thing
  // being searched is established to be the real solver source. Pointing these
  // rows at an empty string, the wrong module, or a source the comment
  // stripper had accidentally erased would satisfy all of them.
  it('is really scanning isochrone.ts, and the solver really emits the cause vocabulary', () => {
    expect(stripped, '#282 guard: solve() not found — wrong file or stripped to nothing').toContain(
      'export function solve',
    );
    for (const cause of SOLVER_CAUSES) {
      expect(
        labelLiteral(cause).test(stripped),
        `#282 guard: isochrone.ts does not emit the cause '${cause}' — either the ` +
          `solver stopped returning it or this scan is looking at the wrong text`,
      ).toBe(true);
    }
  });

  it('never names the presentational NoRouteReason type', () => {
    // The import that used to bring the user-facing union into the solver.
    // While it is present, a future edit can re-derive control flow from a
    // display string without any other file changing.
    expect(
      /\bNoRouteReason\b/.test(stripped),
      '#282: isochrone.ts references NoRouteReason. The solver must return a ' +
        'SolveFailureCause; the user-facing label is derived from it exactly once, by ' +
        "planRoute.ts's NO_ROUTE_LABEL_OF_CAUSE — see issue #282.",
    ).toBe(false);
  });

  it('never names a user-facing no-route label', () => {
    const leaked = SOLVER_LABELS.filter((label) => labelLiteral(label).test(stripped));
    expect(
      leaked,
      `#282: isochrone.ts names the user-facing no-route label(s) ${leaked
        .map((l) => `'${l}'`)
        .join(', ')}. solve() must classify in SolveFailureCause terms only — a label in the ` +
        `solver is how a presentational change silently became a routing change. See issue #282.`,
    ).toEqual([]);
  });
});
