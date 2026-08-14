import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BOAT_DRAFT_M } from '../routing/relaxedDepth';
import { DEFAULT_SETTINGS } from '../types';
import { en } from '../i18n/dict.en';
import { de } from '../i18n/dict.de';
import { MASK_TOLERANCE_M } from '../lib/mask';
import { BOATS, boatById, DEFAULT_BOAT_ID } from '../data/boats';
import {
  ceilToDecimetre,
  defaultSafetyDepthM,
  minSafetyDepthM,
  relaxationFloorM,
} from '../lib/boatDepth';
import { SAFETY_DEPTH_FIELD } from '../components/OptionsPanel';

// #455: pipeline/build_mask.py's TOLERANCE_M is the structural bound behind
// the About dialog's `about.caveats.depthMask` disclosure — no compiler
// spans Python and TypeScript, so nothing else keeps that copy honest if the
// constant ever moves. Pattern follows useBannerHeight.test.ts /
// panelWidth.test.ts: readFileSync a sibling artifact, regex a literal out
// of it, and fail CLOSED (an explicit not.toBeNull() BEFORE any value
// comparison) so a regex that silently stops matching reds loudly instead of
// passing quietly — the same shape as the CSP `String.replace` incident
// (#223) this repo has already been bitten by once.
//
// PR #481 review (F3, MEASURED): the first version of this file only
// asserted relationships among TS/Python CONSTANTS — nothing ever read the
// shipped dict STRINGS, so mutating the copy's numbers alone (leaving
// TOLERANCE_M untouched) passed 17/17 (`AboutDialog.test.tsx`'s
// `getByText(dict[...])` derives its expectation from the same dict under
// test, the #50 equivalence tautology). Every numeric claim in the
// disclosure copy is now asserted BIDIRECTIONALLY below: the NEEDLE
// (expected substring) is computed from the pipeline/TS constants, and the
// HAYSTACK is the shipped dict string — two independent artifacts, so
// perturbing either one alone reds the guard.
const BUILD_MASK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../pipeline/build_mask.py',
);

// F6/F7: normalise EVERY derived float the SAME way. IEEE754 residue hits
// some of these operand pairs and not others — `3.0 - 0.9 === 2.1` is exact
// today but `2.1 - 0.9 === 1.2` is `1.2000000000000002` — so a per-test
// choice of "compare raw" vs "toFixed(1)" would make a real drift red on one
// assertion and pass by binary-representation luck on its sibling. One
// rounding rule, used everywhere a derived float is compared or rendered.
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function readToleranceM(): number {
  const py = readFileSync(BUILD_MASK_PATH, 'utf8');
  // Anchored to a line that is ONLY the assignment (optional leading
  // whitespace, nothing after the number but trailing whitespace) so this
  // cannot match one of the several PROSE mentions of "TOLERANCE_M = <n>"
  // inside build_mask.py's own derivation comment (e.g. "the previous
  // TOLERANCE_M = 2.0 looked safe and was not", or "G = 3.0 m, TOLERANCE_M =
  // 0.9 puts that floor at exactly 2.1 m" — both a few lines above the real
  // assignment). A naive unanchored regex would find one of those decoys
  // (one of them even coincidentally correct-valued) instead of the real
  // assignment.
  const match = py.match(/^[ \t]*TOLERANCE_M\s*=\s*([\d.]+)[ \t]*$/m);
  expect(
    match,
    'TOLERANCE_M assignment not found in pipeline/build_mask.py (renamed, reformatted, or moved) — ' +
      'update the regex above alongside the pipeline change, and re-verify the about.caveats.depthMask copy',
  ).not.toBeNull();
  return Number(match![1]);
}

// Renders a value the way the disclosure copy does: one decimal place, a
// trailing " m", and (for German) a comma decimal separator.
function measurement(value: number, locale: 'en' | 'de'): string {
  const s = round1(value).toFixed(1);
  return `${locale === 'de' ? s.replace('.', ',') : s} m`;
}

// Word-boundary-safe containment: `(?<!\d)`/`(?!\d)` stop "2.1 m" from
// spuriously matching inside a longer number like "12.1 m" or "2.15 m" —
// unlikely in this copy today, but the check should not depend on that.
function containsMeasurement(text: string, value: number, locale: 'en' | 'de'): boolean {
  const formatted = measurement(value, locale);
  const escaped = formatted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`(?<!\d)${escaped}(?!\d)`).test(text);
}

