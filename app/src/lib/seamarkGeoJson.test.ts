import { describe, expect, it } from 'vitest';
import {
  SEAMARKS_LAYOUT,
  pickSeamarkByPriority,
  seamarkFeatureCollectionWithIcons,
  seamarkHazardFilter,
  seamarkPopupAnchor,
  seamarkRoutineFilter,
  seamarksLayout,
  type SeamarkFeatureCollection,
} from './seamarkGeoJson';
import {
  SEAMARK_DISPLAY_TIER_ALL,
  SEAMARK_DISPLAY_TIER_BASE,
  SEAMARK_DISPLAY_TIER_STANDARD,
  SEAMARK_NATURAL_ICON_PX,
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
      // #682 hand-derived: `lateral` is Tier 3 in FAMILY_RANK, not Tier 1
      // (isolatedDanger/cardinal) — HAZARD_SEAMARK_FAMILIES excludes it, so
      // this renders on the routine `sc-seamarks` layer, not the hazard
      // overlay.
      hazard: false,
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
    // #682 hand-derived: `lightMajor` is Tier 2, not Tier 1 — not a hazard
    // family either, despite also being BASE display tier (the two are
    // independent classifications).
    expect(withIcons.features[1].properties.hazard).toBe(false);
    expect(withIcons.features[2].properties.icon).toBe('seamark-light-minor');
    // #513 F1/F2 hand-derived: `lightMinor` is display-category STANDARD —
    // MSC.232(82) Appendix 2 item 2.3's undivided "buoys, beacons, other
    // aids to navigation" group is Standard Display, promoted here from the
    // first #353 PR2 revision's (wrong) ALL placement.
    expect(withIcons.features[2].properties.displayTier).toBe(SEAMARK_DISPLAY_TIER_STANDARD);
    // #682 hand-derived: `lightMinor` is Tier 4 — not a hazard family.
    expect(withIcons.features[2].properties.hazard).toBe(false);
  });

  // #682: a discriminating positive case for BOTH hazard families —
  // #455/CLAUDE.md's "give any probe whose emptiness you intend to
  // interpret a positive control" lesson: the three cases above are all
  // `hazard: false`, so without this test a stubbed-always-false
  // `isHazardSeamark` would pass every assertion in this file.
  it('stamps hazard: true for BOTH Tier 1 families (isolatedDanger, cardinal) and hazard: false for a non-hazard family', () => {
    const mixed: SeamarkFeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10.0, 54.5] },
          properties: { seamarkType: 'buoy_isolated_danger' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10.1, 54.6] },
          properties: { seamarkType: 'buoy_cardinal', category: 'north' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [10.2, 54.7] },
          properties: { seamarkType: 'buoy_safe_water' },
        },
      ],
    };
    const withIcons = seamarkFeatureCollectionWithIcons(mixed);
    expect(withIcons.features[0].properties.hazard).toBe(true);
    expect(withIcons.features[1].properties.hazard).toBe(true);
    // safeWater is Tier 2, not Tier 1 — the control that proves this isn't
    // vacuously true for every feature.
    expect(withIcons.features[2].properties.hazard).toBe(false);
  });
});

