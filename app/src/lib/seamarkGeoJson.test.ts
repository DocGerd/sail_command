import { describe, expect, it } from 'vitest';
import {
  SEAMARKS_LAYOUT,
  pickSeamarkByPriority,
  seamarkDisplayFilter,
  seamarkFeatureCollectionWithIcons,
  seamarksLayout,
  type SeamarkFeatureCollection,
} from './seamarkGeoJson';
import {
  SEAMARK_DISPLAY_TIER_ALL,
  SEAMARK_DISPLAY_TIER_BASE,
  SEAMARK_DISPLAY_TIER_STANDARD,
  seamarkImageId,
} from './seamarkGlyphs';

const FC: SeamarkFeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10.6, 54.4] },
      properties: { seamarkType: 'buoy_lateral', category: 'port', colour: 'red' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10.2, 54.9] },
      properties: { seamarkType: 'light_major' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [10.4, 54.7] },
      properties: { seamarkType: 'light_minor' },
    },
  ],
};

describe('seamarkFeatureCollectionWithIcons', () => {
  it('adds icon and priority properties, preserving geometry and existing properties', () => {
    const withIcons = seamarkFeatureCollectionWithIcons(FC);
    expect(withIcons.features).toHaveLength(3);
    expect(withIcons.features[0].geometry).toEqual(FC.features[0].geometry);
    expect(withIcons.features[0].properties).toEqual({
      ...FC.features[0].properties,
      icon: seamarkImageId(FC.features[0].properties),
      // #200 hand-derived: unlit lateral = 8 (Tier 3 — danger-bearing per
      // R1001 §3.1 Table 16 "New Danger", but one datum on a channel edge, so
      // below the Tier 1 warnings and the Tier 2 scarce marks).
      priority: 8,
      // #353 PR2 hand-derived: `lateral` is in the display-category BASE
      // floor (danger-bearing per the same Table 16 citation as `priority`
      // above) — see seamarkGlyphs.ts's `seamarkDisplayTier` doc comment.
      displayTier: SEAMARK_DISPLAY_TIER_BASE,
    });
    expect(withIcons.features[1].properties.icon).toBe('seamark-light-major');
    // #200 hand-derived: unlit light_major = 4 (Tier 2 — R1001 §2.7 "other
    // marks", ranked on §2.7.1.1's stated long/medium range).
    expect(withIcons.features[1].properties.priority).toBe(4);
    // #513 F1/F2 hand-derived: `lightMajor` is in the display-category BASE
    // floor (a scarce landfall/passage anchor this app's product-specific
    // Base includes — see seamarkGlyphs.ts's `seamarkDisplayTier` doc
    // comment; MSC.232(82)'s own Display Base contains no AtoN class at all).
    expect(withIcons.features[1].properties.displayTier).toBe(SEAMARK_DISPLAY_TIER_BASE);
    expect(withIcons.features[2].properties.icon).toBe('seamark-light-minor');
    // #513 F1/F2 hand-derived: `lightMinor` is display-category STANDARD —
    // MSC.232(82) Appendix 2 item 2.3's undivided "buoys, beacons, other
    // aids to navigation" group is Standard Display, promoted here from the
    // first #353 PR2 revision's (wrong) ALL placement.
    expect(withIcons.features[2].properties.displayTier).toBe(SEAMARK_DISPLAY_TIER_STANDARD);
  });
});

// #353 PR2: the display-category filter expression, unit-tested directly so
// a typo'd MapLibre expression fails at test time rather than only at
// runtime (mirrors the #144 rationale on SEAMARKS_LAYOUT's own pin below —
// enum/expression shapes typo silently past `tsc`).
describe('seamarkDisplayFilter (#353 PR2)', () => {
  it('is cumulative: ALL reproduces the pre-#353 "show everything" shape (tier <= 2 matches every real tier)', () => {
    expect(seamarkDisplayFilter(SEAMARK_DISPLAY_TIER_ALL)).toEqual([
      '<=',
      ['get', 'displayTier'],
      SEAMARK_DISPLAY_TIER_ALL,
    ]);
  });

  it('BASE (0) only matches features whose own displayTier is 0', () => {
    expect(seamarkDisplayFilter(SEAMARK_DISPLAY_TIER_BASE)).toEqual([
      '<=',
      ['get', 'displayTier'],
      0,
    ]);
  });
});

