import { describe, expect, it } from 'vitest';
import { weakestPolarTier } from './boatProvenance';
import { boatById, DEFAULT_BOAT_ID } from '../data/boats';

// PR #563 MINOR 3. `weakestPolarTier`'s mixed-tier behaviour is exercised
// through the picker (BoatPicker.test.tsx / BoatPicker.multiBoat.test.tsx),
// but the sail-less case cannot be: no catalogue entry has an empty `sails`
// list and the picker has no way to render one. That left the JSDoc's
// explicit fail-closed safety claim with no keeper.

describe('#54 weakestPolarTier: the fail-closed empty case', () => {
  it('returns the most cautious tier for a boat with no sails at all', () => {
    // `BoatDef.sails` is typed `readonly SailDef[]`, so an empty list is
    // type-permitted even though today's catalogue has none. Fail-closed is
    // the direction: deriving from an empty list instead — `Math.max` of
    // nothing is `-Infinity` — would index the tier table with a non-tier.
    // MEASURED: without this row, flipping the initial value to
    // 'certificate' leaves the two BoatPicker files 28/28 green. The stale
    // '23/23' this comment used to carry (25/25 by the time #569 first
    // touched it) predates #566's THREE new rows — one in BoatPicker.test.tsx
    // (`it('#566: renders every boat's draftProvenance.note...`), two in
    // BoatPicker.multiBoat.test.tsx (the `#566` describe block) — which move
    // the total 25 -> 28. Re-measure with `grep -c "it(\|test("` on both
    // files rather than hand-adding, since the count drifts with every row
    // either file gains and this comment has already been wrong twice.
    const sailless = { ...boatById(DEFAULT_BOAT_ID), sails: [] };
    expect(weakestPolarTier(sailless)).toBe('estimated');
  });
});
