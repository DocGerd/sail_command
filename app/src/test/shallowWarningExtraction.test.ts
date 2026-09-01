import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #463 structural guard: a DEPENDENCY-DIRECTION property, not a "does the
// file exist" property. #463 asks that `ShallowWarning` stop living inside
// `RouteSummary.tsx` so that `PlannerPanel.tsx` (which already renders it
// alongside the UNRELATED `MarginalDepthNotice`, which stays in
// RouteSummary.tsx) no longer has to import a component it needs from a
// file named after a DIFFERENT component it does not render on its own.
//
// The discriminating mutant (M1, named in the #463 brief): shrink
// `ShallowWarning.tsx` to a single re-export —
// `export { ShallowWarning } from './RouteSummary';` — and repoint
// `PlannerPanel.tsx`'s import at that file. That is the EXACT NEGATION of
// #463: `PlannerPanel.tsx` still transitively depends on `RouteSummary.tsx`,
// now through an indirection that HIDES the backwards edge. M1 still
// satisfies `noUnusedLocals`, eslint, `npm run build`, produces
// byte-identical DOM and byte-identical test pass counts, and touches
// exactly the files a real move would touch — a pass/fail count comparison
// is blind to it by construction. Only inspecting `ShallowWarning.tsx`'s OWN
// source content (never `PlannerPanel.tsx`'s import statement alone, which
// reads identically under M1 and under a real move) can catch it.
//
// `readFileSync` (not `import.meta.glob(..., { query: '?raw' })`) per this
// repo's own convention for source-scanning guards — the `?raw` glob is
// VACUOUS for `.css` under this project's vitest config, but that trap is
// CSS-specific; `readFileSync` is used here for parity with this file's
// sibling structural guards (useBannerHeight.test.ts, panelWidth.test.ts,
// chipShallowFill.test.ts, mapColors.test.ts, …), all of which read exactly
// two or three named files rather than globbing a whole tree, and matches
// this file's presence in tsconfig.test.json's node-types include list.
const COMPONENTS_DIR = join(__dirname, '../components');

function readComponent(name: string): string {
  return readFileSync(join(COMPONENTS_DIR, name), 'utf8');
}

// M1's exact shape, matched deliberately narrowly (single-quote, double-quote
// AND backtick specifiers all covered, per this repo's own "guards fail open
// on quote style" lesson) so a rename or reformat cannot silently widen or
// narrow what counts as the hazard.
const REEXPORTS_SHALLOW_WARNING_FROM_ROUTE_SUMMARY =
  /export\s*\{\s*ShallowWarning\s*\}\s*from\s*['"`]\.\/RouteSummary['"`]/;

const IMPORTS_SHALLOW_WARNING_FROM_ROUTE_SUMMARY =
  /import\s*\{[^}]*\bShallowWarning\b[^}]*\}\s*from\s*['"`]\.\/RouteSummary['"`]/;

const IMPORTS_SHALLOW_WARNING_FROM_ITS_OWN_FILE =
  /import\s*\{[^}]*\bShallowWarning\b[^}]*\}\s*from\s*['"`]\.\/ShallowWarning['"`]/;

describe('#463 structural guard: ShallowWarning.tsx is a real move, not a re-export indirection', () => {
  it('ShallowWarning.tsx declares the real component implementation', () => {
    const source = readComponent('ShallowWarning.tsx');
    expect(
      source,
      'ShallowWarning.tsx should declare `export function ShallowWarning(...)` — the actual implementation, not merely re-export it',
    ).toMatch(/export function ShallowWarning\(/);
    // Non-vacuity / positive control: M1's whole file is one short
    // re-export line. The real component (JSX, ~20 doc-comment paragraphs,
    // the Disclosure summary/body split) is roughly 12 KB. A generous, far
    // lower floor than that still separates "the real component" from "a
    // one-line re-export stub" with headroom, so this cannot pass by
    // accident on a stub, and cannot fail on a legitimate future trim of
    // the component's comments.
    expect(
      source.length,
      'ShallowWarning.tsx is far too short to be the real component — looks like a re-export stub (M1)',
    ).toBeGreaterThan(2000);
  });

  it('ShallowWarning.tsx does not re-export ShallowWarning from RouteSummary.tsx (M1)', () => {
    const source = readComponent('ShallowWarning.tsx');
    expect(
      source,
      "ShallowWarning.tsx must not be `export { ShallowWarning } from './RouteSummary'` — " +
        'that is the exact negation of #463: PlannerPanel.tsx would still transitively depend ' +
        'on RouteSummary.tsx, only now through a hidden indirection',
    ).not.toMatch(REEXPORTS_SHALLOW_WARNING_FROM_ROUTE_SUMMARY);
    expect(
      source,
      'ShallowWarning.tsx must not import anything from ./RouteSummary at all — the dependency ' +
        'direction must be one-way, RouteSummary.tsx -> ShallowWarning.tsx, never the reverse',
    ).not.toMatch(/from\s*['"`]\.\/RouteSummary['"`]/);
  });

  it('RouteSummary.tsx no longer declares ShallowWarning itself and imports it from ./ShallowWarning', () => {
    const source = readComponent('RouteSummary.tsx');
    expect(
      source,
      'RouteSummary.tsx must not still declare `export function ShallowWarning(...)` — the move ' +
        'must be real, not merely duplicated or re-exported',
    ).not.toMatch(/export function ShallowWarning\(/);
    expect(
      source,
      'RouteSummary.tsx must import the extracted ShallowWarning from ./ShallowWarning',
    ).toMatch(IMPORTS_SHALLOW_WARNING_FROM_ITS_OWN_FILE);
  });

  it('PlannerPanel.tsx imports ShallowWarning from ./ShallowWarning, never from ./RouteSummary', () => {
    const source = readComponent('PlannerPanel.tsx');
    expect(
      source,
      'PlannerPanel.tsx must import ShallowWarning directly from ./ShallowWarning',
    ).toMatch(IMPORTS_SHALLOW_WARNING_FROM_ITS_OWN_FILE);
    expect(
      source,
      'PlannerPanel.tsx must not import ShallowWarning from ./RouteSummary — that is the single ' +
        "point (the #463 brief's own words) where the goal can be silently lost",
    ).not.toMatch(IMPORTS_SHALLOW_WARNING_FROM_ROUTE_SUMMARY);
  });
});
