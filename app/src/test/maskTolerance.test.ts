import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { BOAT_DRAFT_M } from '../routing/relaxedDepth';
import { DEFAULT_SETTINGS } from '../types';
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
const BUILD_MASK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../pipeline/build_mask.py',
);

describe('#455: pipeline/build_mask.py TOLERANCE_M / disclosure cross-artifact guard', () => {
  it('TOLERANCE_M is 0.9 — the value the disclosure copy is written against', () => {
    const py = readFileSync(BUILD_MASK_PATH, 'utf8');
    // Anchored to a line that is ONLY the assignment (optional leading
    // whitespace, nothing after the number but trailing whitespace) so this
    // cannot match one of the several PROSE mentions of "TOLERANCE_M = <n>"
    // inside build_mask.py's own derivation comment (e.g. "the previous
    // TOLERANCE_M = 2.0 looked safe and was not" a few lines above the real
    // assignment) — a naive unanchored regex would find that comment first
    // and silently validate against a decoy value instead of the real one.
    const match = py.match(/^[ \t]*TOLERANCE_M\s*=\s*([\d.]+)[ \t]*$/m);
    expect(
      match,
      'TOLERANCE_M assignment not found in pipeline/build_mask.py (renamed, reformatted, or moved) — ' +
        'update the regex above alongside the pipeline change, and re-verify the about.caveats.depthMask copy',
    ).not.toBeNull();

    const toleranceM = Number(match![1]);
    expect(toleranceM).toBe(0.9);
  });

  it('encodes the METHOD, not just the value: safetyDepthM(default) - TOLERANCE_M === BOAT_DRAFT_M', () => {
    const py = readFileSync(BUILD_MASK_PATH, 'utf8');
    const match = py.match(/^[ \t]*TOLERANCE_M\s*=\s*([\d.]+)[ \t]*$/m);
    expect(match, 'TOLERANCE_M assignment not found in pipeline/build_mask.py').not.toBeNull();
    const toleranceM = Number(match![1]);

    // build_mask.py's own derivation: depth_blend <= depth_max + TOLERANCE_M,
    // so a cell navigable at gate G has a conservative depth >= G - TOLERANCE_M.
    // At the default 3.0 m safety depth that floor is exactly BOAT_DRAFT_M —
    // the guarantee the About dialog's disclosure states. Asserting the
    // relationship (not a bare "0.9 === 0.9" literal) means a future change
    // to EITHER DEFAULT_SETTINGS.safetyDepthM OR BOAT_DRAFT_M OR
    // TOLERANCE_M is caught here, not just a change to one of them in
    // isolation.
    expect(DEFAULT_SETTINGS.safetyDepthM - toleranceM).toBe(BOAT_DRAFT_M);
  });

  it('the UI minimum safety depth degrades the floor to 1.3 m, matching the disclosure copy', () => {
    const py = readFileSync(BUILD_MASK_PATH, 'utf8');
    const match = py.match(/^[ \t]*TOLERANCE_M\s*=\s*([\d.]+)[ \t]*$/m);
    expect(match, 'TOLERANCE_M assignment not found in pipeline/build_mask.py').not.toBeNull();
    const toleranceM = Number(match![1]);

    // SAFETY_DEPTH_FIELD.min (OptionsPanel.tsx) is the lowest safetyDepthM a
    // user can actually reach through the UI — the disclosure's stated
    // worst-case floor must track it, not a hypothetical lower bound.
    const worstCaseFloor = SAFETY_DEPTH_FIELD.min - toleranceM;
    expect(Number(worstCaseFloor.toFixed(1))).toBe(1.3);
  });
});
