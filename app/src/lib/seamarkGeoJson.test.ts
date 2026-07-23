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
      // #144 hand-derived: unlit lateral = 10 (family rank 10, no light fields).
      priority: 10,
    });
    expect(withIcons.features[1].properties.icon).toBe('seamark-light-major');
    // #144 hand-derived: unlit light_major = family rank 0.
    expect(withIcons.features[1].properties.priority).toBe(0);
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
});
