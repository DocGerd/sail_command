import { describe, expect, it } from 'vitest';
import { SEAMARKS_IN_VIEW_MAX, seamarksInView, type ViewportBounds } from './seamarksInView';
import type { SeamarkFeatureCollection } from './seamarkGeoJson';
import {
  SEAMARK_DISPLAY_TIER_ALL,
  SEAMARK_DISPLAY_TIER_BASE,
  SEAMARK_DISPLAY_TIER_STANDARD,
} from './seamarkGlyphs';
import type { SeamarkProperties } from '../types';

// #830: the pure viewport filter behind the keyboard-reachable
// "seamarks in view" list. Bounds/tier/sort/cap are each pinned by a
// perturbation that provably MOVES the result (the #455 rule: a green
// mutation row is evidence only if the mutation could have changed the
// subject) — see each `it` for the mutation it reds under.

const VIEW: ViewportBounds = {
  west: 10.0,
  south: 54.8,
  east: 10.2,
  north: 54.9,
  centerLon: 10.1,
  centerLat: 54.85,
};

type FeatureLike = SeamarkFeatureCollection['features'][number];

function pt(lon: number, lat: number, props: SeamarkProperties): FeatureLike {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: props,
  };
}

function fc(features: readonly unknown[]): SeamarkFeatureCollection {
  return { type: 'FeatureCollection', features: features as FeatureLike[] };
}

const CARDINAL: SeamarkProperties = { seamarkType: 'buoy_cardinal', category: 'north' };
const LATERAL: SeamarkProperties = { seamarkType: 'buoy_lateral', category: 'port' };
const LIGHT_MINOR: SeamarkProperties = { seamarkType: 'light_minor' };

describe('seamarksInView (#830)', () => {
  it('keeps only the features inside the bounds (edges inclusive), keyed by their index in the collection', () => {
    const collection = fc([
      pt(10.1, 54.85, CARDINAL), // 0: centre
      pt(10.3, 54.85, LATERAL), // 1: east of the view
      pt(10.0, 54.8, LATERAL), // 2: exactly on the SW corner — inclusive
      pt(10.1, 54.95, LATERAL), // 3: north of the view
      pt(10.2, 54.9, LATERAL), // 4: exactly on the NE corner — inclusive
      pt(9.9, 54.85, LATERAL), // 5: west of the view
    ]);
    const result = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_ALL);
    expect(result.total).toBe(3);
    expect(result.marks.map((m) => m.key).sort()).toEqual(['0', '2', '4']);
    // MUTATION (bounds filter -> return all): total becomes 6, keys gain
    // '1', '3', '5' — reds here.
  });

  it('orders the marks nearest-to-map-centre first, carrying lon/lat/props through', () => {
    const collection = fc([
      pt(10.19, 54.89, LATERAL), // 0: far corner
      pt(10.1, 54.85, CARDINAL), // 1: centre
      pt(10.12, 54.85, LATERAL), // 2: near
    ]);
    const result = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_ALL);
    expect(result.marks.map((m) => m.key)).toEqual(['1', '2', '0']);
    expect(result.marks[0]).toMatchObject({
      lon: 10.1,
      lat: 54.85,
      props: CARDINAL,
      distanceNm: 0,
    });
    expect(result.marks[1]!.distanceNm).toBeGreaterThan(0);
    expect(result.marks[2]!.distanceNm).toBeGreaterThan(result.marks[1]!.distanceNm);
  });

  it('applies the SAME cumulative display-tier cut the map layers use (a light_minor is STANDARD tier)', () => {
    const collection = fc([pt(10.1, 54.85, LIGHT_MINOR), pt(10.11, 54.85, CARDINAL)]);
    const base = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_BASE);
    expect(base.marks.map((m) => m.key)).toEqual(['1']);
    const standard = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_STANDARD);
    expect(standard.marks.map((m) => m.key)).toEqual(['0', '1']);
    // MUTATION (tier cut dropped): `base` lists both — reds here.
  });

  it('caps the list at `max` nearest marks while `total` still counts every mark in view', () => {
    const collection = fc([
      pt(10.15, 54.85, LATERAL), // 0
      pt(10.1, 54.85, CARDINAL), // 1: nearest
      pt(10.19, 54.85, LATERAL), // 2: farthest
      pt(10.12, 54.85, LATERAL), // 3
    ]);
    const result = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_ALL, 2);
    expect(result.total).toBe(4);
    expect(result.marks.map((m) => m.key)).toEqual(['1', '3']);
  });

  it('defaults the cap to SEAMARKS_IN_VIEW_MAX', () => {
    const many = Array.from({ length: SEAMARKS_IN_VIEW_MAX + 7 }, (_, i) =>
      pt(10.1 + i * 0.001, 54.85, LATERAL),
    );
    const result = seamarksInView(fc(many), VIEW, SEAMARK_DISPLAY_TIER_ALL);
    expect(result.total).toBe(SEAMARKS_IN_VIEW_MAX + 7);
    expect(result.marks).toHaveLength(SEAMARKS_IN_VIEW_MAX);
  });

  it('skips malformed features (non-Point, short/non-numeric coordinates, missing type) instead of throwing', () => {
    const collection = fc([
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[10.1, 54.85]] },
        properties: CARDINAL,
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [10.1] }, properties: CARDINAL },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['10.1', 54.85] },
        properties: CARDINAL,
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [10.1, 54.85] },
        properties: null,
      },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [10.1, 54.85] }, properties: {} },
      { type: 'Feature', geometry: null, properties: CARDINAL },
      null,
      pt(10.1, 54.85, CARDINAL), // 7: the one well-formed feature
    ]);
    const result = seamarksInView(collection, VIEW, SEAMARK_DISPLAY_TIER_ALL);
    expect(result.total).toBe(1);
    expect(result.marks.map((m) => m.key)).toEqual(['7']);
  });

  it('handles a world-spanning or antimeridian-wrapped longitude range', () => {
    const collection = fc([pt(10.1, 54.85, CARDINAL), pt(-170, 54.85, LATERAL)]);
    const world = seamarksInView(
      collection,
      { ...VIEW, west: -200, east: 200 },
      SEAMARK_DISPLAY_TIER_ALL,
    );
    expect(world.total).toBe(2);
    const wrapped = seamarksInView(
      collection,
      { ...VIEW, west: 170, east: -160 },
      SEAMARK_DISPLAY_TIER_ALL,
    );
    expect(wrapped.marks.map((m) => m.key)).toEqual(['1']);
  });
});
