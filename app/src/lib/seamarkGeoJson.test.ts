import { describe, expect, it } from 'vitest';
import {
  SEAMARKS_LAYOUT,
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
      // #200 hand-derived: unlit lateral = 6 (danger-bearing per R1001 §3.1
      // Table 16 "New Danger", but below the two self-contained hazard
      // warnings and below the long-range lighthouse; no light fields).
      priority: 6,
    });
    expect(withIcons.features[1].properties.icon).toBe('seamark-light-major');
    // #200 hand-derived: unlit light_major = 4 (R1001 §2.7 "other marks",
    // ranked on §2.7.1.1's stated long/medium range, below every hazard
    // warning but above the sequence-redundant laterals).
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