describe('#455: pipeline/build_mask.py TOLERANCE_M / disclosure cross-artifact guard', () => {
  it('TOLERANCE_M is 0.9 — the value the disclosure copy is written against', () => {
    expect(readToleranceM()).toBe(0.9);
  });

  // #493: app/src/lib/mask.ts's cautiousDepthLowerBoundM (the per-leg and
  // banner disclosure helper) mirrors this same constant under its own name,
  // TypeScript-side — nothing compiles across the Python/TS boundary, so this
  // is the only thing that keeps the mirror honest. Preserves the file's
  // fail-closed property: readToleranceM() itself asserts not.toBeNull()
  // before this comparison ever runs.
  it('#493: mask.ts MASK_TOLERANCE_M mirrors the same Python TOLERANCE_M', () => {
    expect(MASK_TOLERANCE_M).toBe(readToleranceM());
  });

  it('encodes the METHOD, not just the value: safetyDepthM(default) - TOLERANCE_M === BOAT_DRAFT_M', () => {
    const toleranceM = readToleranceM();
    // build_mask.py's own derivation: depth_blend <= depth_max + TOLERANCE_M,
    // so a cell navigable at gate G has a conservative depth >= G -
    // TOLERANCE_M. At the default 3.0 m safety depth that floor is exactly
    // BOAT_DRAFT_M — why 0.9 was chosen, and the "2.1 m ... at the 3.0 m
    // default" clause in the disclosure copy below.
    expect(round1(DEFAULT_SETTINGS.safetyDepthM - toleranceM)).toBe(BOAT_DRAFT_M);
  });

  it('encodes the RELAXATION floor: BOAT_DRAFT_M - TOLERANCE_M is the true worst case at default settings', () => {
    const toleranceM = readToleranceM();
    // PR #481 review (F2, MEASURED): #53's relaxed-depth search
    // (relaxedDepth.ts's findRelaxedGate) probes an internal gate down to
    // BOAT_DRAFT_M itself whenever the requested depth is unreachable —
    // independent of SAFETY_DEPTH_FIELD's 2.2 m UI clamp (OptionsPanel.tsx),
    // which bounds only what a user can TYPE — and it fires at DEFAULT
    // settings with no user input at all (realmask.repro.test.ts pins
    // usedDepthM ~= 2.3 for Flensburg->Marstal at DEFAULT_SETTINGS). So the
    // worst-case floor a user can actually hit without touching any setting
    // is BOAT_DRAFT_M - TOLERANCE_M, NOT SAFETY_DEPTH_FIELD.min - TOLERANCE_M
    // (the earlier, WRONG version of this test and of the disclosure copy).
    expect(round1(BOAT_DRAFT_M - toleranceM)).toBe(1.2);
  });

  describe('the disclosure copy states the numbers this file derives, in BOTH languages', () => {
    // F3: needle from the pipeline/TS constants, haystack from the shipped
    // dict string. Mutation-checked in both directions (see PR #481 body):
    // changing TOLERANCE_M alone reds every row below; changing only the
    // dict text's numbers (leaving TOLERANCE_M untouched) ALSO reds every
    // row below, which the pre-fix version of this file could not do.
    it('EN carries the tolerance bound, the default gate, the default floor, and the relaxation floor', () => {
      const toleranceM = readToleranceM();
      const text = en['about.caveats.depthMask'];
      expect(containsMeasurement(text, toleranceM, 'en')).toBe(true);
      expect(containsMeasurement(text, DEFAULT_SETTINGS.safetyDepthM, 'en')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M, 'en')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M - toleranceM, 'en')).toBe(true);
    });

    it('DE carries the same four numbers, comma-formatted', () => {
      const toleranceM = readToleranceM();
      const text = de['about.caveats.depthMask'];
      expect(containsMeasurement(text, toleranceM, 'de')).toBe(true);
      expect(containsMeasurement(text, DEFAULT_SETTINGS.safetyDepthM, 'de')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M, 'de')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M - toleranceM, 'de')).toBe(true);
    });
  });
});

