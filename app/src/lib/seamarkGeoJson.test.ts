import { describe, expect, it } from 'vitest';
import { seamarkFeatureCollectionWithIcons, type SeamarkFeatureCollection } from './seamarkGeoJson';
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
  it('adds an icon property computed by seamarkImageId, preserving geometry and existing properties', () => {
    const withIcons = seamarkFeatureCollectionWithIcons(FC);
    expect(withIcons.features).toHaveLength(2);
    expect(withIcons.features[0].geometry).toEqual(FC.features[0].geometry);
    expect(withIcons.features[0].properties).toEqual({
      ...FC.features[0].properties,
      icon: seamarkImageId(FC.features[0].properties),
    });
    expect(withIcons.features[1].properties.icon).toBe('seamark-light-major');
  });
});
