import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
// tsconfig.test.json's narrow `include` list (unlike tsconfig.app.json's
// broad `include: ["src"]`) does not pull in src/test/setup.ts, so the
// jest-dom matcher types (toBeInTheDocument etc.) need this direct import
// to be visible under THIS file's program.
import '@testing-library/jest-dom/vitest';
import { I18nProvider } from '../i18n';
import HarborPicker from '../components/HarborPicker';
import type { HarborWithReachability } from '../lib/harborReachability';
import type { Harbor } from '../types';

// #835: nothing previously coupled the shipped `knownDisconnected` JSON key
// (written by pipeline/build_harbors.mjs) to the TS field HarborPicker.tsx's
// render path actually reads (HarborWithReachability's `knownDisconnected`).
// The #835 demonstrating mutation: rename the field CONSISTENTLY across
// harborReachability.ts's type, HarborPicker.tsx's read site, AND
// HarborPicker.test.tsx's own hand-built fixture (say to `unreachable`).
// That typechecks -- the intersection field is optional, so a plain
// Harbor[] parsed from JSON still satisfies HarborWithReachability -- and it
// passes every existing render test, because every existing fixture was
// renamed along with the code. Nothing shipped would ever render the
// disclosure again, and nothing would say so.
//
// This file closes that gap the way the issue asks: it feeds the REAL,
// on-disk app/public/data/harbors.json through the REAL HarborPicker render
// path. The JSON is parsed at runtime (JSON.parse, not a TypeScript object
// literal) and handed to HarborPicker via a `Harbor[]` cast to
// `HarborWithReachability[]` -- exactly how production data flows in
// (App.tsx/PlannerPanel never construct a typed object literal for a
// harbor; they parse JSON and trust the runtime shape).
//
// BOTH coupling tests below read the flag through `hasKnownDisconnectedFlag`
// -- a runtime cast to `Record<string, unknown>` reading the literal string
// key, never a typed `h.knownDisconnected` property access -- deliberately,
// so that if `HarborWithReachability`'s field is ever renamed (the #835
// demonstrating mutation, applied consistently by an IDE "Rename Symbol"
// across every TYPED reference in the tree), a typed access in THIS file
// would silently be renamed right along with it and stop catching anything.
// Measured in PR #895 review: a typed `real.filter((h) => h.knownDisconnected
// === true)` here is itself a typed reference an IDE rename carries along,
// so it goes GREEN after such a rename (0 matches, early-return, ordinary
// pass) even though the shipped harbors.json never changed -- exactly the
// #835 bug reproduced INSIDE the guard meant to catch it. The string-keyed
// cast has no typed reference for a rename to find, so it keeps reading the
// literal 'knownDisconnected' key regardless of what the TYPE currently
// calls the field.
//
// Two tests, deliberately split by what each does NOT depend on:
//   1. is ROBUST to today's real disconnected-harbor count (even zero) --
//      per CLAUDE.md's #595 "what does a guard do when the problem is
//      fixed" rule, a coupling guard must not require the #9 mask gap to
//      stay open forever. It flags a real harbor OBJECT (real names/
//      snap/country/approachNote, not hand-typed) via the literal JSON key,
//      independent of that harbor's ACTUAL flag in the shipped file.
//   2. additionally exercises whichever harbors the shipped file itself
//      flags TODAY (read via the same string-keyed cast, so it stays
//      independently load-bearing rather than merely visible-when-it-gives-
//      up), skipping (not failing, not vacuously passing) if that set is
//      ever legitimately empty.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HARBORS_JSON_PATH = resolve(REPO, 'app', 'public', 'data', 'harbors.json');

// Overridable so the mutation checks below (rename simulation, empty-input
// simulation) can drive this function without touching the real file on
// disk -- see the two `it()` blocks after the coupling tests.
function readShippedHarbors(raw: string = readFileSync(HARBORS_JSON_PATH, 'utf8')): Harbor[] {
  const parsed: unknown = JSON.parse(raw);
  // Fail CLOSED before anything else: an empty/malformed array here would
  // otherwise let every assertion below vacuously pass having read nothing
  // (the same shape CLAUDE.md's useBannerHeight.test.ts pattern guards
  // against for a regex that silently stops matching).
  expect(
    Array.isArray(parsed) && parsed.length > 0,
    `harbors.json did not parse to a non-empty array (path: ${HARBORS_JSON_PATH}) -- ` +
      'this guard reads the real shipped file and cannot proceed without it',
  ).toBe(true);
  return parsed as Harbor[];
}

// Injects the EXACT literal key pipeline/build_harbors.mjs writes
// ('knownDisconnected') onto a real harbor's own shape, via a runtime cast
// rather than a typed object literal. This is deliberate: an object
// literal assigned directly to a HarborWithReachability-typed slot would
// trip TypeScript's excess-property check the instant the field is renamed
// (masking exactly the mutation this file exists to catch), whereas a cast
// -- like a real JSON.parse() result flowing into a typed prop -- carries
// the literal key through untouched regardless of what the TYPE currently
// calls it.
function withKnownDisconnectedFlag(h: Harbor, flagged: boolean): HarborWithReachability {
  const clone: Record<string, unknown> = { ...h };
  clone['knownDisconnected'] = flagged;
  return clone as unknown as HarborWithReachability;
}

