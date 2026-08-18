import type { BoatDef } from '../data/boats';
import { MASK_TOLERANCE_M } from './mask';

/**
 * Quantise UP to a decimetre. The mask encodes decimetres, so a gate of 3.15 m
 * behaves IDENTICALLY to 3.2 m — make that explicit rather than accidental.
 *
 * Never Math.round: measured, Math.round(1.73 * 10) === 17, which would give a
 * 1.73 m boat a 1.7 m relaxation floor UNDER ITS OWN KEEL (spec C.8).
 *
 * The 1e-9 nudge is not decoration. MEASURED 2026-08-14 in node: for draftM 3.2,
 * `3.2 + 0.9` is `4.1000000000000005` and `× 10` is `41.00000000000001`, so a
 * bare Math.ceil quantises to 4.2 m — a whole decimetre of gate the boat never
 * asked for. `3.7` is the same case; they are the only two in [1.00, 4.00].
 * The nudge absorbs it. Note `2.1 * 10` is EXACTLY 21 and is NOT an example of
 * the problem — do not cite it as one.
 */
export function ceilToDecimetre(x: number): number {
  return Math.ceil(x * 10 - 1e-9) / 10;
}

/**
 * Spec C.3. The invariant "no cell the router may plan through reads below the
 * hull on the conservative channel" holds iff G >= draft + T.
 *
 * T CANNOT be per-boat — one mask ships, one blend produced it, one constant
 * governs it. Every per-boat lever is on the GATE side. Do not reach for
 * MASK_TOLERANCE_M here.
 */
export function defaultSafetyDepthM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM + MASK_TOLERANCE_M);
}

/** Spec J OQ-1. Reproduces today's 2.2 m literal for the Salona 45's 2.1 m draft. */
export function minSafetyDepthM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM + 0.1);
}

/**
 * Spec C.4(a). THE SINGLE MOST DANGEROUS SHORTCUT IN THIS FEATURE is leaving
 * this as the module constant BOAT_DRAFT_M: relaxation would then take a
 * 2.30 m boat down to a 2.1 m gate — 0.2 m shallower than its keel before the
 * mask tolerance is even applied — while the shallow banner reports the
 * relaxation as if it were the Salona's.
 */
export function relaxationFloorM(b: BoatDef): number {
  return ceilToDecimetre(b.draftM);
}

export { MASK_TOLERANCE_M };