// #144: literals pinned from the approved design, not from runtime output.
// icon-overlap is enum-valued ('never'|'always'|'cooperative') and a typo'd
// enum string fails at RUNTIME, not typecheck — this pin plus the real-browser
// pass is the guard.
describe('SEAMARKS_LAYOUT (#144 priority-culled, zoom-sized seamark icons)', () => {
  it('reads the precomputed per-feature icon and priority (data-driven, no style-side re-derivation)', () => {
    expect(SEAMARKS_LAYOUT['icon-image']).toEqual(['get', 'icon']);
    expect(SEAMARKS_LAYOUT['symbol-sort-key']).toEqual(['get', 'priority']);
  });

  it('culls by priority below z12 and becomes tap-safe overlap at z>=12 (popup-safety valve, #36)', () => {
    expect(SEAMARKS_LAYOUT['icon-overlap']).toEqual(['step', ['zoom'], 'never', 12, 'always']);
  });

  it('tapers icon size 0.55@z8 -> 0.7@z11 -> 0.85@z13 (pre-#144 constant 0.85 kept as the top stop)', () => {
    expect(SEAMARKS_LAYOUT['icon-size']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      0.55,
      11,
      0.7,
      13,
      0.85,
    ]);
  });

  // #191/#192 review: the enlarged raster (24->32 logical px natural
  // footprint) grows the below-z12 collision box (icon box + icon-padding)
  // and measurably culls more marks at the same zoom. Zeroing the padding
  // (MapLibre default 2px/side) claws back part of that growth without
  // touching the z12 overlap threshold or the icon-size taper.
  //
  // #353 PR1: icon-padding is now a per-zoom-stop interpolate expression
  // (compensated from SEAMARK_SIZE_SCALE — see SEAMARKS_LAYOUT's own doc
  // comment for the derivation), not a bare literal. At the shipped default
  // scale of 1 every stop must still evaluate to exactly 0 — this is the
  // "byte-identical at scale=1" claim for the ONE value in this layer that
  // is not a straight `base * scale` multiplication (icon-size's `x * 1`
  // is exact by IEEE-754 construction; icon-padding's `(1 - 1) * x / 2`
  // needs its own pin because it's a different formula shape).
  it('compensates icon-padding to exactly 0 at every zoom stop at the default SEAMARK_SIZE_SCALE=1 (#353 PR1), still offsetting the #191 collision-box growth', () => {
    expect(SEAMARKS_LAYOUT['icon-padding']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      0,
      11,
      0,
      13,
      0,
    ]);
    // #484 F8: `toBe` in vitest IS `Object.is` — it would already catch a
    // `-0` here perfectly well; the contrast CLAUDE.md's #203 rule draws is
    // with `toEqual`, which treats -0 and 0 as the same. This explicit
    // `Object.is` check below is not needed to distinguish `toBe` from
    // `toEqual` (both would already work); it exists because `-0` here is
    // otherwise BEHAVIOURALLY INERT — `icon.x1 - (-0) === icon.x1` in
    // `collision_feature.ts`, `-0 === 0` for any style diffing, and
    // `JSON.stringify(-0)` is `"0"` — so a `-0` would never actually reach
    // MapLibre or change rendering. What this pins is the compensation
    // FORMULA'S SPELLING, not runtime behaviour: the natural alternative
    // spelling `-(scale - 1) * baseIconSize * SEAMARK_NATURAL_ICON_PX / 2`
    // is a reachable refactor that DOES produce `-0` at scale = 1 (negating
    // a positive-zero result), so this row is a real, non-vacuous mutation
    // guard against that rewrite — just not a guard against any actual
    // rendering defect.
    const padding = SEAMARKS_LAYOUT['icon-padding'] as readonly unknown[];
    for (const stopValue of [padding[4], padding[6], padding[8]]) {
      expect(Object.is(stopValue, -0), `expected +0, got ${String(stopValue)}`).toBe(false);
    }
  });
});

