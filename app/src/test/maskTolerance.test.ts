import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BOAT_DRAFT_M } from '../routing/relaxedDepth';
import { DEFAULT_SETTINGS } from '../types';
import { en } from '../i18n/dict.en';
import { de } from '../i18n/dict.de';
import { MASK_TOLERANCE_M } from '../lib/mask';
import { BOATS, boatById, DEFAULT_BOAT_ID, type BoatDef } from '../data/boats';
import {
  ceilToDecimetre,
  defaultSafetyDepthM,
  minSafetyDepthM,
  relaxationFloorM,
} from '../lib/boatDepth';
import { SAFETY_DEPTH_FIELD } from '../components/OptionsPanel';
import { depthMaskCaveatVars } from '../lib/depthDisclosure';
import type { Lang } from '../i18n';

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
    // the selected boat's relaxation floor — relaxationFloorM(boat), which is
    // BOAT_DRAFT_M's 2.1 for the Salona (#54) — whenever the requested depth
    // is unreachable —
    // independent of SAFETY_DEPTH_FIELD's 2.2 m UI clamp (OptionsPanel.tsx),
    // which bounds only what a user can TYPE — and it fires at DEFAULT
    // settings with no user input at all (realmask.repro.test.ts pins
    // usedDepthM ~= 2.3 for Flensburg->Marstal at DEFAULT_SETTINGS). So the
    // worst-case floor a user can actually hit without touching any setting
    // is BOAT_DRAFT_M - TOLERANCE_M, NOT SAFETY_DEPTH_FIELD.min - TOLERANCE_M
    // (the earlier, WRONG version of this test and of the disclosure copy).
    expect(round1(BOAT_DRAFT_M - toleranceM)).toBe(1.2);
  });

  // R5 (#54 spec C.8 R5 / J OQ-2, made per-boat by #539). The disclosure copy
  // is no longer four literals sitting in the dict: `about.caveats.depthMask`
  // is a TEMPLATE and lib/depthDisclosure.ts fills it from the SELECTED boat,
  // so these rows render it once per catalogue boat, in both languages.
  //
  // WHY THE EXPECTED VALUES ARE HAND-WRITTEN. If the copy derives from the
  // boat and the expectation derives from the boat too, the pin asserts
  // nothing — a change moves both sides together and the row stays green
  // (#50's equivalence tautology; #411's "a guard's DATA needs a twin"). So
  // EXPECTED_DISCLOSURE_M below is typed out by hand and NEVER read off BOATS
  // or recomputed through boatDepth.ts. Needle hand-written, haystack
  // production-rendered — same idiom as EXPECTED_BOAT_IDS and R6 below.
  //
  // Hand-derivation, so a reader can check it rather than trust it:
  //   gate  = ceil-to-a-decimetre of (draft + 0.9)  — spec C.3
  //   floor = draft − 0.9                           — spec C.4(b): the #53
  //           relaxation floor's own cautious reading, NOT the UI-minimum
  //           floor (spec C.8 records that as "the earlier, WRONG version").
  //     salona-45            2.1 →  3.0 / 2.1 / 1.2
  //     salona-44-speedy-go  2.1 →  3.0 / 2.1 / 1.2
  //     elan-444-piranja     1.9 →  2.8 / 1.9 / 1.0
  //
  // DISCRIMINATING EXPERIMENT, recorded so it is re-run rather than re-argued.
  // MEASURED 2026-08-18, each perturbation applied ALONE:
  //   PRODUCTION — make depthMaskCaveatVars derive from boatById(DEFAULT_BOAT_ID)
  //     instead of its argument -> 4 rows red HERE (both salona-44 rows and
  //     both elan rows; the salona-45 rows cannot move, since it IS the
  //     default), and 0 rows red anywhere else in the suite.
  //   THIS TABLE — change the elan's expected gate 2.8 -> 3.0 -> 2 rows red
  //     (the elan's EN and DE rows) and 0 in production's own guards.
  //   THIS TABLE — delete the elan entry entirely -> the same 2 rows red, on
  //     the fail-closed toBeDefined() below rather than on a number.
  //   PRODUCTION CATALOGUE — add a fourth boat -> its 2 rows red on that same
  //     toBeDefined(), so a new entry cannot ship unasserted.
  // The asymmetry is the point: neither side can be the reason the other is
  // green, and the 4-vs-2 split shows the two are genuinely different
  // artifacts rather than one source feeding both.
  //
  // PER-ASSERTION ATTRIBUTION, measured the same day by deleting each row's
  // assertions ONE AT A TIME under a mutation aimed at that one assertion —
  // this repo has shipped multi-assertion pins with a single discriminating
  // member (#516/PR #523), so the table is stated rather than assumed:
  //   toBeDefined()       sole discriminator for a missing/added catalogue boat.
  //   toContain(boat.name) SOLE for `boat: b.name` -> a fixed string.
  //   tolerance bound      SOLE for TOLERANCE_M -> 0.8.
  //   derived gate         catches `gate` <- relaxationFloorM (7 rows red; 1
  //                        still red with it deleted, i.e. it is one of two).
  //   own draft            catches `draft` + 0.1, same shape.
  //   relaxation floor     catches `floor` <- the UI-minimum floor (spec C.8's
  //                        documented WRONG version), same shape.
  //   no-unfilled-placeholder — REDUNDANT TODAY, and kept deliberately: every
  //     slot the template has is also covered by a containment assertion, so
  //     deleting a var reds the row either way (measured: 7 rows red with the
  //     guard present, 7 with it deleted). It earns its place as the only
  //     check that fails CLOSED on a FUTURE slot nothing else names, and it
  //     names the fault instead of reporting a missing measurement.
  describe("R5: the disclosure copy states the SELECTED boat's own numbers, in BOTH languages", () => {
    const EXPECTED_DISCLOSURE_M: Record<string, { gate: number; draft: number; floor: number }> = {
      'salona-45': { gate: 3.0, draft: 2.1, floor: 1.2 },
      'salona-44-speedy-go': { gate: 3.0, draft: 2.1, floor: 1.2 },
      'elan-444-piranja': { gate: 2.8, draft: 1.9, floor: 1.0 },
    };

    // Mirrors i18n/index.tsx's `t()` substitution. Deliberately a second
    // implementation rather than an import: `t()` is a React hook, and this
    // file asserts against the shipped STRING rather than a rendered tree.
    // AboutDialog.test.tsx covers the component wiring.
    function renderCaveat(boat: BoatDef, lang: Lang): string {
      const dict = lang === 'de' ? de : en;
      let text: string = dict['about.caveats.depthMask'];
      for (const [k, v] of Object.entries(depthMaskCaveatVars(boat, lang))) {
        text = text.replaceAll(`{${k}}`, v);
      }
      return text;
    }

    for (const boat of BOATS) {
      for (const lang of ['en', 'de'] as const) {
        it(`${boat.id} / ${lang}: tolerance, derived gate, own draft, relaxation floor`, () => {
          const toleranceM = readToleranceM();
          const expected = EXPECTED_DISCLOSURE_M[boat.id];
          // Fail CLOSED on a catalogue boat this hand-written table does not
          // cover. Without it a new entry would be silently unasserted —
          // exactly the state #539 found this copy in.
          expect(
            expected,
            `no hand-written disclosure expectation for boat id "${boat.id}" — add one to ` +
              'EXPECTED_DISCLOSURE_M, derived BY HAND from spec C.3/C.4(b), never from BOATS',
          ).toBeDefined();
          const text = renderCaveat(boat, lang);
          // Every placeholder must have been filled. A dict slot the vars
          // object does not supply would otherwise ship a literal "{gate}" to
          // users while the four containment checks below still passed on the
          // slots that DID resolve.
          expect(text, 'unfilled placeholder in the rendered disclosure copy').not.toMatch(
            /\{[a-zA-Z]+\}/,
          );
          expect(text, 'the copy must name the boat whose numbers it states').toContain(boat.name);
          expect(containsMeasurement(text, toleranceM, lang), 'tolerance bound').toBe(true);
          expect(containsMeasurement(text, expected.gate, lang), 'derived default gate').toBe(true);
          expect(containsMeasurement(text, expected.draft, lang), "this boat's draft").toBe(true);
          expect(containsMeasurement(text, expected.floor, lang), 'relaxation floor').toBe(true);
        });
      }
    }

    // R5b — the reduces-to-today anchor for the copy, the sibling of R6's for
    // the arithmetic. Before #539 the shipped English string read "2.1 m, the
    // boat's draft, at the 3.0 m default … as little as 1.2 m", and
    // DEFAULT_SETTINGS.safetyDepthM / BOAT_DRAFT_M are where those numbers
    // came from. Re-asserting them against the DEFAULT boat's rendered copy is
    // what proves parameterisation did not quietly move a number users already
    // read — and it is the one row here whose needles are NOT hand-written,
    // deliberately: its job is to tie the new derivation back to the two
    // pre-existing constants, which no hand-typed literal can do.
    it('R5b: the default boat still renders the pre-#539 numbers, from the pre-#539 constants', () => {
      const toleranceM = readToleranceM();
      const text = renderCaveat(boatById(DEFAULT_BOAT_ID), 'en');
      expect(containsMeasurement(text, DEFAULT_SETTINGS.safetyDepthM, 'en')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M, 'en')).toBe(true);
      expect(containsMeasurement(text, BOAT_DRAFT_M - toleranceM, 'en')).toBe(true);
    });
  });
});

