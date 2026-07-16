import { describe, it, expect } from 'vitest';
import { harborFeatureCollection, resolveHarborPickTarget } from './harborGeoJson';
import type { Harbor } from '../types';

const HARBORS: Harbor[] = [
  {
    id: 'sonderborg',
    names: { de: 'Sonderburg', da: 'Sønderborg', en: 'Sønderborg' },
    country: 'DK',
    snap: { lat: 54.909, lon: 9.783 },
  },
  {
    id: 'flensburg',
    names: { de: 'Flensburg', da: 'Flensborg', en: 'Flensburg' },
    country: 'DE',
    snap: { lat: 54.795, lon: 9.435 },
    approachNote: { de: 'Hinweis', en: 'Note' },
  },
];

describe('harborFeatureCollection', () => {
  it('builds one point feature per harbor at its snap point ([lon, lat] order)', () => {
    const fc = harborFeatureCollection(HARBORS, 'de');
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].geometry).toEqual({ type: 'Point', coordinates: [9.783, 54.909] });
    expect(fc.features[1].properties.id).toBe('flensburg');
  });

  it('localizes names to the requested language', () => {
    expect(harborFeatureCollection(HARBORS, 'de').features[0].properties.name).toBe('Sonderburg');
    expect(harborFeatureCollection(HARBORS, 'en').features[0].properties.name).toBe('Sønderborg');
  });
});

describe('resolveHarborPickTarget', () => {
  it('fills origin first when nothing is armed', () => {
    expect(resolveHarborPickTarget(null, false)).toBe('origin');
  });

  it('fills destination once an origin exists', () => {
    expect(resolveHarborPickTarget(null, true)).toBe('destination');
  });

  it('honors an armed tap-to-pick target over the origin/destination default', () => {
    expect(resolveHarborPickTarget('origin', true)).toBe('origin');
    expect(resolveHarborPickTarget('destination', false)).toBe('destination');
  });

  it('yields nothing while armed for via (the raw tap handler owns that click)', () => {
    expect(resolveHarborPickTarget('via', false)).toBeNull();
    expect(resolveHarborPickTarget('via', true)).toBeNull();
  });
});