// #484 F1: the two tests above only ever exercise SEAMARK_SIZE_SCALE = 1
// (a module constant fixed for the whole of PR1), where `iconPaddingAt`
// returns `+0` at every stop — so replacing every `iconPaddingAt(...)` call
// site with a literal `0` left BOTH tests above green (measured; see the PR
// description). `seamarksLayout(scale)` (seamarkGeoJson.ts) exists so this
// file can drive a scale the module constant can't reach.
//
// Every expected value below is HAND-DERIVED from the growth formula in
// `iconPaddingAt`'s own doc comment (`padding(scale) = ((1 - scale) *
// baseIconSize * NATURAL) / 2`, NATURAL = SEAMARK_NATURAL_ICON_PX = 32 at
// scale 1, from seamarkGlyphs.ts's BASE_CANVAS_SIZE/BASE_PIXEL_RATIO) —
// scale 2 is chosen because every operation involved (multiply/divide by a
// power of two) is EXACT in IEEE-754, so the hand math and the production
// formula's actual floating-point output agree bit-for-bit with no rounding
// ambiguity either could hide behind (verified via a throwaway `node -e`
// during review, not asserted from memory):
//   icon-size:    base * 2            -> 0.55*2=1.1, 0.7*2=1.4, 0.85*2=1.7
//   icon-padding: (1-2)*base*32/2 = -16*base -> -16*0.55=-8.8,
//                 -16*0.7=-11.2, -16*0.85=-13.6
// This test file NEVER calls iconPaddingAt/seamarksLayout to derive its own
// expectations — only to produce the ACTUAL value under test — so it cannot
// pass by the #50 equivalence-test tautology.
describe('seamarksLayout(scale) at a non-default scale (#484 F1) — pinned against HAND-DERIVED values, not the production formula', () => {
  it('scales icon-size to 1.1 / 1.4 / 1.7 at scale=2', () => {
    expect(seamarksLayout(2)['icon-size']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      1.1,
      11,
      1.4,
      13,
      1.7,
    ]);
  });

  it('compensates icon-padding to -8.8 / -11.2 / -13.6 at scale=2', () => {
    expect(seamarksLayout(2)['icon-padding']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      -8.8,
      11,
      -11.2,
      13,
      -13.6,
    ]);
  });

  // #484 F3: negative icon-padding is UNSPECIFIED MapLibre behaviour this
  // formula depends on (no floor in `Padding.parse`
  // @maplibre/maplibre-gl-style-spec@26.2.1, no `minimum` in the v8 spec's
  // `icon-padding` entry — an ABSENCE, not a guarantee). If a future
  // MapLibre release adds a floor at 0, the compensation above silently
  // becomes a no-op, the collision box grows in lockstep with icon size
  // exactly as #191/#192 did, and nothing throws or warns. This assertion
  // is what would catch that: it fails the moment a stop stops being
  // negative, independent of the exact literal values pinned above (which
  // could be retuned without this guard's intent changing).
  it('#484 F3: the compensation actually goes NEGATIVE at scale > 1 — a future MapLibre padding floor must red this', () => {
    const padding = seamarksLayout(2)['icon-padding'] as readonly unknown[];
    const stops = [padding[4], padding[6], padding[8]];
    for (const stopValue of stops) {
      expect(typeof stopValue).toBe('number');
      expect(stopValue as number).toBeLessThan(0);
    }
  });
});

// #200: `symbol-sort-key` drives placement below z12 (lower wins collisions)
// AND paint order at z>=12 (HIGHER paints on top). queryRenderedFeatures
// returns top-to-bottom, so the topmost feature at harbor-approach zoom is the
// LEAST significant of an overlapping group — the tap must be resolved by
// priority instead. Expected values are the #200 ranks hand-derived in
// seamarkGlyphs.test.ts (cardinal 2, lateral 8, specialPurpose 12), not read
// back from seamarkPriority.
describe('pickSeamarkByPriority (#200 tap resolution at z>=12)', () => {
  const feat = (seamarkType: string, priority: number) => ({
    properties: { seamarkType, priority },
  });

  it('picks the lowest priority, not the topmost, whatever the query order', () => {
    // A cardinal (2) buried under a special-purpose buoy (12): MapLibre hands
    // the special mark over first because it paints on top.
    const topmostFirst = [feat('buoy_special_purpose', 12), feat('buoy_cardinal', 2)];
    expect(pickSeamarkByPriority(topmostFirst)?.properties.seamarkType).toBe('buoy_cardinal');
    // Order must not matter — same answer with the cardinal already first.
    expect(pickSeamarkByPriority([...topmostFirst].reverse())?.properties.seamarkType).toBe(
      'buoy_cardinal',
    );
  });

  it('picks the single hazard mark out of a dense stack', () => {
    const stack = [
      feat('buoy_special_purpose', 12),
      feat('light_minor', 10),
      feat('buoy_lateral', 8),
      feat('buoy_isolated_danger', 0),
      feat('buoy_lateral', 7),
    ];
    expect(pickSeamarkByPriority(stack)?.properties.seamarkType).toBe('buoy_isolated_danger');
  });

  it('keeps ties on the topmost feature (MapLibre order is the right tiebreak)', () => {
    const a = feat('buoy_cardinal', 2);
    const b = feat('beacon_cardinal', 2);
    expect(pickSeamarkByPriority([a, b])).toBe(a);
    expect(pickSeamarkByPriority([b, a])).toBe(b);
  });

  it('is a no-op for the single-feature case (every tap below z12)', () => {
    const only = feat('buoy_lateral', 8);
    expect(pickSeamarkByPriority([only])).toBe(only);
  });

  it('returns undefined for an empty or absent feature list', () => {
    expect(pickSeamarkByPriority([])).toBeUndefined();
    expect(pickSeamarkByPriority(undefined)).toBeUndefined();
  });

  // Defensive: a feature with no numeric priority must never displace one that
  // has it, and an all-unranked set falls back to the previous features[0].
  it('never lets an unranked feature beat a ranked one, and falls back to topmost', () => {
    const unranked = { properties: { seamarkType: 'buoy_lateral' } };
    const ranked = feat('buoy_cardinal', 2);
    expect(pickSeamarkByPriority([unranked, ranked])).toBe(ranked);
    expect(pickSeamarkByPriority([ranked, unranked])).toBe(ranked);
    expect(pickSeamarkByPriority([unranked, { properties: {} }])).toBe(unranked);
    expect(pickSeamarkByPriority([{ properties: { priority: 'nope' } }, ranked])).toBe(ranked);
  });
});