// The read-side counterpart of withKnownDisconnectedFlag above: reads the
// SAME literal string key via a runtime cast, never a typed property
// access on HarborWithReachability. This is what makes Test 2 below
// independently load-bearing against an IDE "Rename Symbol" mutation
// (PR #895 review Major) -- a typed `h.knownDisconnected` reference in
// THIS test file would be renamed right along with the type it reads,
// and would then report zero flagged harbors (an ordinary, silent pass)
// on a mutation that never touched the shipped JSON at all.
function hasKnownDisconnectedFlag(h: unknown): boolean {
  return (h as Record<string, unknown>)['knownDisconnected'] === true;
}

function renderWithHarbors(harbors: HarborWithReachability[]) {
  localStorage.setItem('sc-lang', 'en');
  render(
    <I18nProvider>
      <HarborPicker harbors={harbors} recentIds={[]} onSelect={vi.fn()} />
    </I18nProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
});

describe('#835: HarborPicker read path is coupled to the shipped knownDisconnected key', () => {
  it('renders the disclosure for a real harbor object carrying knownDisconnected:true, and not for one without it', () => {
    const real = readShippedHarbors();
    expect(
      real.length,
      'need at least two distinct shipped harbors to build a positive/negative pair',
    ).toBeGreaterThanOrEqual(2);
    const [a, b] = real;
    renderWithHarbors([withKnownDisconnectedFlag(a, true), withKnownDisconnectedFlag(b, false)]);

    fireEvent.focus(screen.getByRole('combobox'));
    const flaggedOption = screen.getByRole('option', { name: new RegExp(a.names.en) });
    const unflaggedOption = screen.getByRole('option', { name: new RegExp(b.names.en) });

    expect(within(flaggedOption).getByText(/not reachable/i)).toBeInTheDocument();
    expect(within(unflaggedOption).queryByText(/not reachable/i)).not.toBeInTheDocument();
  });

  it('renders the disclosure for whichever harbors the shipped file itself currently flags', () => {
    const real = readShippedHarbors();
    // Read via the string-keyed cast (hasKnownDisconnectedFlag), NOT a
    // typed `h.knownDisconnected` property access -- see this file's
    // header. A typed access here would be carried along by the same
    // IDE rename that renames the type, production, and read site
    // together, and would then silently report zero flagged harbors
    // (an ordinary pass, not a failure) on the exact mutation this test
    // exists to catch.
    const flagged = (real as HarborWithReachability[]).filter((h) => hasKnownDisconnectedFlag(h));
    if (flagged.length === 0) {
      // Legitimate all-clear state (every #9 KNOWN_DISCONNECTED harbor has
      // reconnected) -- see this file's header and
      // harborKnownDisconnected.test.ts's own note on the same condition.
      // Not a vacuous pass: the sibling test above still exercises the
      // coupling unconditionally.
      return;
    }
    renderWithHarbors(real as HarborWithReachability[]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: flagged[0].names.en } });
    const option = screen.getByRole('option', { name: new RegExp(flagged[0].names.en) });
    expect(within(option).getByText(/not reachable/i)).toBeInTheDocument();
  });
});

describe('#835 mutation checks (against this file, not the shipped code)', () => {
  // Simulates "rename the field in a copy of the JSON": if the SHIPPED
  // KEY itself changed (e.g. build_harbors.mjs started writing
  // `unreachable` instead of `knownDisconnected`) while this guard kept
  // asking for the old key, the render path would see nothing and the
  // disclosure would not appear -- this must fail RED, not silently pass.
  it('goes RED when the loaded data uses a different key than the one the render path reads', () => {
    const real = readShippedHarbors();
    const [a, b] = real;
    const renamed: Record<string, unknown>[] = [
      { ...a, unreachable: true },
      { ...b, unreachable: false },
    ];
    renderWithHarbors(renamed as unknown as HarborWithReachability[]);
    fireEvent.focus(screen.getByRole('combobox'));
    const flaggedOption = screen.getByRole('option', { name: new RegExp(a.names.en) });
    // The real HarborPicker.tsx still reads `knownDisconnected` here (this
    // mutation only renamed the loaded DATA's key, not the read site), so
    // the disclosure must be ABSENT -- proving the positive assertion in
    // the coupling test above is not vacuously satisfied by any input.
    expect(within(flaggedOption).queryByText(/not reachable/i)).not.toBeInTheDocument();
  });

  // Simulates "stub the collector/extractor to empty": readShippedHarbors()
  // itself must refuse to pass silently on an empty/malformed parse, or
  // every assertion built on it would vacuously pass having read nothing.
  it('goes RED when the loaded JSON parses to an empty array', () => {
    expect(() => readShippedHarbors('[]')).toThrowError(/did not parse to a non-empty array/);
  });

  it('goes RED when the loaded JSON is malformed (not an array at all)', () => {
    expect(() => readShippedHarbors('{}')).toThrowError(/did not parse to a non-empty array/);
  });
});