// #682: the routine/hazard layer split. Pinned by literal AST shape (this
// repo's tests can't evaluate a MapLibre expression tree without a real
// style engine — the e2e order comparison in datalayers.spec.ts is what
// exercises these filters against real rendered features).
//
// #682 review MINOR A: the two `it`s below pin the
// `['<=', ['get', 'displayTier'], tier]` SHAPE at all three real tier
// values (BASE, STANDARD, ALL) — shape coverage IS preserved from the
// former standalone `seamarkDisplayFilter` describe block (deleted as dead
// code, see seamarkDisplayTierExpression's own doc comment). VALUE
// coverage was NOT: writing a `SEAMARK_DISPLAY_TIER_*` constant on BOTH
// sides of `toEqual` is a tautology with respect to the constant's own
// value and cannot catch a renumbering (MEASURED: mutating
// `SEAMARK_DISPLAY_TIER_BASE` 0 -> 5 reds nothing here). The third `it`
// below restores that, pinning the literal tier NUMBERS directly.
describe('seamarkRoutineFilter / seamarkHazardFilter (#682)', () => {
  it('each ANDs the SAME display-tier cut with the opposite half of `hazard`', () => {
    expect(seamarkRoutineFilter(SEAMARK_DISPLAY_TIER_STANDARD)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], SEAMARK_DISPLAY_TIER_STANDARD],
      ['!', ['get', 'hazard']],
    ]);
    expect(seamarkHazardFilter(SEAMARK_DISPLAY_TIER_STANDARD)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], SEAMARK_DISPLAY_TIER_STANDARD],
      ['get', 'hazard'],
    ]);
  });

  it('carries the selected tier through unchanged at BASE and ALL too, not just STANDARD', () => {
    expect(seamarkRoutineFilter(SEAMARK_DISPLAY_TIER_BASE)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], SEAMARK_DISPLAY_TIER_BASE],
      ['!', ['get', 'hazard']],
    ]);
    expect(seamarkHazardFilter(SEAMARK_DISPLAY_TIER_ALL)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], SEAMARK_DISPLAY_TIER_ALL],
      ['get', 'hazard'],
    ]);
  });

  // #682 review MINOR A: hand-written literal tier NUMBERS (0/1/2), not the
  // SEAMARK_DISPLAY_TIER_* constants — deriving needle and haystack from one
  // source is the worse tautology (CLAUDE.md). The input side still passes
  // the constant (so this also proves BASE/STANDARD/ALL currently equal
  // 0/1/2); the EXPECTED side is what breaks the tautology, since a
  // renumbered constant would move the function's real output away from
  // this fixed literal.
  it('pins the literal tier numbers 0/1/2 directly, not the SEAMARK_DISPLAY_TIER_* constants', () => {
    expect(seamarkRoutineFilter(SEAMARK_DISPLAY_TIER_BASE)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], 0],
      ['!', ['get', 'hazard']],
    ]);
    expect(seamarkHazardFilter(SEAMARK_DISPLAY_TIER_STANDARD)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], 1],
      ['get', 'hazard'],
    ]);
    expect(seamarkRoutineFilter(SEAMARK_DISPLAY_TIER_ALL)).toEqual([
      'all',
      ['<=', ['get', 'displayTier'], 2],
      ['!', ['get', 'hazard']],
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

  // #860: the top stop moved from 0.85@z13 (pre-#860, 27.2px forever past
  // z13 — an 18-26px tap target) to 1.4@z13 (44.8px). The new (12,0.775)
  // anchor is not a fresh design choice — it's the value the OLD
  // (11,0.7)-(13,0.85) line already gave at z=12, re-used so the [8,12)
  // prefix is provably byte-identical to before (see BASE_ICON_SIZE_STOPS'
  // own doc comment for the derivation).
  it('tapers icon size 0.55@z8 -> 0.7@z11 -> 0.775@z12 -> 1.4@z13 (#860: only the z12/z13 stops changed)', () => {
    expect(SEAMARKS_LAYOUT['icon-size']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      0.55,
      11,
      0.7,
      12,
      0.775,
      13,
      1.4,
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
      12,
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
    // #860: four stops now (8/11/12/13), so four value indices — 4, 6, 8, 10.
    for (const stopValue of [padding[4], padding[6], padding[8], padding[10]]) {
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
//   icon-size:    base * 2            -> 0.55*2=1.1, 0.7*2=1.4, 0.775*2=1.55,
//                 1.4*2=2.8
//   icon-padding: (1-2)*base*32/2 = -16*base -> -16*0.55=-8.8,
//                 -16*0.7=-11.2, -16*0.775=-12.4, -16*1.4=-22.4
// This test file NEVER calls iconPaddingAt/seamarksLayout to derive its own
// expectations — only to produce the ACTUAL value under test — so it cannot
// pass by the #50 equivalence-test tautology.
describe('seamarksLayout(scale) at a non-default scale (#484 F1) — pinned against HAND-DERIVED values, not the production formula', () => {
  it('scales icon-size to 1.1 / 1.4 / 1.55 / 2.8 at scale=2 (#860: fourth stop added)', () => {
    expect(seamarksLayout(2)['icon-size']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      1.1,
      11,
      1.4,
      12,
      1.55,
      13,
      2.8,
    ]);
  });

  it('compensates icon-padding to -8.8 / -11.2 / -12.4 / -22.4 at scale=2 (#860: fourth stop added)', () => {
    expect(seamarksLayout(2)['icon-padding']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      8,
      -8.8,
      11,
      -11.2,
      12,
      -12.4,
      13,
      -22.4,
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
    // #860: four stops now (8/11/12/13) — value indices 4, 6, 8, 10.
    const stops = [padding[4], padding[6], padding[8], padding[10]];
    for (const stopValue of stops) {
      expect(typeof stopValue).toBe('number');
      expect(stopValue as number).toBeLessThan(0);
    }
  });
});

// #860: seamark glyphs were tappable only inside an 18-26px target (the
// pre-#860 icon-size taper topped out at 0.85@z13, clamped there forever —
// `interpolate` clamps outside its domain), below the locked >=44px
// gloved-use touch-target floor CLAUDE.md's a11y-ranking ruling applies to
// this issue. These tests pin the CONSEQUENCE of the BASE_ICON_SIZE_STOPS
// change (its own doc comment in seamarkGeoJson.ts carries the derivation)
// as two SEPARATE, independently mutation-checkable claims: the floor is
// actually met, AND the z<12 prefix — the only zoom band where
// `icon-overlap` is 'never' and a bigger collision box could cull a mark
// (#191/#192) — is untouched.
describe('#860: seamark tap-target floor (>=44px gloved-use)', () => {
  it('the top icon-size stop displays at >=44 CSS px at the default SEAMARK_SIZE_SCALE=1', () => {
    const iconSize = SEAMARKS_LAYOUT['icon-size'] as readonly unknown[];
    const topStopValue = iconSize[iconSize.length - 1] as number;
    // Hand-derived (32 = SEAMARK_NATURAL_ICON_PX, imported, not re-declared
    // here — CLAUDE.md's twin-search rule) rather than calling any
    // production formula, so this can't pass by the #50 equivalence-test
    // tautology.
    expect(topStopValue * SEAMARK_NATURAL_ICON_PX).toBeGreaterThanOrEqual(44);
  });

  // Mutation check (evidence for the PR description, not a duplicate of the
  // assertion above): the pre-#860 top stop was 0.85, which the SAME
  // formula puts at 27.2px — well under the floor. Run against a checkout
  // of the pre-#860 code, the test above fails with exactly this shape.
  it('documents the pre-#860 regime the assertion above must fail against: 0.85 * 32 = 27.2px, under the floor', () => {
    expect(0.85 * SEAMARK_NATURAL_ICON_PX).toBeLessThan(44);
  });

  it('leaves the z8-z11 icon-size prefix byte-identical to the pre-#860 layout — culling risk is confined to z<12', () => {
    const iconSize = SEAMARKS_LAYOUT['icon-size'] as readonly unknown[];
    expect(iconSize.slice(0, 7)).toEqual(['interpolate', ['linear'], ['zoom'], 8, 0.55, 11, 0.7]);
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

// #232 item 4: anchor the popup at the picked feature's own coordinates only
// when the priority pick differs from the topmost feature — the one case
// where the user has no other cue which mark the popover describes. The
// ordinary (single-feature, or tied) click keeps the tap-point anchor.
describe('seamarkPopupAnchor (#232 item 4)', () => {
  const pointFeature = (seamarkType: string, priority: number, coords: [number, number]) => ({
    properties: { seamarkType, priority },
    geometry: { type: 'Point' as const, coordinates: coords },
  });
  const TAP: [number, number] = [10.5, 54.5];

  it('anchors at the picked feature when the priority pick differs from the topmost', () => {
    // Topmost (features[0]) is the LEAST significant — a routine special-
    // purpose buoy painted on top of a cardinal underneath it (#200's
    // z>=12 paint-order inversion, item 1, is exactly why this can happen).
    const topmost = pointFeature('buoy_special_purpose', 12, [10.9, 54.9]);
    const cardinal = pointFeature('buoy_cardinal', 2, [10.1, 54.1]);
    const picked = pickSeamarkByPriority([topmost, cardinal]);
    expect(picked).toBe(cardinal);
    expect(seamarkPopupAnchor(picked, topmost, TAP)).toEqual([10.1, 54.1]);
  });

  it('keeps the tap-point anchor when the pick IS the topmost feature (the ordinary, non-overlapping case)', () => {
    const only = pointFeature('buoy_lateral', 8, [10.9, 54.9]);
    const picked = pickSeamarkByPriority([only]);
    expect(picked).toBe(only);
    expect(seamarkPopupAnchor(picked, only, TAP)).toBe(TAP);
  });

  it('keeps the tap-point anchor on a tie (pickSeamarkByPriority itself falls back to topmost)', () => {
    const a = pointFeature('buoy_cardinal', 2, [10.9, 54.9]);
    const b = pointFeature('beacon_cardinal', 2, [10.1, 54.1]);
    const picked = pickSeamarkByPriority([a, b]);
    expect(picked).toBe(a); // pickSeamarkByPriority's own documented tie rule
    expect(seamarkPopupAnchor(picked, a, TAP)).toBe(TAP);
  });

  it('falls back to the tap point for an undefined pick (no features)', () => {
    expect(seamarkPopupAnchor(undefined, undefined, TAP)).toBe(TAP);
  });

  it('falls back to the tap point when the picked feature has no Point geometry (defensive)', () => {
    const picked = { properties: { seamarkType: 'buoy_cardinal', priority: 2 } };
    const topmost = { properties: { seamarkType: 'buoy_special_purpose', priority: 12 } };
    expect(seamarkPopupAnchor(picked, topmost, TAP)).toBe(TAP);
  });
});