// Generalises the #455 drift guard so every row iterates the boat catalogue
// instead of hardcoding the Salona 45's numbers. What it pins is the
// DERIVATION — that the pure helpers in lib/boatDepth.ts compute each boat's
// gates from that boat's own draft. It deliberately CANNOT observe whether
// planRoute()'s #53 relaxation search actually calls those helpers per boat;
// that wiring is a different artifact and is pinned separately by Task 10's
// own mutation check. Keeping the two claims apart is the point: a guard
// that appears to cover the wiring would be trusted for something it never
// tested.
describe('#54: per-boat catalogue generalises the #455 drift guard (spec C.8)', () => {
  // R1 — the non-vacuity twin. Every row below iterates the catalogue, so a
  // catalogue stubbed to [] leaves the whole guard green (#411, "a guard's DATA
  // needs a twin"). This list is HAND-WRITTEN and must never be derived from BOATS.
  //
  // Discriminating experiment, recorded so it is run rather than assumed:
  //   perturb production alone (add a boat) -> 1 row reds (this one)
  //   perturb this table alone              -> 1 row reds (this one)
  // R6 is independent BY DESIGN: it anchors the Salona literals against a
  // hardcoded id and shares no identifier with this table, so it cannot red
  // from a perturbation here. That independence is the point — R6 is what
  // catches an arithmetic generalisation that is self-consistent but wrong.
  const EXPECTED_BOAT_IDS = ['salona-45'];

  it('R1: the catalogue matches the hand-written expected list', () => {
    expect(BOATS.map((b) => b.id)).toEqual(EXPECTED_BOAT_IDS);
  });

  it('R2: default safety depth is DERIVED, not hand-typed', () => {
    for (const b of BOATS) {
      expect(defaultSafetyDepthM(b)).toBe(ceilToDecimetre(b.draftM + MASK_TOLERANCE_M));
    }
  });

  it('R3: the C.3 invariant holds for every catalogue boat', () => {
    for (const b of BOATS) {
      const floorDm = Math.round((defaultSafetyDepthM(b) - MASK_TOLERANCE_M) * 10);
      expect(floorDm).toBeGreaterThanOrEqual(Math.round(b.draftM * 10));
    }
  });

  it('R4: the relaxation floor is per-boat, not a module constant', () => {
    // This row guards the pure DERIVATION only (relaxationFloorM itself) — it
    // cannot observe whether planRoute()'s #53 relaxation search actually
    // calls this helper per-boat rather than the old module-level
    // BOAT_DRAFT_M. That WIRING is a separate, later concern: Task 10 (not
    // this file) owns the mutation check proving the relaxation search reads
    // relaxationFloorM(boat) rather than a shared constant once PlanDeps
    // carries the boat through.
    for (const b of BOATS) {
      expect(relaxationFloorM(b)).toBe(ceilToDecimetre(b.draftM));
    }
    // The assertion that catches a 2.30 m boat relaxing to 2.1 m: a hypothetical
    // deeper boat must NOT floor at the Salona's draft.
    const deep = { ...boatById('salona-45'), id: 'x', draftM: 2.3 };
    expect(relaxationFloorM(deep)).toBe(2.3);
  });

  it('R6: the Salona 45 still reads its four literals', () => {
    const b = boatById('salona-45');
    expect(b.draftM).toBe(2.1);
    expect(defaultSafetyDepthM(b)).toBe(3.0);
    expect(round1(defaultSafetyDepthM(b) - MASK_TOLERANCE_M)).toBe(2.1);
    expect(round1(relaxationFloorM(b) - MASK_TOLERANCE_M)).toBe(1.2);
  });

  it('R7: every derived default fits inside the field range', () => {
    for (const b of BOATS) {
      expect(b.draftM + MASK_TOLERANCE_M).toBeLessThanOrEqual(SAFETY_DEPTH_FIELD.max);
    }
  });

  it('R7b: the field minimum is the derived per-boat minimum', () => {
    // Beyond the brief (Task 3 controller addition): passes today because both
    // sides read 2.2 m, and becomes the keeper once a later task replaces
    // OptionsPanel.tsx's hardcoded `min: 2.2` with this derived call — min is
    // a bare number, so nothing else in this suite would catch a wrong value.
    expect(SAFETY_DEPTH_FIELD.min).toBe(minSafetyDepthM(boatById(DEFAULT_BOAT_ID)));
  });

  it('R8: report zero-margin boats rather than relying on a binary pass', () => {
    const zero = BOATS.filter(
      (b) => Math.round((defaultSafetyDepthM(b) - MASK_TOLERANCE_M - b.draftM) * 10) === 0,
    ).map((b) => b.id);
    // Reported, NOT failed — spec C.8 R8. The Salona 45 sits at exactly 0.0 m.
    console.info('[R8] zero floor-margin boats:', zero);
    expect(Array.isArray(zero)).toBe(true);
  });
});
