import { describe, expect, it } from 'vitest';
import { defaultMaxFrontier } from './isochrone';
import { mask } from '../test/realmaskFixtures';

/**
 * #1257: `MAX_FRONTIER` was a flat 30 000 sized for the pre-#295 domain, so
 * #295's 1.7875x widening raised truncation pressure — 19 of the 39 plans
 * that moved in that sweep newly hit the cap. The cap now scales with the
 * domain's PRUNE-CELL count; see `FRONTIER_PER_PRUNE_CELL`'s own comment in
 * isochrone.ts for the basis and the peak measurements behind 0.2.
 *
 * Every expectation below is HAND-DERIVED from the domain's degree spans and
 * `PRUNE_LAT`/`PRUNE_LON`, never recomputed with the production formula —
 * deriving needle and haystack from one source is the tautology this repo
 * keeps paying for (#388).
 */
describe('#1257 defaultMaxFrontier', () => {
  it('the committed mask resolves to 95_333', () => {
    // 55.6 - 54.3 = 1.3 deg / PRUNE_LAT 0.002 = 650 rows of prune cells.
    // 11.6 -  9.4 = 2.2 deg / PRUNE_LON 0.003 = 733.33 cols.
    // 650 * 733.33 = 476 666.67 prune cells; * 0.2 = 95 333.33 -> 95 333.
    expect([mask.meta.south, mask.meta.north, mask.meta.west, mask.meta.east]).toEqual([
      54.3, 55.6, 9.4, 11.6,
    ]);
    expect(defaultMaxFrontier(mask.meta)).toBe(95_333);
  });

  it('clears the worst frontier peak measured post-#1322', () => {
    // Worst uncapped peak measured over 8 of the sweep's 440 plans (breeze
    // aperture, solo) is 64 402, rudkoebing / Salona 44 / genoa.
    //
    // NOT redundant with the exact pin above, and the difference is what it
    // catches: that pin fixes the CURRENT constant, so anyone who re-derives
    // 0.2 downward re-pins it mechanically and it stays green. This one pins
    // the FLOOR of admissible constants against the evidence — any value
    // below 0.1351 reds HERE while the re-pinned exact assertion passes.
    // It is a HEADROOM check over a SAMPLE, never a proof the cap cannot bind.
    expect(defaultMaxFrontier(mask.meta)).toBeGreaterThan(64_402);
  });

  it('the pre-#295 domain resolves to 53_333', () => {
    // 1.0 deg / 0.002 = 500; 1.6 deg / 0.003 = 533.33; 500 * 533.33 =
    // 266 666.67; * 0.2 = 53 333.33 -> 53 333. Above the 30 000 floor, so
    // the old domain was ALSO being truncated below what 0.2 asks for —
    // 30 000 was #67's figure, never derived from a peak.
    expect(defaultMaxFrontier({ south: 54.3, north: 55.3, west: 9.4, east: 11.0 })).toBe(53_333);
  });

  it('a synthetic-sized mask keeps the 30_000 floor', () => {
    // 0.1 deg / 0.002 = 50; 0.1 deg / 0.003 = 33.33; 1666.67 * 0.2 = 333.
    expect(defaultMaxFrontier({ south: 54.3, north: 54.4, west: 9.4, east: 9.5 })).toBe(30_000);
  });

  it('scales linearly with domain area', () => {
    // Structural, independent of the constant's VALUE: doubling the lon span
    // doubles the cap. A future re-derivation may move 0.2 and must not be
    // able to break the scaling law without reddening something.
    const oneX = defaultMaxFrontier({ south: 54.3, north: 55.6, west: 9.4, east: 11.6 });
    const twoX = defaultMaxFrontier({ south: 54.3, north: 55.6, west: 9.4, east: 13.8 });
    // Within one unit, because each side rounds independently (190 666.67 ->
    // 190 667 against 2 * 95 333). An exact equality here would depend on
    // 0.2's own rounding and so would NOT be independent of its value.
    expect(Math.abs(twoX - 2 * oneX)).toBeLessThanOrEqual(1);
  });
});
