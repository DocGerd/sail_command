import { describe, expect, it } from 'vitest';
import {
  SEAMARKS_LAYOUT,
  pickSeamarkByPriority,
  seamarkFeatureCollectionWithIcons,
  type SeamarkFeatureCollection,
} from './seamarkGeoJson';
import { seamarkImageId } from './seamarkGlyphs';

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
  ],
};

describe('seamarkFeatureCollectionWithIcons', () => {
  it('adds icon and priority properties, preserving geometry and existing properties', () => {
    const withIcons = seamarkFeatureCollectionWithIcons(FC);
    expect(withIcons.features).toHaveLength(2);
    expect(withIcons.features[0].geometry).toEqual(FC.features[0].geometry);
    expect(withIcons.features[0].properties).toEqual({
      ...FC.features[0].properties,
      icon: seamarkImageId(FC.features[0].properties),
      // #200 hand-derived: unlit lateral = 8 (Tier 3 — danger-bearing per
      // R1001 §3.1 Table 16 "New Danger", but one datum on a channel edge, so
      // below the Tier 1 warnings and the Tier 2 scarce marks).
      priority: 8,
    });
    expect(withIcons.features[1].properties.icon).toBe('seamark-light-major');
    // #200 hand-derived: unlit light_major = 4 (Tier 2 — R1001 §2.7 "other
    // marks", ranked on §2.7.1.1's stated long/medium range).
    expect(withIcons.features[1].properties.priority).toBe(4);
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
  it('drops icon-padding to 0 (MapLibre default 2px/side) to offset the #191 collision-box growth', () => {
    expect(SEAMARKS_LAYOUT['icon-padding']).toBe(0);
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
