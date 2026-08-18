import { describe, expect, it } from 'vitest';
import { SAFETY_DEPTH_FIELD, safetyDepthFieldFor } from './OptionsPanel';
import { minSafetyDepthM } from '../lib/boatDepth';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';

// #539 item 2 / spec J OQ-1. The UI minimum is `draftM + 0.1` per boat, and
// this path is QUIETER than the #53 relaxation one: a gate the user typed
// under their own keel produces no `shallow` block, so nothing discloses a
// wrong minimum. There is no banner standing behind this — the derivation IS
// the protection.

const DEEP = { ...boatById(DEFAULT_BOAT_ID), id: 'deep-46', draftM: 2.3 };
const SHOAL = { ...boatById(DEFAULT_BOAT_ID), id: 'shoal-40', draftM: 1.6 };

describe('#539 item 2: safetyDepthFieldFor', () => {
  it('derives `min` from the BOAT, not from the catalogue default', () => {
    // The control row below cannot discriminate — the default boat's derived
    // minimum coincides with the shipped constant by construction — so this
    // row uses a draft where per-boat and default DISAGREE. 2.3 + 0.1
    // quantises to 2.4 against the default's 2.2.
    expect(safetyDepthFieldFor(DEEP).min).toBe(2.4);
    expect(safetyDepthFieldFor(SHOAL).min).toBe(1.7);
    expect(safetyDepthFieldFor(DEEP).min).not.toBe(SAFETY_DEPTH_FIELD.min);
  });

  it('pins the METHOD, not only the value', () => {
    // Asserting the derivation is what lets a future reader run it backwards
    // (spec C.8 R2's rule, applied to the UI minimum rather than the gate).
    // The literals above are what catch a `minSafetyDepthM` that generalises
    // WRONGLY while staying self-consistent with this row.
    for (const b of [boatById(DEFAULT_BOAT_ID), DEEP, SHOAL]) {
      expect(safetyDepthFieldFor(b).min, `min for ${b.id}`).toBe(minSafetyDepthM(b));
    }
  });

  it('reduces to today for the catalogue default boat', () => {
    // The pre-#539 literal. If this moves, existing users' safety-depth input
    // changed its floor, which #539 item 2 must not do.
    expect(safetyDepthFieldFor(boatById(DEFAULT_BOAT_ID)).min).toBe(2.2);
    expect(SAFETY_DEPTH_FIELD.min).toBe(2.2);
  });

  it('leaves every boat-independent field untouched', () => {
    // Spread-then-override, so `max`/`step`/`labelKey`/`key` cannot drift into
    // a second hand-written table. A reimplementation that rebuilt the whole
    // spec from literals would pass every row above and fail here.
    const f = safetyDepthFieldFor(DEEP);
    expect(f.key).toBe(SAFETY_DEPTH_FIELD.key);
    expect(f.labelKey).toBe(SAFETY_DEPTH_FIELD.labelKey);
    expect(f.max).toBe(SAFETY_DEPTH_FIELD.max);
    expect(f.step).toBe(SAFETY_DEPTH_FIELD.step);
  });

  it('never returns a minimum at or below the boat’s own draft', () => {
    // The property the number exists for, stated independently of the
    // arithmetic: a UI floor at or under the keel is the one outcome no
    // rounding rule may produce (spec C.3's quantise-UP rule).
    for (const b of [boatById(DEFAULT_BOAT_ID), DEEP, SHOAL, { ...DEEP, draftM: 1.73 }]) {
      expect(safetyDepthFieldFor(b).min, `min for draft ${b.draftM}`).toBeGreaterThan(b.draftM);
    }
  });
});
