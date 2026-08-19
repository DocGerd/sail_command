import type { BoatDef, PolarTier } from '../data/boats';
import type { MsgKey } from '../i18n/dict.de';

/**
 * Spec G.3's tiers, ranked weakest-highest. A `Record<PolarTier, number>`
 * rather than an array so adding a tier to the union reds this table at
 * compile time instead of silently ranking as `undefined`.
 */
const TIER_RANK: Record<PolarTier, number> = {
  certificate: 0,
  modelled: 1,
  estimated: 2,
};

export const POLAR_TIER_LABEL_KEY: Record<PolarTier, MsgKey> = {
  certificate: 'boat.polarTier.certificate',
  modelled: 'boat.polarTier.modelled',
  estimated: 'boat.polarTier.estimated',
};

/**
 * A boat carries one provenance tier PER SAIL — the Salona 45 ships a tier-A
 * jib beside a tier-B genoa — so a single boat-level chip has to reduce them.
 * It reduces to the WEAKEST, never the strongest:
 *
 *  - Spec G.2: #54's headline capability is the sail comparison, and a
 *    comparison is driven by the DIFFERENCE between two tables, so it is only
 *    ever as good as the weaker of them.
 *  - Per this repo's guard-asymmetry rule the two failure directions cost
 *    very different amounts, and labelling an estimated table as
 *    certificate-grade is the expensive one.
 *
 * This is the weakest tier WITHIN one boat, which is NOT the catalogue-wide
 * worst case spec J OQ-2 rejects: OQ-2 forbids showing one boat the fleet's
 * worst number, and every tier reduced here belongs to the boat being
 * labelled. The per-sail tiers stay individually visible in the picker's
 * provenance disclosure — this chip summarises them, it does not replace them.
 *
 * A sail-less boat cannot occur in today's catalogue, but `BoatDef.sails` is
 * typed `readonly SailDef[]` and so permits one. Returning the most cautious
 * label for that case is the fail-closed direction; deriving from an empty
 * list instead — `Math.max` of nothing is `-Infinity` — would index the tier
 * table with a value that is not a tier at all.
 *
 * The two sails above are named WITHOUT quote characters on purpose.
 * `src/test/sailLiteralCallSites.test.ts` scans every non-test file for a
 * bare quoted catalogue sail id in all three quote forms, and it caught an
 * earlier revision of this very comment for writing them in backticks. Prose
 * is not exempt from spec F.3's rule, and the guard was right: a comment
 * naming an id is one edit away from code naming it.
 */
export function weakestPolarTier(b: BoatDef): PolarTier {
  let worst: PolarTier = 'estimated';
  let seen = false;
  for (const sail of b.sails) {
    const tier = sail.polarProvenance.tier;
    if (!seen || TIER_RANK[tier] > TIER_RANK[worst]) {
      worst = tier;
      seen = true;
    }
  }
  return worst;
}