// Generalises the #455 drift guard so its rows derive their expectations from
// the boat catalogue rather than hardcoding the Salona 45's numbers. TWO rows
// deliberately do not: R6 anchors the Salona's four literals against a
// hardcoded id, and R7b pins the UI field minimum to DEFAULT_BOAT_ID. That
// independence is the point — R6 is what catches an arithmetic
// generalisation that is self-consistent but wrong. What it pins is the
// DERIVATION: that lib/boatDepth.ts computes a gate from a boat's own draft
// rather than from a module constant. At the ORIGINAL one-boat catalogue
// only R4's synthetic-boat assertion (a 2.3 m boat built in the test and
// deliberately not a member of BOATS) was non-tautological — a hardcoded
// module constant would have coincided with the one catalogue boat's draft
// and passed a BOATS-only loop undetected. #552: R2 iterates BOATS, so it
// ALREADY has teeth against a draft-dependent derivation error, now that the
// catalogue holds a 1.9 m boat (elan-444-piranja) beside the 2.1 m pair
// (measured: a derivation correct at 2.1 m and wrong at 1.9 m reds R2). It
// stays blind to a wrong `draftM` VALUE under a correct id — that is what R6
// is for. R7b is a DIFFERENT case, not merely "weaker" — #552:
// OptionsPanel.tsx's `min` field was ALREADY replaced by the derived
// `minSafetyDepthM(boatById(DEFAULT_BOAT_ID))` call (commit fad6670,
// 2026-08-14), so R7b's assertion now compares that exact expression
// against itself and is VACUOUS: it cannot fail on a wrong draftM (measured
// — mutating salona-45's draftM to 2.4 m leaves R7b green). It reds only
// once a re-hardcoded literal has gone STALE against the derived value —
// e.g. after DEFAULT_BOAT_ID changes or the default boat's draftM moves.
// Re-hardcoding `min` at today's correct 2.2 is NOT caught (measured:
// `min: 2.2` leaves this file 19/19 green; `min: 2.3` reds R7b). It
// deliberately CANNOT observe whether
// planRoute()'s #53 relaxation search actually calls those helpers per boat;
// that wiring is a different artifact and is pinned separately by Task 10's
// own mutation check. Keeping the two claims apart is the point: a guard
// that appears to cover the wiring would be trusted for something it never
// tested.
describe('#54: per-boat catalogue generalises the #455 drift guard (spec C.8)', () => {
  // R1 — the non-vacuity twin. This list is HAND-WRITTEN and must never be derived
  // from BOATS (#411, "a guard's DATA needs a twin").
  // MEASURED 2026-08-14 against the ONE-BOAT catalogue of the day, perturbing
  // boats.ts one way at a time (8 rows in this block then). Scoped to that
  // catalogue because two of the four rows name it directly; the CONCLUSION
  // under them is unchanged and was re-measured on 2026-08-18 (below):
  //   ADD an extra entry, the expected ones intact -> only R1 reds.
  //   RENAME the Salona 45's id                    -> R1 reds, and R4/R6/R7b THROW
  //                                                   via boatById('salona-45').
  //   WRONG draftM under an unchanged id           -> R1 stays GREEN; R6 catches it
  //                                                   via its own literals. R7b does
  //                                                   NOT (#552: now vacuous — see the
  //                                                   header above and R7b's own comment).
  //   BOATS = []                                   -> R1 reds, and R4/R6/R7b throw.
  // So R1 is the only row that sees an EXTRA entry, and it is blind to a wrong VALUE
  // under a correct id — which is what R6 is for (R7b no longer is). An empty or
  // renamed catalogue fails loudly rather than silently.
  //
  // Discriminating experiment, recorded so it is run rather than assumed.
  // RE-MEASURED 2026-08-18 on the three-boat catalogue:
  //   perturb production alone (add a 4th boat)  -> 1 row reds IN THIS FILE
  //                                                 (this one); 9 across the
  //                                                 catalogue guards as a whole,
  //                                                 the other 8 in boats.test.ts,
  //                                                 polarProvenance.test.ts and
  //                                                 verifyMaskBoatGate.test.ts,
  //                                                 which now also pin membership.
  //   perturb this table alone (drop an id)      -> 1 row reds, this one, and
  //                                                 nothing else anywhere.
  // The ASYMMETRY is the point and it survives: only a production-side change
  // reaches the other files, so this row cannot be the reason they are green.
  // R6 is independent BY DESIGN: it anchors the Salona literals against a
  // hardcoded id and shares no identifier with this table, so it cannot red
  // from a perturbation here. That independence is the point — R6 is what
  // catches an arithmetic generalisation that is self-consistent but wrong.
  // RETIRED ASSERTION 3 of 3 (#54 spec N.8) — this list was `['salona-45']`.
  //
  // RATIONALE. It was not a guard that failed; it was the correct expected
  // value for OQ-7's one-boat release, and spec N adds two tier-C fleet models
  // to the catalogue. The list is UPDATED rather than removed, because R1's
  // whole purpose is to be a HAND-WRITTEN twin of production data (#411, "a
  // guard's DATA needs a twin") — deriving it from BOATS would make every row
  // in this block vacuous at once.
  //
  // The retirement makes this block STRONGER, and it is worth naming exactly
  // how — the obvious answer is wrong. The header above records that at a
  // one-boat catalogue R2, R3 and R8 "iterate a single row and cannot fail
  // differently from R6". Three boats carry two DISTINCT drafts (2.1 and 1.9),
  // and what that buys is measured, not assumed:
  //
  //   MEASURED 2026-08-18, hardcoding defaultSafetyDepthM to `return 3.0`
  //   (the hand-typed default R2 exists to catch):
  //     three-boat catalogue -> 7 rows red across the catalogue guards
  //                             (1 here - R2 - plus 3 in boatDepth.test.ts and
  //                             3 in verifyMaskBoatGate.test.ts).
  //     one-boat catalogue   -> 14/14 maskTolerance rows PASS, R2 included,
  //                             because 3.0 IS ceilToDecimetre(2.1 + 0.9) and
  //                             R2's assertion is satisfied by the coincidence.
  //   The Elan's 1.9 m draft is the whole difference: 3.0 !== 2.8 reds it.
  //
  // What the second draft does NOT buy, stated because the plausible-sounding
  // claim is false and was written here before it was run: it does NOT make
  // this block sensitive to the QUANTISER. Replacing ceilToDecimetre with
  // Math.round reds 5 rows and NOT ONE of them is in this describe block —
  // every catalogue draft puts (draft + T) * 10 exactly on a whole decimetre
  // (30.0, 30.0, 28.0), where ceil and round agree. Detecting a wrong
  // quantiser still belongs entirely to the SYNTHETIC probes in
  // boatDepth.test.ts (1.73, 2.25) and to verify_mask.py's
  // GATE_DERIVATION_CASES. Do not add a catalogue boat expecting to cover it.
  const EXPECTED_BOAT_IDS = ['salona-45', 'salona-44-speedy-go', 'elan-444-piranja'];

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
    // #552: OptionsPanel.tsx's `min` field is now DEFINED as
    // `minSafetyDepthM(boatById(DEFAULT_BOAT_ID))` (commit fad6670,
    // 2026-08-14) — this assertion recomputes the identical expression on
    // both sides, so it is VACUOUS today: it cannot fail on a wrong draftM
    // (measured — mutating salona-45's draftM to 2.4 m leaves this row
    // green). It reds only once a re-hardcoded literal has gone STALE
    // against the derived value — e.g. after DEFAULT_BOAT_ID changes or the
    // default boat's draftM moves. Re-hardcoding `min` at today's correct
    // 2.2 is NOT caught (measured: `min: 2.2` leaves this file 19/19 green;
    // `min: 2.3` reds this row) — min is a bare number, so nothing else in
    // this suite would catch that particular staleness either.
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
